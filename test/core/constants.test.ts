import { describe, expect, it } from "vitest";
import {
	SNIFF_BYTES,
	SERVED_TTL_MS,
} from "../../src/infra/constants.js";

describe("constants", () => {
	it("SNIFF_BYTES is a positive number", () => {
		expect(SNIFF_BYTES).toBeGreaterThan(0);
		expect(typeof SNIFF_BYTES).toBe("number");
	});

	it("SERVED_TTL_MS is exactly 7 days", () => {
		expect(SERVED_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
	});
});
