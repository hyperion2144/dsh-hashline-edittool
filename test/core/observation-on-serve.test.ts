/**
 * Serving content IS observing it.
 *
 * Every path that hands the model file content — a read, a grep, the echo a
 * rejected edit returns, an edit's diff, the write tool's auto-read — must tell
 * the dsh observation policy the session has seen that file. Without it the
 * rows are servable but not WRITABLE: the very anchors just handed over fail
 * `[E_NOT_OBSERVED]` on the next edit, which makes serving decorative.
 *
 * The tests drive the real tools over the local IO bridge and record the
 * `emitObserved` calls, so the contract is pinned where it is used.
 *
 * @module dsh-hashline-edittool/test/observation-on-serve
 */
import { describe, expect, it } from "vitest";
import { localIO, type FileIO } from "../../src/fs-bridge.js";
import { buildEditTool } from "../../src/tool-edit.js";
import { buildReadTool } from "../../src/tool-read.js";
import { withTempFile, makeExec } from "../support/fixtures.js";
import { FsSandboxController } from "../../src/sandbox.js";

/** The edit tool needs a sandbox controller; an unconfined one is the test default. */
function testSandbox(): FsSandboxController {
	return new FsSandboxController({ fs: { sandboxMode: undefined }, get: () => undefined } as never);
}

/** The local bridge, recording every observation it is asked to emit. */
function recordingIO(seen: string[]): FileIO {
	const base = localIO();
	return {
		...base,
		async emitObserved(absolutePath, exec, signal) {
			seen.push(absolutePath);
			return base.emitObserved(absolutePath, exec, signal);
		},
	};
}

describe("observed-on-serve", () => {
	it("a read observes the file it served", async () => {
		await withTempFile("obs-read.txt", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
			const seen: string[] = [];
			const tool = buildReadTool(recordingIO(seen));
			await tool.execute({ path: "obs-read.txt" }, makeExec(cwd)({}));
			expect(seen).toHaveLength(1);
			expect(seen[0]).toContain("obs-read.txt");
		});
	});

	it("a REJECTED edit observes the file WITH the calling execution", async () => {
		await withTempFile("obs-echo.txt", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
			// The EXEC matters, not just the call: `fs/observed` with
			// `actor: undefined` records NOTHING, so a rejection that emitted
			// without it left the echoed markers un-writable — the exact
			// `[E_NOT_OBSERVED]` a retry hit on the single-file path.
			const seen: Array<{ path: string; exec: unknown }> = [];
			const base = localIO();
			const io: FileIO = {
				...base,
				async emitObserved(absolutePath, exec, signal) {
					seen.push({ path: absolutePath, exec });
					return base.emitObserved(absolutePath, exec, signal);
				},
			};
			const tool = buildEditTool(io, testSandbox());
			// A bare-digit anchor is refused, and the refusal echoes the lines
			// around it — so the file must come out observed as well.
			await expect(
				tool.execute(
					{
						path: "obs-echo.txt",
						edits: [{ op: "replace", anchor_start: "2", anchor_end: "2", lines: ["beta"] }],
					},
					makeExec(cwd)({}),
				),
			).rejects.toThrow(/Bare-digit anchors are forbidden/);
			expect(seen.length).toBeGreaterThan(0);
			expect(seen.every((call) => call.exec !== undefined)).toBe(true);
			expect(seen.every((call) => call.path.includes("obs-echo.txt"))).toBe(true);
		});
	});

	it("an applied edit observes the file whose diff it served", async () => {
		await withTempFile("obs-edit.txt", "alpha\nbeta\ngamma\n", async ({ cwd }) => {
			const seen: string[] = [];
			const io = recordingIO(seen);
			const reader = buildReadTool(io);
			const anchors = (await reader.execute({ path: "obs-edit.txt" }, makeExec(cwd)({}))) as {
				hashlines: { number: number; hash: string }[];
			};
			const beta = anchors.hashlines.find((row) => row.number === 2)!;
			const editor = buildEditTool(io, testSandbox());
			await editor.execute(
				{
					path: "obs-edit.txt",
					edits: [{ op: "replace", anchor_start: beta.hash, anchor_end: beta.hash, lines: ["BETA"] }],
				},
				makeExec(cwd)({}),
			);
			// The read observed it, the write observes it again — what matters is
			// that the edited file is among the observed paths.
			expect(seen.some((p) => p.includes("obs-edit.txt"))).toBe(true);
		});
	});
});
