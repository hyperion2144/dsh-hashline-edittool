/**
 * Registering our client as a `ctx.lsp` provider.
 *
 * Why we become the provider rather than consuming one: the official seam
 * exposes no process or document control, so a provider we consume is a
 * language server we cannot reach — running ours *alongside* it would start the
 * same server twice. Registering means one process serves both the official
 * `lsp` tool and our own queries (ADR-0008 D2).
 *
 * The interface below is transcribed from the seam's own documentation, not
 * inferred: `LspProvider` is `{ id, extensionToLanguage, query }`, and `query`
 * must return the **closed** union — `locations` or `hover` — never raw
 * protocol output, because the seam deliberately has no JSON-RPC escape hatch.
 *
 * Two obligations that are easy to get wrong and are therefore tested:
 *
 * 1. **`findReferences` includes declarations.** The provider enforces it
 *    internally; callers get no flag. So the request always carries
 *    `includeDeclaration: true`, and a server that omits the definition by
 *    default cannot silently drop it.
 * 2. **`resolvedWorkspaceUri` is the provider's canonical workspace URI**, and
 *    callers relativize against it rather than applying host path rules to the
 *    possibly-symlinked request root. Returning the request root verbatim
 *    would reintroduce exactly the mismatch the field exists to prevent.
 *
 * @module dsh-hashline-edittool/lsp/provider
 */
import { realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { LANGUAGES } from "../ast/language.js";
import type { LspSession } from "./session.js";

/** The operations the seam exposes. */
export type LspOperation = "goToDefinition" | "findReferences" | "goToImplementation" | "hover";

/** One resolved location, as the seam defines it. */
export interface LspLocation {
	readonly uri: string;
	readonly range: unknown;
}

/** A provider query: the caller's request plus the derived language id. */
export interface LspProviderQuery {
	readonly operation: LspOperation;
	readonly filePath: string;
	readonly position: { readonly line: number; readonly character: number };
	readonly workspaceRoot: string;
	readonly languageId: string;
}

/** The seam's closed result union. */
export type LspQueryResult =
	| { readonly kind: "locations"; readonly locations: readonly LspLocation[]; readonly resolvedWorkspaceUri: string }
	| { readonly kind: "hover"; readonly hover: { readonly contents: string; readonly range?: unknown } | null };

/** The provider shape the seam accepts. */
export interface LspProvider {
	readonly id: string;
	readonly extensionToLanguage: Readonly<Record<string, string>>;
	query(request: LspProviderQuery, signal?: AbortSignal): Promise<LspQueryResult>;
}

/** The `ctx.lsp` surface we consume, structurally (the service is optional). */
export interface LspServiceLike {
	registerProvider(provider: LspProvider): () => void;
}

/** This provider's stable id. */
export const PROVIDER_ID = "dsh-hashline-edittool";

/** The extension map, derived from the built-in language registry. */
export function extensionToLanguage(): Record<string, string> {
	const map: Record<string, string> = {};
	for (const language of LANGUAGES) {
		for (const extension of language.extensions) map[extension] = language.id;
	}
	return map;
}

/** The LSP method each operation maps to. */
const METHOD_FOR: Record<LspOperation, string> = {
	goToDefinition: "textDocument/definition",
	findReferences: "textDocument/references",
	goToImplementation: "textDocument/implementation",
	hover: "textDocument/hover",
};

/** How to find a session for a language; injected so the provider is testable. */
export type SessionLookup = (languageId: string, filePath: string, workspaceRoot: string) => LspSession | undefined;

/**
 * Build the provider.
 *
 * @param lookup - resolves a live session for a language, or `undefined` when
 *   none is running. Returning `undefined` is reported as an unavailable
 *   provider rather than an empty answer, because "I could not ask" and "there
 *   is nothing there" are different facts.
 */
export function buildProvider(lookup: SessionLookup): LspProvider {
	return {
		id: PROVIDER_ID,
		extensionToLanguage: extensionToLanguage(),
		async query(request: LspProviderQuery, signal?: AbortSignal): Promise<LspQueryResult> {
			const session = lookup(request.languageId, request.filePath, request.workspaceRoot);
			if (session === undefined || !session.isReady) {
				throw new Error(
					`[E_LSP_UNAVAILABLE] No language server is running for ${request.languageId}. Start one by reading a symbol in that language, or install a server.`,
				);
			}
			if (signal?.aborted === true) throw new Error("[E_LSP_ABORTED] The query was cancelled.");

			const uri = pathToFileURL(request.filePath).href;
			const raw = await session.request(
				METHOD_FOR[request.operation],
				{
					textDocument: { uri },
					position: { line: request.position.line, character: request.position.character },
					// Declarations are always wanted for references: the provider
					// enforces it, and callers get no flag to ask for it.
					...(request.operation === "findReferences" ? { context: { includeDeclaration: true } } : {}),
				},
				// The seam owns no timeout policy, so the session's own deadline
				// applies; the caller's signal is honoured above and below.
				undefined,
			);

			if (request.operation === "hover") {
				const hover = normalizeHover(raw);
				return { kind: "hover", hover };
			}
			return {
				kind: "locations",
				locations: normalizeLocations(raw),
				resolvedWorkspaceUri: await canonicalWorkspaceUri(request.workspaceRoot),
			};
		},
	};
}

/** The canonical `file:` URI of a workspace root, with symlinks resolved. */
async function canonicalWorkspaceUri(workspaceRoot: string): Promise<string> {
	try {
		return pathToFileURL(await realpath(workspaceRoot)).href;
	} catch {
		// An unreadable root is not a reason to fail a query; the unresolved
		// form is still a usable coordinate.
		return pathToFileURL(workspaceRoot).href;
	}
}

/** Normalize the servers' several shapes for "where" into one list. */
function normalizeLocations(raw: unknown): LspLocation[] {
	if (raw === null || raw === undefined) return [];
	const entries = Array.isArray(raw) ? raw : [raw];
	const out: LspLocation[] = [];
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as { uri?: unknown; targetUri?: unknown; range?: unknown; targetRange?: unknown; targetSelectionRange?: unknown };
		// `location` has `uri`; `locationLink` has `targetUri`. Both appear in
		// the wild depending on the server and the operation.
		const uri = typeof record.uri === "string" ? record.uri : typeof record.targetUri === "string" ? record.targetUri : undefined;
		if (uri === undefined) continue;
		const range = record.range ?? record.targetSelectionRange ?? record.targetRange;
		out.push({ uri, range });
	}
	return out;
}

/** Normalize the servers' several shapes for "what" into the seam's hover. */
function normalizeHover(raw: unknown): { contents: string; range?: unknown } | null {
	if (raw === null || raw === undefined) return null;
	if (typeof raw === "string") return { contents: raw };
	if (typeof raw !== "object") return null;
	const record = raw as { contents?: unknown; range?: unknown };
	const contents = record.contents;
	if (typeof contents === "string") {
		return { contents, ...(record.range === undefined ? {} : { range: record.range }) };
	}
	// `MarkupContent` and the legacy `{ language, value }` array both reduce to
	// text: the seam's hover carries normalized content, not protocol shapes.
	if (typeof contents === "object" && contents !== null) {
		const markup = contents as { value?: unknown };
		if (typeof markup.value === "string") {
			return { contents: markup.value, ...(record.range === undefined ? {} : { range: record.range }) };
		}
	}
	if (Array.isArray(contents)) {
		const values = contents
			.map((part) => (typeof part === "string" ? part : typeof (part as { value?: unknown })?.value === "string" ? (part as { value: string }).value : ""))
			.filter((value) => value.length > 0);
		if (values.length > 0) return { contents: values.join("\n\n"), ...(record.range === undefined ? {} : { range: record.range }) };
	}
	return null;
}

/**
 * Register our provider on `ctx.lsp`, when that service exists.
 *
 * The service is consumed **optionally**: declaring `lsp` in a plugin's
 * `inject` would prevent the plugin from loading at all in the default
 * deployment, where none of the official LSP packages are installed
 * (ADR-0008 D2/D3).
 *
 * @param lsp - whatever `ctx.get("lsp")` returned.
 * @param lookup - how to find a live session.
 * @returns a disposer, or `undefined` when there was nothing to register on.
 */
export function registerLspProvider(
	lsp: unknown,
	lookup: SessionLookup,
): (() => void) | undefined {
	const service = lsp as LspServiceLike | undefined;
	if (service === undefined || typeof service.registerProvider !== "function") return undefined;
	try {
		return service.registerProvider(buildProvider(lookup));
	} catch (error) {
		// A conflicting id or extension map publishes nothing and throws; that
		// is the seam's contract, and it must not take our plugin down.
		console.error(
			`dsh-hashline-edittool: ctx.lsp provider registration refused: ${error instanceof Error ? error.message : String(error)}`,
		);
		return undefined;
	}
}
