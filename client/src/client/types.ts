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

/** One line of the served read window, as the card draws it. */
export interface ReadCardRow {
	/** 1-based file line number. */
	readonly number: number;
	/** The line's hashline anchor; `""` when the row carries none. */
	readonly hash: string;
	/**
	 * The marker the card draws in its gutter cell: `<line>:<anchor>`, or the bare
	 * line number when this row has no anchor. Composed in the model so neither the
	 * card nor any shipped component has to build it.
	 */
	readonly gutter: string;
	/** The line's verbatim text. */
	readonly text: string;
}

/**
 * The `read` card's model — the card's OWN shape, not a primitive's props.
 *
 * `rows` is structured (`number` / `hash` / `gutter` / `text`): the anchor is a
 * field again instead of a `<line>:<anchor>` string smuggled through a numeric
 * field, which is the debt issue #98 was filed for.
 */
export interface ReadCardModel {
	/** Absolute path from the persisted meta. */
	readonly path: string;
	/** Display title for the tab: the path relativized to the workspace and `~`-abbreviated. */
	readonly label: string;
	readonly rows: readonly ReadCardRow[];
	readonly totalLines: number;
	readonly lang?: string | undefined;
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
	/**
	 * True when the rows are an `ast_grep` OUTLINE — a folded line view, not
	 * matches — so the footer says what it is instead of counting 0 matches.
	 */
	outline?: boolean | undefined;
}

/**
 * One `lsp` diagnostics row: the source line, plus the diagnostics ON it.
 *
 * Two fields, not one string: the line is the file's text and each message is a
 * server's opinion of it, and the card gives them different weights because a
 * reader has to be able to see which is which.
 */
export interface LspRowMeta {
	readonly number: number;
	readonly hash: string;
	readonly text: string;
	readonly messages: readonly string[];
	/** LSP severity codes (1 error, 2 warning, 3 info, 4 hint), same order as messages. */
	readonly severities: readonly number[];
}

/** The `lsp` diagnostics card: one row per line, its messages attached. */
export interface LspCardModel {
	readonly path: string;
	readonly rows: readonly LspRowMeta[];
}

/**
 * One INLINE diagnostics capsule (#131): one written file's reported rows,
 * persisted beside the diff card's meta. The same row shape the `lsp` card
 * draws, so the expanded capsule renders with that block unchanged.
 */
export interface DiagCapsuleMeta {
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

/** The error card's model: the structured failure of one call (spec #146). */
export interface ErrorCardModel {
	code: string;
	message: string;
	path?: string;
	context?: string;
	hint?: string;
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

/**
 * Structural mirrors of the 0.1.7 settings-form contract, transcribed from
 * the SHIPPED `@deepseek-ai/dsh-client-ui-settings` client types rather
 * than from prose.
 *
 * That discipline is the whole point of this comment block: the first
 * pre-0.1.7 mirror guessed `scope.snapshot` as a *property* because docs
 * said "the scope snapshot carries…" — the real accessor was a METHOD,
 * `getSnapshot()` — so the card threw during render and was removed by the
 * slot host's entry-error handling, invisible to every test. Transcribe
 * from the shipped .d.ts, never from prose.
 */

/** One path-addressed edit carried by a settings write (wire shape). */
export type SettingsPathOpView =
	| { readonly op: "set"; readonly path: readonly string[]; readonly value: unknown }
	| { readonly op: "unset"; readonly path: readonly string[] };

/** Client-side sync state of one settings entry (0.1.7 `ConfigFormSnapshot`). */
export interface ConfigFormSnapshot {
	/** `loading` until the first accepted section, `ready` while one stands, `unavailable` otherwise. */
	readonly status: "loading" | "ready" | "unavailable";
	/** Last accepted schema-resolved section; undefined before the first acceptance. */
	readonly value: Record<string, unknown> | undefined;
	/** Composition layer the Host resolved `value` over — what a field reverts to once cleared. */
	readonly base: unknown;
	/** Raw user layer as stored. A field's PRESENCE here marks it overridden. */
	readonly user: unknown;
	/** Entry revision fencing the next write; undefined before the first Host view. */
	readonly revision: number | undefined;
	/** Whether the Host document accepts writes. */
	readonly writable: boolean;
	/** `host` syncs with the Host document; `memory` keeps a remote browser process-local. */
	readonly mode: "host" | "memory";
}

/** The settings form a client editor drives (0.1.7 `ConfigForm`, structural). */
export interface ConfigForm {
	getSnapshot(): ConfigFormSnapshot;
	subscribe(listener: () => void): () => void;
	set(field: string, value: unknown): Promise<boolean>;
	unset(field: string): Promise<boolean>;
	mutate(ops: readonly SettingsPathOpView[], expectedRevision?: number): Promise<boolean>;
}

/** Reactive page values + the submit command the plugins page hands a config entry. */
export interface ConfigPageForm {
	readonly state: ConfigFormSnapshot;
	readonly mutate: ConfigForm["mutate"];
}
