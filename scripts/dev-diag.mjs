#!/usr/bin/env node
/**
 * dev-diag.mjs — one-shot hashline configuration diagnostic.
 *
 * Prints, in order (run from the plugin repo or the smoke profile that links
 * it; no dsh process needed):
 *   1. where the plugin lib is loaded from + its build time
 *   2. the installed package versions (dsh-settings resolved from the host?)
 *   3. a live pipeline check: the effective config, the hash shape and a
 *      rendered row, so we can see exactly which layer breaks.
 *
 * Usage: node /path/to/dsh-better-edit/scripts/dev-diag.mjs
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = new URL("..", import.meta.url).pathname;

function section(label, value) {
  console.log(`\n=== ${label} ===`);
  console.log(value);
}

// 1. lib freshness
section(
  "plugin lib",
  `${repoRoot}lib/index.js  →  ${statSync(join(repoRoot, "lib/index.js")).mtime.toISOString()}`,
);

// 2. package resolution — the dsh home decides which node_modules we probe
const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");

// 3. package resolution
section(
  "dependency resolution (who provides dsh-settings)",
  (() => {
    const results = [];
    for (const p of [
      join(repoRoot, "node_modules/@deepseek-ai/dsh-settings/package.json"),
      join(dshHome, "../profiles/node_modules/@deepseek-ai/dsh-settings/package.json"),
      "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh-settings/package.json",
    ]) {
      try {
        const v = JSON.parse(readFileSync(p, "utf-8")).version;
        results.push(`${p.replace(join(dshHome, ".."), "~")} -> ${v}`);
      } catch {
        results.push(`${p.replace(join(dshHome, ".."), "~")} -> (absent)`);
      }
    }
    return results.join("\n");
  })(),
);

// 3. live pipeline: apply -> render one row
section("live pipeline", (() => {
  try {
    const { applyEffective, getEffectiveConfig } = require(
      join(repoRoot, "lib/config.js"),
    );
    const { getHashlineShape, lineHashesPure, fmtHashlineRow } = require(
      join(repoRoot, "lib/hashline/hash-assign.js"),
    );
    applyEffective(undefined);
    const cfg = getEffectiveConfig();
    const hash = lineHashesPure("hello\n")[0];
    return [
      `effective: ${JSON.stringify(cfg)}`,
      `shape: ${JSON.stringify(getHashlineShape())}`,
      `sample row: "${fmtHashlineRow("", `1${cfg.separator}${hash}`.replace(cfg.separator, "#") , "hello", 6)}"`,
    ].join("\n");
  } catch (err) {
    return `pipeline failed: ${err instanceof Error ? err.stack : String(err)}`;
  }
})());