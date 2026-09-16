/**
 * The parse worker: the only place a `Parser` is ever constructed.
 *
 * Everything expensive and everything fragile lives here, because the WASM
 * arena is the binding constraint (`docs/adr/0007`):
 *
 * - The arena is capped at 2048 MiB, grows on demand, and **never shrinks**;
 *   dropping references to trees frees nothing. So the worker — not the main
 *   thread — must be the one that can be terminated to reclaim it.
 * - An over-budget parse does not throw a JS error; it surfaces as
 *   `RuntimeError: Aborted()` from inside wasm, and afterwards the SAME
 *   `Parser` silently returns an `ERROR`-rooted tree rather than failing. Any
 *   abort therefore poisons this whole worker, which is why the only sane
 *   response is "report it, get terminated, let the client respawn".
 * - `Parser.init` mutated the options object we passed it
 *   (`var Module = moduleArg`), which is how `arenaBytes()` below can read the
 *   live linear-memory size. It is populated only by whichever call performs
 *   the FIRST init in the process — which is this worker, by construction.
 *
 * @module dsh-hashline-edittool/ast/worker
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Language, Parser, type Node } from "web-tree-sitter";
import {
	AST_ARENA_CEILING_BYTES,
	AST_ADMIT_LIMIT_SOURCE_BYTES,
	AST_ARENA_RESERVE_BYTES,
	AST_BYTES_PER_NODE,
	AST_MAX_DENSITY,
	AST_RETAIN_LIMIT_NODES,
	AST_RETAIN_NODE_BUDGET,
} from "../infra/constants.js";
import {
	E_AST_PATTERN,
	E_AST_TOO_LARGE,
	E_AST_WORKER_ABORTED,
	E_AST_WORKER_FAILED,
	E_PARSE_FAILED,
} from "./codes.js";
import { compilePattern, matchPattern, registerPatternLanguage, type PatternMatch } from "./pattern.js";
import { computeElisions, type ElisionSpan } from "./elide.js";
import { languageById, type LanguageId } from "./language.js";
import { resolveGrammarAsset } from "./registry.js";
import { enumerateSymbols, type SymbolRecord } from "./symbols.js";

/** Parse a source text and enumerate its symbols. */
export interface ParseRequest {
	readonly id: number;
	readonly op: "parse";
	readonly languageId: LanguageId;
	readonly path: string;
	readonly text: string;
}

/** Find identifier occurrences of a name (for the reference scan). */
export interface IdentifiersRequest {
	readonly id: number;
	readonly op: "identifiers";
	readonly languageId: LanguageId;
	readonly path: string;
	readonly text: string;
	readonly name: string;
}

/** Compute the elision spans for a structural summary. */
export interface SummaryRequest {
	readonly id: number;
	readonly op: "summary";
	readonly languageId: LanguageId;
	readonly path: string;
	readonly text: string;
	readonly minBodyLines: number;
	readonly minCommentLines: number;
}

/**
 * A structural pattern search.
 *
 * The parse belongs HERE rather than in the tool: this module is the only
 * place a Parser is built, and a pattern must be parsed by the SAME grammar
 * the target was, or the two trees are not comparable.
 */
export interface GrepRequest {
	readonly id: number;
	readonly op: "grep";
	readonly languageId: LanguageId;
	readonly path: string;
	readonly text: string;
	readonly pat: string;
}

/** Ask whether a text still parses (the post-edit write gate). */
export interface ValidateRequest {
	readonly id: number;
	readonly op: "validate";
	readonly languageId: LanguageId;
	readonly path: string;
	readonly text: string;
}

/** Report the live arena size and the retained node count. */
export interface ArenaRequest {
	readonly id: number;
	readonly op: "arena";
}

/** Drop every cached tree (keeps grammars loaded). */
export interface ReleaseRequest {
	readonly id: number;
	readonly op: "release";
}

/** Anything the client may send. */
export type AstWorkerRequest =
	| ParseRequest
	| IdentifiersRequest
	| SummaryRequest
	| GrepRequest
	| ValidateRequest
	| ArenaRequest
	| ReleaseRequest;

/** A successful parse. */
export interface ParseOk {
	readonly id: number;
	readonly ok: true;
	readonly op: "parse";
	readonly symbols: SymbolRecord[];
	readonly nodeCount: number;
	readonly cached: boolean;
	readonly arenaBytes: number;
}

/** A successful identifier scan: 1-indexed line / 0-indexed UTF-16 column. */
export interface IdentifiersOk {
	readonly id: number;
	readonly ok: true;
	readonly op: "identifiers";
	readonly hits: Array<{ line: number; column: number }>;
	readonly arenaBytes: number;
}

/** One place a pattern matched, with the text its metavariables captured. */
export interface GrepMatch {
	readonly startLine: number;
	readonly startColumn: number;
	readonly endLine: number;
	readonly endColumn: number;
	readonly captures: Record<string, readonly string[]>;
	/**
	 * Where each capture LANDED, per capture name, in the same order as the
	 * capture texts above. The card highlights the captures when a pattern has
	 * metavariables — `const $NAME = $VALUE;` should light up `plan` and its
	 * initializer, not the whole statement — and falls back to the matched node
	 * when there are none. Text alone cannot answer that: two captures can hold
	 * the same word on one line.
	 *
	 * Per capture, `[startLine, startColumn, endLine, endColumn]`, 1-based lines
	 * and 0-based columns (tree-sitter's own coordinates).
	 */
	readonly captureSpans: Record<string, readonly (readonly number[])[]>;
}

/** A pattern search that ran. */
export interface GrepOk {
	readonly id: number;
	readonly ok: true;
	readonly op: "grep";
	readonly matches: readonly GrepMatch[];
	readonly arenaBytes: number;
}

/** A successful elision computation. */
export interface SummaryOk {
	readonly id: number;
	readonly ok: true;
	readonly op: "summary";
	readonly spans: ElisionSpan[];
	readonly arenaBytes: number;
}

/** The write gate's answer. */
export interface ValidateOk {
	readonly id: number;
	readonly ok: true;
	readonly op: "validate";
	/** True when the tree contains an `ERROR` node (or is itself one). */
	readonly hasError: boolean;
	readonly arenaBytes: number;
}

/** A successful arena/release report. */
export interface ArenaOk {
	readonly id: number;
	readonly ok: true;
	readonly op: "arena" | "release";
	readonly arenaBytes: number;
	readonly retainedNodes: number;
}

/**
 * A failed request. `aborted` marks the one failure that is not the caller's
 * fault and not recoverable in place: the wasm instance died.
 */
export interface AstWorkerFailure {
	readonly id: number;
	readonly ok: false;
	readonly code: string;
	readonly message: string;
	readonly aborted?: boolean;
}

/** Anything the worker may send back. */
export type AstWorkerResponse =
	| ParseOk
	| IdentifiersOk
	| SummaryOk
	| GrepOk
	| ValidateOk
	| ArenaOk
	| AstWorkerFailure;

/** The options object `Parser.init` mutates in place (its `HEAPU8` is the arena view). */
type InitOptions = { locateFile: (file: string) => string; HEAPU8?: { buffer: ArrayBuffer } };

let initOptions: InitOptions | undefined;
let initPromise: Promise<void> | undefined;

/** Initialise the WASM core exactly once, keeping the mutated options object. */
function ensureInit(): Promise<void> {
	if (initPromise === undefined) {
		const coreUrl = new URL(import.meta.resolve("web-tree-sitter")).href;
		const opts: InitOptions = { locateFile: (file) => fileURLToPath(new URL(`./${file}`, coreUrl)) };
		initOptions = opts;
		initPromise = Parser.init(opts as never) as unknown as Promise<void>;
	}
	return initPromise;
}

/** The live linear-memory size in bytes, or `undefined` before init. */
function arenaBytes(): number | undefined {
	return initOptions?.HEAPU8?.buffer.byteLength;
}

/**
 * Node types that carry a bare identifier, per language — the reference scan's
 * confirmation set. Object-literal keys and destructuring both surface as one
 * of these, which is why `property_identifier` / `shorthand_property_identifier`
 * are here and not only `identifier`.
 */
const IDENTIFIER_NODE_TYPES: Readonly<Record<string, string[]>> = {
	typescript: ["identifier", "type_identifier", "property_identifier", "shorthand_property_identifier", "shorthand_property_identifier_pattern", "private_property_identifier"],
	tsx: ["identifier", "type_identifier", "property_identifier", "shorthand_property_identifier", "shorthand_property_identifier_pattern", "private_property_identifier"],
	javascript: ["identifier", "property_identifier", "shorthand_property_identifier", "shorthand_property_identifier_pattern", "private_property_identifier"],
	python: ["identifier"],
};

const grammars = new Map<string, Language>();
const parsers = new Map<string, Parser>();

/** Load (once) and return the parser for a language. */
async function parserFor(languageId: LanguageId): Promise<Parser> {
	await ensureInit();
	const existing = parsers.get(languageId);
	if (existing !== undefined) return existing;
	let language = grammars.get(languageId);
	if (language === undefined) {
		// The registry decides WHICH copy: an installed one wins over the
		// packaged one, because it is what the user asked for and the only copy
		// whose hash was verified. Loading the packaged asset directly here
		// would make the whole registry decorative.
		language = await Language.load(readFileSync(await resolveGrammarAsset(languageId)));
		grammars.set(languageId, language);
	}
	const parser = new Parser();
	parser.setLanguage(language);
	parsers.set(languageId, parser);
	return parser;
}

/**
 * Enumerate a tree's symbols, following an embedded block when the language has
 * one.
 *
 * The second parse belongs HERE rather than in `symbols.ts`, because this module
 * is the only place a Parser is built — a rule the codebase keeps deliberately,
 * so that grammar loading, caching and the arena budget all live in one layer.
 *
 * Positions are shifted by the block's own start: a symbol on the embedded
 * tree's first row sits on the host row the block starts at, not on row 1.
 *
 * @param root - the host tree's root.
 * @param languageId - the host language.
 * @returns the host's symbols, plus any found inside an embedded block.
 */
async function symbolsFor(root: Node, languageId: LanguageId): Promise<SymbolRecord[]> {
	const host = enumerateSymbols(root, languageId);
	const embedded = languageById(languageId)?.embedded;
	if (embedded === undefined) return host;

	const block = findEmbedded(root, embedded);
	if (block === undefined) return host;

	const parser = await parserFor(embedded.language);
	const inner = parser.parse(block.text);
	if (inner === null) return host;

	// Row offset only. The block starts at a known row and column, and every
	// embedded row after the first begins at column 0 of the HOST line, so a
	// single row shift is the whole mapping — a general one would be inventing
	// complexity this shape does not have.
	const rowShift = block.startPosition.row;
	const columnShift = block.startPosition.column;
	return [
		...host,
		...enumerateSymbols(inner.rootNode, embedded.language).map((record) => ({
			...record,
			startLine: record.startLine + rowShift,
			endLine: record.endLine + rowShift,
			blockStartLine: record.blockStartLine + rowShift,
			blockEndLine: record.blockEndLine + rowShift,
			// Only the block's first line is indented by the host; later lines
			// start at column 0, so shifting them too would move them right.
			startColumn: record.startLine === 1 ? record.startColumn + columnShift : record.startColumn,
		})),
	];
}

/** The embedded source text, when the host has one. */
function findEmbedded(root: Node, embedded: { containerType: string; textType: string }): Node | undefined {
	for (const container of root.descendantsOfType(embedded.containerType)) {
		const text = container.descendantsOfType(embedded.textType)[0];
		if (text !== undefined) return text;
	}
	return undefined;
}

/** One cached tree. */
interface CacheEntry {
	readonly tree: ReturnType<Parser["parse"]> & object;
	readonly nodes: number;
	readonly languageId: LanguageId;
	used: number;
}

const cache = new Map<string, CacheEntry>();
let retainedNodes = 0;
let clock = 0;

/** Content key for the tree cache. */
function cacheKey(languageId: LanguageId, text: string): string {
	return `${languageId}\0${createHash("sha256").update(text).digest("base64")}`;
}

/** Drop least-recently-used entries until `wanted` more nodes fit the budget. */
function evictTo(wantedBytes: number, budgetBytes: number): void {
	let used = retainedNodes * AST_BYTES_PER_NODE;
	if (used + wantedBytes <= budgetBytes) return;
	const order = [...cache.entries()].sort((a, b) => a[1].used - b[1].used);
	for (const [key, entry] of order) {
		if (used + wantedBytes <= budgetBytes) break;
		cache.delete(key);
		retainedNodes -= entry.nodes;
		used = retainedNodes * AST_BYTES_PER_NODE;
	}
}

/** Drop every cached tree. */
function clearCache(): void {
	for (const entry of cache.values()) {
		try {
			(entry.tree as { delete?: () => void }).delete?.();
		} catch {
			// A tree whose arena is already gone throws; nothing to do.
		}
	}
	cache.clear();
	retainedNodes = 0;
}

/** Whether a thrown value is a wasm abort rather than an ordinary failure. */
function isAbort(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /Aborted|RuntimeError/.test(message);
}

/** A tree plus its accounting, or the refusal that stopped it. */
type TreeOutcome =
	| { readonly ok: true; readonly tree: NonNullable<ReturnType<Parser["parse"]>> & object; readonly nodes: number; readonly cached: boolean }
	| { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Get a tree for `(languageId, text)`, parsing it only on a cache miss.
 *
 * Admission runs FIRST and evicts for the incoming tree *before* it exists:
 * crossing the budget is not "a bit more memory", it is `Aborted()` plus a
 * poisoned parser, so over-eviction is the accepted cost (spec §3.3).
 */
async function treeFor(path: string, languageId: LanguageId, text: string): Promise<TreeOutcome> {
	const estimatedNodes = Math.ceil(text.length * AST_MAX_DENSITY);
	const usableArena = AST_ARENA_CEILING_BYTES - AST_ARENA_RESERVE_BYTES;
	const estimatedBytes = estimatedNodes * AST_BYTES_PER_NODE;
	if (estimatedBytes > usableArena) {
		return {
			ok: false,
			code: E_AST_TOO_LARGE,
			message:
				`${path} is too large for AST parsing: a worst-case estimate of ` +
				`${estimatedNodes} nodes (~${Math.round(estimatedBytes / (1024 * 1024))} MiB) exceeds the ` +
				`${Math.round(usableArena / (1024 * 1024))} MiB usable arena. ` +
				`Read it with line mode instead (offset/limit), or grep it.`,
		};
	}
	evictTo(estimatedBytes, usableArena);

	const key = cacheKey(languageId, text);
	const hit = cache.get(key);
	if (hit !== undefined) {
		hit.used = ++clock;
		return { ok: true, tree: hit.tree, nodes: hit.nodes, cached: true };
	}

	const parser = await parserFor(languageId);
	const tree = parser.parse(text);
	if (tree === null) return { ok: false, code: E_PARSE_FAILED, message: `Parser returned no tree for ${path}.` };
	// `descendantCount` includes the node itself, so the root's count is the
	// tree's total — an O(1) read, measured at 0.0004 ms.
	const nodes = tree.rootNode.descendantCount;
	const cacheable = nodes <= AST_RETAIN_LIMIT_NODES && retainedNodes + nodes <= AST_RETAIN_NODE_BUDGET;
	if (cacheable) {
		evictTo(nodes * AST_BYTES_PER_NODE, AST_RETAIN_NODE_BUDGET * AST_BYTES_PER_NODE);
		cache.set(key, { tree, nodes, languageId, used: ++clock });
		retainedNodes += nodes;
	}
	return { ok: true, tree, nodes, cached: cacheable };
}

/** Handle one request; never throws. */
export async function handleRequest(request: AstWorkerRequest): Promise<AstWorkerResponse> {
	// The named admit limit is the FIRST gate, checked before the estimate:
	// it is the documented contract (`E_AST_TOO_LARGE`, spec §3.6), and the
	// worst-case estimate alone would let a file through at 27 MiB (the maths
	// only crosses the usable arena at ~27.19 MiB), making the constant a lie.
	if (request.op === "parse" && request.text.length > AST_ADMIT_LIMIT_SOURCE_BYTES) {
		return {
			id: request.id,
			ok: false,
			code: E_AST_TOO_LARGE,
			message:
				`${request.path} is ${Math.round(request.text.length / (1024 * 1024))} MiB, over the ` +
				`${Math.round(AST_ADMIT_LIMIT_SOURCE_BYTES / (1024 * 1024))} MiB AST limit. ` +
				`Read it with line mode instead (offset/limit), or grep it.`,
		};
	}
	try {
		if (request.op === "arena") {
			return { id: request.id, ok: true, op: "arena", arenaBytes: arenaBytes() ?? 0, retainedNodes };
		}
		if (request.op === "identifiers") {
			const got = await treeFor(request.path, request.languageId, request.text);
			if (!got.ok) return { id: request.id, ok: false, code: got.code, message: got.message };
			const types = IDENTIFIER_NODE_TYPES[request.languageId] ?? [];
			const found = got.tree.rootNode.descendantsOfType(types.length === 0 ? ["identifier"] : types) as unknown as Node[];
			const hits = found
				.filter((node) => node.isNamed && node.text === request.name)
				.map((node) => ({ line: node.startPosition.row + 1, column: node.startPosition.column }));
			return { id: request.id, ok: true, op: "identifiers", hits, arenaBytes: arenaBytes() ?? 0 };
		}
		if (request.op === "summary") {
			const got = await treeFor(request.path, request.languageId, request.text);
			if (!got.ok) return { id: request.id, ok: false, code: got.code, message: got.message };
			const spans = computeElisions(got.tree.rootNode, request.languageId, {
				minBodyLines: request.minBodyLines,
				minCommentLines: request.minCommentLines,
			});
			return { id: request.id, ok: true, op: "summary", spans, arenaBytes: arenaBytes() ?? 0 };
		}
		if (request.op === "grep") {
			const got = await treeFor(request.path, request.languageId, request.text);
			if (!got.ok) return { id: request.id, ok: false, code: got.code, message: got.message };
			// The pattern is parsed by the SAME grammar the target was — this module
			// already holds it, and handing it to the matcher is what keeps that so.
			const handle = grammars.get(request.languageId);
			if (handle === undefined) {
				return { id: request.id, ok: false, code: E_PARSE_FAILED, message: `no grammar is loaded for ${request.languageId}` };
			}
			registerPatternLanguage(request.languageId, handle);
			let pattern;
			try {
				pattern = compilePattern(request.pat, request.languageId);
			} catch (error) {
				return {
					id: request.id,
					ok: false,
					code: E_AST_PATTERN,
					message: error instanceof Error ? error.message : String(error),
				};
			}
			if (pattern === undefined) {
				return { id: request.id, ok: false, code: E_PARSE_FAILED, message: `unknown language ${request.languageId}` };
			}
			const matches = matchPattern(got.tree.rootNode, pattern).map((m: PatternMatch) => ({
				startLine: m.node.startPosition.row + 1,
				startColumn: m.node.startPosition.column,
				endLine: m.node.endPosition.row + 1,
				endColumn: m.node.endPosition.column,
				// Captures travel as text: the tool renders them and the model reads
				// them, and neither has any use for a node handle.
				captures: Object.fromEntries(
					[...m.captures].map(([name, nodes]) => [name, nodes.map((n: Node) => n.text)]),
				),
				// ...and as SPANS, so the card can highlight what the pattern actually
				// captured instead of the whole matched node.
				captureSpans: Object.fromEntries(
					[...m.captures].map(([name, nodes]) => [
						name,
						nodes.map((n: Node) => [
							n.startPosition.row + 1,
							n.startPosition.column,
							n.endPosition.row + 1,
							n.endPosition.column,
						]),
					]),
				),
			}));
			return { id: request.id, ok: true, op: "grep", matches, arenaBytes: arenaBytes() ?? 0 };
		}
		if (request.op === "validate") {
			const got = await treeFor(request.path, request.languageId, request.text);
			if (!got.ok) return { id: request.id, ok: false, code: got.code, message: got.message };
			return { id: request.id, ok: true, op: "validate", hasError: got.tree.rootNode.hasError, arenaBytes: arenaBytes() ?? 0 };
		}
		if (request.op === "release") {
			clearCache();
			return { id: request.id, ok: true, op: "release", arenaBytes: arenaBytes() ?? 0, retainedNodes };
		}

		const got = await treeFor(request.path, request.languageId, request.text);
		if (!got.ok) return { id: request.id, ok: false, code: got.code, message: got.message };
		return {
			id: request.id,
			ok: true,
			op: "parse",
			symbols: await symbolsFor(got.tree.rootNode, request.languageId),
			nodeCount: got.nodes,
			cached: got.cached,
			arenaBytes: arenaBytes() ?? 0,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (isAbort(error)) {
			// The instance is gone; the client's only move is to terminate this
			// worker and respawn. Report and stop using anything here.
			return { id: request.id, ok: false, code: E_AST_WORKER_ABORTED, message, aborted: true };
		}
		return { id: request.id, ok: false, code: E_AST_WORKER_FAILED, message };
	}
}

/** Wire the worker to its parent port, when running as a thread. */
export function attachWorker(): void {
	// `worker_threads` is imported lazily so this module can also be loaded on
	// the main thread by tests without pulling the worker runtime in.
	void import("node:worker_threads").then((threads) => {
		const port = threads.parentPort;
		if (port === null) return;
		port.on("message", (request: AstWorkerRequest) => {
			void handleRequest(request).then((response) => port.postMessage(response));
		});
	});
}

void attachWorker();
