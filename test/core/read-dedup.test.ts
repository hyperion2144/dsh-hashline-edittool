/**
 * #421 ④ — repeated full-file read deduplication.
 *
 * The gate is TWO facts that must hold together: the served mirror matches
 * the file line-for-line (the session saw these bindings), AND the context
 * generation has not moved since that serve (no compaction has rewritten the
 * model's history). Every unprovable case reads normally — the wrong dedup
 * hands the model "unchanged" while its context no longer holds the file,
 * which is strictly worse than a wasted re-read.
 *
 * Driven through `readAndServe` end-to-end: the first call serves and
 * records the generation, later calls exercise each gate condition.
 *
 * @module dsh-hashline-edittool/test/core/read-dedup
 */
import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { readAndServe } from "../../src/read-and-serve.js";
import { withTempDir, withHome } from "../support/fixtures.js";
import { shutdownHashStore } from "../../src/domain/session/hash-store.js";
import { localIO } from "../../src/infra/fs-bridge.js";

const CONTENT = Array.from({ length: 6 }, (_, i) => `line ${i + 1} alpha beta gamma`).join("\n") + "\n";

/** An exec whose runtime-augmented session reports the given generation. */
function execWithGeneration(generation: number): Parameters<typeof readAndServe>[3] extends never
	? never
	: { agent?: { session?: { surface?: { contentGeneration?: number } } } } & Record<string, unknown> {
	return { agent: { session: { surface: { contentGeneration: generation } } } } as never;
}

async function readOnce(
	cwd: string,
	path: string,
	sessionKey: string,
	generation: number | undefined,
	options: { offset?: number; limit?: number } = {},
) {
	const io = localIO();
	return readAndServe(io, path, cwd, {
		sessionKey,
		exec: generation === undefined ? undefined : (execWithGeneration(generation) as never),
		...options,
	});
}

/** Temp dir + temp DSH home (same shape the served-store tests use). */
async function withTempHome(prefix: string, run: (cwd: string) => Promise<void>): Promise<void> {
	await withTempDir(prefix, async (cwd) => {
		const restore = withHome(cwd);
		try {
			await run(cwd);
		} finally {
			restore();
			shutdownHashStore();
		}
	});
}
describe("read dedup (#421 ④)", () => {
	it("answers unchanged on the second identical full-file read", async () => {
		await withTempHome("dedup-hit-", async (cwd) => {
			const path = join(cwd, "f.ts");
			await writeFile(path, CONTENT, "utf8");

			const first = await readOnce(cwd, path, "s1", 7);
			expect(first.deduped).toBeUndefined();
			expect(first.served.length).toBe(6);

			const second = await readOnce(cwd, path, "s1", 7);
			expect(second.deduped).toBe(true);
			expect(second.text).toContain("Unchanged");
			expect(second.text).toContain("6 lines");
			// the anchors are untouched — the model can still edit with them
			expect(second.hashes?.length).toBe(6);
		});
	});

	it("reads normally after a compaction moved the context generation", async () => {
		await withTempHome("dedup-compaction-", async (cwd) => {
			const path = join(cwd, "f.ts");
			await writeFile(path, CONTENT, "utf8");
			await readOnce(cwd, path, "s2", 7);

			// generation 8: a surface replacement (compaction) happened between
			// the serve and this read — the mirror's testimony is void.
			const after = await readOnce(cwd, path, "s2", 8);
			expect(after.deduped).toBeUndefined();
			expect(after.text).toContain("line 1");
		});
	});

	it("reads normally without a generation signal (no live session)", async () => {
		await withTempHome("dedup-nosignal-", async (cwd) => {
			const path = join(cwd, "f.ts");
			await writeFile(path, CONTENT, "utf8");
			await readOnce(cwd, path, "s3", undefined);

			const again = await readOnce(cwd, path, "s3", undefined);
			expect(again.deduped).toBeUndefined();
			expect(again.text).toContain("line 1");
		});
	});

	it("reads normally for a partial window (offset/limit)", async () => {
		await withTempHome("dedup-window-", async (cwd) => {
			const path = join(cwd, "f.ts");
			await writeFile(path, CONTENT, "utf8");
			await readOnce(cwd, path, "s4", 7);

			const partial = await readOnce(cwd, path, "s4", 7, { offset: 2, limit: 3 });
			expect(partial.deduped).toBeUndefined();
			expect(partial.text).toContain("line 2");
		});
	});

	it("reads normally when the file changed after the serve (fingerprint mismatch)", async () => {
		await withTempHome("dedup-changed-", async (cwd) => {
			const path = join(cwd, "f.ts");
			await writeFile(path, CONTENT, "utf8");
			await readOnce(cwd, path, "s5", 7);

			await writeFile(path, CONTENT.replace("line 3", "line THREE EDITED"), "utf8");
			const after = await readOnce(cwd, path, "s5", 7);
			expect(after.deduped).toBeUndefined();
			expect(after.text).toContain("line THREE EDITED");
		});
	});
});
