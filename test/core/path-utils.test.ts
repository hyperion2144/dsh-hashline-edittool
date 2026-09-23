import { describe, expect, it } from "vitest";
import * as os from "node:os";
import { join, resolve } from "node:path";
import { toCwd } from "../../src/infra/paths.js";

describe("toCwd", () => {
  const cwd = "/home/user/project";

  it("resolves a relative path against cwd", () => {
    expect(toCwd("src/main.ts", cwd)).toBe(
      resolve(cwd, "src/main.ts"),
    );
  });

  it("returns absolute paths unchanged", () => {
    expect(toCwd("/etc/hosts", cwd)).toBe("/etc/hosts");
  });

  /**
   * Run `body` with the environment home pointing at `home`, then restore it.
   * The implementation reads THIS value (with `os.homedir()` only as the
   * fallback), so a case that redirects the home must set it here rather than
   * trying to influence the OS helper — on Windows `os.homedir()` reads
   * USERPROFILE and would disagree.
   */
  function withEnvHome(home: string, body: () => void): void {
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      body();
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
    }
  }

  it("expands ~ to the home the ENVIRONMENT names", () => {
    withEnvHome(join(os.tmpdir(), "dsh-home-probe"), () => {
      expect(toCwd("~/file.txt", cwd)).toBe(process.env.HOME + "/file.txt");
      expect(toCwd("~", cwd)).toBe(process.env.HOME);
    });
  });

  it("falls back to the OS home when the environment names none", () => {
    const previous = process.env.HOME;
    delete process.env.HOME;
    try {
      expect(toCwd("~", cwd)).toBe(os.homedir());
      expect(toCwd("~/file.txt", cwd)).toBe(os.homedir() + "/file.txt");
    } finally {
      if (previous !== undefined) process.env.HOME = previous;
    }
  });

  it("preserves a leading @ in relative paths", () => {
    expect(toCwd("@src/main.ts", cwd)).toBe(
      resolve(cwd, "@src/main.ts"),
    );
  });

  it("preserves unicode spaces in file names", () => {
    expect(toCwd("src/my\u00A0file.ts", cwd)).toBe(
      resolve(cwd, "src/my\u00A0file.ts"),
    );
  });

  it("does not treat @~ as home-directory expansion", () => {
    expect(toCwd("@~/notes.md", cwd)).toBe(
      resolve(cwd, "@~/notes.md"),
    );
  });
});
