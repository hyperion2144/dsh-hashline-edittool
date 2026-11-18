/**
 * The format row's LEGACY replay (ADR-0040).
 *
 * The host now carries the row-group shape itself, so a new format call's meta
 * names its tab directly. A meta persisted BEFORE that change carries only
 * `formats` — and it must still render: logged history never stops drawing
 * (the same promise ADR-0026 decision 6 makes for the wire texts).
 *
 * The projection is a PURE function (`formatRowGroups`), so it is pinned here
 * without a DOM — this environment cannot render, and the source-text pins
 * this file used to carry broke on any refactor.
 *
 * @module dsh-hashline-edittool/client/test/format-legacy-meta
 */
import { describe, expect, it } from "vitest";
import { formatRowGroups } from "../src/client/models.js";

/** A meta persisted before the host carried the row-group shape. */
const legacyMeta = {
	formats: [{ path: "/w/a.ts", status: "formatted" }],
};

/** A meta the host writes today. */
const modernMeta = {
	formats: [{ path: "/w/a.ts", status: "formatted" }],
	diffRowGroups: [{ path: "/w/a.ts", rows: [] }],
};

describe("the format row's groups — the host's, or the legacy synthesis", () => {
	it("synthesizes the row group for a meta that carries only `formats`", () => {
		expect(formatRowGroups(legacyMeta, "/w/fallback.ts")).toEqual([{ path: "/w/a.ts", rows: [] }]);
	});

	it("uses the host's row group when the meta carries one", () => {
		expect(formatRowGroups(modernMeta, "/w/fallback.ts")).toEqual([{ path: "/w/a.ts", rows: [] }]);
	});

	it("names the fallback path for a section that carries none", () => {
		expect(formatRowGroups({ formats: [{ status: "formatted" }] }, "/w/fallback.ts")).toEqual([
			{ path: "/w/fallback.ts", rows: [] },
		]);
	});

	it("draws nothing for a meta with no format sections", () => {
		expect(formatRowGroups({}, "/w/fallback.ts")).toEqual([]);
		expect(formatRowGroups(undefined, "/w/fallback.ts")).toEqual([]);
	});
});
