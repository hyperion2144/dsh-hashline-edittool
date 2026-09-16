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
 * with named fields (`op` / `anchor_after?` / `anchor_start?` / `anchor_end?` / `lines?`) and an `op` semantic
 * distinguishing `ins` / `del` / `replace`. **Which anchor field is legal depends on the
 * op**: `ins` takes `anchor_after`, the other two take `anchor_start`, and a call that
 * mixes them is refused. See `EditItemParams.anchor_after` for why the names differ.
 * (An earlier revision of THIS line said `op` / `anchor_start` / `anchor_end?` / `lines?`).
 * is removed; its multi-file capability is preserved as a per-item
 * optional `path` that overrides the top-level `path`. `remove_from` /
 * `remove_to` / `replacement_text` are gone — use `anchor_start` / `anchor_end` / `lines`
 * inside each `edits[i]` instead. See `docs/edit-payload-spec.md` for the
 * full design and the rationale.
 * @module dsh-hashline-edittool/contract
 */

import type { ParameterPropertySpec, ParameterSchemaSpec } from "@deepseek-ai/dsh-tools";
import { EDITS_MAX_ITEMS } from "../infra/constants.js";
import type { AnchorRef } from "../hashline/declaration.js";
import { isRec, normalizeFilePath, rejectUnknownFields } from "../infra/utils.js";

// ---- request shapes --------------------------------------------------------

/**
 * One edit within the `edits:[]` array. The `op` field disambiguates
 * insert / delete / replace semantics so the model can state its
 * intent unambiguously; the runtime never has to guess between
 * "replace with empty" and "delete this range".
 */
/**
 * The edit vocabulary: line-anchored, and only line-anchored.
 *
 * `replace_block` and `del_block` used to live here — a symbol-anchored op whose
 * extent the engine resolved, so the model could not self-certify an end it had
 * not checked. That reasoning was sound and the ANSWER was wrong: resolving an
 * extent from a symbol is a structural question, and answering it inside the
 * line engine is what made `edit` depend on a grammar.
 *
 * `ast_edit` asks it now, by SHAPE, and hands a resolved line edit back here.
 * The engine stayed what it was: three ops, no grammar, no switch.
 */
export type EditOp = "ins" | "del" | "replace" | "sed";


export interface EditItemParams {
	/** Required. Insert / delete / replace / sed semantic. */
	op: EditOp;
	/**
	 * Required. Anchor of the FIRST line of the affected range. A plain
	 * anchor string when `require_line_content` is OFF; a
	 * `{ anchor, line }` declaration pair when ON (see declaration.ts).
	 */
	/**
	 * Required for `replace` and `del`, forbidden for `ins`. Anchor of the FIRST
	 * line of the affected RANGE — and for `replace`, `lines` is what that range
	 * BECOMES, so the range's own lines do belong there.
	 */
	anchor_start?: AnchorRef;
	/**
	 * Required for `ins`, forbidden for the other two. The anchor whose line the
	 * new lines are placed BELOW.
	 *
	 * NOT CALLED `anchor_start`, DELIBERATELY. Under a shared name, a caller that
	 * had just used `replace` — where `anchor_start` begins a range whose content
	 * `lines` CONSUMES — carried that reading into `ins`, wrote the anchor's own
	 * line into `lines`, and got a duplicate. It was not carelessness: the field
	 * was the same name, so the habit transferred. Here there is no range for
	 * `lines` to consume and no `anchor_start` to misread, and a call that sends
	 * one anyway is REFUSED rather than transliterated.
	 */
	anchor_after?: AnchorRef;
	/**
	 * Anchor of the LAST line. Optional for `replace` (omit = single-line
	 * passes the same anchor twice); optional for `del` (omit = one line);
	 * forbidden for `ins`. Same dual form as `anchor_start`.
	 */
	anchor_end?: AnchorRef;
	/** Required for `ins` and `replace`; ignored for `del` (deletion is anchor-defined); FORBIDDEN for `sed` (its replacement comes from `pattern`/`replacement`). New content (for `ins`: lines to insert; for `replace`: lines to substitute). */
	lines?: string[];
	/**
	 * `op: "sed"` only. Regular-expression SOURCE applied to every line of the
	 * anchor range, exactly as `sed` works a stream: line by line, so a pattern
	 * never spans two lines. Without the `g` flag only the FIRST match on each
	 * line is replaced, which is sed's own default.
	 */
	pattern?: string;
	/**
	 * `op: "sed"` only. The replacement text. Both dialects work: sed's `\1` and
	 * `&` are translated to `$1` / `$&`, and JavaScript's `$1` / `$&` pass through
	 * unchanged. An empty string DELETES what the pattern matched.
	 */
	replacement?: string;
	/** `op: "sed"` only. A unique subset of `gims`: `g` (every match per line), `i` (ignore case), `m` (^ and $ match line boundaries), `s` (dot matches newline). Default: none. */
	flags?: string;
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
	// No `symbol` / `kind` / `anchor` / `references` / `include`.
	//
	// They were the AST fold: selectors that made a LINE reader need a grammar
	// and a global switch. `ast_grep` answers them now (with no pattern it
	// returns the outline) and `lsp` answers anything semantic — so the parser
	// no longer accepts them, and a stale call fails loudly instead of being
	// silently answered as a line window.
}

export interface UndoParams {
	path: string;
	/** Optional: render restored diff rows with `<line>:<anchor>` markers (default false). */
	line_numbers?: boolean;
}

// ---- field sets (derived — the schema is the single authority) --------------

// ADR-0002 D5 makes the schema the canonical statement of the request shape,
// so the validator's unknown-field sets are DERIVED from the schema factories
// instead of being hand-written alongside them. A field added to the schema is
// accepted by the validator automatically; a field removed from it is rejected
// automatically. (The `EditItemParams` type stays the compile-time face;
// require-line-content tests pin the schema factories to each other.)

const EDIT_KS = new Set([
	"path",
	"edits",
	"line_numbers",
	"sandbox_permissions",
	"justification",
]);

const EDIT_ITEM_KS = new Set(
	Object.keys((buildEditItemSchema(false) as { properties?: Record<string, unknown> }).properties ?? {}),
);

/** Fields of the `{ anchor, line }` declaration form (require_line_content ON). */
const ANCHOR_DECLARATION_KS = new Set(
	Object.keys((anchorDeclarationSchema(true) as { properties?: Record<string, unknown> }).properties ?? {}),
);

/**
 * The AST parameters exist only while `ast.enabled` is true: with AST off the
 * tool surface is rebuilt without them (spec §7.4), so an AST parameter here
 * is always a caller error, never a silently ignored extra.
 */
const READ_KS = new Set([
	"path",
	"offset",
	"limit",
	"line_numbers",
]);

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
	field: "anchor_start" | "anchor_end" | "anchor_after",
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
			`[E_BAD_SHAPE] edits[${index}] must be an object with op and an anchor — \`anchor_after\` for op:"ins", \`anchor_start\` for the other ops — plus (when applicable) anchor_end / lines / pattern.`,
		);
	}
	rejectUnknownFields(item, EDIT_ITEM_KS, `edits[${index}]`);
	if (
		item.op !== "ins" &&
		item.op !== "del" &&
		item.op !== "replace" &&
		item.op !== "sed"
	) {
		throw new Error(
			`[E_BAD_SHAPE] edits[${index}].op must be one of "ins", "del", "replace", "sed". Structural changes go through \`ast_edit\`, which resolves a shape into exactly these.`,
		);
	}
	// WHICH ANCHOR FIELD IS LEGAL DEPENDS ON THE OP, and the check is hard.
	//
	// `ins` takes `anchor_after` and ONLY that; `replace` / `del` take
	// `anchor_start` and only that. A call that mixes them is rejected rather than
	// transliterated — accepting `anchor_start` on `ins` for compatibility would
	// keep the very habit this change exists to break.
	if (item.op === "ins") {
		if (item.anchor_start !== undefined) {
			throw new Error(
				`[E_BAD_SHAPE] edits[${index}].op:"ins" takes "anchor_after", not "anchor_start". The anchor is a POSITION to insert below, not the start of a range: the line it names is kept, and \`lines\` holds only what is NEW.`,
			);
		}
		if (item.anchor_end !== undefined) {
			throw new Error(
				`[E_BAD_SHAPE] edits[${index}].op:"ins" has no "anchor_end": insert below "anchor_after" — one anchor, one position.`,
			);
		}
		if (item.anchor_after === undefined) {
			throw new Error(
				`[E_BAD_SHAPE] edits[${index}].op:"ins" requires "anchor_after" — the anchor whose line the new lines go BELOW.`,
			);
		}
		assertAnchorField(item.anchor_after, "anchor_after", index, requireLineContent);
	} else {
		if (item.anchor_after !== undefined) {
			throw new Error(
				`[E_BAD_SHAPE] edits[${index}].op:"${item.op}" takes "anchor_start", not "anchor_after" — it names a RANGE, and \`lines\` is what that range becomes.`,
			);
		}
		assertAnchorField(item.anchor_start, "anchor_start", index, requireLineContent);
	}
	if (item.anchor_end !== undefined) {
		assertAnchorField(item.anchor_end, "anchor_end", index, requireLineContent);
	}
	if (item.op === "replace" && item.anchor_end === undefined) {
		// omitted anchor_end defaults to a SINGLE-LINE replace (range =
		// start..start). The replacement (`lines`) may have ANY number of
		// lines — "replace one line with many" is the common case. The fold
		// end = start is applied downstream (buildPreparedItem); args may be
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
					: `[E_BAD_SHAPE] edits[${index}].op:"${item.op}" requires a non-empty "lines" array of strings. Use op:"del" to delete.`,
			);
		}
	}
	if (item.op === "sed") {
		// sed IS the replacement, so `lines` is a contradiction, not a spare
		// field: accepting both would leave the caller guessing which one won.
		if (item.lines !== undefined) {
			throw new Error(
				`[E_BAD_SHAPE] edits[${index}].op:"sed" takes "pattern" + "replacement", not "lines" — the substitution IS the new content.`,
			);
		}
		if (typeof item.pattern !== "string" || item.pattern.length === 0) {
			throw new Error(
				`[E_BAD_SHAPE] edits[${index}].op:"sed" requires a non-empty "pattern" (regular-expression source, applied line by line over the anchor range).`,
			);
		}
		if (typeof item.replacement !== "string") {
			throw new Error(
				`[E_BAD_SHAPE] edits[${index}].op:"sed" requires "replacement" (a string; empty deletes what the pattern matched).`,
			);
		}
		if (item.replacement.includes("\n")) {
			// sed substitutes WITHIN a line: one line in, one line out. Allowing a
			// newline here would change the range's line count behind every
			// downstream hunk calculation, and `op:"replace"` already does that job
			// honestly.
			throw new Error(
				`[E_BAD_SHAPE] edits[${index}].replacement must not contain a newline — op:"sed" rewrites each line in place. Use op:"replace" to change the line count.`,
			);
		}
		if (item.flags !== undefined) {
			if (typeof item.flags !== "string" || !/^[gims]*$/.test(item.flags) || new Set(item.flags).size !== item.flags.length) {
				throw new Error(
					`[E_BAD_SHAPE] edits[${index}].flags must be a unique subset of "gims" (g = every match per line, i = ignore case, m = multi-line anchors, s = dot matches newline).`,
				);
			}
		}
		// Compiled HERE so a bad pattern fails as a shape error with the regex
		// engine's own words, instead of surfacing later as a mysterious no-op.
		const flags = item.flags === undefined || item.flags === "" ? "" : item.flags;
		try {
			new RegExp(item.pattern, flags);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`[E_BAD_SHAPE] edits[${index}].pattern is not a valid regular expression: ${message}`,
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
	// No cross-field AST rules any more, and their absence is the point: those
	// selectors are gone, so `rejectUnknownFields` above is the whole story — a
	// call still carrying one is rejected as an unknown field, which is the
	// honest answer. `validateReadAstFields` survived the removal because it
	// takes `Record<string, unknown>`, so the type checker could not see that the
	// fields it validates no longer exist and that `rejectUnknownFields` had
	// already made it unreachable.
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
				enum: ["ins", "del", "replace", "sed"],
				required: true,
				description:
					'Edit semantic. Line ops name their range: "ins" puts `lines` BELOW the `anchor_after` line, which is KEPT — `lines` holds only what is NEW, so the anchor line must NOT appear in it; "del" removes the `anchor_start..anchor_end` range; "replace" swaps it with `lines`; "sed" rewrites EVERY line of that range with the regular expression in `pattern` (with `replacement` and optional `flags`) — line by line, so the range\'s line count never changes and a pattern never spans two lines. ' +
					'For a STRUCTURAL change — replace or delete a function, class or method as a whole — use `ast_edit` with a pattern: it resolves the extent from the parse and applies the result through this same engine. That is why there is no block op here.',
			},
			// The `ins` anchor, under its own name. See `anchor_after` on the type.
			anchor_after: requireLineContent
					// OPTIONAL at the schema level, both of them: which one is REQUIRED
					// depends on `op`, and a schema cannot express that. `assertEditItem`
					// enforces the per-op rule, and neither is marked required here so a
					// `replace` is never asked for an `anchor_after` it must not send.
					? anchorDeclarationSchema(false)
				: {
						type: "string",
						description:
							'REQUIRED FOR `op:"ins"`, forbidden otherwise. The anchor whose line the new lines go BELOW. It is a POSITION — the line it names is kept, and `lines` holds ONLY the new lines. Deliberately not named `anchor_start`: under that name a caller who had just used `replace` wrote the anchor\'s own line into `lines` and duplicated it. Sending `anchor_start` with `op:"ins"` is refused.',
					},
			anchor_start: requireLineContent
				? anchorDeclarationSchema(false)
				: {
						type: "string",
						description:
							'Required for `op:"replace"` and `op:"del"`, forbidden for `op:"ins"` (which takes `anchor_after`). Anchor of the FIRST line of the RANGE — and `lines` is what that range BECOMES, so for `replace` the range\'s own lines DO belong in `lines`.',
					},
			anchor_end: requireLineContent
				? anchorDeclarationSchema(false)
				: {
					type: "string",
					description:
						'Anchor (variable-length Base62) of the LAST line of the range. Optional for `op:"replace"` and `op:"del"` — omitting it defaults to a SINGLE-line range (anchor_start only); the replacement `lines` may have any number of lines (replacing one line with many is fine). Pass `anchor_end` when the RANGE spans multiple original lines. Forbidden for `op:"ins"`, which has one anchor and no range.'
				},
			lines: {
				type: "array",
				items: { type: "string" },
				description:
					'Required and must be non-empty for `op:"ins"` and `op:"replace"`. On `op:"del"` it is accepted and IGNORED — deletion is defined by the anchors alone. FORBIDDEN on `op:"sed"`, whose replacement is `pattern`/`replacement`. For `ins`: ONLY the new lines that go BELOW `anchor_after` — the anchor\'s own line is kept, and putting it here duplicates it. For `replace`: the lines that SUBSTITUTE the anchor_start..anchor_end range, so the range\'s original lines do not belong here either. Pass `[""]` to clear a single line (still a replace, not a del).'
			},
			pattern: {
				type: "string",
				description:
					'`op:"sed"` only. Regular-expression SOURCE applied to every line of the `anchor_start..anchor_end` range, exactly as command-line sed works a stream: line by line, so a pattern never spans two lines. Without the `g` flag only the FIRST match on each line is replaced — sed\'s own default. Keep it cheap: the regex runs once per line of the range.',
			},
			replacement: {
				type: "string",
				description:
					'`op:"sed"` only. The replacement text. Both dialects work: sed\'s `\\1` (group) and `&` (whole match) are translated, and JavaScript\'s `$1` / `$&` pass through unchanged. An empty string DELETES what the pattern matched. It must NOT contain a newline — sed substitutes within a line, so the range\'s line count never changes; use `op:"replace"` when lines must be added or removed.',
			},
			flags: {
				type: "string",
				description:
					'`op:"sed"` only. Any unique combination of: `g` (every match per line, not just the first), `i` (ignore case), `m` (^ and $ match line boundaries), `s` (. matches newline). Omit for sed\'s default behaviour.',
			},
			path: {
				type: "string",
				description:
					"Optional per-item path override (multi-file edits in one call). Overrides the top-level `path` for this edit only.",
			},
		},
	} as const;
}

export function buildEditsSchema(
	requireLineContent: boolean,
): ParameterPropertySpec & { items: ParameterPropertySpec } {
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
		"When true, each output row's marker carries its 1-indexed line as `<anchor>:<line>` — the anchor first (the token to copy), its line number trailing as a positional hint. The anchor is authoritative and either half may be sent back. Default true — pass `false` for bare `<anchor>` rows.",
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
