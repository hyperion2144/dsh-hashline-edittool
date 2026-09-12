/**
 * The `ctx.lsp` provider we register.
 *
 * The seam is a closed union with no escape hatch, so the two things that can
 * silently go wrong are the ones tested: references must always ask for
 * declarations (the seam gives callers no flag), and the workspace URI must be
 * the provider's canonical one rather than the request root.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildProvider, extensionToLanguage, PROVIDER_ID, registerLspProvider } from "../../src/lsp/provider.js";
import { LspSession, type LspTransport } from "../../src/lsp/session.js";
import { encodeMessage, MessageReader } from "../../src/lsp/framing.js";

let dir: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "lsp-provider-"));
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

/** A ready session whose server answers with `reply` and records requests. */
async function readySession(reply: unknown): Promise<{ session: LspSession; requests: Array<{ method: string; params: never }> }> {
	const outbound = new MessageReader();
	const requests: Array<{ method: string; params: never }> = [];
	let onData: ((chunk: Buffer) => void) | undefined;
	const transport: LspTransport = {
		write(bytes) {
			for (const message of outbound.push(bytes)) {
				const m = message as { id?: number; method?: string; params: never };
				if (m.method === undefined) continue;
				requests.push({ method: m.method, params: m.params });
				if (m.id !== undefined) {
					const result = m.method === "initialize" ? { capabilities: {} } : reply;
					queueMicrotask(() => onData?.(encodeMessage({ jsonrpc: "2.0", id: m.id, result })));
				}
			}
		},
		onData(listener) {
			onData = listener;
		},
		onExit() {},
		kill() {},
	};
	const session = new LspSession(transport, { requestTimeoutMs: 200 });
	await session.initialize(dir);
	requests.length = 0;
	return { session, requests };
}

function providerFor(session: LspSession | undefined) {
	return buildProvider(() => session);
}

describe("the extension map", () => {
	it("covers every built-in language's extensions", () => {
		const map = extensionToLanguage();
		expect(map[".ts"]).toBe("typescript");
		expect(map[".tsx"]).toBe("tsx");
		expect(map[".js"]).toBe("javascript");
		expect(map[".py"]).toBe("python");
	});

	it("uses lowercase leading-dot keys, as the seam requires", () => {
		for (const key of Object.keys(extensionToLanguage())) {
			expect(key).toMatch(/^\.[a-z0-9]+$/);
		}
	});
});

describe("locations operations", () => {
	it("normalizes a location array", async () => {
		const uri = pathToFileURL(join(dir, "a.ts")).href;
		const { session } = await readySession([{ uri, range: { start: { line: 3 } } }]);
		const result = await providerFor(session).query({
			operation: "goToDefinition",
			filePath: join(dir, "a.ts"),
			position: { line: 0, character: 5 },
			workspaceRoot: dir,
			languageId: "typescript",
		});
		expect(result.kind).toBe("locations");
		if (result.kind !== "locations") return;
		expect(result.locations).toEqual([{ uri, range: { start: { line: 3 } } }]);
	});

	it("normalizes a locationLink (targetUri), which some servers return", async () => {
		const uri = pathToFileURL(join(dir, "b.ts")).href;
		const { session } = await readySession([{ targetUri: uri, targetSelectionRange: { start: { line: 7 } } }]);
		const result = await providerFor(session).query({
			operation: "goToImplementation",
			filePath: join(dir, "a.ts"),
			position: { line: 1, character: 2 },
			workspaceRoot: dir,
			languageId: "typescript",
		});
		expect(result.kind).toBe("locations");
		if (result.kind !== "locations") return;
		expect(result.locations[0]!.uri).toBe(uri);
		expect(result.locations[0]!.range).toEqual({ start: { line: 7 } });
	});

	it("treats null as no locations, not as an error", async () => {
		const { session } = await readySession(null);
		const result = await providerFor(session).query({
			operation: "goToDefinition",
			filePath: join(dir, "a.ts"),
			position: { line: 0, character: 0 },
			workspaceRoot: dir,
			languageId: "typescript",
		});
		expect(result).toMatchObject({ kind: "locations", locations: [] });
	});
});

describe("reference declarations", () => {
	it("always asks for declarations, because callers get no flag", async () => {
		const { session, requests } = await readySession([]);
		await providerFor(session).query({
			operation: "findReferences",
			filePath: join(dir, "a.ts"),
			position: { line: 2, character: 4 },
			workspaceRoot: dir,
			languageId: "typescript",
		});
		const request = requests.find((r) => r.method === "textDocument/references")!;
		expect(request).toBeDefined();
		// A server that omits the definition by default would otherwise silently
		// drop it, and the caller has no way to ask.
		expect((request.params as { context?: { includeDeclaration?: boolean } }).context?.includeDeclaration).toBe(true);
	});

	it("does not send a context for the other operations", async () => {
		const { session, requests } = await readySession([]);
		await providerFor(session).query({
			operation: "goToDefinition",
			filePath: join(dir, "a.ts"),
			position: { line: 0, character: 0 },
			workspaceRoot: dir,
			languageId: "typescript",
		});
		expect((requests.find((r) => r.method === "textDocument/definition")!.params as { context?: unknown }).context).toBeUndefined();
	});
});

describe("the workspace URI", () => {
	it("resolves symlinks, so callers relativize against the real root", async () => {
		const real = join(dir, "real");
		await mkdir(real, { recursive: true });
		const link = join(dir, "link");
		await symlink(real, link);
		const { session } = await readySession([]);
		const result = await providerFor(session).query({
			operation: "goToDefinition",
			filePath: join(link, "a.ts"),
			position: { line: 0, character: 0 },
			workspaceRoot: link,
			languageId: "typescript",
		});
		if (result.kind !== "locations") throw new Error("expected locations");
		// The field exists precisely so callers do NOT apply host path rules to
		// a possibly-symlinked request root.
		expect(result.resolvedWorkspaceUri).toBe(pathToFileURL(await realpath(real)).href);
		expect(result.resolvedWorkspaceUri).not.toBe(pathToFileURL(link).href);
	});

	it("falls back to the request root when it cannot be resolved", async () => {
		const missing = join(dir, "does-not-exist");
		const { session } = await readySession([]);
		const result = await providerFor(session).query({
			operation: "goToDefinition",
			filePath: join(dir, "a.ts"),
			position: { line: 0, character: 0 },
			workspaceRoot: missing,
			languageId: "typescript",
		});
		if (result.kind !== "locations") throw new Error("expected locations");
		expect(result.resolvedWorkspaceUri).toBe(pathToFileURL(missing).href);
	});
});

describe("hover", () => {
	it("reduces MarkupContent to text", async () => {
		const { session } = await readySession({ contents: { kind: "markdown", value: "**alpha**" } });
		const result = await providerFor(session).query({
			operation: "hover",
			filePath: join(dir, "a.ts"),
			position: { line: 0, character: 0 },
			workspaceRoot: dir,
			languageId: "typescript",
		});
		expect(result).toEqual({ kind: "hover", hover: { contents: "**alpha**" } });
	});

	it("joins the legacy string array form", async () => {
		const { session } = await readySession({ contents: ["first", { language: "ts", value: "second" }] });
		const result = await providerFor(session).query({
			operation: "hover",
			filePath: join(dir, "a.ts"),
			position: { line: 0, character: 0 },
			workspaceRoot: dir,
			languageId: "typescript",
		});
		expect(result).toEqual({ kind: "hover", hover: { contents: "first\n\nsecond" } });
	});

	it("reports null for an empty hover rather than an empty string", async () => {
		const { session } = await readySession(null);
		const result = await providerFor(session).query({
			operation: "hover",
			filePath: join(dir, "a.ts"),
			position: { line: 0, character: 0 },
			workspaceRoot: dir,
			languageId: "typescript",
		});
		expect(result).toEqual({ kind: "hover", hover: null });
	});
});

describe("unavailability", () => {
	it("refuses rather than pretending there are no results", async () => {
		const provider = providerFor(undefined);
		// "I could not ask" and "there is nothing there" are different facts.
		await expect(
			provider.query({
				operation: "findReferences",
				filePath: join(dir, "a.ts"),
				position: { line: 0, character: 0 },
				workspaceRoot: dir,
				languageId: "typescript",
			}),
		).rejects.toThrow(/E_LSP_UNAVAILABLE/);
	});

	it("honours a pre-aborted signal", async () => {
		const { session } = await readySession([]);
		const controller = new AbortController();
		controller.abort();
		await expect(
			providerFor(session).query(
				{
					operation: "goToDefinition",
					filePath: join(dir, "a.ts"),
					position: { line: 0, character: 0 },
					workspaceRoot: dir,
					languageId: "typescript",
				},
				controller.signal,
			),
		).rejects.toThrow(/cancelled/);
	});
});

describe("optional registration", () => {
	it("registers on a service that offers registerProvider", () => {
		const registered: unknown[] = [];
		const dispose = registerLspProvider({ registerProvider: (p: unknown) => (registered.push(p), () => undefined) }, () => undefined);
		expect(dispose).toBeTypeOf("function");
		expect(registered).toHaveLength(1);
		expect((registered[0] as { id: string }).id).toBe(PROVIDER_ID);
	});

	it("is a no-op when ctx.lsp is absent, which is the default deployment", () => {
		// Declaring `lsp` in `inject` would stop the plugin loading at all where
		// the official packages are not installed.
		expect(registerLspProvider(undefined, () => undefined)).toBeUndefined();
		expect(registerLspProvider({}, () => undefined)).toBeUndefined();
	});

	it("survives a refused registration instead of taking the plugin down", () => {
		const dispose = registerLspProvider(
			{
				registerProvider: () => {
					throw new Error("LSP_CONFLICT");
				},
			},
			() => undefined,
		);
		expect(dispose).toBeUndefined();
	});
});
