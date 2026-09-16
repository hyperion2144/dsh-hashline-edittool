import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Global isolation first: every run gets a throwaway $DSH_HOME so no
		// test can ever touch the developer's real ~/.dsh. See test/setup.ts.
		setupFiles: ["./test/setup.ts"],
		// The client workspace runs its own suite (`npm test -w client`);
		// including it here double-ran those files and broke on build
		// artifacts that only exist after a client build.
		exclude: ["**/node_modules/**", "client/**"],
	},
});
