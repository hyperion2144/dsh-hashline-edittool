import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { saveUndo, getUndo, clearUndo } from "../../src/domain/edit/undo-edit.js";
import { loadHashStore, shutdownHashStore } from "../../src/domain/session/hash-store.js";
import * as hashStoreModule from "../../src/domain/session/hash-store.js";
import { hashStorePath } from "../../src/infra/paths.js";
import { UNDO_STACK_DEPTH } from "../../src/infra/constants.js";
import { useTestHome } from "../support/fixtures.js";

const home = useTestHome();

describe("undo-store", () => {
	it("round-trips a single entry", async () => {
		await saveUndo(home.testPath, {
			content: "hello\nworld",
			bom: "",
			originalEnding: "\n",
			hashes: ["abc", "def"],
			resultContent: "hello\nworld!",
		});
		const entry = await getUndo(home.testPath);
		expect(entry).toBeDefined();
		expect(entry!.content).toBe("hello\nworld");
		expect(entry!.bom).toBe("");
		expect(entry!.originalEnding).toBe("\n");
		expect(entry!.hashes).toEqual(["abc", "def"]);
		expect(entry!.resultContent).toBe("hello\nworld!");
	});

	it("returns undefined for a path with no undo history", async () => {
		expect(await getUndo("/nonexistent.ts")).toBeUndefined();
	});

	it("the NEWEST entry wins — a push, not an overwrite", async () => {
		await saveUndo(home.testPath, {
			content: "first",
			bom: "",
			originalEnding: "\n",
			hashes: ["aB3"],
			resultContent: "first!",
		});
		await saveUndo(home.testPath, {
			content: "second",
			bom: "\uFEFF",
			originalEnding: "\r\n",
			hashes: ["bC4"],
			resultContent: "second!",
		});
		const entry = await getUndo(home.testPath);
		expect(entry!.content).toBe("second");
		expect(entry!.bom).toBe("\uFEFF");
		expect(entry!.originalEnding).toBe("\r\n");
		expect(entry!.hashes).toEqual(["bC4"]);
	});

	it("clearUndo removes the entry", async () => {
		await saveUndo(home.testPath, {
			content: "data",
			bom: "",
			originalEnding: "\n",
			hashes: ["xY7"],
			resultContent: "data!",
		});
		expect(await getUndo(home.testPath)).toBeDefined();
		await clearUndo(home.testPath);
		expect(await getUndo(home.testPath)).toBeUndefined();
	});

	it("handles multiple independent paths", async () => {
		await saveUndo(home.testPath, {
			content: "aaa",
			bom: "",
			originalEnding: "\n",
			hashes: ["h1A"],
			resultContent: "aaa!",
		});
		await saveUndo("/b.ts", {
			content: "bbb",
			bom: "",
			originalEnding: "\n",
			hashes: ["h2B"],
			resultContent: "bbb!",
		});
		expect((await getUndo(home.testPath))!.content).toBe("aaa");
		expect((await getUndo("/b.ts"))!.content).toBe("bbb");
		await clearUndo(home.testPath);
		expect(await getUndo(home.testPath)).toBeUndefined();
		expect((await getUndo("/b.ts"))!.content).toBe("bbb");
	});

	it("survives a hash-store shutdown and reopen", async () => {
		await saveUndo(home.testPath, {
			content: "old",
			bom: "\uFEFF",
			originalEnding: "\r",
			hashes: ["abc", "def"],
			resultContent: "new",
		});
		shutdownHashStore();
		const entry = await getUndo(home.testPath);
		expect(entry).toBeDefined();
		expect(entry!.content).toBe("old");
		expect(entry!.bom).toBe("\uFEFF");
		expect(entry!.originalEnding).toBe("\r");
		expect(entry!.hashes).toEqual(["abc", "def"]);
		expect(entry!.resultContent).toBe("new");
	});

	it("saveUndo reports failure when the hash store cannot be opened", async () => {
		const spy = vi
			.spyOn(hashStoreModule, "loadHashStore")
			.mockRejectedValue(new Error("store down"));
		try {
			const ok = await saveUndo(home.testPath, {
				content: "old",
				bom: "",
				originalEnding: "\n",
				hashes: ["abc"],
				resultContent: "new",
			});
			expect(ok.persisted).toBe(false);
		} finally {
			spy.mockRestore();
		}
	});

	it("treats a row with an invalid ending as a miss", async () => {
		await saveUndo(home.testPath, {
			content: "old",
			bom: "",
			originalEnding: "\r\n",
			hashes: ["abc"],
			resultContent: "new",
		});
		const db = new DatabaseSync(hashStorePath(), { defensive: false } as any);
		db.prepare("UPDATE undo SET ending = ? WHERE path = ?").run(
			"bogus",
			home.testPath,
		);
		db.close();
		expect(await getUndo(home.testPath)).toBeUndefined();
		const check = new DatabaseSync(hashStorePath(), {
			defensive: false,
		} as any);
		const remaining = check
			.prepare("SELECT COUNT(*) AS n FROM undo WHERE path = ?")
			.get(home.testPath) as { n: number };
		check.close();
		expect(remaining.n).toBe(0);
	});
});

describe("undo-store — raw entries", () => {
	it("round-trips an undo entry", async () => {
		const store = await loadHashStore();
		store.pushUndo("/a.ts", {
			content: "old",
			bom: "\uFEFF",
			ending: "\r\n",
			hashes: ["abc", "def"],
			resultContent: "new",
		});
		const entry = store.getUndo("/a.ts");
		expect(entry).toEqual({
			content: "old",
			bom: "\uFEFF",
			ending: "\r\n",
			hashes: ["abc", "def"],
			resultContent: "new",
		});
	});

	it("returns undefined for a path with no undo entry", async () => {
		const store = await loadHashStore();
		expect(store.getUndo("/missing.ts")).toBeUndefined();
	});

	it("the NEWEST entry wins — a push, not an overwrite", async () => {
		const store = await loadHashStore();
		store.pushUndo("/a.ts", {
			content: "first",
			bom: "",
			ending: "\n",
			hashes: ["aB3"],
			resultContent: "first!",
		});
		store.pushUndo("/a.ts", {
			content: "second",
			bom: "",
			ending: "\r",
			hashes: ["bC4"],
			resultContent: "second!",
		});
		const entry = store.getUndo("/a.ts");
		expect(entry!.content).toBe("second");
		expect(entry!.ending).toBe("\r");
		expect(entry!.hashes).toEqual(["bC4"]);
	});

	it("deletes an undo entry", async () => {
		const store = await loadHashStore();
		store.pushUndo("/a.ts", {
			content: "old",
			bom: "",
			ending: "\n",
			hashes: ["xY7"],
			resultContent: "new",
		});
		store.deleteUndo("/a.ts");
		expect(store.getUndo("/a.ts")).toBeUndefined();
	});

	it("treats a row with unparseable hashes as a miss", async () => {
		const store = await loadHashStore();
		store.pushUndo("/a.ts", {
			content: "old",
			bom: "",
			ending: "\n",
			hashes: ["xY7"],
			resultContent: "new",
		});
		const db = new DatabaseSync(hashStorePath(), { defensive: false } as any);
		db.prepare("UPDATE undo SET hashes = ? WHERE path = ?").run(
			"{not json",
			"/a.ts",
		);
		db.close();
		expect(store.getUndo("/a.ts")).toBeUndefined();
		const check = new DatabaseSync(hashStorePath(), {
			defensive: false,
		} as any);
		const remaining = check
			.prepare("SELECT COUNT(*) AS n FROM undo WHERE path = ?")
			.get("/a.ts") as { n: number };
		check.close();
		expect(remaining.n).toBe(0);
	});

	it("treats a row with malformed hash strings as a miss", async () => {
		const store = await loadHashStore();
		store.pushUndo("/a.ts", {
			content: "old",
			bom: "",
			ending: "\n",
			hashes: ["xY7"],
			resultContent: "new",
		});
		const db = new DatabaseSync(hashStorePath(), { defensive: false } as any);
		db.prepare("UPDATE undo SET hashes = ? WHERE path = ?").run(
			'["ZZ!", "ab-c"]',
			"/a.ts",
		);
		db.close();
		expect(store.getUndo("/a.ts")).toBeUndefined();
		const check = new DatabaseSync(hashStorePath(), {
			defensive: false,
		} as any);
		const remaining = check
			.prepare("SELECT COUNT(*) AS n FROM undo WHERE path = ?")
			.get("/a.ts") as { n: number };
		check.close();
		expect(remaining.n).toBe(0);
	});

	it("walks back through the stack, newest first", async () => {
		const store = await loadHashStore();
		for (const name of ["first", "second", "third"]) {
			store.pushUndo("/stack.ts", {
				content: name,
				bom: "",
				ending: "\n",
				hashes: ["xY7"],
				resultContent: `${name}!`
			});
		}
		expect(store.undoDepth("/stack.ts")).toBe(3);
		expect(store.getUndo("/stack.ts")!.content).toBe("third");
		store.popUndo("/stack.ts");
		expect(store.getUndo("/stack.ts")!.content).toBe("second");
		store.popUndo("/stack.ts");
		expect(store.getUndo("/stack.ts")!.content).toBe("first");
		store.popUndo("/stack.ts");
		expect(store.getUndo("/stack.ts")).toBeUndefined();
		expect(store.undoDepth("/stack.ts")).toBe(0);
	});

	it("bounds the stack at UNDO_STACK_DEPTH, dropping the OLDEST entry", async () => {
		const store = await loadHashStore();
		for (let i = 0; i < UNDO_STACK_DEPTH + 3; i++) {
			store.pushUndo("/bounded.ts", {
				content: `v${i}`,
				bom: "",
				ending: "\n",
				hashes: ["xY7"],
				resultContent: `v${i}!`
			});
		}
		expect(store.undoDepth("/bounded.ts")).toBe(UNDO_STACK_DEPTH);
		const seen: string[] = [];
		for (let i = 0; i < UNDO_STACK_DEPTH; i++) {
			seen.push(store.getUndo("/bounded.ts")!.content);
			store.popUndo("/bounded.ts");
		}
		// Newest first, and the three oldest never made it.
		expect(seen[0]).toBe(`v${UNDO_STACK_DEPTH + 2}`);
		expect(seen[UNDO_STACK_DEPTH - 1]).toBe("v3");
		expect(store.getUndo("/bounded.ts")).toBeUndefined();
	});

	it("deleteUndo drops the whole stack, not just the top", async () => {
		const store = await loadHashStore();
		for (const name of ["a", "b"]) {
			store.pushUndo("/clear.ts", {
				content: name,
				bom: "",
				ending: "\n",
				hashes: ["xY7"],
				resultContent: `${name}!`
			});
		}
		store.deleteUndo("/clear.ts");
		expect(store.getUndo("/clear.ts")).toBeUndefined();
		expect(store.undoDepth("/clear.ts")).toBe(0);
	});
});
