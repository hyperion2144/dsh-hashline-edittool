/**
 * Post-edit document sync. The link is small; what matters is that it fires
 * after a real write, that it never spawns a server, and that a misbehaving
 * server cannot turn a successful edit into a failed one.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runFileEdits, persistUndoAndWrite, type PreparedItem } from "../../src/edit-engine.js";
import { notifyDocumentWritten, setDocumentSyncHook } from "../../src/lsp/sync.js";
import { getLspManager, LspManager, setLspManager } from "../../src/lsp/manager.js";
import { encodeMessage, MessageReader } from "../../src/lsp/framing.js";
import type { LspTransport } from "../../src/lsp/session.js";
import { lineHashes } from "../../src/hashline/index.js";
import { recordServed } from "../../src/session-view.js";
import { splitLines } from "../../src/utils.js";
import { canon, contentChecksum } from "../../src/hashline/hash-assign.js";

const SOURCE = "export const alpha = 1;\nexport const beta = 2;\n";
let dir: string;
let file: string;
const sessionKey = "sync-session";

const io = {
	resolve: async (p: string) => p,
	readText: async (p: string) => readFileSync(p, "utf-8"),
	// The write path needs a real write; this test asserts the sync fires
	// AFTER content lands, so the stub must actually land it.
	writeText: async (p: string, content: string) => {
		await writeFile(p, content, "utf-8");
	},
} as never;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "lsp-sync-"));
	file = join(dir, "a.ts");
	await writeFile(file, SOURCE, "utf-8");
	setDocumentSyncHook(undefined);
});

afterEach(async () => {
	setDocumentSyncHook(undefined);
	setLspManager(undefined);
	await rm(dir, { recursive: true, force: true });
});

interface Notification {
	readonly method: string;
	readonly params: {
		readonly textDocument?: { readonly uri?: string; readonly version?: number };
		readonly contentChanges?: ReadonlyArray<{ readonly text?: string }>;
	};
}

/**
 * A manager whose typescript slot is genuinely ready.
 *
 * Driven through the real warm path (discovery → spawn → handshake) rather than
 * by poking the slot table, so this exercises the same route production takes.
 */
async function readyManager(): Promise<{ notifications: Notification[] }> {
	const outbound = new MessageReader();
	const notifications: Notification[] = [];
	let onData: ((chunk: Buffer) => void) | undefined;
	const transport: LspTransport = {
		write(bytes) {
			for (const message of outbound.push(bytes)) {
				const m = message as { id?: number; method?: string; params: Notification["params"] };
				if (m.method === undefined) continue;
				if (m.id !== undefined) {
					// A request: answer it so the handshake completes.
					queueMicrotask(() => onData?.(encodeMessage({ jsonrpc: "2.0", id: m.id, result: { capabilities: {} } })));
					continue;
				}
				notifications.push({ method: m.method, params: m.params });
			}
		},
		onData(listener) {
			onData = listener;
		},
		onExit() {},
		kill() {},
	};
	const manager = new LspManager({
		pathDirs: ["/bin"],
		isExecutable: async (p) => p === join("/bin", "typescript-language-server"),
		spawn: () => ({ transport }),
	});
	setLspManager(manager);
	manager.decide("typescript", dir, 10); // starts the warm
	// A microtask drain with room to spare, for the same reason and in the same
	// shape as `lsp-manager.test.ts`'s `settle`: the previous twenty-tick budget
	// was outnumbered the moment discovery grew a search location, because each
	// `await isExecutable` costs a tick. Microtasks and not timers, because a
	// sibling in this file runs under fake timers.
	for (let i = 0; i < 1000; i++) await Promise.resolve();
	expect(manager.readyLanguages).toEqual(["typescript"]);
	notifications.length = 0; // drop the handshake traffic
	return { notifications };
}

describe("the sync hook", () => {
	it("reaches the hook with the new content", () => {
		const seen: Array<[string, string]> = [];
		setDocumentSyncHook((path, text) => seen.push([path, text]));
		notifyDocumentWritten("/repo/a.ts", "new text");
		expect(seen).toEqual([["/repo/a.ts", "new text"]]);
	});

	it("swallows a hook failure so a good edit never becomes a failed one", () => {
		setDocumentSyncHook(() => {
			throw new Error("server exploded");
		});
		expect(() => notifyDocumentWritten("/repo/a.ts", "x")).not.toThrow();
	});

	it("is a no-op with no manager installed or an unknown language", () => {
		setLspManager(undefined);
		expect(() => notifyDocumentWritten("/repo/a.ts", "x")).not.toThrow();
		expect(() => notifyDocumentWritten("/repo/a.rb", "x")).not.toThrow();
	});
});

describe("open-or-change semantics", () => {
	it("returns undefined when no session is ready, so a write never warms one", async () => {
		const manager = new LspManager({
			pathDirs: [],
			isExecutable: async () => false,
			spawn: () => ({ transport: { write() {}, onData() {}, onExit() {}, kill() {} } }),
		});
		setLspManager(manager);
		const uri = pathToFileURL("/repo/a.ts").href;
		expect(manager.openDocumentFor("typescript", uri)).toBeUndefined();
		// And nothing was started: an edit must not spawn a language server.
		expect(manager.readyLanguages).toEqual([]);
	});

	it("opens on the first sync and changes on the next", async () => {
		const { notifications } = await readyManager();
		const uri = pathToFileURL("/repo/a.ts").href;
		const sync = getLspManager()!.openDocumentFor("typescript", uri);
		expect(sync).toBeDefined();
		sync!("const a = 1;");
		sync!("const a = 2;");
		expect(notifications.map((n) => n.method)).toEqual([
			"textDocument/didOpen",
			"textDocument/didChange",
		]);
		// Versions must increase: a server that sees the same version twice may
		// discard the second change as a duplicate.
		expect(notifications[1]!.params.textDocument?.version).toBe(2);
		expect(notifications[1]!.params.contentChanges?.[0]?.text).toBe("const a = 2;");
	});

	it("does not re-open a document the session already has", async () => {
		const { notifications } = await readyManager();
		const uri = pathToFileURL("/repo/a.ts").href;
		const sync = getLspManager()!.openDocumentFor("typescript", uri)!;
		sync("one");
		sync("two");
		sync("three");
		expect(notifications.filter((n) => n.method === "textDocument/didOpen")).toHaveLength(1);
	});
});

describe("the write path", () => {
	it("notifies with the new content after an edit lands on disk", async () => {
		const written: Array<[string, string]> = [];
		setDocumentSyncHook((path, text) => written.push([path, text]));
		const hashes = await lineHashes(SOURCE, file);
		const lines = splitLines(SOURCE);
		await recordServed(
			sessionKey,
			file,
			lines.map((line, index) => ({
				position: index,
				anchor: hashes[index] ?? "",
				contentKey: contentChecksum(canon(line)),
			})),
		);
		const item = {
			index: 0,
			path: file,
			absolutePath: file,
			remove_from: hashes[0] ?? "",
			remove_to: hashes[0] ?? "",
			replacement_text: "export const alpha = 9;",
			op: "replace",
			lineStart: 1,
		} as PreparedItem;
		const result = await runFileEdits(io, [item], { sessionKey });
		await persistUndoAndWrite({
			io,
			signal: undefined,
			files: [result],
			undoUnavailableMessage: () => "no undo",
			// The transaction maps a write failure through the sandbox; a stub
			// that rethrows is enough here, since nothing is expected to fail.
			sandbox: { mapError: (error: unknown) => error },
			sandboxPolicy: undefined,
		} as never);
		expect(await readFile(file, "utf-8")).toContain("alpha = 9");
		// The write happened AND the server was told; the second half is what
		// keeps its answers from drifting away from the file.
		expect(written).toHaveLength(1);
		expect(written[0]![0]).toBe(file);
		expect(written[0]![1]).toContain("alpha = 9");
	});
});
