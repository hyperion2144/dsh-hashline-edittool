import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { defaultDshHome } from "@deepseek-ai/dsh-home-paths";
import { configDir, hashStorePath, hashStoreDir } from "../../src/infra/paths.js";

describe("configDir", () => {
	it("returns the store dir under the default DSH home when DSH_HOME is unset", () => {
		const previousDsh = process.env.DSH_HOME;
		delete process.env.DSH_HOME;
		try {
			expect(configDir()).toBe(
				join(defaultDshHome(), "plugins", "dsh-hashline-edittool"),
			);
		} finally {
			if (previousDsh === undefined) delete process.env.DSH_HOME;
			else process.env.DSH_HOME = previousDsh;
		}
	});

	it("uses DSH_HOME when set", () => {
		const previousDsh = process.env.DSH_HOME;
		// A platform-LEGAL absolute root. The old "/custom/dsh" is drive-relative
		// on Windows (a leading separator with no drive), so resolving it gained the
		// current drive and the expectation — built with the platform's own join —
		// no longer matched. A temp path is absolute on every platform.
		process.env.DSH_HOME = join(tmpdir(), "dsh-custom-home");
		try {
			expect(configDir()).toBe(join(process.env.DSH_HOME, "plugins", "dsh-hashline-edittool"));
		} finally {
			if (previousDsh === undefined) delete process.env.DSH_HOME;
			else process.env.DSH_HOME = previousDsh;
		}
	});

	it("ignores an empty DSH_HOME", () => {
		const previousDsh = process.env.DSH_HOME;
		process.env.DSH_HOME = "   ";
		try {
			expect(configDir()).toBe(
				join(defaultDshHome(), "plugins", "dsh-hashline-edittool"),
			);
		} finally {
			if (previousDsh === undefined) delete process.env.DSH_HOME;
			else process.env.DSH_HOME = previousDsh;
		}
	});

	it("keys the store by projectKey(cwd) under the plugin base", () => {
		const previousDsh = process.env.DSH_HOME;
		process.env.DSH_HOME = "/custom/dsh";
		try {
			const base = configDir();
			const withCwd = configDir("/home/user/my-project");
			expect(withCwd.startsWith(base)).toBe(true);
			expect(withCwd).not.toBe(base);
			expect(withCwd).toContain("home");
			expect(withCwd).toContain("my-project");
			const otherCwd = configDir("/home/user/other-project");
			expect(otherCwd).not.toBe(withCwd);
		} finally {
			if (previousDsh === undefined) delete process.env.DSH_HOME;
			else process.env.DSH_HOME = previousDsh;
		}
	});
});

describe("hashStorePath", () => {
	it("returns the hash store file path", () => {
		const path = hashStorePath();
		expect(path).toBe(join(configDir(), "hash-store.sqlite"));
	});
});

describe("hashStoreDir", () => {
	it("returns the directory of the hash store path", () => {
		const dir = hashStoreDir();
		expect(dir).toBe(dirname(hashStorePath()));
	});
});
