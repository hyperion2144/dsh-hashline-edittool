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

const ctx = {
	plugins: [],
	plugin(pluginObject) {
		this.plugins.push(pluginObject);
		pluginObject.apply(this); // cordis mounts sub-plugins: apply runs immediately
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

if (ctx.plugins.length !== 3) throw new Error(`expected 3 sub-plugins, got ${ctx.plugins.length}`);
const keys = ctx.slots.registeredEntries
	.filter((entry) => entry?.options?.name === "tool.call.toolview")
	.map((entry) => `${entry.options.key}:${entry.options.priority}:${entry.options.locale}`);
const expected = ["read:-1:conversation", "edit:-1:conversation", "write:-1:conversation"];
if (JSON.stringify(keys) !== JSON.stringify(expected)) {
	throw new Error(`unexpected registrations: ${keys.join(", ")}`);
}
for (const entry of ctx.slots.registeredEntries) {
	if (entry && typeof entry === "object" && typeof entry.component !== "function") throw new Error("component is not a function");
}
if (ctx.slots.injectCalls.filter((key) => key === "tool.call.toolview").length !== 3) {
	throw new Error("expected all three toolviews to inject the tool.call.toolview declaration");
}
console.log("bundle evaluation OK:");
console.log("  - factory registered under", registered[0].id);
console.log("  - exports {inject, apply} mount 3 toolview plugins");
console.log("  - registrations:", keys.join(", "));
console.log("  - components:", ctx.slots.registeredEntries.filter((e) => e && typeof e === "object").map((e) => e.component.name).join(", "));
