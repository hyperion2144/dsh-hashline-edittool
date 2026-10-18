/**
 * Reading indentation settings from a `.editorconfig` — opt-in, dependency-free.
 *
 * `format.editorconfig: true` (G1) makes the plugin prefer a project's
 * `.editorconfig` over the document-whitespace heuristic when assembling
 * `FormattingOptions`. The spec is large; the slice a FORMATTER needs is two
 * keys — `indent_style` and `indent_size` — so this module implements a
 * minimal, honest subset instead of a dependency:
 *
 * - Sections are matched only when they name the file exactly
 *   (`[*.editorconfig`-style GLOBS are unsupported and ignored — an
 *   unsupported section must fall back, not guess), alongside the universal
 *   `[*]`. Later matching sections override earlier ones, per spec.
 * - `indent_style = tab` → `insertSpaces: false`; `indent_size = <n>` →
 *   `tabSize: n`. `indent_size = tab` means "tabs, tab-width from
 *   `tab_width`" — honored as tabs with the default width, which is what the
 *   key means without a `tab_width` alongside it.
 * - `root = true` stops the upward walk at that file.
 *
 * Absent/unsupported keys are simply not set; the caller falls back to the
 * heuristic per key, which is the spec's own "properties cascade" read at
 * plugin scale.
 *
 * @module dsh-hashline-edittool/lsp/editorconfig
 */
import { basename, dirname, join, resolve, sep } from "node:path";
import type { FileIO } from "../infra/fs-bridge.js";

/** The indentation facts a `.editorconfig` can contribute. */
export interface EditorconfigIndent {
	/** From `indent_style`; absent when the file does not name it. */
	readonly insertSpaces?: boolean;
	/** From `indent_size`; absent when the file does not name it. */
	readonly tabSize?: number;
}

/** One INI section: the selector it matched under, plus its key/values. */
interface IniSection {
	readonly selector: string;
	readonly values: ReadonlyMap<string, string>;
}

/** Parse `.editorconfig` text into sections (keys lowercased, values trimmed). */
function parseSections(text: string): IniSection[] {
	const sections: IniSection[] = [];
	let current: Map<string, string> | undefined;
	for (const rawLine of text.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;
		if (line.startsWith("[") && line.endsWith("]")) {
			current = new Map<string, string>();
			sections.push({ selector: line.slice(1, -1).trim(), values: current });
			continue;
		}
		const eq = line.indexOf("=");
		if (eq === -1 || current === undefined) continue;
		const key = line.slice(0, eq).trim().toLowerCase();
		const value = line.slice(eq + 1).trim();
		if (key.length > 0) current.set(key, value);
	}
	return sections;
}

/**
 * The indentation keys the two matching sections name, later section winning.
 *
 * A section matches when it is `[*]` or names this file's basename exactly.
 * A glob (`[*.{ts,tsx}]`) is NOT matched — an unsupported selector falls back
 * to the heuristic rather than guessing at glob semantics.
 */
function indentFromSections(
	sections: readonly IniSection[],
	fileName: string,
): { indent?: EditorconfigIndent; root: boolean } {
	let indent: EditorconfigIndent | undefined;
	let root = false;
	for (const section of sections) {
		const matches =
			section.selector === "*" || section.selector === fileName;
		if (!matches) continue;
		if (section.values.get("root") === "true") root = true;
		const style = section.values.get("indent_style");
		const size = section.values.get("indent_size");
		const next: { insertSpaces?: boolean; tabSize?: number } = { ...indent };
		if (style === "tab") next.insertSpaces = false;
		else if (style === "space") next.insertSpaces = true;
		if (size !== undefined) {
			if (size === "tab") next.tabSize = next.tabSize ?? 4;
			else {
				const width = Number.parseInt(size, 10);
				if (Number.isInteger(width) && width > 0) next.tabSize = width;
			}
		}
		indent = Object.keys(next).length > 0 ? next : undefined;
	}
	return { indent, root };
}

/**
 * Read the indentation facts from the nearest `.editorconfig`.
 *
 * Walks UP from the file's directory to `workspaceRoot` (inclusive) — the
 * walk stops at the workspace because settings outside the session's scope
 * are not this session's facts. The FIRST file found wins (nearest per
 * spec); `root = true` in a HIGHER file does not resurrect an absent lower
 * one, it only caps the walk.
 *
 * @param io - the file bridge (read-only use).
 * @param absolutePath - the file being formatted.
 * @param workspaceRoot - absolute workspace root; the walk never climbs past it.
 * @returns the facts, or `undefined` when no readable `.editorconfig` in scope
 *   names either key. A missing/ambiguous/unreadable file is `undefined`, NOT
 *   an error — the caller falls back to the heuristic.
 */
export async function readIndentFromEditorconfig(
	io: Pick<FileIO, "readText">,
	absolutePath: string,
	workspaceRoot: string | undefined,
): Promise<EditorconfigIndent | undefined> {
	const root = workspaceRoot === undefined ? undefined : resolve(workspaceRoot);
	let dir = dirname(resolve(absolutePath));
	const fileName = basename(resolve(absolutePath));
	for (;;) {
		let text: string;
		try {
			text = await io.readText(join(dir, ".editorconfig"));
		} catch {
			text = "";
		}
		if (text !== "") {
			const { indent, root: isRoot } = indentFromSections(parseSections(text), fileName);
			if (indent !== undefined) return indent;
			if (isRoot) return undefined;
		}
		if (root !== undefined && (dir === root || !dir.startsWith(root + sep))) {
			return undefined;
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}
