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

/** Row model derived per call, mirroring the shipped toolRowModel subset. */
export interface ToolRowModel {
	variant: "read" | "edit";
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
