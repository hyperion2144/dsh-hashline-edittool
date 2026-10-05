import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { anchorsFor, updateAnchorsAfterEdit } from "../../src/domain/session/anchor-state.js";
import { anchorFor } from "../../src/domain/session/anchor-entry.js";
import { loadHashStore, shutdownHashStore } from "../../src/domain/session/hash-store.js";
import { assignAnchors, contentKey } from "../../src/hashline/alloc.js";
import { contentChecksum } from "../../src/hashline/hash-assign.js";
import { splitLines } from "../../src/infra/utils.js";
import { getWritableTempRoot } from "../support/fixtures.js";

/**
 * Anchor state is PERSISTED, and it is the only source.
 *
 * These cases used to exercise a per-path in-memory cache: eviction, write-behind
 * flush, cache invalidation by a concurrent writer. That cache is gone (contract
 * §3 — the pure layer holds no store-scoped state; §2.3 — a question about an
 * anchor is answered by `anchor_lines`, not by anything materialised first), so
 * the cases are re-expressed against the ROWS. What they assert is unchanged:
 * an unchanged line keeps its anchor across a store reopen, a foreign write is
 * picked up, corruption is healed locally, and TTL/pruning still apply.
 */

let tmpHome: string;

beforeEach(async () => {
	tmpHome = await mkdtemp(join(await getWritableTempRoot(), "pi-hashline-anchor-state-"));
	vi.stubEnv("HOME", tmpHome);
	vi.stubEnv("USERPROFILE", tmpHome);
	vi.stubEnv("DSH_HOME", join(tmpHome, ".dsh"));
	vi.stubEnv("XDG_CONFIG_HOME", "");
});

afterEach(async () => {
	shutdownHashStore();
	vi.unstubAllEnvs();
	await rm(tmpHome, { recursive: true, force: true });
});

// ---- fixtures: repeated blank lines / closing braces, the shapes the field
// report churned on (identical-content runs reshuffle under a recompute). ---
const C0 = [
	"import { x } from \"x\";",
	"",
	"export function a() {",
	"    if (x) {",
	"        return 1;",
	"    }",
	"}",
	"",
	"export function b() {",
	"    return 2;",
	"}",
	"",
].join("\n");

const C1 = C0.replace("        return 1;", "        return 42;");
const C2 = C1.replace("export function b() {", "export function bee() {");

function hunkLine5(): { oldStart1: number; oldEnd1: number; finalStart1: number; finalEnd1: number } {
	return { oldStart1: 5, oldEnd1: 5, finalStart1: 5, finalEnd1: 5 };
}

/**
 * Serve every line of `content`, the way a read does, and return the view.
 *
 * Goes through the ONE allocate entry point (`anchorFor`). It used to call
 * `allocateForLines`, a second allocation path that has been deleted.
 */
async function serveAll(path: string, content: string): Promise<string[]> {
	await anchorFor({
		path,
		content,
		lines: Array.from({ length: splitLines(content).length }, (_, i) => i + 1),
		sessionKey: "persist-test",
	});
	return anchorsFor(path, content);
}

/** Touch unrelated paths. There is no cache to evict any more — this is noise. */
async function touchOtherPaths(prefix: string): Promise<void> {
	for (let i = 0; i < 5; i++) {
		await serveAll(`${prefix}-${i}.txt`, "other\nfile\n");
	}
}

function configHome(home: string): string {
	return join(home, ".dsh", "plugins", "dsh-hashline-edittool");
}

function sqlitePath(home: string): string {
	return join(configHome(home), "hash-store.sqlite");
}

/** Simulate ANOTHER process writing the anchor rows directly. */
function plantAnchorState(
	home: string,
	path: string,
	checksum: string,
	anchors: string[],
	lineKeys: number[],
): void {
	const db = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
	const now = Date.now();
	db.prepare(
		"INSERT INTO anchor_meta (path, checksum, line_count, updated_at) VALUES (?, ?, ?, ?) " +
			"ON CONFLICT(path) DO UPDATE SET checksum = excluded.checksum, line_count = excluded.line_count, updated_at = excluded.updated_at"
	).run(path, checksum, lineKeys.length, now);
	db.prepare("DELETE FROM anchor_lines WHERE path = ?").run(path);
	const insert = db.prepare(
		"INSERT INTO anchor_lines (path, line, anchor, content_key, updated_at) VALUES (?, ?, ?, ?, ?)",
	);
	for (let i = 0; i < anchors.length && i < lineKeys.length; i++) {
		if (anchors[i] === "" || anchors[i] === undefined) continue; // sparse: only allocated lines
		insert.run(path, i + 1, anchors[i], lineKeys[i], now);
	}
	db.close();
}

function countAnchorRows(home: string, path: string): number {
	const db = new DatabaseSync(sqlitePath(home), { defensive: false } as any);
	const row = db.prepare("SELECT COUNT(*) AS n FROM anchor_lines WHERE path = ?").get(path) as {
		n: number;
	};
	db.close();
	return row.n;
}

describe("anchor state persistence (#136)", () => {
	it("other paths being served does not disturb this one", async () => {
		await loadHashStore();
		const p = "/proj/evict.ts";
		const a0 = await serveAll(p, C0);
		const a1 = updateAnchorsAfterEdit({
			path: p,
			oldContent: C0,
			newContent: C1,
			oldAnchors: a0,
			hunks: [hunkLine5()],
		});
		expect(a1[4]).not.toBe(a0[4]); // the edited line re-anchors
		expect(a1[0]).toBe(a0[0]); // untouched lines keep theirs

		await touchOtherPaths("/flood-evict");
		expect(anchorsFor(p, C1)).toEqual(a1);
	});

	it("a store reopen (process restart) recovers anchors from sqlite", async () => {
		const p = "/proj/restart.ts";
		await loadHashStore();
		const a0 = await serveAll(p, C0);
		const a1 = updateAnchorsAfterEdit({
			path: p,
			oldContent: C0,
			newContent: C1,
			oldAnchors: a0,
			hunks: [hunkLine5()],
		});
		shutdownHashStore();
		await loadHashStore();
		await touchOtherPaths("/flood-restart");
		expect(anchorsFor(p, C1)).toEqual(a1);
	});

	it("an external change inherits by diff — realigned on the ALLOCATE path", async () => {
		const p = "/proj/external.ts";
		await loadHashStore();
		const a0 = await serveAll(p, C0);
		const a1 = updateAnchorsAfterEdit({
			path: p,
			oldContent: C0,
			newContent: C1,
			oldAnchors: a0,
			hunks: [hunkLine5()],
		});
		await touchOtherPaths("/flood-external");
		// Realigning is a WRITE, so it belongs to the allocate path (§2.1 item 1);
		// `anchorsFor` alone would project the pre-change rows. Serving C2 runs the
		// realign, and only line 9 (changed externally) re-anchors.
		const a2 = await serveAll(p, C2);
		expect(a2.length).toBe(splitLines(C2).length);
		for (let i = 0; i < a2.length; i++) {
			if (i === 8) continue;
			expect(a2[i]).toBe(a1[i]); // every unchanged line keeps its anchor
		}
		expect(a2[8]).not.toBe(a1[8]); // only the changed line re-anchors
	});

	it("a foreign writer's rows are what the next read sees", async () => {
		const r = "/proj/shared.ts";
		await loadHashStore();
		const a0r = await serveAll(r, C0);
		updateAnchorsAfterEdit({
			path: r,
			oldContent: C0,
			newContent: C1,
			oldAnchors: a0r,
			hunks: [hunkLine5()],
		});
		// Another process moves the shared state to C2 with its own allocation.
		// There is no cache to invalidate: the rows ARE the state.
		const foreignAnchors = assignAnchors(splitLines(C2));
		plantAnchorState(
			tmpHome,
			r,
			contentChecksum(C2),
			foreignAnchors,
			splitLines(C2).map(contentKey),
		);
		expect(anchorsFor(r, C2)).toEqual(foreignAnchors);
	});

	it("a partially-served state is legal — survivors keep their anchors, gaps stay unallocated", async () => {
		const s = "/proj/partial.ts";
		await loadHashStore();
		const p0 = await serveAll(s, C0);
		// Only lines 1..4 were ever served: the sparse shape, legal, not corruption.
		plantAnchorState(
			tmpHome,
			s,
			contentChecksum(C0),
			p0.slice(0, 4),
			splitLines(C0).map(contentKey),
		);
		await touchOtherPaths("/flood-partial");
		const view = anchorsFor(s, C0);
		expect(view.slice(0, 4)).toEqual(p0.slice(0, 4)); // survivors keep theirs
		expect(view.slice(4).every((a) => a === "")).toBe(true); // gaps unallocated
		const served = await serveAll(s, C0);
		expect(served.slice(0, 4)).toEqual(p0.slice(0, 4)); // still stable after serving
	});

	it("a persisted state with duplicate anchors keeps every row except the duplicate", async () => {
		// The allocator invariant holds at every write; a row that violates it
		// (external corruption / legacy dirt) must be repaired at the entry gate,
		// not handed to the served layer where duplicates become E_SERVED_DUP noise.
		//
		// The repair is LOCAL: dropping the file's whole state would turn one bad
		// row into `[E_STALE]` for every anchor the session legitimately holds —
		// reported from a live session as "an anchor I just read no longer exists".
		const s = "/proj/dup-state.ts";
		await loadHashStore();
		const p0 = await serveAll(s, C0);
		// Plant a row whose anchors repeat p0[0] at position 2:
		plantAnchorState(
			tmpHome,
			s,
			contentChecksum(C0),
			[p0[0]!, p0[1]!, p0[0]!, ...p0.slice(3)],
			splitLines(C0).map(contentKey),
		);
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		// The heal lives on the state-entry gate, i.e. the allocate path.
		const view = await serveAll(s, C0);
		const healedLoud = errSpy.mock.calls.length > 0;
		const message = String(errSpy.mock.calls[0]?.[0] ?? "");
		errSpy.mockRestore();
		// Unique again — and, crucially, the SURVIVORS are the very anchors the
		// session already holds: line 2 keeps p0[1] instead of being re-minted,
		// and the duplicate at line 3 is the only casualty.
		expect(new Set(view).size).toBe(view.length);
		expect(view[0]).toBe(p0[0]);
		expect(view[1]).toBe(p0[1]);
		expect(view.slice(3)).toEqual(p0.slice(3));
		expect(healedLoud).toBe(true);
		expect(message).toContain("dropped 1 duplicate row");
		// The repaired projection is what the next process loads.
		await touchOtherPaths("/flood-dup-again");
		expect(anchorsFor(s, C0)[1]).toBe(p0[1]);
	});

	it("undo needs no seed — the realign self-corrects on the reverted content", async () => {
		const t = "/proj/undo-lazy.ts";
		await loadHashStore();
		const a0 = await serveAll(t, C0);
		const a1 = updateAnchorsAfterEdit({
			path: t,
			oldContent: C0,
			newContent: C1,
			oldAnchors: a0,
			hunks: [hunkLine5()],
		});
		expect(a1[4]).not.toBe(a0[4]); // the edited line re-anchored
		// The revert: the file goes back to C0. No seed — the next serve realigns
		// against the reverted content and hands back stable anchors.
		await touchOtherPaths("/flood-undo");
		const a2 = await serveAll(t, C0);
		for (let i = 0; i < a2.length; i++) {
			if (i === 4) continue;
			expect(a2[i]).toBe(a0[i]); // unchanged lines keep their anchors
		}
		expect(a2[4]).not.toBe(a1[4]); // the reverted line is not the edit's anchor
	});

	it("anchor rows are pruned when the file no longer exists", async () => {
		const gone = "/gone/no-such-file.ts";
		await loadHashStore();
		await serveAll(gone, C0);
		expect(countAnchorRows(tmpHome, gone)).toBe(splitLines(C0).length); // one row per SERVED line
		const store = await loadHashStore();
		await store.pruneMissing();
		expect(countAnchorRows(tmpHome, gone)).toBe(0);
	});

	it("anchor states older than the TTL are swept on store open", async () => {
		const old = "/proj/ttl-old.ts";
		const fresh = "/proj/ttl-fresh.ts";
		await loadHashStore();
		await serveAll(old, C0);
		await serveAll(fresh, C0);
		// Age one row past the TTL directly, then reopen (the sweep runs on open).
		shutdownHashStore();
		{
			const db = new DatabaseSync(sqlitePath(tmpHome), { defensive: false } as any);
			db.prepare("UPDATE anchor_meta SET updated_at = ? WHERE path = ?").run(
				Date.now() - 31 * 24 * 60 * 60 * 1000,
				old,
			);
			db.prepare("UPDATE anchor_lines SET updated_at = ? WHERE path = ?").run(
				Date.now() - 31 * 24 * 60 * 60 * 1000,
				old,
			);
			db.close();
		}
		await loadHashStore();
		expect(countAnchorRows(tmpHome, old)).toBe(0);
		expect(countAnchorRows(tmpHome, fresh)).toBe(splitLines(C0).length);
	});
});
