import { describe, expect, it, vi, beforeAll } from "vitest";
import { mkdtemp, rm } from "fs/promises";
import { join } from "node:path";

import {
	loadServed,
	recordServed,
	driftReported,
	markDriftReported,
	clearDriftReported,
	wipeServedState,
} from "../../src/domain/session/session-view.js";
import { shutdownHashStore } from "../../src/domain/session/hash-store.js";
import { getWritableTempRoot } from "../support/fixtures.js";

let tmpHome: string;
beforeAll(async () => {
});

describe("served-state — record semantics", () => {
	it("records served rows that load back by path and position", async () => {
		await withTempHome(async () => {
			await recordServed("sessionA", "/a.ts", [
				{ position: 0, anchor: "abc" },
				{ position: 1, anchor: "def" },
				{ position: 2, anchor: "ghi" },
			]);
			expect(await loadServed("sessionA", "/a.ts")).toEqual(new Set(["abc", "def", "ghi"]));
		});
	});

	it("returns an empty record for a path with no served entries", async () => {
		await withTempHome(async () => {
			expect(await loadServed("sessionA", "/missing.ts")).toEqual(new Set());
		});
	});

	it("exposes interior gaps as never-served markers", async () => {
		await withTempHome(async () => {
			await recordServed("sessionA", "/p.ts", [
				{ position: 0, anchor: "abc" },
				{ position: 2, anchor: "def" },
			]);
			expect(await loadServed("sessionA", "/p.ts")).toEqual(new Set(["abc", "def"]));
		});
	});

	it("overwrites a previously served position", async () => {
		await withTempHome(async () => {
		await recordServed("sessionA", "/p.ts", [{ position: 0, anchor: "abc" }]);
		await recordServed("sessionA", "/p.ts", [{ position: 0, anchor: "def" }]);
			expect(await loadServed("sessionA", "/p.ts")).toEqual(new Set(["abc", "def"]));
		});
	});

	it("marks a served position as never-served with a null hash", async () => {
		await withTempHome(async () => {
			await recordServed("sessionA", "/p.ts", [
				{ position: 0, anchor: "abc" },
				{ position: 1, anchor: "def" },
				{ position: 2, anchor: "ghi" },
			]);
		await recordServed("sessionA", "/p.ts", [{ position: 1, anchor: null }]);
			expect(await loadServed("sessionA", "/p.ts")).toEqual(new Set(["abc", "def", "ghi"]));
		});
	});

	it("keeps unrelated served records intact when recording another path", async () => {
		await withTempHome(async () => {
		await recordServed("sessionA", "/a.ts", [{ position: 0, anchor: "abc" }]);
			await recordServed("sessionA", "/b.ts", [
				{ position: 0, anchor: "def" },
				{ position: 1, anchor: "ghi" },
			]);
			expect(await loadServed("sessionA", "/a.ts")).toEqual(new Set(["abc"]));
			expect(await loadServed("sessionA", "/b.ts")).toEqual(new Set(["def", "ghi"]));
		});
	});
});

describe("served-state — session isolation", () => {
	it("keeps one session's rows invisible to another session", async () => {
		await withTempHome(async () => {
		await recordServed("sessionA", "/p.ts", [{ position: 0, anchor: "abc" }]);
			expect(await loadServed("sessionA", "/p.ts")).toEqual(new Set(["abc"]));
			expect(await loadServed("sessionB", "/p.ts")).toEqual(new Set());
		});
	});

	it("wipes only the targeted session's served state", async () => {
		await withTempHome(async () => {
		await recordServed("sessionA", "/p.ts", [{ position: 0, anchor: "abc" }]);
		await recordServed("sessionB", "/p.ts", [{ position: 0, anchor: "def" }]);
			await wipeServedState("sessionA");
			expect(await loadServed("sessionA", "/p.ts")).toEqual(new Set());
			expect(await loadServed("sessionB", "/p.ts")).toEqual(new Set(["def"]));
		});
	});

	it("keeps reported drift sets per session", async () => {
		await withTempHome(async () => {
			await markDriftReported("sessionA", "/p.ts", ["abc"]);
			await markDriftReported("sessionB", "/p.ts", ["def"]);
			expect(await driftReported("sessionA", "/p.ts")).toEqual(new Set(["abc"]));
			expect(await driftReported("sessionB", "/p.ts")).toEqual(new Set(["def"]));
		});
	});
});

describe("served-state — reported drift set policy", () => {
	it("marks hashes as reported and clears them on demand", async () => {
		await withTempHome(async () => {
			await markDriftReported("sessionA", "/p.ts", ["abc", "def"]);
			expect(await driftReported("sessionA", "/p.ts")).toEqual(
				new Set(["abc", "def"]),
			);
			await clearDriftReported("sessionA", "/p.ts");
			expect(await driftReported("sessionA", "/p.ts")).toEqual(new Set());
		});
	});

	it("keeps reported sets per path", async () => {
		await withTempHome(async () => {
			await markDriftReported("sessionA", "/a.ts", ["abc"]);
			await markDriftReported("sessionA", "/b.ts", ["def"]);
			expect(await driftReported("sessionA", "/a.ts")).toEqual(new Set(["abc"]));
			expect(await driftReported("sessionA", "/b.ts")).toEqual(new Set(["def"]));
			await clearDriftReported("sessionA", "/a.ts");
			expect(await driftReported("sessionA", "/a.ts")).toEqual(new Set());
			expect(await driftReported("sessionA", "/b.ts")).toEqual(new Set(["def"]));
		});
	});

	it("returns an empty reported set for a path with no marks", async () => {
		await withTempHome(async () => {
			expect(await driftReported("sessionA", "/missing.ts")).toEqual(new Set());
		});
	});
});

describe("served-state — session wipe", () => {
	it("removes the session's served records and reported sets", async () => {
		await withTempHome(async () => {
		await recordServed("sessionA", "/a.ts", [{ position: 0, anchor: "abc" }]);
		await recordServed("sessionA", "/b.ts", [{ position: 1, anchor: "def" }]);
			await markDriftReported("sessionA", "/a.ts", ["abc"]);
			await wipeServedState("sessionA");
			expect(await loadServed("sessionA", "/a.ts")).toEqual(new Set());
			expect(await loadServed("sessionA", "/b.ts")).toEqual(new Set());
			expect(await driftReported("sessionA", "/a.ts")).toEqual(new Set());
		});
	});
});

async function withTempHome(run: () => Promise<void>): Promise<void> {
	tmpHome = await mkdtemp(
		join(await getWritableTempRoot(), "pi-hashline-served-state-test-"),
	);
	vi.stubEnv("HOME", tmpHome);
	vi.stubEnv("USERPROFILE", tmpHome);
	// Empty DSH_HOME = "unset" for resolveDshHome — the store resolves to
	// homedir()/.dsh, matching sqlitePath in this file.
	vi.stubEnv("DSH_HOME", "");
	vi.stubEnv("XDG_CONFIG_HOME", "");
	try {
		await run();
	} finally {
		shutdownHashStore();
		vi.unstubAllEnvs();
		await rm(tmpHome, { recursive: true, force: true });
	}
}
