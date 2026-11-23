/**
 * #429 — the regression-signal semantics, end to end through the REAL
 * delivery path (seam 1): the suppression ledger splits a write's push into
 * fresh and unchanged, the unchanged ride one summary line, and
 * `source` / `code` reach every face without any classification.
 *
 * The ledger is in-process, so every test starts from `resetSuppressionLedger`
 * and drives TWO deliveries against the same (session key, path) to simulate
 * two consecutive writes.
 *
 * @module dsh-hashline-edittool/test/issue-429-diagnostic-regression
 */
import { afterEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	deliverDiagnosticsAfterWrite,
	diagnosticsJson,
	diagnosticsMeta,
	formatDiagnosticsSection,
	type AfterWriteInput,
} from "../../src/lsp/auto-diag.js";
import { resetSuppressionLedger } from "../../src/lsp/diagnostics/ledger.js";
import { setLspManager } from "../../src/lsp/manager.js";
import { withTempDir } from "../support/fixtures.js";
import type { LspSession } from "../../src/lsp/session.js";

const SOURCE = "export const alpha = 1;\nexport const beta = 2;\n";

/** Fifty standing warnings — the "dynamic-language file" the spec opens with. */
function standingFifty(): unknown[] {
	return Array.from({ length: 50 }, (_, i) => ({
		message: `old problem ${i}`,
		severity: 1,
		source: "pyright",
		code: 1000 + i,
		range: { start: { line: i } },
	}));
}

const BRAND_NEW = {
	message: "a brand new problem",
	severity: 1,
	source: "pyright",
	code: 9999,
	range: { start: { line: 0 } },
};

/** A PULL-capable session whose whole answer is the given items (simplest verified path). */
function fakeSession(items: unknown[] | undefined): LspSession {
	return {
		diagnosticsRevision: 1,
		getDiagnostics: () => items,
		pullDiagnostics: async () => (items === undefined ? undefined : { items, version: 1 }),
	} as never;
}

function makeInput(cwd: string, items: unknown[] | undefined): AfterWriteInput {
	const session = fakeSession(items);
	setLspManager({ readySessionFor: () => session } as never);
	return {
		session,
		languageId: "typescript",
		root: cwd,
		uri: pathToFileURL(join(cwd, "a.ts")).href,
		toolName: "edit",
		text: SOURCE,
		absolutePath: join(cwd, "a.ts"),
		displayPath: "a.ts",
		io: { emitObserved: async () => undefined } as never,
		exec: {
			signal: new AbortController().signal,
			callId: "call-1",
			name: "edit",
			arguments: {},
			agent: { id: "test-session", session: { id: "test-session", header: { cwd } } },
			deferContext() { },
			concludeTurn() { },
		} as unknown as AfterWriteInput["exec"],
	};
}

afterEach(() => {
	setLspManager(undefined);
	resetSuppressionLedger();
});

describe("the regression signal (#429)", () => {
	it("reports the first write in full, then suppresses an unchanged re-push to one line", async () => {
		await withTempDir("diag-regression-", async (cwd) => {
			const first = await deliverDiagnosticsAfterWrite(makeInput(cwd, standingFifty()));
			expect(first!.rows).toHaveLength(50);
			expect(first!.suppressedCount).toBe(0);

			// A second write, same fifty standing problems: nothing is new, and
			// the report is the ONE summary line — no repeated entries.
			const second = await deliverDiagnosticsAfterWrite(makeInput(cwd, standingFifty()));
			expect(second!.rows).toHaveLength(0);
			expect(second!.suppressedOnly).toBe(true);
			expect(second!.suppressedCount).toBe(50);
			const section = formatDiagnosticsSection([second!]);
			expect(section).toContain("50 unchanged since the last report");
			expect(section).not.toContain("old problem");
			// The capsule keeps rendering (the standing indicator), with the count.
			expect(diagnosticsMeta([second!])[0]?.suppressedCount).toBe(50);
			expect(diagnosticsJson([second!])[0]?.suppressedCount).toBe(50);
		});
	});

	it("reports ONLY the newly-introduced diagnostic beside the unchanged summary", async () => {
		await withTempDir("diag-regression-", async (cwd) => {
			await deliverDiagnosticsAfterWrite(makeInput(cwd, standingFifty()));
			const withNew = [...standingFifty(), BRAND_NEW];
			const report = await deliverDiagnosticsAfterWrite(makeInput(cwd, withNew));
			expect(report!.rows).toHaveLength(1);
			expect(report!.rows[0]!.messages[0]).toContain("a brand new problem");
			expect(report!.suppressedCount).toBe(50);
			const section = formatDiagnosticsSection([report!]);
			expect(section).toContain("a brand new problem");
			expect(section).toContain("50 more unchanged since the last report");
		});
	});

	it("re-reports a diagnostic that was fixed and then re-introduced", async () => {
		await withTempDir("diag-regression-", async (cwd) => {
			const all = standingFifty();
			await deliverDiagnosticsAfterWrite(makeInput(cwd, all));
			// The model fixes ONE: the push loses it. The FIXED diagnostic does NOT
			// appear (story 4, first half) — the report is pure suppression of the
			// remaining 49, and the ledger forgets the fixed one.
			const fixed = await deliverDiagnosticsAfterWrite(makeInput(cwd, all.slice(1)));
			expect(fixed!.suppressedOnly).toBe(true);
			expect(fixed!.suppressedCount).toBe(49);
			// The model re-introduces the SAME problem: it must resurface.
			const reintro = await deliverDiagnosticsAfterWrite(makeInput(cwd, all));
			expect(reintro!.rows).toHaveLength(1);
			expect(reintro!.rows[0]!.messages[0]).toContain("old problem 0");
		});
	});

	it("does not re-report a line-shifted copy of the same sentence", async () => {
		await withTempDir("diag-regression-", async (cwd) => {
			await deliverDiagnosticsAfterWrite(makeInput(cwd, standingFifty()));
			// The same sentences, shifted one line down by an unrelated edit above.
			const shifted = standingFifty().map((d) => ({
				...(d as { range: { start: { line: number } } }),
				range: { start: { line: (d as { range: { start: { line: number } } }).range.start.line + 1 } },
			}));
			const report = await deliverDiagnosticsAfterWrite(makeInput(cwd, shifted));
			expect(report!.rows).toHaveLength(0);
			expect(report!.suppressedCount).toBe(50);
		});
	});

	it("carries source and code through every face, degrading when absent", async () => {
		await withTempDir("diag-regression-", async (cwd) => {
			const withSource = [BRAND_NEW];
			const withoutSource = [{ ...BRAND_NEW, source: undefined, code: undefined }];
			const first = await deliverDiagnosticsAfterWrite(makeInput(cwd, withSource));
			const second = await deliverDiagnosticsAfterWrite(makeInput(cwd, withoutSource));
			// The second push's message differs from the first's identity ONLY by
			// losing the handles — the label shows the degradation.
			expect(first!.rows[0]!.messages[0]).toBe("error(pyright/9999): a brand new problem");
			expect(second!.rows[0]!.messages[0]).toBe("error: a brand new problem");
			// JSON face: sources / codes aligned with messages, "" for absent.
			const json = diagnosticsJson([first!])[0]!.rows;
			const values = Object.values(json)[0]!;
			expect(values.sources).toEqual(["pyright"]);
			expect(values.codes).toEqual(["9999"]);
			expect(values.messages).toEqual(["error(pyright/9999): a brand new problem"]);
		});
	});

	it("does not count info/hint entries toward anything", async () => {
		await withTempDir("diag-regression-", async (cwd) => {
			const mixed = [
				...standingFifty(),
				{ message: "prefer const", severity: 3, range: { start: { line: 0 } } },
				{ message: "unused hint", severity: 4, range: { start: { line: 1 } } },
			];
			const report = await deliverDiagnosticsAfterWrite(makeInput(cwd, mixed));
			expect(report!.rows).toHaveLength(50);
			expect(report!.suppressedCount).toBe(0);
		});
	});
});
