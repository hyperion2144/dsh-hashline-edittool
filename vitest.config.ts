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

export default defineConfig({
	test: {
		// Global isolation first: every run gets a throwaway $DSH_HOME so no
		// test can ever touch the developer's real ~/.dsh. See test/setup.ts.
		setupFiles: ["./test/setup.ts"],
		// The client workspace runs its own suite (`npm test -w client`);
		// including it here double-ran those files and broke on build
		// artifacts that only exist after a client build.
		//
		// Two projects, one pool policy each: everything runs in parallel except
		// the heavy files, which run one at a time with their own budget. Both
		// inherit this block (setupFiles, the exclude above) through `extends`.
		exclude: ["**/node_modules/**", "client/**"],
		projects: [
			{
				extends: true,
				test: { name: "core", exclude: ["**/node_modules/**", "client/**", ...HEAVY_TEST_FILES] },
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
