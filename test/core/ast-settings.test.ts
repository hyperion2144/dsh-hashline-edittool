/**
 * The AST capability's settings surface: the namespace shape, the
 * master-switch/per-language relationship, and the guidance that has to move
 * with them.
 *
 * The guidance half matters as much as the schema half: with AST off the
 * parameters do not exist, so a description that still explains `symbol` would
 * send the model at a parameter it cannot pass.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	applyEffective,
	astDisabledLanguages,
	isAstEnabled,
	isAstLanguageEnabled,
	lspConfiguredServers,
} from "../../src/config.js";
import { readDescription } from "../../src/domain/edit/prompts.js";
import { HashlineSettingsSchema, resolveSettings } from "../../src/config.js";

afterEach(() => {
	// Restore the compiled defaults so suites cannot leak a flag into each other.
	applyEffective(undefined);
});

describe("the ast namespace", () => {
	it("accepts the documented shape", () => {
		// 0.1.7: the volatile marks mean the resolved value carries live
		// references — resolve through resolveSettings exactly like apply does.
		const resolved = resolveSettings(
			HashlineSettingsSchema({
				ast: { enabled: true, languages: { python: { enabled: false } } },
			}),
		);
		expect(resolved?.ast?.enabled).toBe(true);
		expect(resolved?.ast?.languages?.python?.enabled).toBe(false);
	});

});

describe("the master switch and per-language narrowing", () => {
	it("is off by default, which is what keeps pre-AST behaviour intact", () => {
		applyEffective(undefined);
		expect(isAstEnabled()).toBe(false);
		expect(isAstLanguageEnabled("python")).toBe(false);
	});

	it("enables every language when the master switch is on and nothing narrows it", () => {
		applyEffective({ ast: { enabled: true } });
		expect(isAstEnabled()).toBe(true);
		// An absent entry means enabled: turning AST on should not also require
		// visiting every language row.
		expect(isAstLanguageEnabled("python")).toBe(true);
		expect(isAstLanguageEnabled("typescript")).toBe(true);
	});

	it("narrows per language without touching the others", () => {
		applyEffective({ ast: { enabled: true, languages: { python: { enabled: false } } } });
		expect(isAstEnabled()).toBe(true);
		expect(isAstLanguageEnabled("python")).toBe(false);
		expect(isAstLanguageEnabled("typescript")).toBe(true);
		expect(astDisabledLanguages()).toEqual(["python"]);
	});

	it("gates everything on the master switch, whatever the per-language entries say", () => {
		applyEffective({ ast: { enabled: false, languages: { python: { enabled: true } } } });
		expect(isAstLanguageEnabled("python")).toBe(false);
	});
});

describe("the read description no longer moves with the switch", () => {
	/**
	 * It USED to move, and these tests asserted that it did. The parameters it
	 * described are gone, so the description is now constant — and what it says
	 * instead is where structure went. That is the assertion worth holding: a
	 * model reaching for the old selectors must be told the replacement, not
	 * left to infer it from a rejection.
	 */
	const describe_ = (astEnabled: boolean, outputFormat: "text" | "json") =>
		readDescription({ separator: ":", outputFormat, contextLines: 3, requireLineContent: false, lineNumbers: false, astEnabled, astLanguages: new Set(), lspServers: new Map(), autoDiagnostics: true, grepRespectGitignore: true, maxResponseChars: 48000 });

	it("is the SAME text whether the capability is on or off", () => {
		applyEffective(undefined);
		expect(describe_(true, "text")).toBe(describe_(false, "text"));
		expect(describe_(true, "json")).toBe(describe_(false, "json"));
	});

	it("names the replacement instead of the removed selectors", () => {
		for (const text of [describe_(false, "text"), describe_(true, "text"), describe_(false, "json")]) {
			expect(text).toContain("ast_grep");
			expect(text).toContain("lsp");
			expect(text).toContain("reads LINES");
		}
	});

	it("no longer advertises selectors the parser would reject", () => {
		// Every one of these is now rejected by the request parser, so a description
		// mentioning them would teach a call that always fails.
		const text = describe_(true, "text");
		for (const gone of ["`symbol`", "`anchor`", "references: true", "structural summary"]) {
			expect(text).not.toContain(gone);
		}
	});
});

describe("lsp.servers — the named-server sub-tree (#120)", () => {
	// The sub-tree is reached through the schema's nested shape, not by parsing
	// a file: the hand-written YAML reader is gone (#237), so what has to hold
	// now is that the nested map survives the effective snapshot and that an
	// empty command is still dropped rather than mapped to nothing.
	it("reads a language -> command map", () => {
		applyEffective({ lsp: { servers: { typescript: "/opt/tsserver", tsx: "/opt/my tools/tsserver" } } });
		expect([...lspConfiguredServers()]).toEqual([
			["typescript", "/opt/tsserver"],
			["tsx", "/opt/my tools/tsserver"],
		]);
	});

	it("drops an empty command instead of mapping the language to nothing", () => {
		applyEffective({ lsp: { servers: { typescript: "/opt/tsserver", python: "" } } });
		expect([...lspConfiguredServers()]).toEqual([["typescript", "/opt/tsserver"]]);
	});

	it("coexists with ast — two nested sub-trees, one snapshot", () => {
		applyEffective({
			ast: { enabled: true, languages: { python: { enabled: false } } },
			lsp: { servers: { python: "/opt/pyright" } },
		});
		expect(isAstLanguageEnabled("python")).toBe(false);
		expect(lspConfiguredServers().get("python")).toBe("/opt/pyright");
	});
});
