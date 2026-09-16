import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Global isolation first: every run gets a throwaway $DSH_HOME so no
		// test can ever touch the developer's real ~/.dsh. See test/setup.ts.
		setupFiles: ["./test/setup.ts"],
	},
});
