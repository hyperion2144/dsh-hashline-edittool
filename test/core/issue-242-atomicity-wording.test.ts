/**
 * #242 — model-facing edit wording must claim PER-FILE atomicity.
 *
 * ADR-0003 is the authority: within one file the edits are one atomic batch
 * (`[E_BATCH_ABORT]`), files are independent, and a multi-file call reports
 * partial success per file. The prompt used to say "The batch is ATOMIC — any
 * hunk failure rejects the WHOLE batch and nothing is written", which reads as
 * one transaction over the whole call: a model that saw a single failure
 * concluded that nothing had happened and never retried the failed file.
 *
 * These assertions are about the CLAIM, not about a fixed sentence: they ban
 * the whole-call vocabulary and require the per-file scope, so the prose stays
 * free to be reworded.
 * @module dsh-hashline-edittool/test-issue-242-atomicity-wording
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyEffective, getEffectiveConfig } from "../../src/config.js";
import { buildEditsSchema } from "../../src/contract/contract.js";
import { editDescription, editGuidance } from "../../src/domain/edit/prompts.js";
import { applyEdit, type HEdit } from "../../src/hashline/anchor-pipeline.js";

/** Only true of the whole call — ADR-0003 says the batch is per file. */
const WHOLE_CALL_CLAIMS = [
	/whole batch/i,
	/whole call/i,
	/apply atomically/i,
	/batch is atomic/i,
	/nothing was written/i,
] as const;

/** What the wording must promise instead. */
const PER_FILE_PROMISE = /that file/i;

afterEach(() => {
	applyEffective({});
});

function guidanceText(): string {
	const guidance = editGuidance(getEffectiveConfig());
	return [guidance.intro, ...guidance.lines].join("\n");
}

function editFacingTexts(): Array<{ label: string; text: string }> {
	return [
		{ label: "editDescription", text: editDescription(getEffectiveConfig()) },
		{ label: "editGuidance", text: guidanceText() },
	];
}

describe("#242 — edit wording is per-file, never whole-call", () => {
	for (const on of [false, true]) {
		describe(on ? "require_line_content ON" : "require_line_content OFF", () => {
			beforeEach(() => {
				applyEffective({ require_line_content: on });
			});

			it("never claims the whole call is atomic", () => {
				for (const { label, text } of editFacingTexts()) {
					for (const claim of WHOLE_CALL_CLAIMS) {
						expect(text, `${label} must not claim ${String(claim)}`).not.toMatch(claim);
					}
				}
			});

			it("scopes the rejection to the failing file", () => {
				for (const { label, text } of editFacingTexts()) {
					expect(text, label).toMatch(PER_FILE_PROMISE);
				}
			});
		});
	}

	it("the `edits` schema description carries the same per-file scope", () => {
		for (const flag of [false, true]) {
			const description = buildEditsSchema(flag).description ?? "";
			expect(description, `buildEditsSchema(${flag})`).toMatch(PER_FILE_PROMISE);
			for (const claim of WHOLE_CALL_CLAIMS) {
				expect(description, `buildEditsSchema(${flag})`).not.toMatch(claim);
			}
		}
	});

	it("the noop guidance scopes the no-write to that file", () => {
		applyEffective({});
		expect(guidanceText()).toContain("that file was not written");
	});

	it("the per-file ambiguity guard scopes its no-write claim too", () => {
		const edit: HEdit = {
			hash_bounds: [{ anchor: "AA" }, { anchor: "AA" }],
			content_lines: ["gone"],
		};
		expect(() => applyEdit("one\ntwo\nthree\n", edit, undefined, ["AA", "BB", "AA"])).toThrow(
			/nothing was written for that file/
		);
	});
});
