#!/usr/bin/env node
/**
 * dev-diag.mjs — one-shot hashline configuration diagnostic.
 *
 * Prints, in order (run from the plugin repo or the smoke profile that links
 * it; no dsh process needed):
 *   1. where the plugin lib is loaded from + its build time
 *   2. the effective settings.yaml path and its hashline section
 *   3. the installed package versions (dsh-settings resolved from the host?)
 *   4. a live pipeline check: applyEffective from the file, then the hash
 *      shape + a rendered row, so we can see exactly which layer breaks.
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

// 2. settings path + raw hashline section
const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const yamlPath = join(dshHome, "settings.yaml");
let raw = "(missing)";
try {
  raw = readFileSync(yamlPath, "utf-8");
} catch {}
const lines = raw.split("\n");
const sectionStart = lines.findIndex((l) => /^hashline:/.test(l.trim()));
section(
  "settings.yaml",
  `path: ${yamlPath}\n--- raw hashline section ---\n${
    sectionStart >= 0
      ? lines.slice(sectionStart, sectionStart + 6).join("\n")
      : "<< no 'hashline:' top-level key found >>"
  }`,
);

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

// 4. live pipeline: parse file -> apply -> render one row
section("live pipeline", (() => {
  try {
    const { applyEffective, getEffectiveConfig } = require(
      join(repoRoot, "lib/config.js"),
    );
    const { getHashlineShape, lineHashesPure, fmtHashlineRow } = require(
      join(repoRoot, "lib/hashline/hash-assign.js"),
    );
    // parse like the provider would
    const { parseSettingsYaml } = require(
      join(repoRoot, "lib/config.js"),
    );
    const parsed = sectionStart >= 0 ? parseSettingsYaml(lines.join("\n")) : {};
    applyEffective(parsed);
    const cfg = getEffectiveConfig();
    const hash = lineHashesPure("hello\n")[0];
    return [
      `parsed from file: ${JSON.stringify(parsed)}`,
      `effective: ${JSON.stringify(cfg)}`,
      `shape: ${JSON.stringify(getHashlineShape())}`,
      `sample row: "${fmtHashlineRow("", `1${cfg.separator}${hash}`.replace(cfg.separator, "#") , "hello", 6)}"`,
    ].join("\n");
  } catch (err) {
    return `pipeline failed: ${err instanceof Error ? err.stack : String(err)}`;
  }
})());