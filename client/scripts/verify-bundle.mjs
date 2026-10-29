/**
 * Headless evaluation of the built client bundle: execute lib/client.js in a
 * stubbed browser scope (window/document + a require resolving the platform
 * seed words from the local node_modules), then drive `apply(ctx)` with a
 * recording slot registry and assert the keyed registrations.
 *
 * This exercises the exact shipped artifact — factory shape, externals
 * binding, export face, and the registration calls — without a browser.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(here, "..");
const nodeRequire = createRequire(join(clientRoot, "package.json"));

const source = readFileSync(join(clientRoot, "lib", "client.js"), "utf8");

// Browser stubs: the bundle touches neither DOM nor window at factory time
// (CSS injection waits for component render), but the loader face is referenced.
const registered = [];
const windowObj = {
	__ModuleLoader__: {
		load(registration) {
			registered.push(registration);
		},
	},
};

// The primitives artifact is a browser closure bundle importing .module.css —
// unevaluable under Node. The wiring under test needs only callable exports, so
// a Proxy hands back a stable stub component per property name.
const primitivesStub = new Proxy({}, {
	get(_target, prop) {
		if (prop === "__esModule") return false;
		const name = String(prop);
		const fn = { [`Icon_${name}`](_, ...rest) {} }[`Icon_${name}`];
		Object.defineProperty(fn, "name", { value: name });
		return fn;
	},
});
const requireStub = (spec) => {
	if (spec === "react") return nodeRequire("react");
	if (spec === "react/jsx-runtime") return nodeRequire("react/jsx-runtime");
	if (spec === "@deepseek-ai/dsh-client-ui-primitives") return primitivesStub;
	throw new Error(`unexpected require in bundle: ${spec}`);
};

// Evaluate the closure-factory script with `window` and `require` in scope.
const run = new Function("window", "require", source);
run(windowObj, requireStub);

if (registered.length !== 1) {
	throw new Error(`expected exactly one bundle registration, got ${registered.length}`);
}
if (registered[0].id !== "dsh-hashline-edittool") {
	throw new Error(`unexpected registration id: ${registered[0].id}`);
}

// Materialize the factory with a recording client context.
const exports_ = registered[0].factory(requireStub);
if (typeof exports_.apply !== "function" || exports_.inject?.[0] !== "slots") {
	throw new Error(`bad export face: ${Object.keys(exports_)}`);
}

// The bundle root asks the locale service for the cards' OWN namespace: the
// vocabulary is registered there, once, with both baseline languages.
if (!exports_.inject.includes("locale")) {
	throw new Error(`the bundle root does not require the locale service: ${exports_.inject}`);
}
const ctx = {
	plugins: [],
	plugin(pluginObject) {
		this.plugins.push(pluginObject);
		pluginObject.apply(this); // cordis mounts sub-plugins: apply runs immediately
	},
	// Cordis effect: run the callback and keep its disposer (the shipped face).
	effect(callback) {
		const disposer = callback();
		return typeof disposer === "function" ? disposer : () => {};
	},
	// The settings domain's shared forms, stubbed to the two calls the card
	// makes: `whileServed` (register once the namespace is served) and `get`
	// (the per-ENTRY form the card drives as its own controller).
	configForms: {
		served: new Set(["dsh-hashline-edittool"]),
		formCalls: [],
		get(entryId) {
			this.formCalls.push(entryId);
			return {
				getSnapshot: () => ({ status: "ready", value: {}, base: {}, user: {}, revision: 1, writable: true, mode: "host" }),
				subscribe: () => () => {},
				set: async () => true,
				unset: async () => true,
				mutate: async () => true,
			};
		},
		whileServed(namespaces, register) {
			const served = namespaces.filter((ns) => this.served.has(ns));
			if (served.length === 0) return () => {};
			return register(new Set(served)) ?? (() => {});
		},
	},
	// The locale service: the plugin registers its OWN vocabulary namespace
	// with it, once, and every registration is recorded here.
	locale: {
		registered: [],
		register(ns, dictionaries) {
			this.registered.push({ ns, dictionaries });
			return () => {};
		},
	},
	slots: {
		injectCalls: [],
		registeredEntries: [],
		inject(key, create) {
			this.injectCalls.push(key);
			const disposer = create();
			this.registeredEntries.push(...(Array.isArray(disposer) ? disposer : [disposer]));
		},
		register(options, component) {
			this.registeredEntries.push({ options, component });
			return () => {};
		},
	},
};
exports_.apply(ctx);

// Eleven toolview keys: read, edit, undo_last_edit, grep, write, delete,
// rename, the AST tools (which register TWO entries under one sub-plugin),
// `lsp`, `format`, and the settings card.
if (ctx.plugins.length !== 9) throw new Error(`expected 9 sub-plugins, got ${ctx.plugins.length}`);
const keys = ctx.slots.registeredEntries
	.filter((entry) => entry?.options?.name === "tool.call.toolview")
	.map((entry) => `${entry.options.key}:${entry.options.priority}:${entry.options.locale}`);
// Each AST/LSP tool has its OWN key AND its own row component. The keys were
// already their own; the components were not, and that is what made `ast_grep`
// announce itself as 读取: the title is derived from the row's variant, so a tool
// wearing the read component reads as a read. `lsp` had no row at all and fell
// through to raw input/output.
const expected = [
	"read:-2:hashline.card",
	"edit:-2:hashline.card",
	// `undo_last_edit` answers with the diff of the revert and now wears that
	// same row — without a registration the web drew raw input/output for it.
	"undo_last_edit:-2:hashline.card",
	"grep:-2:hashline.card",
	"write:-2:hashline.card",
	// The delete card needs its own row: the platform default shows raw I/O.
	"delete:-2:hashline.card",
	// The rename card needs its own row too: a moved pair reads nothing like
	// raw input/output.
	"rename:-2:hashline.card",
	"ast_grep:-2:hashline.card",
	"ast_edit:-2:hashline.card",
	"lsp:-2:hashline.card",
	// `format` draws its formats section through the edit row (one empty tab
	// per file; the section IS the diff) — without the key it drew raw I/O.
	"format:-2:hashline.card",
];
if (JSON.stringify(keys) !== JSON.stringify(expected)) {
	throw new Error(`unexpected registrations: ${keys.join(", ")}`);
}
// The cards' vocabulary: ONE namespace, registered once, carrying BOTH
// baseline languages with the SAME key set. The shipped `conversation` seat
// never carried four of these keys, so a card drew their names verbatim.
const localeRegistrations = ctx.locale.registered;
if (localeRegistrations.length !== 1) {
	throw new Error(`expected one locale registration, got ${localeRegistrations.length}`);
}
const vocabulary = localeRegistrations[0];
if (vocabulary.ns !== "hashline.card") {
	throw new Error(`unexpected locale namespace: ${vocabulary.ns}`);
}
const enKeys = Object.keys(vocabulary.dictionaries.en ?? {}).sort();
const zhKeys = Object.keys(vocabulary.dictionaries.zh ?? {}).sort();
if (enKeys.length === 0) throw new Error("the card vocabulary is empty");
if (JSON.stringify(enKeys) !== JSON.stringify(zhKeys)) {
	throw new Error("the en/zh card vocabularies carry different key sets");
}
for (const entry of ctx.slots.registeredEntries) {
	if (entry && typeof entry === "object" && typeof entry.component !== "function") throw new Error("component is not a function");
}
// The settings card registers on the plugin manager's BUNDLE-config slot
// (#171): the page rendered for the plugin ITSELF, so opening the plugin shows
// the configuration — the second layer's row page is no longer involved.
// The key is the Host plugin ENTRY id, which is the bundle's package name.
const settingsCards = ctx.slots.registeredEntries
	.filter((entry) => entry?.options?.name === "plugins.bundle.config")
	.map((entry) => `${entry.options.key}`);
if (JSON.stringify(settingsCards) !== JSON.stringify(["dsh-hashline-edittool"])) {
	throw new Error(`unexpected settings card registration: ${settingsCards.join(", ")}`);
}
// The settings card reads the SAME namespace as the tool rows: one
// vocabulary for the whole plugin.
const settingsCardLocales = ctx.slots.registeredEntries
	.filter((entry) => entry?.options?.name === "plugins.bundle.config")
	.map((entry) => `${entry.options.locale}`);
if (JSON.stringify(settingsCardLocales) !== JSON.stringify(["hashline.card"])) {
	throw new Error(`the settings card reads another locale: ${settingsCardLocales.join(", ")}`);
}
if (ctx.slots.injectCalls.filter((key) => key === "plugins.bundle.config").length !== 1) {
	throw new Error("expected the settings card to inject the plugins.bundle.config declaration");
}
// The bundle page hands `{ view }` and NO form, so the card drives its OWN
// controller: the settings domain's `configForms` service (the same source the
// row page's form is built from). `settingsScope` does not exist in the 0.1.7
// composition — injecting it would keep the card, and every row with it, from
// loading at all.
const settingsCardPlugin = ctx.plugins.find((p) => p.name === "hashline-settings-card");
if (JSON.stringify(settingsCardPlugin?.inject) !== JSON.stringify(["slots", "configForms"])) {
	throw new Error(`settings card injects unavailable services: ${settingsCardPlugin?.inject?.join(", ")}`);
}
// ELEVEN, not ten: the AST sub-plugin loops over its FOUR keys (ast_grep,
// ast_edit, lsp, format) and each iteration asks the slot for its entry, so
// seven single-key sub-plugins plus four. The count is asserted rather than
// assumed so a sub-plugin added without a key cannot pass quietly.
if (ctx.slots.injectCalls.filter((key) => key === "tool.call.toolview").length !== 11) {
	throw new Error("expected every toolview to inject the tool.call.toolview declaration");
}
console.log("bundle evaluation OK:");
console.log("  - factory registered under", registered[0].id);
console.log("  - exports {inject, apply} mount 8 toolview plugins + 1 settings card");
console.log("  - registrations:", keys.join(", "));
console.log("  - components:", ctx.slots.registeredEntries.filter((e) => e && typeof e === "object").map((e) => e.component.name).join(", "));
console.log("  - settings card:", settingsCards.join(", "));
