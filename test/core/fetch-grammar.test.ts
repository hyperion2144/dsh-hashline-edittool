/**
 * The one-click install's download half.
 *
 * Tested against **synthesized tarballs**, not the network: what needs proving
 * is the extraction rules (which entry is picked, what is refused), and a test
 * that reached registry.npmjs.org would be slow, flaky and would prove nothing
 * extra about our code.
 */
import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import {
	E_GRAMMAR_FETCH_FAILED,
	E_GRAMMAR_NOT_IN_TARBALL,
	extractGrammarFromTarball,
	GrammarFetchError,
	readTarEntries,
	tarballUrl,
} from "../../src/ast/fetch-grammar.js";

/** Build one ustar entry. */
function tarEntry(name: string, content: Buffer, typeFlag = "0"): Buffer {
	const header = Buffer.alloc(512, 0);
	header.write(name, 0, 100, "utf8");
	header.write("0000644\0", 100, "ascii"); // mode
	header.write("0000000\0", 108, "ascii"); // uid
	header.write("0000000\0", 116, "ascii"); // gid
	header.write(`${content.byteLength.toString(8).padStart(11, "0")}\0`, 124, "ascii");
	header.write("00000000000\0", 136, "ascii"); // mtime
	header.write("        ", 148, "ascii"); // checksum placeholder
	header.write(typeFlag, 156, 1, "ascii");
	header.write("ustar\0", 257, "ascii");
	header.write("00", 263, "ascii");
	const padding = Buffer.alloc(Math.ceil(content.byteLength / 512) * 512 - content.byteLength, 0);
	return Buffer.concat([header, content, padding]);
}

function tar(entries: Buffer[]): Buffer {
	return Buffer.concat([...entries, Buffer.alloc(1024, 0)]);
}

function tarball(entries: Buffer[]): Buffer {
	return gzipSync(tar(entries));
}

describe("the tarball URL", () => {
	it("follows the registry layout", () => {
		expect(tarballUrl("tree-sitter-python", "0.25.0")).toBe(
			"https://registry.npmjs.org/tree-sitter-python/-/tree-sitter-python-0.25.0.tgz",
		);
	});

	it("escapes a scoped package's slash", () => {
		expect(tarballUrl("@scope/grammar", "1.0.0")).toContain("%2f");
		// The FILE segment keeps the bare name.
		expect(tarballUrl("@scope/grammar", "1.0.0")).toContain("/-/grammar-1.0.0.tgz");
	});
});

describe("the tar reader", () => {
	it("reads entries and their bytes", () => {
		const entries = readTarEntries(tar([tarEntry("package/a.txt", Buffer.from("hello"))]));
		expect(entries).toHaveLength(1);
		expect(entries[0]!.name).toBe("package/a.txt");
		expect(entries[0]!.bytes.toString("utf8")).toBe("hello");
	});

	it("handles an entry whose size is not a block multiple", () => {
		const payload = Buffer.alloc(700, 0x41);
		const entries = readTarEntries(tar([tarEntry("package/big.bin", payload), tarEntry("package/next.txt", Buffer.from("x"))]));
		expect(entries.map((e) => e.name)).toEqual(["package/big.bin", "package/next.txt"]);
		expect(entries[0]!.bytes.byteLength).toBe(700);
	});

	it("skips a non-regular entry instead of reading it as content", () => {
		// A directory entry has size 0 and must not appear as a file.
		const entries = readTarEntries(tar([tarEntry("package/dir/", Buffer.alloc(0), "5")]));
		expect(entries).toEqual([]);
	});

	it("uses the ustar prefix for long paths", () => {
		const header = tarEntry("wasm", Buffer.from("data"));
		header.write("package/nested", 345, "utf8");
		const entries = readTarEntries(tar([header]));
		expect(entries[0]!.name).toBe("package/nested/wasm");
	});

	it("refuses an entry that claims more bytes than the archive holds", () => {
		const header = tarEntry("package/x", Buffer.from("ab"));
		header.write("00000077777\0", 124, "ascii"); // a size far past the data
		expect(() => readTarEntries(Buffer.concat([header, Buffer.alloc(512)]))).toThrow(/claims more bytes/);
	});
});

describe("extraction", () => {
	const wasm = Buffer.from([0x00, 0x61, 0x73, 0x6d, 1, 2, 3]);

	it("finds the wanted file among unrelated entries", () => {
		const archive = tarball([
			tarEntry("package/package.json", Buffer.from("{}")),
			tarEntry("package/README.md", Buffer.from("# x")),
			tarEntry("package/tree-sitter-python.wasm", wasm),
			tarEntry("package/bindings/node/index.js", Buffer.from("x")),
		]);
		expect(extractGrammarFromTarball(archive, "tree-sitter-python.wasm").equals(wasm)).toBe(true);
	});

	it("matches by suffix, not by a fixed package/ prefix", () => {
		// `package/` is npm's layout, not a contract.
		const archive = tarball([tarEntry("some-other-root/x.wasm", wasm)]);
		expect(extractGrammarFromTarball(archive, "x.wasm").equals(wasm)).toBe(true);
	});

	it("refuses an archive without the wanted file", () => {
		const archive = tarball([tarEntry("package/other.wasm", wasm)]);
		const error = (() => {
			try {
				extractGrammarFromTarball(archive, "tree-sitter-python.wasm");
				return undefined;
			} catch (e) {
				return e as GrammarFetchError;
			}
		})();
		expect(error?.code).toBe(E_GRAMMAR_NOT_IN_TARBALL);
	});

	it("refuses a response that is not gzip at all", () => {
		const error = (() => {
			try {
				extractGrammarFromTarball(Buffer.from("not gzip"), "x.wasm");
				return undefined;
			} catch (e) {
				return e as GrammarFetchError;
			}
		})();
		expect(error?.code).toBe(E_GRAMMAR_FETCH_FAILED);
	});
});
