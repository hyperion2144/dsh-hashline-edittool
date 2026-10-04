/**
 * The anchor ENTRY POINT (contract §9, #223).
 *
 * `anchorFor` and `probeLines` are the only two ways anchor state may be
 * touched, so this file is where the contract's invariants are pinned at their
 * own seam — no tool, no rendering, just the primitives:
 *
 *  1. uniqueness      — one anchor never names two lines (#217's root defect);
 *  2. remap keeps identity — an unchanged line keeps its anchor across a shift;
 *  3. only returned lines are allocated;
 *  4. release is three-way — out of `anchor_lines`, out of the RELEASING
 *     session's served set, and into this call's pool;
 *  5. no reissue within a call;
 *  6. what comes out is usable — a fresh anchor passes `probeLines` at once;
 *  7. a refusal is self-describing — `rows` names the anchor that IS there.
 *
 * Plus the property the whole design exists for: the file checksum is NOT a
 * rejection condition. Another session moving another line must not make my
 * line uneditable.
 *
 * @module dsh-hashline-edittool/test/core/anchor-entry-invariants
 */
import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
	anchorFor,
	clearReleasePool,
	markReleased,
	probeLines,
	releaseLines,
	releasePoolFor,
} from "../../src/domain/session/anchor-entry.js";
import type { AnchorRef } from "../../src/domain/session/anchor-entry.js";
import { contentChecksum } from "../../src/hashline/hash-assign.js";
import { persistedAnchorChecksum } from "../../src/domain/session/anchor-state.js";
import { loadHashStore, shutdownHashStore } from "../../src/domain/session/hash-store.js";
import { loadServed, openWorkspaceStore } from "../../src/domain/session/session-view.js";
import { withWorkspace } from "../../src/infra/workspace.js";
import { withTempDir } from "../support/fixtures.js";

/** `n` distinct lines, 1-based, no trailing newline surprises. */
function lines(tag: string, n: number, from = 0): string {
	return Array.from({ length: n }, (_, i) => `${tag}-${from + i}`).join("\n");
}

/**
 * Open the workspace store, then call the entry point — the order every tool
 * uses (`openWorkspaceStore` runs before any serve).
 *
 * Not a convenience: the anchor port writes ONLY to an already-open store, so
 * a primitive exercised without this persists nothing and passes on the
 * in-memory cache alone. That is exactly the trap `#171` found, and it makes a
 * test that skips this step verify a state nobody else can see.
 */
async function withStore<T>(dir: string, run: () => Promise<T>): Promise<T> {
	return withWorkspace(dir, async () => {
		await openWorkspaceStore(dir);
		return run();
	});
}

/** Every anchor currently live for a file, via a successful probe. */
async function liveAnchors(dir: string, path: string, content: string, session: string): Promise<string[]> {
	const probe = await withStore(dir, () =>
		probeLines({ path, content, refs: [], sessionKey: session }),
	);
	if (!probe.ok) throw new Error(`probe failed: ${probe.reason}`);
	return [...probe.mapped.keys()];
}

describe("anchorFor — allocation and reuse (#223 §2.1)", () => {
	it("invariant 3 — allocates ONLY for the lines it was asked for", async () => {
		await withTempDir("anchor-entry-1-", async (dir) => {
			const path = join(dir, "a.ts");
			const content = lines("l", 10);
			await writeFile(path, content, "utf8");

			const result = await withStore(dir, () =>
				anchorFor({ path, content, lines: [2, 5, 9], sessionKey: "s1" }),
			);

			expect(result.anchors).toHaveLength(3);
			expect(result.anchors.every((a) => a.length > 0)).toBe(true);
			// Invariant 3: the lines nobody asked for have no anchor at all.
			const live = await liveAnchors(dir, path, content, "s1");
			expect(live.sort()).toEqual([...result.anchors].sort());
		});
	});

	it("gives a line outside the file an empty anchor instead of inventing one", async () => {
		await withTempDir("anchor-entry-2-", async (dir) => {
			const path = join(dir, "a.ts");
			const content = lines("l", 3);
			await writeFile(path, content, "utf8");

			const result = await withStore(dir, () =>
				anchorFor({ path, content, lines: [1, 99], sessionKey: "s1" }),
			);
			expect(result.anchors[0]).not.toBe("");
			expect(result.anchors[1]).toBe("");
		});
	});

	it("reuses the anchor of an unchanged line on a later call", async () => {
		await withTempDir("anchor-entry-3-", async (dir) => {
			const path = join(dir, "a.ts");
			const content = lines("l", 6);
			await writeFile(path, content, "utf8");

			const first = await withStore(dir, () =>
				anchorFor({ path, content, lines: [1, 2, 3], sessionKey: "s1" }),
			);
			const second = await withStore(dir, () =>
				anchorFor({ path, content, lines: [1, 2, 3], sessionKey: "s1" }),
			);

			expect(second.anchors).toEqual(first.anchors);
			// Nothing was minted the second time: reuse is not re-allocation.
			expect(second.minted).toEqual([]);
		});
	});

	it("mints distinct anchors for two lines that share their content", async () => {
		await withTempDir("anchor-entry-4-", async (dir) => {
			const path = join(dir, "dup.ts");
			const content = ["same", "same", "same"].join("\n");
			await writeFile(path, content, "utf8");

			const result = await withStore(dir, () =>
				anchorFor({ path, content, lines: [1, 2, 3], sessionKey: "s1" }),
			);

			// Invariant 1: three identical lines must still get three identities,
			// otherwise "the anchor names the line" collapses.
			expect(new Set(result.anchors).size).toBe(3);
		});
	});

	it("serves the anchors it mints, so they are usable immediately", async () => {
		await withTempDir("anchor-entry-5-", async (dir) => {
			const path = join(dir, "a.ts");
			const content = lines("l", 4);
			await writeFile(path, content, "utf8");

			const { anchors } = await withStore(dir, () =>
				anchorFor({ path, content, lines: [1, 4], sessionKey: "s1" }),
			);

			// Invariant 6.
			const probe = await withStore(dir, () =>
				probeLines({
					path,
					content,
					refs: anchors.map((anchor) => ({ anchor })),
					sessionKey: "s1",
				}),
			);
			expect(probe.ok).toBe(true);
			if (probe.ok) {
				expect(probe.resolved.map((r) => r.line)).toEqual([1, 4]);
			}
		});
	});
});

describe("anchorFor — remap keeps identity (#223 §5, invariant 2)", () => {
	it("keeps an unchanged line's anchor across an insertion above it", async () => {
		await withTempDir("anchor-entry-remap-", async (dir) => {
			const path = join(dir, "a.ts");
			const before = lines("l", 6);
			await writeFile(path, before, "utf8");

			const first = await withStore(dir, () =>
				anchorFor({ path, content: before, lines: [4, 5], sessionKey: "s1" }),
			);

			// Someone (another session, or an external tool) inserts two lines at
			// the top. The file now hashes differently — which is a REMAP signal,
			// not a reason to re-mint.
			const after = `x-1\nx-2\n${before}`;
			await writeFile(path, after, "utf8");
			shutdownHashStore(); // drop the in-process cache: force the persisted path

			const second = await withStore(dir, () =>
				anchorFor({ path, content: after, lines: [6, 7], sessionKey: "s1" }),
			);

			expect(second.anchors).toEqual(first.anchors);
			expect(second.minted).toEqual([]);
		});
	});

	it("re-mints a line whose content actually changed", async () => {
		await withTempDir("anchor-entry-remap2-", async (dir) => {
			const path = join(dir, "a.ts");
			const before = lines("l", 4);
			await writeFile(path, before, "utf8");

			const first = await withStore(dir, () =>
				anchorFor({ path, content: before, lines: [2], sessionKey: "s1" }),
			);

			const after = before.replace("l-1", "l-1 CHANGED");
			await writeFile(path, after, "utf8");
			shutdownHashStore();

			const second = await withStore(dir, () =>
				anchorFor({ path, content: after, lines: [2], sessionKey: "s1" }),
			);

			expect(second.anchors[0]).not.toBe(first.anchors[0]);
			expect(second.minted).toHaveLength(1);
		});
	});
});

describe("probeLines — the three conditions, and the checksum that is NOT one (#223 §2.2)", () => {
	it("accepts an anchor this session was served", async () => {
		await withTempDir("probe-1-", async (dir) => {
			const path = join(dir, "a.ts");
			const content = lines("l", 5);
			await writeFile(path, content, "utf8");
			const { anchors } = await withStore(dir, () =>
				anchorFor({ path, content, lines: [3], sessionKey: "s1" }),
			);

			const probe = await withStore(dir, () =>
				probeLines({ path, content, refs: [{ anchor: anchors[0]!, line: 3 }], sessionKey: "s1" }),
			);
			expect(probe.ok).toBe(true);
		});
	});

	it("refuses an anchor another session was served", async () => {
		await withTempDir("probe-2-", async (dir) => {
			const path = join(dir, "a.ts");
			const content = lines("l", 5);
			await writeFile(path, content, "utf8");
			const { anchors } = await withStore(dir, () =>
				anchorFor({ path, content, lines: [3], sessionKey: "SESSION_A" }),
			);

			// Cross-session: anchors are SHARED, served state is not.
			const probe = await withStore(dir, () =>
				probeLines({
					path,
					content,
					refs: [{ anchor: anchors[0]!, line: 3 }],
					sessionKey: "SESSION_B",
				}),
			);
			expect(probe.ok).toBe(false);
			if (!probe.ok) {
				expect(probe.reason).toBe("never-seen");
				expect(probe.rows[0]!.line).toBe(3);
				// Invariant 7: the refusal names the anchor that IS there.
				expect(probe.rows[0]!.current).toBe(anchors[0]);
			}
		});
	});

	it("refuses an anchor that is not live, and says so", async () => {
		await withTempDir("probe-3-", async (dir) => {
			const path = join(dir, "a.ts");
			const content = lines("l", 5);
			await writeFile(path, content, "utf8");

			const probe = await withStore(dir, () =>
				probeLines({
					path,
					content,
					refs: [{ anchor: "NotARealAnchor", line: 2 }],
					sessionKey: "s1",
				}),
			);
			expect(probe.ok).toBe(false);
			if (!probe.ok) {
				expect(probe.reason).toBe("not-live");
				expect(probe.rows[0]!.given).toBe("NotARealAnchor");
			}
		});
	});

	it("ignores a wrong line number when the anchor is right", async () => {
		await withTempDir("probe-4-", async (dir) => {
			const path = join(dir, "a.ts");
			const content = lines("l", 5);
			await writeFile(path, content, "utf8");
			const { anchors } = await withStore(dir, () =>
				anchorFor({ path, content, lines: [4], sessionKey: "s1" }),
			);

			// The model remembered line 1; the anchor says line 4. The anchor wins.
			const probe = await withStore(dir, () =>
				probeLines({ path, content, refs: [{ anchor: anchors[0]!, line: 1 }], sessionKey: "s1" }),
			);
			expect(probe.ok).toBe(true);
			if (probe.ok) expect(probe.resolved[0]!.line).toBe(4);
		});
	});

	it("does NOT refuse merely because the file changed elsewhere", async () => {
		await withTempDir("probe-5-", async (dir) => {
			const path = join(dir, "a.ts");
			const before = lines("l", 6);
			await writeFile(path, before, "utf8");
			const { anchors } = await withStore(dir, () =>
				anchorFor({ path, content: before, lines: [5], sessionKey: "s1" }),
			);
			const recorded = await withStore(dir, async () => persistedAnchorChecksum(path));

			// Another session edits line 1. Line 5's content is untouched, so the
			// model's anchor for it must keep working — the whole cross-session value
			// proposition (§5).
			const after = before.replace("l-0", "l-0 REWRITTEN");
			await writeFile(path, after, "utf8");
			shutdownHashStore();

			// The file genuinely differs from what was recorded. `persistedAnchorChecksum`
			// reports the STATE's checksum, which stays stale until something loads the
			// changed file — that staleness IS the remap trigger, and it never gates a
			// write, which the probe below demonstrates.
			expect(recorded).toBe(contentChecksum(before));
			expect(contentChecksum(after)).not.toBe(recorded);

			const probe = await withStore(dir, () =>
				probeLines({ path, content: after, refs: [{ anchor: anchors[0]!, line: 5 }], sessionKey: "s1" }),
			);
			expect(probe.ok).toBe(true);
			if (probe.ok) expect(probe.resolved[0]!.line).toBe(5);

			// §2.2: the probe is a PURE READ — "永不分配、永不落库". So the recorded
			// checksum has NOT moved: the verdict answered about the changed file
			// without rewriting anything, which is exactly what makes it safe to ask.
			const afterProbe = await withStore(dir, async () => persistedAnchorChecksum(path));
			expect(afterProbe).toBe(contentChecksum(before));

			// The REMAP is a write, so it belongs to the allocate path (§2.1 item 1).
			// Asking for an anchor over the changed file does it, and only then does
			// the recorded checksum move — "the checksum triggers a remap instead of a
			// refusal", with the write attributed to the call that owns writes.
			await withStore(dir, () =>
				anchorFor({ path, content: after, lines: [5], sessionKey: "s1" }),
			);
			const afterAllocate = await withStore(dir, async () => persistedAnchorChecksum(path));
			expect(afterAllocate).toBe(contentChecksum(after));
		});
	});

	it("fails the whole probe when any single ref fails", async () => {
		await withTempDir("probe-6-", async (dir) => {
			const path = join(dir, "a.ts");
			const content = lines("l", 5);
			await writeFile(path, content, "utf8");
			const { anchors } = await withStore(dir, () =>
				anchorFor({ path, content, lines: [1, 2], sessionKey: "s1" }),
			);

			const refs: AnchorRef[] = [
				{ anchor: anchors[0]!, line: 1 },
				{ anchor: "Bogus", line: 2 },
				{ anchor: anchors[1]!, line: 2 },
			];
			const probe = await withStore(dir, () =>
				probeLines({ path, content, refs, sessionKey: "s1" }),
			);
			expect(probe.ok).toBe(false);
			if (!probe.ok) expect(probe.rows).toHaveLength(1);
		});
	});
});

describe("the release pool (contract §4.1)", () => {
	it("keeps a released anchor away from any line for the rest of the call", async () => {
		await withTempDir("pool-1-", async (dir) => {
			const path = join(dir, "a.ts");
			const content = lines("l", 5);
			await writeFile(path, content, "utf8");
			const { anchors } = await withStore(dir, () =>
				anchorFor({ path, content, lines: [1], sessionKey: "s1" }),
			);
			const released = anchors[0]!;

			// The call releases line 1's anchor, then asks for a DIFFERENT line
			// whose content is identical — the anchor must not come back.
			markReleased(path, [released]);
			expect([...releasePoolFor(path)]).toContain(released);
			const sameContent = ["l-0", "l-0", "l-0", "l-0", "l-0"].join("\n");
			await writeFile(path, sameContent, "utf8");
			shutdownHashStore();

			const after = await withStore(dir, () =>
				anchorFor({ path, content: sameContent, lines: [3], sessionKey: "s1" }),
			);
			expect(after.anchors[0]).not.toBe(released);
		});
	});

	it("lets the next call use the anchor again, and starts clean", async () => {
		await withTempDir("pool-2-", async (dir) => {
			const path = join(dir, "a.ts");
			const content = lines("l", 3);
			await writeFile(path, content, "utf8");
			const { anchors } = await withStore(dir, () =>
				anchorFor({ path, content, lines: [1], sessionKey: "s1" }),
			);

			markReleased(path, [anchors[0]!]);
			clearReleasePool(path);
			// The pool is per-call state; after the call it must not linger.
			expect(releasePoolFor(path).size).toBe(0);
		});
	});

	it("scopes the pool per file, so one file's release cannot block another's", async () => {
		await withTempDir("pool-3-", async (dir) => {
			const a = join(dir, "a.ts");
			const b = join(dir, "b.ts");
			markReleased(a, ["Shared"]);
			expect(releasePoolFor(b).has("Shared")).toBe(false);
		});
	});
});

describe("uniqueness is enforced across calls, not just within one (#217 §1)", () => {
	it("never hands one anchor to two different lines", async () => {
		await withTempDir("uniq-1-", async (dir) => {
			const path = join(dir, "a.ts");
			const first = lines("l", 40);
			await writeFile(path, first, "utf8");

			// Serve a lot of lines, then shuffle the file underneath and serve
			// again — the shape that originally reissued a live anchor (#217).
			const a = await withStore(dir, () =>
				anchorFor({ path, content: first, lines: [...Array(20).keys()].map((i) => i + 1), sessionKey: "s1" }),
			);
			const second = [`m-0`, `m-1`, ...Array.from({ length: 38 }, (_, i) => `l-${i + 2}`)].join("\n");
			await writeFile(path, second, "utf8");
			shutdownHashStore();
			const b = await withStore(dir, () =>
				anchorFor({ path, content: second, lines: [...Array(20).keys()].map((i) => i + 1), sessionKey: "s2" }),
			);

			// Invariant 1 on the CURRENT file: every live anchor names exactly one
			// line. A reissue is precisely a collapse of this set.
			const live = await liveAnchors(dir, path, second, "s2");
			expect(new Set(live).size).toBe(live.length);
			// And the resolution agrees with the row it came from: probing every
			// live anchor yields one distinct line each.
			const probe = await withStore(dir, () =>
				probeLines({
					path,
					content: second,
					refs: live.map((anchor) => ({ anchor })),
					sessionKey: "s2",
				}),
			);
			expect(probe.ok).toBe(true);
			if (probe.ok) {
				const resolvedLines = probe.resolved.map((r) => r.line);
				expect(new Set(resolvedLines).size).toBe(resolvedLines.length);
			}
			// The first call's anchors split into exactly two groups, and the split is
			// the content rule, not luck: an anchor stays live iff its line's content
			// survived the shuffle (`l-2` onward did; `l-0`/`l-1` became `m-0`/`m-1`).
			const droppedFromA = a.anchors.filter((anchor) => anchor !== "" && !live.includes(anchor));
			expect(droppedFromA).toHaveLength(2);
			// Everything the SECOND call returned is live, and each live anchor is
			// still bound to the content it was minted for — which is what "the
			// anchor names the line" means once the file has moved underneath it.
			expect(b.anchors.filter((anchor) => anchor !== "" && !live.includes(anchor))).toEqual([]);
			const resolved = await withStore(dir, () =>
				probeLines({ path, content: second, refs: [{ anchor: b.anchors[2]!, line: 3 }], sessionKey: "s2" }),
			);
			expect(resolved.ok).toBe(true);
			if (resolved.ok) {
				// Line 3 of the shuffled file is `l-2`, the same content the anchor was
				// minted for, so the ANCHOR — not the reported number — decides.
				expect(resolved.resolved[0]!.line).toBe(3);
			}
		});
	});
});

describe("release is three-way (contract §4, invariant 4)", () => {
	it("leaves the anchor dead, unserved for the releaser, and pooled", async () => {
		await withTempDir("release-1-", async (dir) => {
			const path = join(dir, "a.ts");
			const content = lines("l", 5);
			await writeFile(path, content, "utf8");
			const { anchors } = await withStore(dir, () =>
				anchorFor({ path, content, lines: [2], sessionKey: "s1" }),
			);
			const doomed = anchors[0]!;
			// Before: live, served and usable.
			const before = await withStore(dir, () =>
				probeLines({ path, content, refs: [{ anchor: doomed, line: 2 }], sessionKey: "s1" }),
			);
			expect(before.ok).toBe(true);

			const released = await withStore(dir, () =>
				releaseLines({ path, lines: [2], content, sessionKey: "s1" }),
			);
			expect(released).toEqual([doomed]);

			// (1) no longer live — the refusal says so rather than accepting it.
			const after = await withStore(dir, () =>
				probeLines({ path, content, refs: [{ anchor: doomed, line: 2 }], sessionKey: "s1" }),
			);
			expect(after.ok).toBe(false);
			if (!after.ok) expect(after.reason).toBe("not-live");
			// (2) gone from the RELEASING session's served set…
			const served = await withStore(dir, async () => loadServed("s1", path));
			expect(served.has(doomed)).toBe(false);
			// (3) …and pooled for the rest of the call.
			expect([...releasePoolFor(path)]).toContain(doomed);
		});
	});

	it("does not touch another session's served record", async () => {
		await withTempDir("release-2-", async (dir) => {
			const path = join(dir, "a.ts");
			const content = lines("l", 4);
			await writeFile(path, content, "utf8");
			// Both sessions read the same line, so both hold the same anchor.
			await withStore(dir, () => anchorFor({ path, content, lines: [1], sessionKey: "A" }));
			const { anchors } = await withStore(dir, () =>
				anchorFor({ path, content, lines: [1], sessionKey: "B" }),
			);

			await withStore(dir, () => releaseLines({ path, lines: [1], content, sessionKey: "A" }));

			// B released nothing, so B's record is untouched. B's write is still
			// refused — but by condition 1 (the anchor is dead), never a served miss,
			// which is the distinction the reason codes carry.
			// Wrapped in the workspace scope on purpose: a bare `loadServed` resolves
			// the DEFAULT `$DSH_HOME` store, not this temp workspace's, and would
			// silently answer "nothing served".
			const servedB = await withStore(dir, async () => loadServed("B", path));
			expect(servedB.has(anchors[0]!)).toBe(true);
			const probeB = await withStore(dir, () =>
				probeLines({ path, content, refs: [{ anchor: anchors[0]!, line: 1 }], sessionKey: "B" }),
			);
			expect(probeB.ok).toBe(false);
			if (!probeB.ok) expect(probeB.reason).toBe("not-live");
		});
	});

	it("stops the call that released it from reissuing it", async () => {
		await withTempDir("release-3-", async (dir) => {
			const path = join(dir, "a.ts");
			const content = ["l-0", "l-0", "l-0", "l-0"].join("\n");
			await writeFile(path, content, "utf8");
			const { anchors } = await withStore(dir, () =>
				anchorFor({ path, content, lines: [1], sessionKey: "s1" }),
			);
			const doomed = anchors[0]!;
			await withStore(dir, () => releaseLines({ path, lines: [1], content, sessionKey: "s1" }));

			// Three lines carry byte-identical content, so every one of them is a
			// candidate for the freed anchor. None may get it.
			const again = await withStore(dir, () =>
				anchorFor({ path, content, lines: [2, 3, 4], sessionKey: "s1" }),
			);
			expect(again.anchors).not.toContain(doomed);
		});
	});
});

describe("the used-set is the FILE's rows ∪ this call's pool — no store-wide source", () => {
	// §2.1 item 3, corrected. Anchors are scoped to a file: two files may
	// legitimately carry the SAME anchor string, because an anchor is a handle
	// the model holds alongside a path, and nothing resolves one without one.
	//
	// The contract used to add a third source — "全库已分配锚点（兜底）" — which,
	// read as written, means every anchor in the store. That would forbid strings
	// that are perfectly valid in THIS file, and it would cost a full-table read
	// on every allocation. The two cases below pin both halves of the real rule:
	// same content in two files MAY share a string, while two lines of ONE file
	// may not. A store-wide source breaks the first; no source at all breaks the
	// second.
	it("lets two DIFFERENT files reuse the same anchor string", async () => {
		await withTempDir("used-set-scope-", async (dir) => {
			const a = join(dir, "a.ts");
			const b = join(dir, "b.ts");
			// Byte-identical files: with no store-wide source the allocator has the
			// same candidates in both, and the per-call cursor starts fresh, so the
			// anchors agree element for element.
			const content = lines("shared", 3);
			await writeFile(a, content, "utf8");
			await writeFile(b, content, "utf8");
			const first = await withStore(dir, () =>
				anchorFor({ path: a, content, lines: [1, 2, 3], sessionKey: "s1" }),
			);
			const second = await withStore(dir, () =>
				anchorFor({ path: b, content, lines: [1, 2, 3], sessionKey: "s1" }),
			);
			expect(first.anchors.every((anchor) => anchor !== "")).toBe(true);
			expect(second.anchors).toEqual(first.anchors);
		});
	});

	it("still refuses to hand one anchor to two lines of the SAME file", async () => {
		await withTempDir("used-set-unique-", async (dir) => {
			const path = join(dir, "dup.ts");
			// Four byte-identical lines: the file-scoped rule is what forces four
			// distinct anchors here, and it is the half a store-wide source would
			// NOT have fixed — so this case fails if the used-set is emptied.
			// Four BYTE-IDENTICAL lines — the `lines()` helper makes distinct ones.
			const content = ["same", "same", "same", "same"].join("\n");
			await writeFile(path, content, "utf8");
			const { anchors } = await withStore(dir, () =>
				anchorFor({ path, content, lines: [1, 2, 3, 4], sessionKey: "s1" }),
			);
			expect(anchors.every((anchor) => anchor !== "")).toBe(true);
			expect(new Set(anchors).size).toBe(4);
		});
	});
});

describe("invariant 7 — a refusal is SELF-CONSISTENT (#223 §9)", () => {
	// The refusal is the recovery path: whatever it puts in front of the model
	// has to be true of the file at that moment, or the model's next move — the
	// one the wording invites — is another refusal.
	it("reports the failing line's CURRENT anchor, and that marker is usable", async () => {
		await withTempDir("invariant-7-", async (dir) => {
			const path = join(dir, "a.ts");
			const content = lines("l", 6);
			await writeFile(path, content, "utf8");
			const { anchors } = await withStore(dir, () =>
				anchorFor({ path, content, lines: [1, 2, 3, 4, 5, 6], sessionKey: "s1" }),
			);
			const doomed = anchors[2]!;
			// The three-way release: dead, unserved for s1, pooled for this call.
			await withStore(dir, () => releaseLines({ path, lines: [3], content, sessionKey: "s1" }));

			const failed = await withStore(dir, () =>
				probeLines({ path, content, refs: [{ anchor: doomed, line: 3 }], sessionKey: "s1" }),
			);
			expect(failed.ok).toBe(false);
			if (failed.ok) return;
			expect(failed.reason).toBe("not-live");
			const row = failed.rows.find((candidate) => candidate.line === 3);
			expect(row).toBeDefined();
			// `current` is the honest answer for that line — nothing is live there any
			// more, so it must NOT repeat the released marker back as if it were.
			expect(row!.current).toBe("");
			expect(row!.given).toBe(doomed);

			// …and the marker the same session gets next IS usable by it: the recovery
			// the refusal exists to enable, with no re-read in between.
			const remint = await withStore(dir, () =>
				anchorFor({ path, content, lines: [3], sessionKey: "s1" }),
			);
			expect(remint.anchors[0]).not.toBe("");
			const retry = await withStore(dir, () =>
				probeLines({ path, content, refs: [{ anchor: remint.anchors[0]!, line: 3 }], sessionKey: "s1" }),
			);
			expect(retry.ok).toBe(true);
			if (retry.ok) expect(retry.resolved[0]!.line).toBe(3);
		});
	});
});

