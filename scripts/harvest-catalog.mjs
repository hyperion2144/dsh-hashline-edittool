/**
 * Harvest the real catalog facts for every curated grammar: pinned version,
 * .wasm file name, byte size and sha256.
 *
 * Why a script and not a table someone typed: #110 already shipped once with a
 * placeholder hash (`"pinned-at-install"`), which made hash verification
 * decorative. A catalog entry is only worth having if its hash came from the
 * artifact that will actually be downloaded.
 *
 * Curation is part of the job: `npm view <pkg> version` can answer
 * `0.0.1-security`, which means the original package was unpublished and the
 * name now belongs to a security placeholder. Those must be EXCLUDED, not
 * shipped — that is the difference between a curated catalog and "whatever is
 * on npm".
 *
 * Dev tool. Writes JSON to stdout; nothing imports it.
 *   node scripts/harvest-catalog.mjs > .tmp/catalog-facts.json
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The curated set. `tree-sitter-r` and `tree-sitter-dockerfile` are absent on
 * purpose: both resolve to 0.0.1-security. */
const PACKAGES = [
	"go", "rust", "java", "c", "cpp", "c-sharp", "ruby", "php", "bash", "kotlin",
	"swift", "scala", "lua", "elixir", "haskell", "ocaml", "zig", "julia", "perl",
	"nix", "svelte", "vue", "dart", "css", "html", "json", "yaml", "toml", "sql",
	"markdown",
].map((name) => `tree-sitter-${name}`);

const npm = (args) => execFileSync("npm", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

const facts = [];
const skipped = [];

for (const pkg of PACKAGES) {
	let version;
	try {
		version = npm(["view", pkg, "version"]);
	} catch {
		skipped.push({ package: pkg, reason: "npm view failed" });
		continue;
	}
	// A `-security` version means the original was unpublished. Shipping it
	// would install a placeholder that cannot parse anything.
	if (version.includes("security")) {
		skipped.push({ package: pkg, reason: `placeholder version ${version}` });
		continue;
	}
	const tarball = npm(["view", pkg, "dist.tarball"]);
	const dir = mkdtempSync(join(tmpdir(), "grammar-"));
	try {
		execFileSync("sh", ["-c", `curl -sL ${JSON.stringify(tarball)} | tar -xz -C ${JSON.stringify(dir)}`], { stdio: "ignore" });
		const wasm = readdirSync(dir).flatMap((entry) => {
			try {
				return readdirSync(join(dir, entry)).filter((f) => f.endsWith(".wasm")).map((f) => join(dir, entry, f));
			} catch {
				return [];
			}
		})[0];
		if (wasm === undefined) {
			skipped.push({ package: pkg, reason: "no .wasm in tarball" });
			continue;
		}
		const bytes = readFileSync(wasm);
		facts.push({
			id: pkg.replace(/^tree-sitter-/, ""),
			grammarPackage: pkg,
			version,
			wasmFile: wasm.split("/").pop(),
			size: bytes.byteLength,
			sha256: createHash("sha256").update(bytes).digest("hex"),
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

console.log(JSON.stringify({ facts, skipped }, null, "\t"));
console.error(`harvested ${facts.length}, skipped ${skipped.length}`);
