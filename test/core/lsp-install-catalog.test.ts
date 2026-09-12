/**
 * The install catalog, checked for the property that matters most: it must not
 * offer a command the machine cannot run.
 *
 * `brew install jdtls` was written into the catalog as though Homebrew were the
 * world. On Linux and Windows that command does not exist, so the card would have
 * offered a button whose only possible outcome was a failure — the same mistake as
 * refusing on the user's behalf, made in the other direction. These tests pin the
 * platform split, because it is invisible on the machine most likely to develop it.
 *
 * @module
 */
import { describe, expect, it } from "vitest";
import { KNOWN_SERVERS } from "../../src/lsp/discovery.js";
import { canInstallServer, installCommandFor, serverEntryFor } from "../../src/lsp/install-server.js";

/** Every platform `process.platform` can actually take. */
const PLATFORMS = ["darwin", "linux", "win32"] as const;

describe("the install catalog is platform-aware", () => {
	it("offers jdtls on macOS only, because Homebrew is its only formula", () => {
		expect(installCommandFor("java", "darwin")).toEqual(["brew", "install", "jdtls"]);
		expect(canInstallServer("java", "linux")).toBe(false);
		expect(canInstallServer("java", "win32")).toBe(false);
	});

	it("offers ghcup's HLS on every platform, since ghcup is itself cross-platform", () => {
		for (const platform of PLATFORMS) {
			expect(installCommandFor("haskell", platform)).toEqual(["ghcup", "install", "hls"]);
		}
	});

	it("offers elixir-ls on macOS only", () => {
		expect(canInstallServer("elixir", "darwin")).toBe(true);
		expect(canInstallServer("elixir", "linux")).toBe(false);
		expect(canInstallServer("elixir", "win32")).toBe(false);
	});

	it("refuses every platform for a language the catalog has no entry for", () => {
		// `julia`'s server is launched with a project path inside its argv, so it cannot
		// be a static entry — and the card must say that rather than name nothing.
		expect(serverEntryFor("julia")).toBeUndefined();
		for (const platform of PLATFORMS) {
			expect(canInstallServer("julia", platform)).toBe(false);
		}
	});

	it("asks npm for a package rather than a bare binary, and asks it everywhere", () => {
		// npm needs the plugin's prefix, so the real argv is built later; what this
		// pins is that an npm entry answers on every platform.
		for (const platform of PLATFORMS) {
			expect(installCommandFor("typescript", platform)).toEqual(["npm"]);
		}
	});

	it("never claims a platform has an installer the catalog cannot produce", () => {
		// The invariant behind all of the above: `canInstall` is derived from the
		// command, so the two can never disagree.
		for (const entry of KNOWN_SERVERS) {
			const language = entry.languages[0]!;
			for (const platform of PLATFORMS) {
				const command = installCommandFor(language, platform);
				expect(canInstallServer(language, platform)).toBe(command !== undefined);
			}
		}
	});

	it("keeps clangd out of the catalog's installers on purpose", () => {
		// Its formula is `llvm` — a gigabyte of compiler infrastructure. Installing that
		// from a settings card is not a convenience, and the exclusion is deliberate.
		for (const platform of PLATFORMS) {
			expect(canInstallServer("c", platform)).toBe(false);
		}
	});
});
