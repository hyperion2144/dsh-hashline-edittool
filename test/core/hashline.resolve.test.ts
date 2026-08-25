import { describe, expect, it } from "vitest";
import {
	resEdit,
	type Anchor,
	type HTEdit,
} from "../../src/hashline/index.js";

describe("resEdit", () => {
	it("resolves replace with remove_from/remove_to", () => {
		const edit: HTEdit = { remove_from: "1#ZZP", remove_to: "1#PPW", replacement_text: "a\nb" };
		const resolved = resEdit(edit);
		expect(resolved).toHaveProperty("hash_bounds");
		expect(resolved).toHaveProperty("content_lines");
	});

	it("resolves a 1-line edit (same anchor)", () => {
		const edit: HTEdit = { remove_from: "1#MQX", remove_to: "1#MQX", replacement_text: "new" };
		const resolved = resEdit(edit);
		const r = resolved as {
			hash_bounds: [Anchor, Anchor];
      content_lines: string[];
		};
		expect(r.hash_bounds[0].hash).toBe("MQX");
		expect(r.hash_bounds[1].hash).toBe("MQX");
	});

	it("throws on replace with no remove_from/remove_to (E_BAD_SHAPE)", () => {
    const edit = { replacement_text: "new" } as any;
		expect(() => resEdit(edit)).toThrow(/^\[E_BAD_SHAPE\]/);
	});

	it("throws on malformed remove_from/remove_to", () => {
		const edit: HTEdit = { remove_from: "not-valid", remove_to: "not-valid", replacement_text: "x" };
		expect(() => resEdit(edit)).toThrow(/Invalid anchor/);
	});

  it("rejects array replacement_text input", () => {
    const edit = {
      remove_from: "1#ZZP", remove_to: "1#ZZP",
      replacement_text: ["hello", "world"],
    } as unknown as HTEdit;
    expect(() => resEdit(edit)).toThrow(
      /must be a string with \\n line separators, not an array/i,
    );
  });

  it("splits string replacement_text on line separators", () => {
    const edit = {
      remove_from: "1#ZZP", remove_to: "1#ZZP",
      replacement_text: "line1\nline2\n",
    } as unknown as HTEdit;
    const resolved = resEdit(edit);
    expect(resolved.content_lines).toEqual(["line1", "line2", ""]);
  });

  it("normalizes CRLF in replacement_text", () => {
    const edit = {
      remove_from: "1#ZZP", remove_to: "1#ZZP",
      replacement_text: "a\r\nb",
    } as unknown as HTEdit;
    const resolved = resEdit(edit);
    expect(resolved.content_lines).toEqual(["a", "b"]);
  });

	it("rejects null replacement_text input", () => {
		const edit = {
			remove_from: "1#ZZP", remove_to: "1#ZZP",
      replacement_text: null,
		} as unknown as HTEdit;
		expect(() => resEdit(edit)).toThrow(
      /must be a string with \\n line separators, not an array/i,
		);
	});

	it("rejects unknown fields", () => {
    const edit = { remove_from: "1#ZZP", remove_to: "1#ZZP", replacement_text: "x", extra: true } as any;
		expect(() => resEdit(edit)).toThrow(
			/unknown or unsupported fields/i,
		);
	});

	it("rejects missing replacement_text", () => {
		const edit = { remove_from: "1#ZZP", remove_to: "1#ZZP" } as any;
		expect(() => resEdit(edit)).toThrow(
      /requires a "replacement_text" field/i,
		);
	});

	it("leaves bare anchors untouched and emits no warning", () => {
		const edit: HTEdit = { remove_from: "1#MQX", remove_to: "1#MQX", replacement_text: "new" };
		const warnings: string[] = [];
		const resolved = resEdit(edit, warnings);
		expect(resolved.hash_bounds[0].hash).toBe("MQX");
		expect(warnings).toHaveLength(0);
	});

	it("still rejects rows without a leading hash", () => {
		const edit: HTEdit = { remove_from: "│const x = 1;", remove_to: "1#MQX", replacement_text: "new" };
		expect(() => resEdit(edit)).toThrow(/^\[E_BAD_REF\]/);
	});
	it("extracts line#hash from a full read row and drops trailing content", () => {
		const edit: HTEdit = { remove_from: "12#MQX│const x = 1;", remove_to: "12#MQX│const x = 1;", replacement_text: "new" };
		const warnings: string[] = [];
		const resolved = resEdit(edit, warnings);
		expect(resolved.hash_bounds[0]).toEqual({ line: 12, hash: "MQX" });
		expect(resolved.hash_bounds[1]).toEqual({ line: 12, hash: "MQX" });
		expect(warnings[0]).toMatch(/stripped trailing content/);
		expect(warnings[0]).toMatch(/using "12#MQX"/);
	});

	it("strips + and - diff markers from pasted rows, keeping the anchor", () => {
		const edit: HTEdit = { remove_from: "+12#MQX│const x = 1;", remove_to: "-12#MQX│const x = 1;", replacement_text: "new" };
		const warnings: string[] = [];
		const resolved = resEdit(edit, warnings);
		expect(resolved.hash_bounds[0]).toEqual({ line: 12, hash: "MQX" });
		expect(resolved.hash_bounds[1]).toEqual({ line: 12, hash: "MQX" });
		expect(warnings[0]).toMatch(/stripped diff-preview "\+" marker/);
		expect(warnings[1]).toMatch(/stripped leading "-" marker/);
	});

	it("trims surrounding whitespace around a pasted row", () => {
		const edit: HTEdit = { remove_from: "  12#MQX│const x = 1;  ", remove_to: "  12#MQX│const x = 1;  ", replacement_text: "new" };
		const resolved = resEdit(edit);
		expect(resolved.hash_bounds[0]).toEqual({ line: 12, hash: "MQX" });
	});

	it("rejects a pasted row without a line number", () => {
		const edit: HTEdit = { remove_from: "MQX│const x = 1;", remove_to: "1#MQX", replacement_text: "new" };
		expect(() => resEdit(edit)).toThrow(/lacks a line number/);
	});

	it("takes only the first row of a multi-line block pasted into an anchor", () => {
		const edit: HTEdit = { remove_from: "12#MQX│line1\n34#cD4│line2", remove_to: "12#MQX│line1\n34#cD4│line2", replacement_text: "new" };
		const warnings: string[] = [];
		const resolved = resEdit(edit, warnings);
		expect(resolved.hash_bounds[0]).toEqual({ line: 12, hash: "MQX" });
		expect(resolved.hash_bounds[1]).toEqual({ line: 12, hash: "MQX" });
		expect(warnings[0]).toMatch(/multi-line block/);
		expect(warnings[0]).toMatch(/only the first row's anchor "12#MQX" was used/);
	});

	it("does not warn when a pasted row has empty content after the separator", () => {
		const edit: HTEdit = { remove_from: "12#MQX│", remove_to: "12#MQX│", replacement_text: "new" };
		const warnings: string[] = [];
		resEdit(edit, warnings);
		expect(warnings).toHaveLength(0);
	});

	it("clips long pasted content in the rejection message", () => {
		const longContent = "y".repeat(500);
		const edit: HTEdit = { remove_from: `MQX│${longContent}`, remove_to: "1#MQX", replacement_text: "new" };
		const error = () => resEdit(edit);
		expect(error).toThrow(/lacks a line number/);
		expect(error).toThrow(/MQX│y{50,59}\.\.\./);
		expect(error).not.toThrow(longContent.slice(60));
	});


});
