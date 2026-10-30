/**
 * #260 — the search engine sizes each `rg` invocation by command-line
 * LENGTH, never by FILE COUNT.
 *
 * The pre-filter that came before it sized the file list by count
 * (`CHUNK = 400`), not by the LENGTH of the command line it builds. Count is
 * not a bound on argv: 400 paths at 120 chars compose a ~48,000-char command
 * line, and an OS that cannot hold it fails the spawn instead of running rg.
 *
 * On Windows that is `CreateProcess`'s 32,767-char limit and the error is
 * `spawn ENAMETOOLONG`; Node raises it SYNCHRONOUSLY out of `execFile`
 * (verified on this repo's Node: an over-limit argv throws `spawn E2BIG` at
 * the call, not through the callback). A synchronous throw inside the promise
 * executor REJECTS the promise, so the caller's fallback never ran and the
 * whole grep failed — that is the reported symptom.
 *
 * The OS limit is not fakeable on the machine running these tests, so the
 * spawn is: the mock composes the command line the way the platform would,
 * enforces the Windows limit on it, and otherwise answers like `rg --json`
 * (a chunk's files whose NAME contains `hit` matched; exit 1 when none did).
 * Every assertion below is therefore measured on the REAL argv the engine
 * builds — the only substituted piece is the kernel.
 *
 * @module
 */
import { describe, expect, it, vi } from "vitest";

/**
 * `CreateProcessW`'s lpCommandLine cap — the KERNEL's number, deliberately its
 * own literal here: this mock stands in for the OS, so it must hold the limit
 * the OS holds, not the one production happens to budget against.
 */
const WINDOWS_COMMAND_LINE_LIMIT = 32_767;

type Invocation = { readonly argv: readonly string[]; readonly commandLine: number };

const harness = vi.hoisted(() => ({
	invocations: [] as Invocation[],
	/** Set to make every spawn fail synchronously, whatever the command line is. */
	alwaysThrow: undefined as Error | undefined,
	/** Length of the command line Windows would compose: `rg`, args, NUL-free, quoted. */
	commandLine(argv: readonly string[]): number {
		// Quoting is conservative on purpose: Node wraps an argument that holds a
		// space or a quote, and only ever makes it longer, so an unquoted join is
		// the lower bound the limit is checked against.
		return argv.reduce((total, arg) => total + arg.length + 3, 0);
	},
}));

vi.mock("node:child_process", () => ({
	execFile: (
		file: string,
		args: string[],
		_opts: unknown,
		callback: (error: { code?: string | number } | null, stdout: string, stderr: string) => void,
	) => {
		const argv = [file, ...args];
		const commandLine = harness.commandLine(argv);
		harness.invocations.push({ argv, commandLine });
		if (harness.alwaysThrow !== undefined) throw harness.alwaysThrow;
		if (commandLine > WINDOWS_COMMAND_LINE_LIMIT) {
			// What the kernel does on Windows: the process never exists, and
			// `child_process` surfaces it as a synchronous throw.
			throw new Error("spawn ENAMETOOLONG");
		}
		// The files ride behind `--`; the flags ride before it.
		const separator = args.indexOf("--");
		const files = separator === -1 ? [] : args.slice(separator + 1);
		const hits = files.filter((candidate) => candidate.includes("hit"));
		if (hits.length === 0) {
			// Exit 1 = nothing matched: an ANSWER, not a failure.
			callback({ code: 1 }, "", "");
			return {} as never;
		}
		// Answer like `rg --json`: one match record per hit file.
		const stdout = hits
			.map((path) =>
				JSON.stringify({
					type: "match",
					data: {
						path: { text: path },
						lines: { text: "needle\n" },
						line_number: 1,
						absolute_offset: 0,
						submatches: [{ match: { text: "needle" }, start: 0, end: 6 }],
					},
				}),
			)
			.join("\n");
		callback(null, stdout, "");
		return {} as never;
	},
}));

import { planArgvChunks } from "../../src/infra/argv-limit.js";
import { rgSearchMatches } from "../../src/tools/grep-rg.js";
import { rgMatchesOf } from "../support/fixtures.js";


/** A candidate path of EXACTLY `length` characters, self-describing for the fake rg. */
function pathOf(length: number, index: number, marker = "miss"): string {
	const name = `${marker}-${index}.ts`;
	return `/deep/${"d".repeat(length - name.length - 7)}/${name}`;
}

function longPaths(count: number, length: number, hitAt: readonly number[] = []): string[] {
	return Array.from({ length: count }, (_unused, index) =>
		pathOf(length, index, hitAt.includes(index) ? "hit" : "miss"),
	);
}

function reset(): void {
	harness.invocations.length = 0;
	harness.alwaysThrow = undefined;
}

describe("the engine sizes each invocation by command-line length (#260)", () => {
	it("survives the reported shape: 400 files, ~120-char paths", async () => {
		reset();
		const files = longPaths(400, 120, [0, 399]);

		// Pre-fix: one 400-file chunk ≈ 48,400 chars — over the limit, so the spawn
		// throws out of the executor and this await REJECTS with ENAMETOOLONG.
		const outcome = await rgSearchMatches({ pattern: "needle", literal: true, files });

		expect(outcome.kind).toBe("ok");
		expect(rgMatchesOf(outcome)).toMatchObject([
			{ path: files[0], line: 1 },
			{ path: files[399], line: 1 },
		]);
		expect(harness.invocations.length).toBeGreaterThan(1);
		for (const invocation of harness.invocations) {
			expect(invocation.commandLine).toBeLessThanOrEqual(WINDOWS_COMMAND_LINE_LIMIT);
		}
	});

	it("keeps the minimal repro under the limit: 6 files at ~6.3K chars", async () => {
		reset();
		// The smallest input the count-based chunker still sends in one command
		// line: 6 × 6,300 ≈ 37,900 > 32,767. Fewer files or shorter paths and the
		// count-based code passes — every element here is load-bearing.
		const files = longPaths(6, 6_300, [4]);

		const outcome = await rgSearchMatches({ pattern: "needle", literal: true, files });
		expect(outcome.kind).toBe("ok");
		expect(rgMatchesOf(outcome)).toMatchObject([{ path: files[4], line: 1 }]);
		for (const invocation of harness.invocations) {
			expect(invocation.commandLine).toBeLessThanOrEqual(WINDOWS_COMMAND_LINE_LIMIT);
		}
	});

	it("still batches short paths — length-based is not one-file-per-spawn", async () => {
		reset();
		// 400 × 20 ≈ 8,000 chars: comfortably one invocation. A fix that split per
		// file would pass every limit assertion above and lose rg's whole point.
		const files = longPaths(400, 20, [7]);

		const outcome = await rgSearchMatches({ pattern: "needle", literal: true, files });
		expect(outcome.kind).toBe("ok");
		expect(rgMatchesOf(outcome)).toMatchObject([{ path: files[7], line: 1 }]);
		expect(harness.invocations).toHaveLength(1);
	});
});

describe("a spawn that throws synchronously is a FAILURE outcome, never a rejection (#260)", () => {
	it("answers 'failed', so the caller can fall back", async () => {
		reset();
		harness.alwaysThrow = new Error("spawn ENAMETOOLONG");

		// The documented contract of this seam: ANY failure — binary missing,
		// spawn error, timeout — is an OUTCOME. A synchronous spawn throw used to
		// escape the promise (and the contract) as a rejection.
		await expect(
			rgSearchMatches({ pattern: "needle", literal: true, files: [pathOf(30, 1), pathOf(30, 2)] }),
		).resolves.toMatchObject({ kind: "failed" });
	});

	it("gives up on a path no command line can hold, without rejecting", async () => {
		reset();
		// One path longer than the whole budget: no chunking can save it, so the
		// planner abstains — the engine answers 'failed' AND never hands the OS a
		// command line it would have to refuse (acceptance criterion a).
		await expect(
			rgSearchMatches({
				pattern: "needle",
				literal: true,
				files: [pathOf(40_000, 1), pathOf(30, 2)],
			}),
		).resolves.toMatchObject({ kind: "failed" });
		expect(harness.invocations).toHaveLength(0);
	});
});

describe("planArgvChunks — the budget arithmetic itself (#260)", () => {
	it("keeps every item in one chunk while the composed line fits", () => {
		expect(planArgvChunks(["/usr/bin/rg"], ["a".repeat(100), "b".repeat(100)], 1_000)).toEqual([
			["a".repeat(100), "b".repeat(100)],
		]);
	});

	it("splits where the composed line stops fitting, and only there", () => {
		const items = ["a".repeat(300), "b".repeat(300), "c".repeat(300)];
		// head "rg" = 2 + 4 = 6; each item = 300 + 4 = 304, so a 700 budget holds two
		// items plus the head (614) and refuses the third (918).
		expect(planArgvChunks(["rg"], items, 700)).toEqual([[items[0], items[1]], [items[2]]]);
	});

	it("abstains when the fixed argv alone spends the budget", () => {
		expect(planArgvChunks(["rg".padEnd(200, "x")], ["a"], 100)).toBeUndefined();
	});

	it("abstains on an item no chunk could hold, instead of spawning it", () => {
		expect(planArgvChunks(["rg"], ["a".repeat(500)], 100)).toBeUndefined();
	});

	it("preserves order across chunks, drops nothing and never emits an empty chunk", () => {
		const items = Array.from({ length: 10 }, (_unused, index) => `${index}`.padEnd(50, "x"));
		const chunks = planArgvChunks(["rg"], items, 200);
		expect(chunks?.flat()).toEqual(items);
		expect(chunks?.every((chunk) => chunk.length > 0)).toBe(true);
	});
});
