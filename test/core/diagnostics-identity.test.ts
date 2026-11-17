/**
 * S4 (#429): the diagnostic IDENTITY as a pure function — the rules the
 * suppression ledger and the projection both lean on, pinned here where no
 * ledger, no session and no server can blur them.
 *
 * @module dsh-hashline-edittool/test/diagnostics-identity
 */
import { describe, expect, it } from "vitest";
import {
	diagnosticIdentity,
	diagnosticLabel,
	normalizeDiagnosticMessage,
} from "../../src/lsp/diagnostics/identity.js";

describe("normalizeDiagnosticMessage (#429)", () => {
	it("folds whitespace runs and trims, preserving case", () => {
		expect(normalizeDiagnosticMessage("  a   bad\n\tthing  ")).toBe("a bad thing");
		expect(normalizeDiagnosticMessage("Type 'Foo' is not assignable")).toBe(
			"Type 'Foo' is not assignable",
		);
		expect(normalizeDiagnosticMessage("Foo")).not.toBe(normalizeDiagnosticMessage("foo"));
	});
});

describe("diagnosticIdentity (#429)", () => {
	it("is blind to the line number: the same sentence at two lines is ONE identity", () => {
		const atLine5 = { severity: 1, source: "pyright", code: 2322, message: "x", range: { start: { line: 4 } } };
		const atLine50 = { ...atLine5, range: { start: { line: 49 } } };
		expect(diagnosticIdentity(atLine5)).toBe(diagnosticIdentity(atLine50));
	});

	it("folds message whitespace: a re-wrapped sentence is ONE identity", () => {
		const one = { severity: 1, message: "a bad thing" };
		const wrapped = { severity: 1, message: "a\nbad   thing" };
		expect(diagnosticIdentity(one)).toBe(diagnosticIdentity(wrapped));
	});

	it("treats missing source / code as empty, not as distinct servers", () => {
		const bare = { severity: 1, message: "x" };
		const explicit = { severity: 1, source: "", code: "", message: "x" };
		expect(diagnosticIdentity(bare)).toBe(diagnosticIdentity(explicit));
	});

	it("keeps severity, source and code INSIDE the identity", () => {
		const base = { severity: 1, source: "pyright", code: 2322, message: "x" };
		expect(diagnosticIdentity(base)).not.toBe(diagnosticIdentity({ ...base, severity: 2 }));
		expect(diagnosticIdentity(base)).not.toBe(diagnosticIdentity({ ...base, source: "eslint" }));
		expect(diagnosticIdentity(base)).not.toBe(diagnosticIdentity({ ...base, code: 1005 }));
	});

	it("is injective across message contents: `|` and quotes in a message forge nothing", () => {
		expect(diagnosticIdentity({ severity: 1, message: 'a","' })).not.toBe(
			diagnosticIdentity({ severity: 1, message: "a" }),
		);
	});
});

describe("diagnosticLabel (#429)", () => {
	it("speaks source/code when the server supplied both", () => {
		expect(diagnosticLabel(1, "pyright", 2322, "msg")).toBe("error(pyright/2322): msg");
		expect(diagnosticLabel(2, "eslint", "no-unused", "msg")).toBe("warning(eslint/no-unused): msg");
	});

	it("degrades to source-only, then code-only, then the bare word", () => {
		expect(diagnosticLabel(1, "pyright", undefined, "msg")).toBe("error(pyright): msg");
		expect(diagnosticLabel(1, undefined, 2322, "msg")).toBe("error(2322): msg");
		expect(diagnosticLabel(1, undefined, undefined, "msg")).toBe("error: msg");
		expect(diagnosticLabel(2, "", "", "msg")).toBe("warning: msg");
	});
});
