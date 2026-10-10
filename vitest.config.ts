import { defineConfig } from "vitest/config";

/**
 * Files that run long enough to collide with a fully parallel pool on a modest
 * machine: measured at 2s–17s EACH here, and reported as per-test timeouts
 * (default 5s) on a Windows box with 93 files in flight (#162). They keep every
 * assertion; they just stop competing with the other ninety.
 *
 * Sequential, NOT a raised global budget: a global bump would also hide a test
 * that genuinely hangs.
 */
const HEAVY_TEST_FILES = [
	"test/core/tool-lsp.test.ts",
	"test/core/hashline-limit.test.ts",
	"test/core/issue-147-line-space.test.ts",
	"test/core/anchor-state-persistence.test.ts",
	"test/core/tool-ast.test.ts",
	"test/core/visible-rows-ast.test.ts",
];

/**
 * Never part of the repo's own suite: dependencies, the `client` workspace (it
 * runs its own suite through `npm test -w client`), and the tooling directory —
 * `.agents/worktrees/<branch>` holds a full checkout of this repo, so without that
 * entry a leftover worktree doubles the discovered file count and drags in copies
 * whose client build artifacts do not exist in that checkout (#266).
 *
 * Root-relative globs on purpose: they resolve against whichever checkout is the
 * root, and they have to keep working on Windows too.
 */
const EXCLUDED_PATHS = ["**/node_modules/**", "client/**", ".agents/**"];

export default defineConfig({
	test: {
		// Global isolation first: every run gets a throwaway $DSH_HOME so no
		// test can ever touch the developer's real ~/.dsh. See test/setup.ts.
		setupFiles: ["./test/setup.ts"],
		// The client workspace runs its own suite (`npm test -w client`);
		// including it here double-ran those files and broke on build
		// artifacts that only exist after a client build. `.agents/**` is the same
		// class of mistake one level out: a checkout under `.agents/worktrees/`
		// is a copy of this repo, not part of it (#266). Both live in
		// EXCLUDED_PATHS so the two projects cannot drift apart.
		//
		// Two projects, one pool policy each: everything runs in parallel except
		// the heavy files, which run one at a time with their own budget. Both
		// inherit this block (setupFiles, the exclude above) through `extends`.
		exclude: EXCLUDED_PATHS,
		projects: [
			{
				extends: true,
				test: { name: "core", exclude: [...EXCLUDED_PATHS, ...HEAVY_TEST_FILES] },
			},
			{
				extends: true,
				test: {
					name: "heavy",
					include: [...HEAVY_TEST_FILES],
					fileParallelism: false,
					testTimeout: 30_000,
					hookTimeout: 30_000,
				},
			},
		],
	},

});
