/**
 * The delete-side LSP sync: `notifyDocumentClosed` must route through the
 * close hook, never warm a server, and never turn a successful delete into a
 * failure when the server misbehaves.
 * @module
 */
import { afterEach, describe, expect, it } from "vitest";
import { notifyDocumentClosed, setDocumentClosedHook } from "../../src/lsp/sync.js";

afterEach(() => {
	setDocumentClosedHook(undefined);
});

describe("notifyDocumentClosed", () => {
	it("routes the delete through the close hook", () => {
		const seen: string[] = [];
		setDocumentClosedHook((path) => seen.push(path));
		notifyDocumentClosed("/tmp/deleted.ts");
		expect(seen).toEqual(["/tmp/deleted.ts"]);
	});

	it("swallows a hook failure", () => {
		setDocumentClosedHook(() => {
			throw new Error("server gone");
		});
		expect(() => notifyDocumentClosed("/tmp/x.ts")).not.toThrow();
	});
});
