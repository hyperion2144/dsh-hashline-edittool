/**
 * Issue #271: a backend's "too large to read" refusal (`FS_TOO_LARGE`, the
 * documented outcome of `readBytes` past its `maxBytes`) fell through
 * `mapFsError`'s whitelist and reached the caller as the raw backend error —
 * `message: "FS_TOO_LARGE"` with no `[E_*]` domain code, no path, no next
 * step. Every other `FS_*` refusal maps; this one must too.
 *
 * The mapping test drives the production `mapFsError` directly (no mocks);
 * the end-to-end test pins the #268 contract through `ctxFsIO` + the real
 * grep tool: mapping the code must NOT turn grep's silent skip of an
 * unreadable file into a surfaced error.
 * @module dsh-hashline-edittool/issue-271-too-large-mapping.test
 */

import { describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { ctxFsIO, mapFsError } from "../../src/infra/fs-bridge.js";
import { setupIntegrationTest, withTempDir } from "../support/fixtures.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** A backend error with an `FsError`-shaped code, as dsh-fs throws them. */
function withCode(code: string): Error {
	return Object.assign(new Error(code), { code });
}

describe("mapFsError maps FS_TOO_LARGE (#271)", () => {
	it("maps the refusal onto the [E_TOO_LARGE] domain code, with the path", () => {
		expect(() => mapFsError(withCode("FS_TOO_LARGE"), "/tmp/big.log")).toThrow(
			"[E_TOO_LARGE]",
		);
		expect(() => mapFsError(withCode("FS_TOO_LARGE"), "/tmp/big.log")).toThrow(
			"/tmp/big.log",
		);
	});

	it("keeps every other mapping intact (regression guard on the whitelist)", () => {
		expect(() => mapFsError(withCode("FS_NOT_FOUND"), "/p")).toThrow("[E_NOT_FOUND]");
		expect(() => mapFsError(withCode("FS_PERMISSION_DENIED"), "/p")).toThrow("[E_ACCESS]");
		expect(() => mapFsError(withCode("FS_NOT_TEXT"), "/p")).toThrow("[E_NOT_TEXT]");
		expect(() => mapFsError(withCode("FS_ABORTED"), "/p")).toThrow("Operation aborted");
	});
});

