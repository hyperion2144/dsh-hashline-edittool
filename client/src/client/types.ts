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
}
