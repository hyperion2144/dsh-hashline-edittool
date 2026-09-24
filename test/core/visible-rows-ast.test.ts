/**
 * The maintainer's PR-169 probe table, part 2: the AST and LSP serve points.
 *
 * They were measured at ZERO persisted rows before this migration — a
 * `lineHashesPure` call minted anchors that went nowhere, so a row the model
 * could see was not in `anchor_lines` and did not survive a restart. This
 * pins the other half of the rule: persisted == served == visible.
 *
 * HEAVY project: the parse worker needs the longer startup budget.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getWritableTempRoot, makeExec } from "../support/fixtures.js";
import { loadHashStore } from "../../src/domain/session/hash-store.js";
import { hashStorePath } from "../../src/infra/paths.js";
import { buildAstGrepTool } from "../../src/tools/tool-ast-grep.js";
import { buildAstEditTool } from "../../src/tools/tool-ast-edit.js";
import { localIO } from "../../src/infra/fs-bridge.js";
import { applyEffective } from "../../src/config.js";
import { setAstClient, type WorkerLike } from "../../src/ast/client.js";
import { handleRequest, type AstWorkerRequest, type AstWorkerResponse } from "../../src/ast/worker.js";

/** The same IN-PROCESS worker `tool-ast.test.ts` drives — the grammar really
 * parses and no spawn timing is involved. */
function inProcessWorker(): WorkerLike {
	let respond: ((response: AstWorkerResponse) => void) | undefined;
	return {
		postMessage(message: AstWorkerRequest) {
			void handleRequest(message).then((response) => respond?.(response));
		},
		onMessage(listener) {
			respond = listener;
		},
		onExit() {},
		terminate() {},
	};
}

let tmpHome: string;
beforeAll(async () => {
	tmpHome = await mkdtemp(join(await getWritableTempRoot(), "visible-rows-ast-"));
	vi.stubEnv("HOME", tmpHome);
	vi.stubEnv("USERPROFILE", tmpHome);
	vi.stubEnv("DSH_HOME", join(tmpHome, ".dsh"));
	applyEffective({ ast: { enabled: true } });
	const { AstClient } = (await import("../../src/ast/client.js")) as unknown as {
		AstClient: new (opts: { spawn: () => WorkerLike; idleMs: number }) => Parameters<typeof setAstClient>[0];
	};
	setAstClient(new AstClient({ spawn: inProcessWorker, idleMs: 0 }));
});

function countRows(cwd: string): number {
	const db = new DatabaseSync(hashStorePath(cwd), { defensive: false } as never);
	try {
		const row = db.prepare("SELECT COUNT(*) AS n FROM anchor_lines").get() as { n: number };
		return row.n;
	} finally {
		db.close();
	}
}

/** 400 lines so a whole-file allocation is unmistakable against a few rows. */
function bigSources(): string {
	const out: string[] = [];
	for (let i = 0; i < 100; i++) {
		out.push(`export function fn${i}() {`, `\tconst a${i} = f(${i}, ${i + 1});`, `\treturn a${i};`, "}", "");
	}
	return out.join("\n");
}

describe("ast_grep / lsp persisted rows == model-visible rows (#169)", () => {
	it("ast_grep persists ONLY its matched rows, not the file", async () => {
		const cwd = join(tmpHome, "ast-case");
		await mkdir(cwd, { recursive: true });
		const file = join(cwd, "many.ts");
		await writeFile(file, bigSources());
		await loadHashStore(cwd);
		const tool = buildAstGrepTool(localIO());
		const res = (await tool.execute(
			{ path: file, pat: "const $NAME = f($$$ARGS);" },
			makeExec(cwd, "s")({}),
		)) as { matches?: unknown[]; modelText?: string };
		const text = res.modelText ?? "";
		const servedRows = [...text.matchAll(/^\s*([A-Za-z0-9]{2,8}):\d+[:|]/gm)].length;
		expect(servedRows).toBeGreaterThan(0); // the AST actually answered
		expect(servedRows).toBe(res.matches?.length ?? 0); // one row per match
		const persisted = countRows(cwd);
		expect(persisted).toBe(servedRows); // persisted == served == visible, exactly
		expect(persisted).toBeLessThan(500); // and the 500-line file was NOT allocated whole
	});

	it("ast_grep's anchors are SERVED too — they start an edit, not E_RANGE_UNSERVED", async () => {
		const cwd = join(tmpHome, "ast-served-case");
		await mkdir(cwd, { recursive: true });
		const file = join(cwd, "many.ts");
		await writeFile(file, bigSources());
		await loadHashStore(cwd);
		const grep = buildAstGrepTool(localIO());
		const found = (await grep.execute(
			{ path: file, pat: "const $NAME = f($$$ARGS);" },
			makeExec(cwd, "s")({}),
		)) as { modelText?: string };
		// The FIRST matched row's anchor, taken from the model text the way the
		// model would read it.
		const anchor = /^\s*([A-Za-z0-9]{2,8}):(\d+)[:|]/m.exec(found.modelText ?? "");
		expect(anchor).not.toBeNull();
		const [, anchorText, lineText] = anchor!;
		const line = Number(lineText);
		// Persisting an anchor is only half the contract (#171 probe: ast_grep
		// persisted but every edit came back E_RANGE_UNSERVED) — the shown rows
		// must also be in the served mirror, or they are anchors nobody can use.
		const { FsSandboxController } = await import("../../src/infra/sandbox.js");
		const sandbox = new FsSandboxController({ fs: { sandboxMode: undefined }, get: () => undefined } as never);
		const edit = buildAstEditTool(localIO(), sandbox);
		const applied = (await edit.execute(
			{ path: file, pat: `const a${line - 1} = f($$$ARGS);`, out: `const a${line - 1} = g($$$ARGS);` },
			makeExec(cwd, "s")({}),
		)) as { ok?: boolean; message?: string };
		expect(applied.message ?? "").not.toContain("E_RANGE_UNSERVED");
		expect(applied.ok).toBe(true);
		expect(await readFile(file, "utf8")).toContain("= g(");
		expect(anchorText.length).toBeGreaterThan(0);
	});
});
