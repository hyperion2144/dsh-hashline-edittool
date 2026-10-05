import { describe, expect, it, beforeAll } from "vitest";
import { readAndServe } from "../../src/read-and-serve.js";
import { localIO } from "../../src/infra/fs-bridge.js";
import {
	loadServed,
	markDriftReported,
	driftReported,
	sessionKeyFor,
} from "../../src/domain/session/session-view.js";
import { useNumberedRows, withTempFile } from "../support/fixtures.js";
// #244: the line-number switch belongs to the user now and defaults OFF; this
// file asserts numbered rows, so every test here pins it ON.
useNumberedRows();
import { withWorkspace } from "../../src/infra/workspace.js";

beforeAll(async () => {
});

describe("readAndServe", () => {
	it("renders hashline rows, records them as served, and clears drift marks", async () => {
		await withTempFile("a.txt", "one\ntwo\nthree\n", async ({ cwd, path }) => {
			const sessionKey = sessionKeyFor("session-1");
			await markDriftReported(sessionKey, path, ["abc", "def"]);

			const { text, absolutePath, hadUtf8DecodeErrors, served } =
				await readAndServe(localIO(), "a.txt", cwd, { sessionKey });

			expect(hadUtf8DecodeErrors).toBe(false);
			expect(absolutePath).toBe(path);
			expect(served).toHaveLength(3);

			expect(text).toMatch(/^ANCHOR:LINE[^\n]*\n/);
			const lines = text.split("\n");
			expect(lines[0]).toMatch(/^ANCHOR:LINE/);
			expect(lines[1]).toMatch(/^[A-Za-z0-9]{2,8}:\d+:\s*one$/);
			expect(lines[2]).toMatch(/^[A-Za-z0-9]{2,8}:\d+:\s*two$/);
			expect(lines[3]).toMatch(/^[A-Za-z0-9]{2,8}:\d+:\s*three$/);

			const stored = await withWorkspace(cwd, () => loadServed(sessionKey, path));
			expect(stored.size).toBe(3);
			expect([...stored].every((hash) => hash !== null)).toBe(true);
			expect(await withWorkspace(cwd, () => driftReported(sessionKey, path))).toEqual(new Set());
		});
	});

	it("respects offset and limit when serving rows", async () => {
		await withTempFile("b.txt", "one\ntwo\nthree\nfour\n", async ({ cwd, path }) => {
			const sessionKey = sessionKeyFor("session-2");

			const result = await readAndServe(localIO(), "b.txt", cwd, {
				sessionKey,
				offset: 2,
				limit: 2,
			});
			const { text } = result;

			const lines = text.split("\n");
			expect(lines[0]).toMatch(/^ANCHOR:LINE/);
			expect(lines[1]).toMatch(/^[A-Za-z0-9]{2,8}:\d+:\s*two$/);
			expect(lines[2]).toMatch(/^[A-Za-z0-9]{2,8}:\d+:\s*three$/);
			// #245: the renderer stops at the bound and reports it; the closing
			// "how to continue" sentence belongs to the tool layer.
			expect(text).not.toContain("[Showing lines");

			const stored = await withWorkspace(cwd, () => loadServed(sessionKey, path));
			expect([...stored].filter((hash) => hash !== null)).toHaveLength(2);
		});
	});
});
