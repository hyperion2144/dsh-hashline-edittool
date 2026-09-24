/**
 * Issue #136 — anchor state must be PERSISTED (per cwd + path in the sqlite
 * hash-store); a cache miss may never fall back to a full re-allocation.
 *
 * The field failure: `session-anchors` kept per-path anchor state in a memory
 * LRU (256 paths, no disk). Once a session touched more paths than the cap,
 * the file's state was evicted and the next `anchorsFor` re-ran
 * `assignAnchors` — handing DIFFERENT anchors to lines whose content never
 * changed. The served mirror still held the old anchors, so edits rejected
 * with `[E_RANGE_UNVERIFIED]` ("stale" / "never served") no matter how often
 * the echo re-served them.
 *
 * These tests pin the contract the fix introduces:
 *   1. eviction / restart recovers the state from sqlite (never recomputes);
 *   2. external changes diff-inherit against the PERSISTED state;
 *   3. a state allocated before the store opened is flushed to sqlite once
 *      the store exists (write-behind, at most once per path);
 *   4. a concurrent writer's persisted state invalidates this process's cache;
 *   5. a poisoned stored state heals positionally (keep what exists, allocate
 *      the gaps) instead of recomputing;
 *   6. the anchor_state row family participates in pruning + TTL sweep.
 *
 * @module dsh-hashline-edittool/anchor-state-persistence
 */
import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

import {
	anchorsFor,
	allocateForLines,
	updateAnchorsAfterEdit,
	ANCHOR_CACHE_LIMIT,
} from "../../src/hashline/session-anchors.js";
import { loadHashStore, shutdownHashStore } from "../../src/domain/session/hash-store.js";
import { contentChecksum } from "../../src/hashline/hash-assign.js";
import { assignAnchors, contentKey } from "../../src/hashline/alloc.js";
import { splitLines } from "../../src/infra/utils.js";
import { getWritableTempRoot } from "../support/fixtures.js";

let tmpHome: string;
beforeAll(async () => {
	tmpHome = await mkdtemp(
		join(await getWritableTempRoot(), "pi-hashline-anchor-state-test-"),
	);
	vi.stubEnv("HOME", tmpHome);
	vi.stubEnv("USERPROFILE", tmpHome);
	// Point the harness home at the TEMP home explicitly — see the note in
	// snapshot-store.test.ts: an EMPTY stub leans on `homedir()/.dsh`, which is
	// a different directory on Windows (`os.homedir()` reads USERPROFILE).
	vi.stubEnv("DSH_HOME", join(tmpHome, ".dsh"));
	vi.stubEnv("XDG_CONFIG_HOME", "");
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

/** Touch enough distinct paths that ANY earlier path is evicted: two full
 *  cache generations, so even a path cached right before the flood is gone. */
function floodCache(prefix: string): void {
	for (let i = 0; i <= ANCHOR_CACHE_LIMIT * 2 + 1; i++) {
		anchorsFor(`${prefix}-${i}.txt`, "evict\nme\n");
	}
}

function configHome(home: string): string {
	return join(home, ".dsh", "plugins", "dsh-hashline-edittool");
}

function sqlitePath(home: string): string {
	return join(configHome(home), "hash-store.sqlite");
}

/** Serve every line — the read path's allocation step (LAZY #169). */
function serveAll(path: string, content: string): string[] {
	return allocateForLines(
		path, content,
		Array.from({ length: splitLines(content).length }, (_, i) => i + 1),
	);
}

/** Simulate ANOTHER process writing the sparse anchor rows directly. */
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
	it("eviction falls back to the persisted state — unchanged lines keep their anchors", async () => {
		await loadHashStore();
		const p = "/proj/evict.ts";
		const a0 = serveAll(p, C0);
		const a1 = updateAnchorsAfterEdit({
			path: p,
			oldContent: C0,
			newContent: C1,
			oldAnchors: a0,
			hunks: [hunkLine5()],
		});
		expect(a1[4]).not.toBe(a0[4]); // the edited line re-anchors
		expect(a1[0]).toBe(a0[0]); // untouched lines keep theirs

		floodCache("/flood-evict"); // the old bug: eviction → full recompute
		expect(anchorsFor(p, C1)).toEqual(a1);
	});

	it("a store reopen (process restart) recovers anchors from sqlite", async () => {
		const p = "/proj/restart.ts";
		await loadHashStore();
		const a0 = serveAll(p, C0);
		const a1 = updateAnchorsAfterEdit({
			path: p,
			oldContent: C0,
			newContent: C1,
			oldAnchors: a0,
			hunks: [hunkLine5()],
		});
		shutdownHashStore();
		await loadHashStore();
		floodCache("/flood-restart");
		expect(anchorsFor(p, C1)).toEqual(a1);
	});

	it("external change after eviction inherits by diff against the persisted state", async () => {
		const p = "/proj/external.ts";
		await loadHashStore();
		const a0 = serveAll(p, C0);
		const a1 = updateAnchorsAfterEdit({
			path: p,
			oldContent: C0,
			newContent: C1,
			oldAnchors: a0,
			hunks: [hunkLine5()],
		});
		floodCache("/flood-external");
		const a2 = anchorsFor(p, C2); // line 9 changed externally after the eviction
		expect(a2.length).toBe(splitLines(C2).length);
		for (let i = 0; i < a2.length; i++) {
			if (i === 8) continue;
			expect(a2[i]).toBe(a1[i]); // every unchanged line keeps its anchor
		}
		expect(a2[8]).not.toBe(a1[8]); // only the changed line re-anchors
	});

	it("a state allocated before the store opened is flushed once the store exists", async () => {
		const q = "/proj/late-open.ts";
		// No store open in this workspace yet: first serve is memory-only.
		const b0 = serveAll(q, C0);
		const b1 = updateAnchorsAfterEdit({
			path: q,
			oldContent: C0,
			newContent: C1,
			oldAnchors: b0,
			hunks: [hunkLine5()],
		});
		await loadHashStore();
		anchorsFor(q, C1); // probe miss → flush the memory state to sqlite
		floodCache("/flood-late");
		expect(anchorsFor(q, C1)).toEqual(b1);
	});

	it("a concurrent writer's persisted state invalidates this process's cache", async () => {
		const r = "/proj/shared.ts";
		await loadHashStore();
		const a0r = serveAll(r, C0);
		updateAnchorsAfterEdit({
			path: r,
			oldContent: C0,
			newContent: C1,
			oldAnchors: a0r,
			hunks: [hunkLine5()],
		});
		// Another process moves the shared state to C2 with its own allocation:
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
		const p0 = serveAll(s, C0);
		// Simulate a state where only lines 1..4 were ever served (the sparse
		// analog of the old partial-write shape — legal now, not corruption):
		plantAnchorState(
			tmpHome,
			s,
			contentChecksum(C0),
			p0.slice(0, 4),
			splitLines(C0).map(contentKey),
		);
		floodCache("/flood-partial");
		const view = anchorsFor(s, C0);
		expect(view.slice(0, 4)).toEqual(p0.slice(0, 4)); // survivors keep theirs
		expect(view.slice(4).every((a) => a === "")).toBe(true); // gaps unallocated
		const served = serveAll(s, C0);
		expect(served.slice(0, 4)).toEqual(p0.slice(0, 4)); // still stable after serving
	});

	it("a persisted state with duplicate anchors is healed, never trusted", async () => {
		// The allocator invariant holds at every write; a row that violates it
		// (external corruption / legacy dirt) must be repaired at the entry gate,
		// not handed to the served layer where duplicates become E_SERVED_DUP noise.
		const s = "/proj/dup-state.ts";
		await loadHashStore();
		const p0 = serveAll(s, C0);
		// Plant a row whose anchors repeat p0[0] at position 2:
		plantAnchorState(
			tmpHome,
			s,
			contentChecksum(C0),
			[p0[0]!, p0[1]!, p0[0]!, ...p0.slice(3)],
			splitLines(C0).map(contentKey),
		);
		floodCache("/flood-dup");
		const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const healed = serveAll(s, C0);
		const healedLoud = errSpy.mock.calls.length > 0;
		errSpy.mockRestore();
		expect(new Set(healed).size).toBe(healed.length); // unique again (wiped + fresh)
		expect(healedLoud).toBe(true);
	});

	it("undo needs no seed — the lazy state self-corrects on the reverted content", async () => {
		const t = "/proj/undo-lazy.ts";
		await loadHashStore();
		const a0 = serveAll(t, C0);
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
		floodCache("/flood-undo");
		const a2 = serveAll(t, C0);
		for (let i = 0; i < a2.length; i++) {
			if (i === 4) continue;
			expect(a2[i]).toBe(a0[i]); // unchanged lines keep their anchors
		}
		expect(a2[4]).not.toBe(a1[4]); // the reverted line is not the edit's anchor
	});

	it("anchor rows are pruned when the file no longer exists", async () => {
		const gone = "/gone/no-such-file.ts";
		await loadHashStore();
		serveAll(gone, C0);
		expect(countAnchorRows(tmpHome, gone)).toBe(splitLines(C0).length); // one row per SERVED line
		const store = await loadHashStore();
		await store.pruneMissing();
		expect(countAnchorRows(tmpHome, gone)).toBe(0);
	});

	it("anchor states older than the TTL are swept on store open", async () => {
		const old = "/proj/ttl-old.ts";
		const fresh = "/proj/ttl-fresh.ts";
		await loadHashStore();
		serveAll(old, C0);
		serveAll(fresh, C0);
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
