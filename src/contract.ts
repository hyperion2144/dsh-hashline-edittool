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
 * with named fields (`op` / `from` / `to?` / `lines?`) and an `op` semantic
 * distinguishing `ins` / `del` / `replace`. The legacy `batch_edit` tool
 * is removed; its multi-file capability is preserved as a per-item
 * optional `path` that overrides the top-level `path`. `remove_from` /
 * `remove_to` / `replacement_text` are gone — use `from` / `to` / `lines`
 * inside each `edits[i]` instead. See `docs/edit-payload-spec.md` for the
 * full design and the rationale.
 * @module dsh-hashline-edittool/contract
 */

import { EDITS_MAX_ITEMS } from "./constants.js";
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
	/** Required. Anchor of the FIRST line of the affected range. */
	anchor_start: string;
	/**
	 * Anchor of the LAST line. REQUIRED for `replace` (single-line replace
	 * passes the same anchor twice); optional for `del` (omit = one line);
	 * forbidden for `ins`.
	 */
	anchor_end?: string;
	/** Required for `ins` and `replace`; forbidden for `del`. New content (for `ins`: lines to insert; for `replace`: lines to substitute). */
	lines?: string[];
	/** Optional per-item path override (multi-file edits in one call). */
	path?: string;
}

export interface EditParams {
	path: string;
	edits: EditItemParams[];
}

export interface ReadParams {
	path: string;
	offset?: number;
	limit?: number;
}

export interface UndoParams {
	path: string;
}

// ---- filed sets (declared once) ---------------------------------------------

const EDIT_KS = new Set([
	"path",
	"edits",
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

const READ_KS = new Set(["path", "offset", "limit"]);

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
 * Validate one edit item. Throws `[E_BAD_SHAPE]` with a path-qualified
 * message on the first violation. Validation rules:
 *   - `op` is required and one of `ins` / `del` / `replace`
 *   - `from` is required and a non-empty string (the anchor)
 *   - `to` is forbidden for `op: "ins"`, optional otherwise
 *   - `lines` is required and must be a non-empty string array for `ins` /
 *     `replace`, and forbidden for `del`
 *   - per-item `path`, if set, must be a non-empty string
 */
export function assertEditItem(
	item: unknown,
	index: number,
	hasTopLevelPath: boolean,
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
	if (typeof item.anchor_start !== "string" || item.anchor_start.length === 0) {
		throw new Error(
			`[E_BAD_SHAPE] edits[${index}].anchor_start must be a non-empty "<line>#<hash>" anchor string (e.g. "12#aB3").`,
		);
	}
	if (item.anchor_end !== undefined) {
		if (typeof item.anchor_end !== "string" || item.anchor_end.length === 0) {
			throw new Error(
				`[E_BAD_SHAPE] edits[${index}].anchor_end must be a non-empty anchor string when provided.`,
			);
		}
		if (item.op === "ins") {
			throw new Error(
				`[E_BAD_SHAPE] edits[${index}].op:"ins" does not accept "anchor_end"; ins inserts immediately after "anchor_start".`,
			);
		}
	}
	if (item.op === "replace" && item.anchor_end === undefined) {
		throw new Error(
			`[E_MISSING_ANCHOR_END] edits[${index}].op:"replace" requires BOTH anchor_start and anchor_end — replace always swaps a whole range; for a single-line replace pass the same anchor twice (anchor_start === anchor_end). To insert lines, use op:"ins".`,
		);
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
	} else if (item.lines !== undefined) {
		throw new Error(
			`[E_BAD_SHAPE] edits[${index}].op:"del" does not accept "lines"; use op:"replace" with lines:[""] to clear a single line.`,
		);
	}
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
): asserts request is EditParams {
	if (!isRec(request)) {
		throw new Error("[E_BAD_SHAPE] Edit request must be an object.");
	}

	rejectUnknownFields(request, EDIT_KS, "Edit request");

	if (typeof request.path !== "string" || request.path.length === 0) {
		throw new Error(
			'[E_BAD_SHAPE] Edit request requires a non-empty "path" string.',
		);
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

	const hasTopLevelPath = true;
	request.edits.forEach((item, index) => {
		assertEditItem(item, index, hasTopLevelPath);
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

export const editItemSchema = {
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
		anchor_start: {
			type: "string",
			required: true,
			description:
				'Required. Anchor (line#hash from a read/grep/diff row) of the FIRST line of the range. For `op:"ins"`, the lines land AFTER this line.',
		},
		anchor_end: {
			type: "string",
			description:
					'Anchor of the LAST line of the range. REQUIRED for `op:"replace"` (single-line replace passes the same anchor twice); optional for `del` (omit = one line). Forbidden for `op:"ins"`.',
		},
		lines: {
			type: "array",
			items: { type: "string" },
			description:
				'Required and must be non-empty for `op:"ins"` and `op:"replace"`. Forbidden for `op:"del"`. For `ins`: lines to insert after `anchor_start`. For `replace`: lines to substitute the anchor_start..anchor_end range with. Pass `[""]` to clear a single line (still a replace, not a del).',
		},
		path: {
			type: "string",
			description:
				"Optional per-item path override (multi-file edits in one call). Overrides the top-level `path` for this edit only.",
		},
	},
} as const;

export const editsSchema = {
	type: "array",
	description:
		"Ordered list of edits to apply atomically in one file (or across files when per-item `path` overrides). Edits apply in order against evolving content; each one sees the file state after the previous edit in the same call. After the call, a per-hunk `Shift:` block tells the model how the absolute line numbers below the edits moved, so the next edit can chain via `newLine=<N>#<oldHash>` from the next unchanged diff row (if rendered), or read for fresh anchors.",
	items: editItemSchema,
} as const;

export const pathSchema = {
	type: "string",
	description:
		"Default path for the edits. Required unless every item carries its own `path`. Accepts the built-in `file_path` spelling too.",
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
