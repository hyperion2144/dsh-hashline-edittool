/**
 * One module owns the request shapes for the hashline tools — edit,
 * read, undo_last_edit — plus their validation. Field sets are declared
 * once here; every tool validates through these asserts, and the
 * [E_BAD_SHAPE] vocabulary is shared instead of re-implemented per tool.
 *
 * Note: `resolve.ts` keeps its own internal item check (content-only fields,
 * no path) — that is the hashline-internal edit-item shape, deliberately
 * decoupled from the tool-layer request contract so the hashline module does
 * not depend on this one.
 *
 * **0.4.0 contract change.** The `edit` tool now takes an `edits:[]` array
 * with named fields (`op` / `anchor_start` / `anchor_end?` / `lines?`) and an `op` semantic
 * distinguishing `ins` / `del` / `replace`. The legacy `batch_edit` tool
 * is removed; its multi-file capability is preserved as a per-item
 * optional `path` that overrides the top-level `path`. `remove_from` /
 * `remove_to` / `replacement_text` are gone — use `anchor_start` / `anchor_end` / `lines`
 * inside each `edits[i]` instead. See `docs/edit-payload-spec.md` for the
 * full design and the rationale.
 * @module dsh-hashline-edittool/contract
 */

import type { ParameterPropertySpec, ParameterSchemaSpec } from "@deepseek-ai/dsh-tools";
import { EDITS_MAX_ITEMS } from "./constants.js";
import type { AnchorRef } from "./declaration.js";
import { isRec, normalizeFilePath, rejectUnknownFields } from "./utils.js";

// ---- request shapes --------------------------------------------------------

/**
 * One edit within the `edits:[]` array. The `op` field disambiguates
 * insert / delete / replace semantics so the model can state its
 * intent unambiguously; the runtime never has to guess between
 * "replace with empty" and "delete this range".
 */
export interface EditItemParams {
	/** Required. Insert / delete / replace semantic. */
	op: "ins" | "del" | "replace";
	/**
	 * Required. Anchor of the FIRST line of the affected range. A plain
	 * anchor string when `require_line_content` is OFF; a
	 * `{ anchor, line }` declaration pair when ON (see declaration.ts).
	 */
	anchor_start: AnchorRef;
	/**
	 * Anchor of the LAST line. Optional for `replace` (omit = single-line
	 * passes the same anchor twice); optional for `del` (omit = one line);
	 * forbidden for `ins`. Same dual form as `anchor_start`.
	 */
	anchor_end?: AnchorRef;
	/** Required for `ins` and `replace`; ignored for `del` (deletion is anchor-defined). New content (for `ins`: lines to insert; for `replace`: lines to substitute). */
	lines?: string[];
	/** Optional per-item path override (multi-file edits in one call). */
	path?: string;
}

/** The anchor string of either anchor-field form (post-validation). */
export function anchorOf(ref: AnchorRef): string {
	return typeof ref === "string" ? ref : ref.anchor;
}

/** The declared line text, when the anchor field is the declaration form. */
export function declaredLineOf(ref: AnchorRef): string | undefined {
	return typeof ref === "string" ? undefined : ref.line;
}

export interface EditParams {
	/**
	 * Default path for the edits. Optional iff every item in `edits` carries its
	 * own `path`; otherwise required (non-empty string). When present, items
	 * without their own `path` use this as the file; items with their own `path`
	 * override it per-item.
	 */
	path?: string;
	edits: EditItemParams[];
	/** Optional: render diff rows with `<line>:<anchor>` markers (default false). */
	line_numbers?: boolean;
}

export interface ReadParams {
	path: string;
	offset?: number;
	limit?: number;
	/** Optional: render rows with `<line>:<anchor>` markers (default false). */
	line_numbers?: boolean;
}

export interface UndoParams {
	path: string;
	/** Optional: render restored diff rows with `<line>:<anchor>` markers (default false). */
	line_numbers?: boolean;
}

// ---- filed sets (declared once) ---------------------------------------------

const EDIT_KS = new Set([
	"path",
	"edits",
	"line_numbers",
	"sandbox_permissions",
	"justification",
]);

const EDIT_ITEM_KS = new Set([
	"op",
	"anchor_start",
	"anchor_end",
	"lines",
	"path",
]);

/** Fields of the `{ anchor, line }` declaration form (require_line_content ON). */
const ANCHOR_DECLARATION_KS = new Set(["anchor", "line"]);

const READ_KS = new Set(["path", "offset", "limit", "line_numbers"]);

// ---- normalization -----------------------------------------------------------

/**
 * Normalize `file_path` → `path` alias on the request record. Returns the
 * input unchanged when not a record; otherwise returns a shallow copy with
 * the alias applied so callers never mutate the original `args` object.
 */
export function normalizeRequest(input: unknown): unknown {
	if (!isRec(input)) return input;
	const record: Record<string, unknown> = { ...input };
	normalizeFilePath(record);
	return record;
}

/** @deprecated use normalizeRequest — kept as alias for migration */
export const normReq = normalizeRequest;

// ---- assertions ---------------------------------------------------------------


/**
 * Validate one anchor field in its dual form (contract #76).
 *
 * OFF (`requireLineContent` false): the field must be a plain non-empty
 * anchor string; the `{ anchor, line }` object form is a shape error that
 * points at the setting.
 *
 * ON: the field must be a `{ anchor, line }` pair — `anchor` non-empty,
 * `line` a single-line string (empty string declares an empty line). A
 * plain string is a MISSING declaration and is rejected with the exact
 * object shape to send.
 */
function assertAnchorField(
	value: unknown,
	field: "anchor_start" | "anchor_end",
	index: number,
	requireLineContent: boolean,
): void {
	const label = `edits[${index}].${field}`;
	if (!requireLineContent) {
		if (isRec(value)) {
			throw new Error(
				`[E_BAD_SHAPE] ${label} must be an anchor string; the { anchor, line } object form is only valid when the hashline.require_line_content setting is enabled.`,
			);
		}
		if (typeof value !== "string" || value.length === 0) {
			throw new Error(
				`[E_BAD_SHAPE] ${label} must be a non-empty anchor string (variable-length Base62 or \`<line>:<anchor>\`).`,
			);
		}
		return;
	}
	if (typeof value === "string") {
		throw new Error(
			value.length === 0
				? `[E_BAD_SHAPE] ${label} must be a { anchor, line } object — require_line_content is ON: anchor is required, and line must declare the current full text of that line.`
				: `[E_BAD_SHAPE] ${label} is missing the required line declaration — require_line_content is ON, so pass { anchor: ${JSON.stringify(value)}, line: "<the current full text of that line>" }.`,
		);
	}
	if (!isRec(value)) {
		throw new Error(
			`[E_BAD_SHAPE] ${label} must be a { anchor, line } object — require_line_content is ON.`,
		);
	}
	rejectUnknownFields(value, ANCHOR_DECLARATION_KS, label);
	if (typeof value.anchor !== "string" || value.anchor.length === 0) {
		throw new Error(
			`[E_BAD_SHAPE] ${label}.anchor must be a non-empty anchor string (variable-length Base62 or \`<line>:<anchor>\`).`,
		);
	}
	if (typeof value.line !== "string") {
		throw new Error(
			`[E_BAD_SHAPE] ${label}.line is required: declare the current full text of the line (an empty string declares an empty line).`,
		);
	}
	if (value.line.includes("\n")) {
		throw new Error(
			`[E_BAD_SHAPE] ${label}.line must be a SINGLE line of text (no newlines) — the current full text of the line the anchor resolves to.`,
		);
	}
}
/**
 * Validate one edit item. Throws `[E_BAD_SHAPE]` with a path-qualified
 * message on the first violation. Validation rules:
 *   - `op` is required and one of `ins` / `del` / `replace`
 *   - `anchor_start` / `anchor_end` follow the dual form: plain anchor
 *     strings when `requireLineContent` is OFF; `{ anchor, line }`
 *     declaration pairs when ON (missing `line` = missing declaration,
 *     object form when OFF = shape error; see declaration.ts)
 *   - `anchor_end` is forbidden for `op: "ins"`, optional otherwise (required for `op: "replace"`)
 *   - `lines` is required and must be a non-empty string array for `ins` /
 *     `replace`; on `del` it is accepted and IGNORED (anchor-defined deletion)
 *   - per-item `path`, if set, must be a non-empty string
 */
export function assertEditItem(
	item: unknown,
	index: number,
	hasTopLevelPath: boolean,
	requireLineContent: boolean,
): asserts item is EditItemParams {
	if (!isRec(item)) {
		throw new Error(
			`[E_BAD_SHAPE] edits[${index}] must be an object with op, anchor_start, and (when applicable) anchor_end / lines.`,
		);
	}
	rejectUnknownFields(item, EDIT_ITEM_KS, `edits[${index}]`);
	if (item.op !== "ins" && item.op !== "del" && item.op !== "replace") {
		throw new Error(
			`[E_BAD_SHAPE] edits[${index}].op must be "ins", "del", or "replace".`,
		);
	}
	assertAnchorField(item.anchor_start, "anchor_start", index, requireLineContent);
	if (item.anchor_end !== undefined) {
		assertAnchorField(item.anchor_end, "anchor_end", index, requireLineContent);
	}
	if (item.op === "replace" && item.anchor_end === undefined) {
		// v2.0.3 (#68-class DX): omitted anchor_end defaults to a SINGLE-LINE
		// replace (range = start..start). The model forgetting to duplicate the
		// anchor was the highest-frequency contract failure, and for single-line
		// edits the end anchor is pure redundancy. A MULTI-line replacement
		// still requires it explicitly: lines.length > 1 with no end anchor is
		// an under-specified range declaration — reject rather than silently
		// replacing one line and leaving the rest of the intended range behind.
		const lineCount = Array.isArray(item.lines) ? item.lines.length : 0;
		if (lineCount > 1) {
			throw new Error(
				`[E_MISSING_ANCHOR_END] edits[${index}].op:"replace" with ${lineCount} replacement lines requires BOTH anchor_start and anchor_end — omit anchor_end only for a SINGLE-line replace (or pass the same anchor twice). For multi-line ranges, anchor_end is the verified boundary; the tool will not guess it from the replacement length.`,
			);
		}
		// single-line replace / del without anchor_end: the fold end = start is
		// applied downstream (buildPreparedItem / assertItem) — args may be
		// frozen by the host runner, so validation must not mutate them.
	}
	if (item.op === "ins" || item.op === "replace") {
		if (
			!Array.isArray(item.lines) ||
			!(item.lines as unknown[]).every((l) => typeof l === "string") ||
			(item.lines as unknown[]).length === 0
		) {
			throw new Error(
				item.op === "ins"
					? `[E_BAD_SHAPE] edits[${index}].op:"ins" requires a non-empty "lines" array of strings to insert.`
					: `[E_BAD_SHAPE] edits[${index}].op:"replace" requires a non-empty "lines" array of strings. Use op:"del" to delete.`,
			);
		}
	}
	// op:"del" with `lines` set: accepted and IGNORED (issue #69 user feedback) —
	// deletion is anchor-defined; the model sometimes carries lines from a
	// copy-pasted replace pattern, and a hard reject forced a pointless retry.
	if (item.path !== undefined) {
		if (typeof item.path !== "string" || item.path.length === 0) {
			throw new Error(
				`[E_BAD_SHAPE] edits[${index}].path must be a non-empty string.`,
			);
		}
	} else if (!hasTopLevelPath) {
		throw new Error(
			`[E_BAD_SHAPE] edits[${index}] requires a "path" string (top-level or per-item).`,
		);
	}
}

export function assertEditRequest(
	request: unknown,
	requireLineContent: boolean,
): asserts request is EditParams {
	if (!isRec(request)) {
		throw new Error("[E_BAD_SHAPE] Edit request must be an object.");
	}

	rejectUnknownFields(request, EDIT_KS, "Edit request");

	const topLevelPath = request.path;
	const hasTopLevelPath = typeof topLevelPath === "string" && topLevelPath.length > 0;
	if (hasTopLevelPath) {
		normalizeFilePath(request);
	}

	if (!Array.isArray(request.edits) || request.edits.length === 0) {
		throw new Error(
			'[E_BAD_SHAPE] Edit request requires a non-empty "edits" array.',
		);
	}
	if (request.edits.length > EDITS_MAX_ITEMS) {
		throw new Error(
			`[E_BAD_SHAPE] Edit accepts at most ${EDITS_MAX_ITEMS} edits; got ${request.edits.length}. Split the batch.`,
		);
	}
	request.edits.forEach((item, index) => {
		assertEditItem(item, index, hasTopLevelPath, requireLineContent);
	});
}

export function assertReadRequest(
	request: unknown,
): asserts request is ReadParams {
	if (!isRec(request)) {
		throw new Error("[E_BAD_SHAPE] Read request must be an object.");
	}
	rejectUnknownFields(request, READ_KS, "Read request");
	if (typeof request.path !== "string" || request.path.length === 0) {
		throw new Error(
			'[E_BAD_SHAPE] Read request requires a non-empty "path" string.',
		);
	}
}

export function assertUndoRequest(
	request: unknown,
): asserts request is UndoParams {
	if (!isRec(request)) {
		throw new Error("[E_BAD_SHAPE] undo_last_edit request must be an object.");
	}
	normalizeFilePath(request);
	if (typeof request.path !== "string" || request.path.length === 0) {
		throw new Error(
			'[E_BAD_SHAPE] undo_last_edit request requires a non-empty "path" string.',
		);
	}
}

// ---- shared JSON Schema literals (co-located with field sets) ---------------

/**
 * Shared model-facing parameter schemas for the hashline tools, expressed in
 * the dsh schema DSL (not TypeBox). `path` is deliberately NOT `required` at
 * the schema level: the tools accept the built-in `file_path` spelling too
 * (the implicit parameter root stays open), and enforce path presence in
 * `assertEditRequest` after `normalizeFilePath` aliasing.
 */

/**
 * The `{ anchor, line }` declaration-pair schema (require_line_content ON).
 */
function anchorDeclarationSchema(required: boolean): ParameterPropertySpec {
	if (required) {
		return {
			type: "object",
			additionalProperties: false,
			required: true,
			description:
				"Anchor + declared line content pair: the edit applies only when `line` matches the current text of the line `anchor` resolves to.",
			properties: {
				anchor: {
					type: "string",
					required: true,
					description:
						"The anchor (variable-length Base62 from a read/grep/diff row; `<line>:<anchor>` also accepted).",
				},
				line: {
					type: "string",
					required: true,
					description:
						'Your declaration of the line\'s CURRENT full text, verbatim (trailing whitespace may be omitted; a copied read-row marker prefix is tolerated). Single line only — no newlines; an empty string declares an empty line. A mismatch rejects with [E_CONTENT_MISMATCH].',
				},
			},
		} as const;
	}
	return {
		type: "object",
		additionalProperties: false,
		description:
			"Anchor + declared line content pair: the edit applies only when `line` matches the current text of the line `anchor` resolves to.",
		properties: {
			anchor: {
				type: "string",
				required: true,
				description:
					"The anchor (variable-length Base62 from a read/grep/diff row; `<line>:<anchor>` also accepted).",
			},
			line: {
				type: "string",
				required: true,
				description:
					'Your declaration of the line\'s CURRENT full text, verbatim (trailing whitespace may be omitted; a copied read-row marker prefix is tolerated). Single line only — no newlines; an empty string declares an empty line. A mismatch rejects with [E_CONTENT_MISMATCH].',
			},
		},
	} as const;
}

export function buildEditItemSchema(requireLineContent: boolean): ParameterPropertySpec {
	return {
		type: "object",
		additionalProperties: false,
		properties: {
			op: {
				type: "string",
				enum: ["ins", "del", "replace"],
				required: true,
				description:
					'Edit semantic. "ins" inserts `lines` AFTER the `anchor_start` line; "del" removes the range; "replace" swaps it with `lines`.',
			},
			anchor_start: requireLineContent
				? anchorDeclarationSchema(true)
				: {
					type: "string",
					required: true,
					description:
						'Required. Anchor (variable-length Base62 from a read/grep/diff row; `<line>:<anchor>` with the line_numbers option is accepted, anchor authoritative) of the FIRST line of the range. For `op:"ins"`, the lines land AFTER this line.'
				},
			anchor_end: requireLineContent
				? anchorDeclarationSchema(false)
				: {
					type: "string",
					description:
						'Anchor (variable-length Base62) of the LAST line of the range. Optional for `op:"replace"` and `op:"del"` — omitting it defaults to a SINGLE-line replace/delete (range = anchor_start only). REQUIRED when the replacement has more than one line (`lines.length > 1`): the tool will not guess a multi-line range from the replacement length. Ignored for `op:"ins"` (a warning is returned instead — ins inserts after `anchor_start`; do not pass anchor_end).'
				},
			lines: {
				type: "array",
				items: { type: "string" },
				description:
					'Required and must be non-empty for `op:"ins"` and `op:"replace"`. On `op:"del"` it is accepted and IGNORED — deletion is defined by the anchors alone. For `ins`: lines to insert after `anchor_start`. For `replace`: lines to substitute the anchor_start..anchor_end range with. Pass `[""]` to clear a single line (still a replace, not a del).',
			},
			path: {
				type: "string",
				description:
					"Optional per-item path override (multi-file edits in one call). Overrides the top-level `path` for this edit only.",
			},
		},
	} as const;
}

export function buildEditsSchema(requireLineContent: boolean): ParameterPropertySpec {
	return {
		type: "array",
		required: true,
		description:
			"Ordered list of edits to apply atomically. Edits apply in order against evolving content; each one sees the file state after the previous edit in the same call. All anchors come from one read (original snapshot) — re-read for fresh anchors after an edit (there is no `Shift:` block in v2.0).",
		items: buildEditItemSchema(requireLineContent),
	} as const;
}

export const pathSchema = {
	type: "string",
	description:
		"Default path for the edits. Required unless every item carries its own `path`. Accepts the built-in `file_path` spelling too.",
} as const;

/**
 * Read tool path spelling. `file_path` is the ONLY model-facing name:
 * the dsh 0.1.2 web client validates the raw call args (`JSON.parse(argsRaw)`,
 * before any normalize layer) against `file_path` to derive the read card, so
 * the schema declares exactly that spelling and the description teaches it.
 * `path` is deliberately NOT a schema parameter anymore (removed in #69);
 * `normalizeRequest` still folds a `path` key into `path` before validation,
 * so direct API callers predating the rename keep working without a card.
 */
export const readFilePathSchema = {
	type: "string",
	description:
		"Path of the file to read. Preferred spelling (also what the web UI expects).",
} as const;


/** Optional line-number output toggle shared by read/grep/edit/undo. */
export const lineNumbersSchema = {
	type: "boolean",
	description:
		"When true, each output row's marker is prefixed with its 1-indexed line as `<line>:<anchor>` (informational positional hint only — the anchor is authoritative; markers remain editable either form). Default true — pass `false` for bare `<anchor>` rows.",
} as const;

/** @deprecated — kept for backward compat with the pre-0.4 contract. */
export const replacementTextSchema = {
	type: "string",
	description:
		"DEPRECATED: use the new `edits[].lines` shape. Kept for compatibility only; the model should never use this directly.",
} as const;

/** @deprecated — kept for backward compat with the pre-0.4 contract. */
export const removeFromSchema = {
	type: "string",
	description:
		"DEPRECATED: use the new `edits[].from` shape. Kept for compatibility only.",
} as const;

/** @deprecated — kept for backward compat with the pre-0.4 contract. */
export const removeToSchema = {
	type: "string",
	description:
		"DEPRECATED: use the new `edits[].to` shape. Kept for compatibility only.",
} as const;
