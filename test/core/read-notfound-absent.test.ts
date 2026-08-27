import { describe, expect, it } from "vitest";
import { buildReadTool } from "../../src/tool-read.js";
import { makeExec } from "../support/fixtures.js";

/**
 * Regression: a file read earlier in the session, then deleted externally,
 * used to deadlock — write demanded a re-read, read answered not-found, and
 * the policy's stale "present" observation was never cleared. A not-found
 * read must emit an ABSENT observation so a later write becomes
 * create-if-absent.
 */
describe("read of a deleted file emits an absent observation", () => {
	it("emits emitAbsent and rejects with not-found", async () => {
		const absentEmitted: string[] = [];
		const io = {
			resolve: async (p: string) => p,
			readText: async () => {
				throw Object.assign(new Error("File not found: gone.txt"), {
					code: "FS_NOT_FOUND",
				});
			},
			emitObserved: async () => {},
			emitAbsent: async (abs: string) => {
				absentEmitted.push(abs);
			},
			statVersion: async () => undefined,
		} as never;

		const tool = buildReadTool(io as never);
		const exec = makeExec("/tmp")("r");
		await expect(
			tool.execute({ path: "gone.txt" }, exec as never),
		).rejects.toThrow(/not found/i);
		expect(absentEmitted).toContain("gone.txt");
	});

	it("does not emit absent on a successful read", async () => {
		let absent = 0;
		const io = {
			resolve: async (p: string) => p,
			readText: async () => "line one\nline two\n",
			emitObserved: async () => {},
			emitAbsent: async () => {
				absent++;
			},
			statVersion: async () => undefined,
		} as never;
		const tool = buildReadTool(io as never);
		const exec = makeExec("/tmp")("r");
		const res = await tool.execute({ path: "ok.txt" }, exec as never);
		expect(res).toBeDefined();
		expect(absent).toBe(0);
	});
});