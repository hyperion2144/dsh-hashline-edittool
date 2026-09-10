#!/usr/bin/env node
/**
 * Remove build outputs so a build never ships stale artifacts.
 *
 * `tsc` does not delete outputs whose sources were removed, and `npm pack`
 * ships whatever sits in `lib/` — a file deleted from `src/` would otherwise
 * survive in the published tarball forever (and could import the wrong
 * module). Both halves are removed: the main `lib/` and the client `client/lib/`.
 */
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
for (const dir of ["lib", join("client", "lib")]) {
	rmSync(join(root, dir), { recursive: true, force: true });
}
console.log("[clean] removed lib/ and client/lib/");
