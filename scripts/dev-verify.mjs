#!/usr/bin/env node
/**
 * dev-verify.mjs — boot-time simulation of the settings initialization chain,
 * exactly as a freshly restarted dsh would run it, in a minimal cordis ctx:
 *
 *   1. installHashlineSettings(ctx)  (our apply() call)
 *      → ensureSettingsService() mounts FileSettingsProvider when ctx has no
 *        'settings' service (serverless profile like smoke)
 *      → installSettingsSection registers the hashline namespace and pushes
 *        the resolved value into the snapshot
 *      → sync() applies it to the hash shape
 *   2. afterwards, print the effective config + a rendered read row, plus the
 *      resolved hashline section as seen by the settings service.
 *
 * If this prints separator '|' with your current settings.yaml, the whole
 * init chain works and a restarted dsh WILL read the file — the remaining
 * variable is which lib/环境 the restarted process actually loads.
 *
 * Run: node scripts/dev-verify.mjs
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const repoRoot = new URL("..", import.meta.url).pathname;

const { Context } = require("@deepseek-ai/cordis");
const { installHashlineSettings, getEffectiveConfig, HASHLINE_SETTINGS_NAMESPACE } =
  require(join(repoRoot, "lib/config.js"));
const { getHashlineShape, fmtHashlineRow, lineHashesPure } = require(
  join(repoRoot, "lib/hashline/hash-assign.js"),
);

const ctxA = new Context();
const ctxB = new Context();

// Simulate a fresh dsh boot where the profile DOUBLE-MOUNTS the plugin
// (bundles + dependencies both list it): apply() runs twice, on sibling
// scopes. The second ensure() must accept the already-registered service
// and must NOT reset the effective config.
installHashlineSettings(ctxA);
installHashlineSettings(ctxB);

// Give cordis a tick to settle inject registrations/effects.
await new Promise((resolve) => setTimeout(resolve, 50));

const cfg = getEffectiveConfig();
const shape = getHashlineShape();
const hash = lineHashesPure("hello\n")[0];

console.log("effective config :", JSON.stringify(cfg));
console.log("hash shape       :", JSON.stringify(shape));
console.log(
  "sample read row   :",
  `"${fmtHashlineRow("", `1#${hash}`, "hello", 6)}"`,
);

// What the settings service itself resolved for our namespace?
const svc = ctxA.get("settings");
if (svc === undefined) {
  console.log("settings service  : (absent after install — installation failed)");
  process.exit(1);
}
try {
  const resolved = svc.get(HASHLINE_SETTINGS_NAMESPACE);
  console.log("service resolved  :", JSON.stringify(resolved));
} catch (err) {
  console.log("service resolved  : (read failed)", err instanceof Error ? err.message : String(err));
}

// The raw file we read from:
const { settingsYamlPath } = require(join(repoRoot, "lib/config.js"));
let file;
try {
  file = readFileSync(settingsYamlPath(), "utf-8");
} catch {
  file = "(unreadable)";
}
console.log("settings file     :", settingsYamlPath());
console.log("--- raw (hashline section) ---");
console.log(
  file
    .split("\n")
    .filter((l, i, a) => /^hashline:/.test(l.trim()) || (i > 0 && /^\s/.test(l) && /^hashline:/.test(a.find((x) => /^hashline:/.test(x.trim())))))
    .join("\n") || file,
);