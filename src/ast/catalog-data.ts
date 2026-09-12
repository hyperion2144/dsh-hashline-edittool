/**
 * GENERATED — do not edit by hand.
 *
 * Produced by `scripts/emit-catalog-rows.mjs` from `scripts/harvest-catalog.mjs`,
 * which downloads each package and hashes the artifact it actually contains.
 * Every sha256 and size here is measured, not transcribed.
 *
 * Regenerate:
 *   node scripts/harvest-catalog.mjs > .tmp/catalog-facts.json
 *   node scripts/emit-catalog-rows.mjs
 *
 * Only packages that PUBLISH a prebuilt .wasm appear here. Eleven candidates
 * (kotlin, swift, lua, zig, perl, nix, vue, yaml, toml, sql, markdown) ship C
 * source plus native bindings and no wasm at all, so supporting them would mean
 * compiling and hosting binaries ourselves — a different supply-chain problem,
 * not a catalog row. `tree-sitter-r` and `tree-sitter-dockerfile` are absent
 * because both now resolve to a 0.0.1-security placeholder.
 */
export interface HarvestedCatalogRow {
	readonly id: string;
	readonly displayName: string;
	readonly grammarPackage: string;
	readonly version: string;
	readonly wasmFile: string;
	readonly sha256: string;
	/** Size of the .wasm in bytes — the figure a user judges a download by. */
	readonly size: number;
	/** Lowercase extensions with the leading dot. */
	readonly extensions: readonly string[];
}

/** The 15 grammars that publish a prebuilt wasm, measured. */
export const HARVESTED_CATALOG: readonly HarvestedCatalogRow[] = [
	{
		id: "bash",
		displayName: "Bash",
		grammarPackage: "tree-sitter-bash",
		version: "0.25.1",
		wasmFile: "tree-sitter-bash.wasm",
		sha256: "8292919c88a0f7d3fb31d0cd0253ca5a9531bc1ede82b0537f2c63dd8abe6a7a",
		size: 1358224,
		extensions: [".sh", ".bash", ".zsh"],
	},
	{
		id: "c",
		displayName: "C",
		grammarPackage: "tree-sitter-c",
		version: "0.24.1",
		wasmFile: "tree-sitter-c.wasm",
		sha256: "c852c2a85ebf2beb636aa3b0ef7f7e70458684d74f6741b20dcb296885bed9f9",
		size: 625918,
		extensions: [".c", ".h"],
	},
	{
		id: "c-sharp",
		displayName: "C#",
		grammarPackage: "tree-sitter-c-sharp",
		version: "0.23.5",
		wasmFile: "tree-sitter-c_sharp.wasm",
		sha256: "6f69e1cae44e1c32c1eccc170dc5a9778fb94ff716f71113fe1f8c4299aa2f40",
		size: 5350581,
		extensions: [".cs"],
	},
	{
		id: "cpp",
		displayName: "C++",
		grammarPackage: "tree-sitter-cpp",
		version: "0.23.4",
		wasmFile: "tree-sitter-cpp.wasm",
		sha256: "174eb0deb75b2ec7881bcacda9f995648d8e683956e5c2267e69ab6dc503fcbf",
		size: 3434931,
		extensions: [".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx"],
	},
	{
		id: "elixir",
		displayName: "Elixir",
		grammarPackage: "tree-sitter-elixir",
		version: "0.3.5",
		wasmFile: "tree-sitter-elixir.wasm",
		sha256: "ed99093c548c12d43f7e337fd3440e9e2daa2ec671a5e29aadb6c6dcb2232a62",
		size: 1412267,
		extensions: [".ex", ".exs"],
	},
	{
		id: "go",
		displayName: "Go",
		grammarPackage: "tree-sitter-go",
		version: "0.25.0",
		wasmFile: "tree-sitter-go.wasm",
		sha256: "9504573f352b20be7f2f1911754d710622aedc15afff16d5ed8fb5645681aee7",
		size: 217182,
		extensions: [".go"],
	},
	{
		id: "haskell",
		displayName: "Haskell",
		grammarPackage: "tree-sitter-haskell",
		version: "0.23.1",
		wasmFile: "tree-sitter-haskell.wasm",
		sha256: "37a6b07b1a838d02ffb4f4c2a06863637a8efe48432d60a275f50f1d08f1092c",
		size: 3805902,
		extensions: [".hs", ".lhs"],
	},
	{
		id: "java",
		displayName: "Java",
		grammarPackage: "tree-sitter-java",
		version: "0.23.5",
		wasmFile: "tree-sitter-java.wasm",
		sha256: "4fdeac4ca6ca089f06c6f7e562abcac1733cd465728cc7031ebb73c2019122c4",
		size: 414641,
		extensions: [".java"],
	},
	{
		id: "julia",
		displayName: "Julia",
		grammarPackage: "tree-sitter-julia",
		version: "0.23.1",
		wasmFile: "tree-sitter-julia.wasm",
		sha256: "e0f52c36eadf0299e46fccd6715c760d35eaa3f09721bec38633da551ac9e781",
		size: 6223352,
		extensions: [".jl"],
	},
	{
		id: "ocaml",
		displayName: "OCaml",
		grammarPackage: "tree-sitter-ocaml",
		version: "0.24.2",
		wasmFile: "tree-sitter-ocaml.wasm",
		sha256: "761a78a804931cfac1fa0c6238989b4b0e86cc70db461b1315d743de923f8246",
		size: 5553934,
		extensions: [".ml", ".mli"],
	},
	{
		id: "php",
		displayName: "Php",
		grammarPackage: "tree-sitter-php",
		version: "0.24.2",
		wasmFile: "tree-sitter-php.wasm",
		sha256: "d4df6a6ff08c87c3ec4f9cbb785fe09998a0cb570e03f57d7b19b3acfb146aa7",
		size: 1058041,
		extensions: [".php", ".phtml"],
	},
	{
		id: "ruby",
		displayName: "Ruby",
		grammarPackage: "tree-sitter-ruby",
		version: "0.23.1",
		wasmFile: "tree-sitter-ruby.wasm",
		sha256: "09a96427d7c72f0613ed470cd9812223fc4a91d6a9c025c0235cc6bd59ff96f4",
		size: 2106352,
		extensions: [".rb", ".rake", ".gemspec"],
	},
	{
		id: "rust",
		displayName: "Rust",
		grammarPackage: "tree-sitter-rust",
		version: "0.24.0",
		wasmFile: "tree-sitter-rust.wasm",
		sha256: "f65f354215611fd94ad34134b3427eb3d58cbb745df7b6509ba722184db73d57",
		size: 1102547,
		extensions: [".rs"],
	},
	{
		id: "scala",
		displayName: "Scala",
		grammarPackage: "tree-sitter-scala",
		version: "0.24.0",
		wasmFile: "tree-sitter-scala.wasm",
		sha256: "b7ec2bb29c19827abcefd18ed5cb5a43596009f96a5d53c5b9d1f9676d7521c3",
		size: 3786700,
		extensions: [".scala", ".sc"],
	},
	{
		id: "svelte",
		displayName: "Svelte",
		grammarPackage: "tree-sitter-svelte",
		version: "0.11.0",
		wasmFile: "tree-sitter-svelte.wasm",
		sha256: "0ed8d4aca53f9f1bafc1844575dcb259a598cca099105b772f6c0c6bcbd299b4",
		size: 35635,
		extensions: [".svelte"],
	},
];
