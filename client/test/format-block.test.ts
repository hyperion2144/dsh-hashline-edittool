/**
 * The auto-format section's card contract (#275), pinned without a DOM.
 *
 * This environment cannot render, so — the same split the read card made —
 * the PURE half is covered by models.test.ts (`metaFormatSections`), and this
 * file pins the STRUCTURAL promises of the renderer: the literals a reader
 * sees (the no-anchor hint, the in-main count, the bracketed header), the
 * rule that routes sections to their file's tab, and the fact that the
 * shipped BUNDLE carries all of it (a source-only pin would pass while the
 * build went stale).
 *
 * @module dsh-hashline-edittool/client/test/format-block
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(here, "..");
const blockSource = readFileSync(join(clientRoot, "src", "client", "diff-block.tsx"), "utf8");
const toolRowSource = readFileSync(join(clientRoot, "src", "client", "tool-row.tsx"), "utf8");
const bundleSource = readFileSync(join(clientRoot, "lib", "client.js"), "utf8");
const indexSource = readFileSync(join(clientRoot, "src", "client", "index.ts"), "utf8");
const settingsCardSource = readFileSync(join(clientRoot, "src", "client", "settings-card.tsx"), "utf8");

describe("the format.servers naming block (#425/#427 rework)", () => {
	it("names format servers through a segmented [\"format\", \"servers\"] write", () => {
		expect(settingsCardSource).toContain('writeField(["format", "servers"], servers)');
	});

	it("the three format switches write segmented leaf paths, never the whole subtree", () => {
		expect(settingsCardSource).toContain('writeField(["format", "auto"], mode)');
		expect(settingsCardSource).toContain('writeField(["format", "fallback_full_file"], checked)');
		expect(settingsCardSource).toContain('writeField(["format", "editorconfig"], checked)');
		expect(settingsCardSource).not.toContain('writeField("format", {');
	});
});

describe("a borrowed-card tool keeps its own TITLE (#427 review)", () => {
	it("the format row's fallbacks announce the format tool, not the card it borrows", () => {
		expect(toolRowSource.match(/titleOverride: rest\.t\("row\.title\.format"\)/g)?.length).toBe(3);
	});

	it("the row model resolves a borrowed tool's title from its OWN name, never the read title", () => {
		const modelsSource = readFileSync(join(clientRoot, "src", "client", "models.ts"), "utf8");
		expect(modelsSource).toContain('TOOL_TITLE_KEYS[toolName] ?? "row.title.generic"');
		expect(modelsSource).toContain('format: "row.title.format"');
		expect(modelsSource).toContain('lsp: "row.title.lsp"');
	});
});

describe("the auto-format section in the diff card (#275)", () => {
	it("draws the gray no-anchor hint on unserved formatter rows", () => {
		expect(blockSource).toContain("no anchor (not served)");
		expect(bundleSource).toContain("no anchor (not served)");
	});

	it("withholds in-main rows: no badge, only the header count (#312)", () => {
		// The retired overlap badge must be gone from source AND bundle — an
		// in-main row is counted by the header's `n in main diff`, never drawn.
		expect(blockSource).not.toContain("also in main diff");
		expect(bundleSource).not.toContain("also in main diff");
		expect(blockSource).toContain(" in main diff ");
		// esbuild escapes non-ASCII in the bundle (· → \xB7), so assert the
		// count phrase without the middot there; the source keeps the full form.
		expect(bundleSource).toContain(" in main diff ");
	});

	it("summarizes restored runs instead of re-quoting them (#315 review)", () => {
		// The locator + restored-summary literals exist in source AND bundle;
		// the summary deliberately carries NO line content — the main diff
		// already owns every net change, so a restored run only says WHERE.
		expect(blockSource).toContain("@@ ~${cluster.startLine},${cluster.lines} @@");
		expect(bundleSource).toContain("line(s) restored to their pre-edit content");
		expect(blockSource).toContain("line(s) restored to their pre-edit content");
		// The header names the count like the other withholds do.
		expect(blockSource).toContain(" restored ·");
		expect(bundleSource).toContain(" restored ");
	});

	it("carries the bracketed header the host's text contract mirrors", () => {
		expect(blockSource).toContain("[auto-format:");
		expect(blockSource).toContain("lines changed");
		expect(blockSource).toContain("unserved]");
		expect(blockSource).toContain("no changes]");
	});

	it("renders a skipped section as a status line with the reason", () => {
		expect(blockSource).toContain('section.status === "skipped"');
		expect(blockSource).toContain("section.reason ?? \"\"");
	});

	it("routes each section to ITS file's tab; a pathless section rides the first", () => {
		expect(blockSource).toContain("sectionsForPath");
		expect(blockSource).toContain('section.path === undefined ? isFirst : section.path === path');
	});

	it("rides below the main diff rows, outside the fold", () => {
		// The section renders inside the same body (gutter width applies) and
		// is NOT part of the head/tail fold window.
		expect(blockSource).toContain('key: "format-section"');
		expect(blockSource.indexOf("format-section")).toBeGreaterThan(blockSource.indexOf("foldRow"));
	});

	it("flows from the meta through both card models to the block", () => {
		expect(toolRowSource).toContain("formats: diffBody.formats");
		expect(bundleSource).toContain("metaFormatSections");
	});

	it("registers the `format` toolview so manual calls render as a card", () => {
		// #275 follow-up: without the registry key the manual format call drew
		// raw input/output; the row reshapes its meta into one empty row group
		// and lets the edit row's DiffRowsBlock draw the section.
		expect(toolRowSource).toContain("export function HashlineFormatRow");
		expect(indexSource).toContain('["format", HashlineFormatRow]');
		expect(bundleSource).toContain('["format", HashlineFormatRow]');
	});
});
