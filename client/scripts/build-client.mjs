/**
 * Build the browser half: `lib/client.js` as a closure-factory bundle.
 *
 * Mirrors the shipped dsh client artifact contract: the bundle registers its
 * factory via `window.__ModuleLoader__.load({id, factory})`; the factory
 * receives the loader's synchronous `require` (the browser module table) and
 * returns the module exports. Bare specifiers stay external — `react`,
 * `react/jsx-runtime`, and `@deepseek-ai/dsh-client-ui-primitives` are
 * platform seed words, so every consumer shares the shell's single instance.
 *
 * esbuild runs with `--platform=node --format=cjs` so external requires stay
 * plain `require(...)` identifiers bound to the factory parameter (a browser
 * platform would rewrite them into a global-require shim and break the
 * factory binding).
 */

import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
const outfile = join(pkgRoot, "lib", "client.js");

const result = await build({
	entryPoints: [join(pkgRoot, "src", "client", "index.ts")],
	bundle: true,
	format: "cjs",
	platform: "node",
	target: "es2022",
	outfile,
	external: ["react", "react/jsx-runtime", "@deepseek-ai/dsh-client-ui-primitives"],
	sourcemap: false,
	logLevel: "info",
});

if (result.errors.length > 0) {
	throw new Error(`esbuild failed with ${result.errors.length} error(s)`);
}

const body = readFileSync(outfile, "utf8");
const wrapped = `window.__ModuleLoader__.load({
	id: ${JSON.stringify(pkg.name)},
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
${body}
		return module.exports;
	}
});
`;
mkdirSync(dirname(outfile), { recursive: true });
writeFileSync(outfile, wrapped);
console.log(`client bundle written: lib/client.js (${wrapped.length} bytes)`);
