/**
 * The auto-format section's card contract (#275), pinned without a DOM.
 *
 * This environment cannot render, so — the same split the read card made —
 * the PURE half is covered by models.test.ts (`metaFormatSections`), and this
 * file pins the STRUCTURAL promises of the renderer: the literals a reader
 * sees (the no-anchor hint, the overlap badge, the bracketed header), the
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

describe("the auto-format section in the diff card (#275)", () => {
	it("draws the gray no-anchor hint on unserved formatter rows", () => {
		expect(blockSource).toContain("no anchor (not served)");
		expect(bundleSource).toContain("no anchor (not served)");
	});

	it("badges rows the main diff already shows instead of hiding them", () => {
		expect(blockSource).toContain("also in main diff");
		expect(bundleSource).toContain("also in main diff");
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
