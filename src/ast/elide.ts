/**
 * Structural-summary elision: decide which line spans a whole-file outline
 * folds away.
 *
 * Three rules, and one implementation note worth reading:
 *
 * 1. **Body / literal nodes** — the interior strictly between the opener and
 *    the closer. The opener line and the closer line stay visible, so a
 *    multi-line signature is kept verbatim (never reconstructed).
 * 2. **Consecutive import / use runs** — elide strictly between the first and
 *    the last sibling, keeping both ends as anchors.
 * 3. **Block comments** — the interior, same shape as a body.
 *
 * All three use the **same interior rule** (`opener + 1 .. closer - 1`). The
 * spec's comment clause described a different offset; applying one rule to all
 * three is both simpler and produces the property that matters — **every
 * elision leaves its delimiter lines in the output**, so what is shown is
 * always real source and a merged row can always name a real opener.
 *
 * Spans are returned **top-level only**: a method body inside a folded class
 * body is already inside a fold, and rendering it separately would emit a
 * nested marker the renderer has no representation for.
 *
 * @module dsh-hashline-edittool/ast/elide
 */
import type { Node } from "web-tree-sitter";

/** One folded line span. */
export interface ElisionSpan {
	/** 1-indexed first folded line, inclusive. */
	readonly startLine: number;
	/** 1-indexed last folded line, inclusive. */
	readonly endLine: number;
	/** 1-indexed opener line — always shown, and the merged row's anchor. */
	readonly openerLine: number;
	/** 1-indexed closer line — always shown. */
	readonly closerLine: number;
	readonly kind: "body" | "imports" | "comment";
}

/** Body / literal node types whose interior folds, per language. */
const BODY_NODE_TYPES: Readonly<Record<string, string[]>> = {
	typescript: [
		"statement_block",
		"class_body",
		"object",
		"array",
		"enum_body",
		"object_type",
		"switch_body",
		"interface_body",
	],
	tsx: ["statement_block", "class_body", "object", "array", "enum_body", "object_type", "switch_body", "interface_body"],
	javascript: ["statement_block", "class_body", "object", "array", "switch_body"],
	python: ["block", "dictionary", "list", "set", "argument_list", "parameters"],
};

/** Import-ish node types whose consecutive runs fold, per language. */
const IMPORT_NODE_TYPES: Readonly<Record<string, string[]>> = {
	typescript: ["import_statement"],
	tsx: ["import_statement"],
	javascript: ["import_statement"],
	python: ["import_statement", "import_from_statement"],
};

/** Floors: a span shorter than its floor is not worth folding. */
export interface ElisionLimits {
	readonly minBodyLines: number;
	readonly minCommentLines: number;
}

/** Build a span from a node's extent, or `undefined` when it is too short. */
function interiorOf(
	node: Node,
	kind: ElisionSpan["kind"],
	floor: number,
): ElisionSpan | undefined {
	const openerLine = node.startPosition.row + 1;
	const closerLine = node.endPosition.row + 1;
	// Same-line constructs (`{ a: 1 }`) have no interior at all.
	if (closerLine - openerLine - 1 < floor) return undefined;
	return { startLine: openerLine + 1, endLine: closerLine - 1, openerLine, closerLine, kind };
}

/**
 * Compute the top-level elision spans for a tree.
 *
 * @param root - the tree's root node.
 * @param languageId - registry id.
 * @param limits - the two floors (body / comment).
 * @returns spans sorted by start line, with nested spans removed.
 */
export function computeElisions(
	root: Node,
	languageId: string,
	limits: ElisionLimits,
): ElisionSpan[] {
	const spans: ElisionSpan[] = [];

	const bodyTypes = BODY_NODE_TYPES[languageId] ?? [];
	if (bodyTypes.length > 0) {
		for (const node of root.descendantsOfType(bodyTypes) as unknown as Node[]) {
			if (!node.isNamed) continue;
			const span = interiorOf(node, "body", limits.minBodyLines);
			if (span !== undefined) spans.push(span);
		}
	}

	// A block comment is a `comment` node spanning more than one line; a `//`
	// or `#` line comment never qualifies, which is correct — folding a single
	// line saves nothing and would hide content for no gain.
	for (const node of root.descendantsOfType(["comment"]) as unknown as Node[]) {
		if (node.startPosition.row === node.endPosition.row) continue;
		const span = interiorOf(node, "comment", limits.minCommentLines);
		if (span !== undefined) spans.push(span);
	}

	spans.push(...importRunSpans(root, languageId));

	return dropNested(spans);
}

/**
 * Fold the middle of a consecutive import run, keeping the first and last
 * import visible. A run shorter than three imports has no middle worth
 * folding, and its ends already anchor the group.
 */
function importRunSpans(root: Node, languageId: string): ElisionSpan[] {
	const types = IMPORT_NODE_TYPES[languageId] ?? [];
	if (types.length === 0) return [];
	const isImport = (node: Node): boolean => types.includes(node.type);
	const out: ElisionSpan[] = [];
	for (const child of root.namedChildren as unknown as Node[]) {
		if (!isImport(child)) continue;
		// Walk the whole run from its first member only.
		let last = child;
		for (const sibling of (root.namedChildren as unknown as Node[])) {
			if (!isImport(sibling)) continue;
			if (sibling.startPosition.row > last.endPosition.row) last = sibling;
		}
		const openerLine = child.startPosition.row + 1;
		const closerLine = last.endPosition.row + 1;
		if (closerLine - openerLine - 1 < 1) return out;
		out.push({ startLine: openerLine + 1, endLine: closerLine - 1, openerLine, closerLine, kind: "imports" });
		return out;
	}
	return out;
}

/** Remove spans fully contained in another; the outer fold already covers them. */
function dropNested(spans: readonly ElisionSpan[]): ElisionSpan[] {
	const sorted = [...spans].sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
	const out: ElisionSpan[] = [];
	let coveredTo = 0;
	for (const span of sorted) {
		if (span.startLine <= coveredTo) continue;
		out.push(span);
		coveredTo = span.endLine;
	}
	return out;
}

/** Overlapping spans are not representable by the renderer; this is the check. */
export function spansAreDisjoint(spans: readonly ElisionSpan[]): boolean {
	for (let i = 1; i < spans.length; i++) {
		if (spans[i]!.startLine <= spans[i - 1]!.endLine) return false;
	}
	return true;
}
