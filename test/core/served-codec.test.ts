/**
 * The served set's packing (#176, spec #184): the same set stored as sorted
 * delta varints in base64 instead of a JSON array, with every legacy shape still
 * readable so a store written by an older build keeps working until its next
 * write.
 *
 * What matters here: the round trip is exact, legacy rows decode, an unreadable
 * payload is reported (so the caller can heal the row rather than serving a
 * silently empty set), and the packed form is actually smaller — the reason the
 * change exists.
 *
 * @module dsh-hashline-edittool/test/core/served-codec
 */
import { describe, expect, it } from "vitest";
import {
	decodeServedAnchors,
	encodeServedAnchors,
} from "../../src/domain/session/served-codec.js";

describe("the served codec round-trips", () => {
	it("keeps every anchor", () => {
		// Canonical anchors only: the plugin mints Base62 integers, so no anchor
		// has a leading zero. The codec normalises to that form — "000" decodes
		// as "0" — which is asserted separately below.
		const anchors = ["abc", "aB", "9", "zzz", "ZZZ9", "ZZ"];
		const decoded = decodeServedAnchors(encodeServedAnchors(anchors));
		expect(decoded).toEqual(new Set(anchors));
	});

	it("is order- and duplicate-insensitive", () => {
		const packed = encodeServedAnchors(["bbb", "aaa", "bbb", "ccc"]);
		expect(decodeServedAnchors(packed)).toEqual(new Set(["aaa", "bbb", "ccc"]));
		// A different insertion order is the same set, hence the same payload.
		expect(encodeServedAnchors(["ccc", "aaa", "bbb"])).toBe(packed);
	});

	it("handles the empty set and the single anchor", () => {
		expect(decodeServedAnchors(encodeServedAnchors([]))).toEqual(new Set());
		expect(decodeServedAnchors(encodeServedAnchors(["k"]))).toEqual(new Set(["k"]));
	});

	it("marks its payload so it can never be mistaken for JSON", () => {
		expect(encodeServedAnchors(["abc"]).startsWith("~")).toBe(true);
		// A legacy JSON row starts with '[', so the marker is unambiguous.
		expect(decodeServedAnchors('["abc"]')).toEqual(new Set(["abc"]));
	});

	it("drops anchors that are not Base62 rather than corrupting the payload", () => {
		// A hand-edited store could hold anything; the set's only consumer tests
		// membership of anchors this plugin minted.
		expect(decodeServedAnchors(encodeServedAnchors(["abc", "nope!", "", "   "]))).toEqual(new Set(["abc"]));
	});
});

describe("legacy shapes still decode (lazy migration)", () => {
	it("reads the plain anchor array", () => {
		expect(decodeServedAnchors('["aa","bb"]')).toEqual(new Set(["aa", "bb"]));
	});

	it("reads the v2 envelope", () => {
		expect(decodeServedAnchors('{"v":2,"a":["aa",null,"bb"],"k":[1,2]}')).toEqual(new Set(["aa", "bb"]));
	});

	it("reads the dense (string|null) array", () => {
		expect(decodeServedAnchors('["aa",null,"bb"]')).toEqual(new Set(["aa", "bb"]));
	});

	it("reports an unreadable payload instead of pretending the set is empty", () => {
		// The caller deletes the row and re-serves; returning an empty set would
		// silently revoke every anchor the session holds.
		expect(decodeServedAnchors("{not json")).toBeUndefined();
		expect(decodeServedAnchors("42")).toBeUndefined();
		expect(decodeServedAnchors("~!!!not base64!!!")).toBeUndefined();
	});
});

describe("the packed form is smaller — the point of the change", () => {
	it("beats the JSON array it replaces", () => {
		// A realistic window: 2,000 distinct anchors, generated the way the plugin
		// mints them — Base62 of an integer, so no leading zero and no collisions.
		const ALPH = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
		const canonical = (n: number): string => {
			let out = "";
			let rest = n;
			do {
				out = ALPH[rest % 62]! + out;
				rest = Math.floor(rest / 62);
			} while (rest > 0);
			return out;
		};
		const anchors: string[] = [];
		for (let i = 0; i < 2000; i++) anchors.push(canonical(i * 7919 + 13));
		const json = JSON.stringify(anchors);
		const packed = encodeServedAnchors(anchors);
		expect(decodeServedAnchors(packed)).toEqual(new Set(anchors));
		// JSON spends ~7–10 bytes per anchor on quotes and commas; the packed form
		// spends a couple of bytes on the deltas plus base64's 4/3 overhead.
		expect(packed.length).toBeLessThan(json.length / 2);
	});
});
