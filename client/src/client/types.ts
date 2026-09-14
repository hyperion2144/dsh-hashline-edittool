/**
 * Structural client-side types for the hashline tool cards.
 *
 * Kept minimal and dependency-free on purpose: the dsh client type surface
 * (`@deepseek-ai/dsh-client-ui-slots` SlotMap augmentation, ToolCallBlock…)
 * lives in shell-only packages, so the browser half compiles against these
 * structural mirrors of the wire shapes instead.
 */

/** Running tool call half of a ToolCallBlock. */
export interface RunningToolCall {
	callId: string;
	parentCallId?: string | undefined;
	name: string;
	argsRaw: string;
	turn: number;
	step: number;
	time: number;
	subCalls: readonly ToolCallBlock[];
}

/** Settled tool result half of a ToolCallBlock. */
export interface ToolResultNode {
	kind: "tool-result";
	seq: number;
	time: number;
	callId: string;
	parentCallId?: string | undefined;
	call: { name: string; argsRaw: string } | null;
	callTime: number | null;
	content: readonly { type: string; text?: string }[];
	isError: boolean;
	error?: { name: string; code: string } | undefined;
	meta?: unknown;
	subCalls: readonly ToolCallBlock[];
}

/** One running or settled call, the owner currency of a keyed tool view. */
export type ToolCallBlock = RunningToolCall | ToolResultNode;

/** Owner props every `tool.call.toolview` component receives. */
export interface ToolCallOwnerProps {
	callId: string;
	toolName: string;
	block: ToolCallBlock;
	cwd?: string | undefined;
	home?: string | undefined;
	openFile: (path: string) => void;
	inspect?: (() => void) | undefined;
}

/** Locale seat props added by the registration's `locale` declaration. */
export interface LocaleProps {
	t: (key: string, params?: Record<string, unknown>) => string;
}

/** Full props of a registered read/edit tool view. */
export type ToolViewProps = ToolCallOwnerProps & LocaleProps;

/** One read-window line as persisted by the hashline read tool. */
export interface ReadMetaLine {
	number: number;
	text: string;
}

/** One read-window line carrying its hashline anchor. */
export interface ReadMetaHashline extends ReadMetaLine {
	hash: string;
}

/** The hashline read tool's persisted presentation projection (meta). */
export interface ReadPresentation {
	path: string;
	offset: number;
	lines: ReadMetaLine[];
	totalLines: number;
	hashlines?: ReadMetaHashline[] | undefined;
	lang?: string | undefined;
}

/** One applied hunk as persisted by the hashline edit tool (meta.diffs[]). */
export interface FileDiff {
	path: string;
	oldText: string | null;
	newText: string;
}

/** Props accepted by the primitives' ReadBlock. */
export interface ReadCardProps {
	label: string;
	lines: readonly { number: number | string; text: string }[];
	totalLines: number;
	lang?: string | undefined;
}

/** Props accepted by the primitives' DiffBlock. */
export interface DiffCardProps {
	diffs: readonly FileDiff[];
}

/** One rendered diff row from the persisted meta (rendering channel, issue #71). */
export interface DiffRowMeta {
	/** `+` added, `-` removed, ` ` context. */
	kind: "+" | "-" | " ";
	/** `+` / context: the post-edit line number. `-`: the pre-edit line number. */
	lineNumber: number;
	/** `+` / context: the served post-edit anchor. `-`: the stale pre-edit anchor. Empty when unknown. */
	hash: string;
	text: string;
}
/** One file's diff rows in a multi-file group (issue #82: per-file tab rendering). */
export interface DiffRowGroup {
	path: string;
	rows: readonly DiffRowMeta[];
}

/**
 * One grep card row as persisted by the hashline grep tool (ADR-0005): the
 * line's identity, its verbatim text and the highlight spans of every pattern
 * occurrence. `match` is present only on rows the capped match list contains.
 */
export interface GrepRowMeta {
	/** 1-based line number within the file. */
	number: number;
	/** The served hashline anchor (empty string when unavailable). */
	hash: string;
	/** The line's full text, verbatim. */
	text: string;
	/** Present on the capped match rows only. */
	match?: true | undefined;
	/** `[start, end)` UTF-16 offsets into `text`; absent when the line has none. */
	spans?: [number, number][] | undefined;
}

/** One file's grep card rows (match rows + echoed context rows) in file order. */
export interface GrepFileRowGroup {
	path: string;
	rows: readonly GrepRowMeta[];
}

/** The grep card derived from the persisted meta (three degradation tiers). */
export interface GrepCardModel {
	files: readonly GrepFileRowGroup[];
	truncated: boolean;
	total: number;
}

/**
 * One `lsp` diagnostics row: the source line, plus the diagnostics ON it.
 *
 * Two fields, not one string: the line is the file's text and the messages are
 * a server's opinion of it, and the card gives them different weights because a
 * reader has to be able to see which is which.
 */
export interface LspRowMeta {
	readonly number: number;
	readonly hash: string;
	readonly text: string;
	readonly messages: readonly string[];
}

/** The `lsp` diagnostics card: one row per line, its messages attached. */
export interface LspCardModel {
	readonly path: string;
	readonly rows: readonly LspRowMeta[];
}

/** One rendered slice of a card row: plain text, or a highlighted occurrence. */
export interface GrepSegment {
	text: string;
	hit: boolean;
}

/** A diff card backed by the structured rows projection (gutter-rendering). */
export interface RowsDiffCard {
	path: string;
	rows: readonly DiffRowMeta[];
}

/** Row model derived per call, mirroring the shipped toolRowModel subset. */
export interface ToolRowModel {
	variant: "read" | "edit" | "write" | "grep";
	titleKey: string;
	summary: string;
	filePath: string | undefined;
	bodyRaw: string | null;
	output: string | null;
	errorSummary: string | null;
	state: "running" | "ok" | "error" | "stopped";
}

/** Minimal structural face of the client cordis context used at registration. */
export interface ClientCtx {
	plugin(pluginObject: { name: string; inject: string[]; apply: (ctx: ClientCtx) => void }): void;
	slots: {
		inject(key: string, create: () => () => void): void;
		register(options: Record<string, unknown>, component: unknown): () => void;
	};
	/**
	 * The revision-fenced settings writer. Bound to a namespace, it reads the
	 * current snapshot and refuses a write made against a stale revision —
	 * which is why a card never needs its own reader.
	 */
	settingsScope: SettingsScopeService;
}

/**
 * The structural mirror of `ctx.settingsScope`, transcribed from the SHIPPED
 * implementation rather than from the cookbook's prose.
 *
 * That distinction is the whole point of this comment: the first version of
 * this mirror guessed `scope.snapshot` as a *property* because the cookbook
 * says "the scope snapshot carries…". The real accessor is
 * `scope.getSnapshot()` — a method — so the card threw during render and was
 * removed from the settings tab by the slot host's entry-error handling. It
 * was invisible in every test we had, which is exactly why the guess is worth
 * naming here.
 */
export interface SettingsScopeSnapshot {
	/** Host-side state: a form is only usable once this reads `"ready"`. */
	readonly status: string;
	/** Whether a write would be accepted at all. */
	readonly writable: boolean;
	/** Monotonic revision; a write made against a stale one is refused. */
	readonly revision: number;
	/** Resolved value: the base layer merged with the user layer. */
	readonly value: Record<string, unknown>;
	/** The composition layer, for "reset to default". */
	readonly base: Record<string, unknown>;
	/**
	 * The raw user layer. **Key PRESENCE, not the value, marks a field
	 * overridden** — which is why clearing is `unset` rather than writing the
	 * base value back.
	 */
	readonly user: Record<string, unknown>;
}

/** The bound scope a card reads and writes through. */
export interface SettingsScope {
	/** Current snapshot. A METHOD, not a property. */
	getSnapshot(): SettingsScopeSnapshot;
	/** Subscribe to changes; returns the unsubscribe. */
	subscribe(listener: () => void): () => void;
	set(field: string, value: unknown): Promise<void>;
	unset(field: string): Promise<void>;
	mutate?(mutator: unknown): Promise<void>;
}

/** The `settingsScope` service, structurally. */
export interface SettingsScopeService {
	bind(options: { readonly namespace: string }): SettingsScope;
}
