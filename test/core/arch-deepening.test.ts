/**
 * The deepened seams, pinned by BEHAVIOUR (ADR-0040).
 *
 * Each case here exists because the shallow version of the code let the same
 * fact live in two places: the probe table, the anchor fold, the diagnostics
 * projection, the slot root, the wire keys. A source-text pin breaks on any
 * refactor; these pins break only when the BEHAVIOUR changes.
 *
 * @module dsh-hashline-edittool/test/core/arch-deepening
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { probeVerdict } from "../../src/infra/probe-verdict.js";
import { WIRE_TEXT_KEYS } from "../../src/wire/keys.js";
import { buildPreparedItem } from "../../src/domain/edit/anchor-fold.js";
import { LspManager } from "../../src/lsp/manager.js";
import { subprocessTransport, type SubprocessLike } from "../../src/lsp/transport.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("probe verdict — one table, every prober (C7)", () => {
	it("maps each shape to its code and one shared wording skeleton", () => {
		const symlink = probeVerdict({ probe: { kind: "symlink" }, expect: "file", verb: "delete", path: "/p" });
		expect(symlink?.code).toBe("E_SYMLINK");
		expect(symlink?.message).toContain("Refusing to delete a symbolic link: /p.");
		expect(symlink?.message).toContain("use bash");

		const directory = probeVerdict({ probe: { kind: "directory" }, expect: "file", verb: "delete", path: "/p" });
		expect(directory?.code).toBe("E_NOT_FILE");
		expect(directory?.message).toContain("Path is not a regular file: /p.");
		expect(directory?.message).toContain("use bash for directories");

		const absent = probeVerdict({ probe: { kind: "absent" }, expect: "file", verb: "delete", path: "/p" });
		expect(absent?.code).toBe("E_NOT_FOUND");

		// The verb is the ONLY difference between the tools' wording.
		const renamed = probeVerdict({ probe: { kind: "symlink" }, expect: "file", verb: "rename", path: "/p" });
		expect(renamed?.code).toBe(symlink?.code);
		expect(renamed?.message).toContain("Refusing to rename a symbolic link: /p.");
	});

	it("treats an unoccupied destination as satisfied, an occupied one as E_EXISTS", () => {
		expect(probeVerdict({ probe: { kind: "absent" }, expect: "unoccupied", verb: "rename", path: "/p" })).toBeUndefined();
		const taken = probeVerdict({ probe: { kind: "file" }, expect: "unoccupied", verb: "rename", path: "/p" });
		expect(taken?.code).toBe("E_EXISTS");
		expect(taken?.message).toContain("Destination already exists: /p.");
	});

	it("keeps the patch's vocabulary: absent→E_NOT_FOUND, directory→E_NOT_FILE", () => {
		expect(probeVerdict({ probe: { kind: "absent" }, expect: "file", verb: "edit", path: "/p" })?.code).toBe(
			"E_NOT_FOUND",
		);
		expect(probeVerdict({ probe: { kind: "directory" }, expect: "file", verb: "edit", path: "/p" })?.code).toBe(
			"E_NOT_FILE",
		);
		expect(probeVerdict({ probe: { kind: "absent" }, expect: "directory", verb: "edit", path: "/p" })?.code).toBe(
			"E_NOT_FOUND",
		);
	});
});

describe("the wire key contract — one source (C4)", () => {
	it("carries every key the host NAMES", () => {
		// The host's key literals live in its render modules; the single source
		// is src/wire/keys.ts and the client's gate is its build-time
		// projection. A key the host sends but the list lacks must fail HERE.
		const renderDir = join(repoRoot, "src", "render");
		const named = new Set<string>();
		for (const file of readdirSync(renderDir)) {
			if (!file.endsWith(".ts")) continue;
			const source = readFileSync(join(renderDir, file), "utf8");
			for (const match of source.matchAll(/key: "([a-z][A-Za-z0-9_.]+)"/g)) named.add(match[1]!);
		}
		expect(named.size).toBeGreaterThanOrEqual(20);
		for (const key of named) {
			expect(Object.hasOwn(WIRE_TEXT_KEYS, key)).toBe(true);
		}
	});
});

describe("anchor fold — one fold for every tool (C6)", () => {
	it("salvages a pasted-row ref the way `edit` does", () => {
		const item = buildPreparedItem(
			0,
			"/w/a.ts",
			{ op: "replace", anchor_start: "Ab:the pasted line", lines: ["new"] },
			"/w/a.ts",
		);
		// The salvage REDUCES the pasted row to a reference form, and the
		// warning says so — the same facts an `edit` item carries.
		expect(item.remove_from).not.toContain(":the pasted line");
		expect(item.refWarnings?.[0]).toContain("stripped trailing content");
		expect(item.refWarnings?.[0]).toContain("Ab");
	});

	it("defaults anchor_end to anchor_start and maps `del` to an empty replacement", () => {
		const item = buildPreparedItem(0, "/w/a.ts", { op: "del", anchor_start: "Ab" }, "/w/a.ts");
		expect(item.remove_to).toBe(item.remove_from);
		expect(item.replacement_text).toBe("");
	});

	it("refuses an item with no anchor at all", () => {
		expect(() => buildPreparedItem(0, "/w/a.ts", { op: "replace", lines: ["x"] }, "/w/a.ts")).toThrow(
			/E_BAD_SHAPE/,
		);
	});
});

describe("slot root — the manager's own fact (C2)", () => {
	it("advertises the ROOT IT RESOLVES, not a caller's process cwd", async () => {
		// The root is resolved by the manager (ADR-0031): a caller cannot
		// disagree about it, because no caller passes one.
		const spawns: string[] = [];
		// A server that never answers: the spawn ALREADY happened by then, which
		// is the fact under test — the ROOT the manager advertised.
		const handle: SubprocessLike = {
			pid: 4242,
			stdin: { write: () => true },
			stdout: { on: () => undefined },
			stderr: { on: () => undefined },
			done: new Promise(() => undefined),
			async waitForExit() {
				return true;
			},
			terminate() { },
		};
		const manager = new LspManager({
			pathDirs: ["/bin"],
			isExecutable: async () => true,
			initializeTimeoutMs: 200,
			rootResolver: async () => "/the/session/root",
			spawn: (_server, cwd) => {
				spawns.push(cwd);
				return { transport: subprocessTransport(handle) };
			},
		});
		manager.warm("typescript");
		for (let i = 0; i < 50; i++) await Promise.resolve();
		expect(spawns[0]).toBe("/the/session/root");
		await manager.dispose();
	});
});

describe("the deepened seams — no dead copies left (C1/C5/C8)", () => {
	it("keeps no zero-call legacy pipeline in the mutation module", () => {
		const source = readFileSync(join(repoRoot, "src", "domain", "edit", "mutation.ts"), "utf8");
		expect(source).not.toContain("execPipeline");
		expect(source).not.toContain("applySingle");
		expect(source).not.toContain("applySequence");
	});

	it("keeps the local IO out of the production fs bridge", () => {
		const source = readFileSync(join(repoRoot, "src", "infra", "fs-bridge.ts"), "utf8");
		expect(source).not.toContain("export function localIO");
	});

	it("declares ONE diagnostics policy per channel", () => {
		const auto = readFileSync(join(repoRoot, "src", "lsp", "auto-diag.ts"), "utf8");
		const tool = readFileSync(join(repoRoot, "src", "tools", "tool-lsp.ts"), "utf8");
		expect(auto).toContain("WRITE_DIAGNOSTIC_POLICY");
		expect(tool).toContain("MANUAL_DIAGNOSTIC_POLICY");
		// The projection itself is shared: neither channel builds its own rows.
		expect(auto).toContain("diagnostics/projection.js");
		expect(tool).toContain("diagnostics/projection.js");
	});
});
