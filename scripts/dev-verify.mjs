#!/usr/bin/env node
/**
 * dev-verify.mjs — boot-time simulation of the settings wiring, in a minimal
 * cordis ctx, exactly as a freshly restarted dsh would run it:
 *
 *   1. installHashlineSettings(ctx, config)  (our apply() call)
 *      → resolves the Config the loader handed us into the effective snapshot
 *      → applies it to the hash shape (separator, anchor width)
 *      → subscribes to `settings/document-updated` for later changes
 *   2. afterwards, print the effective config + a rendered read row.
 *
 * The plugin reads no settings file: the profile's entry configuration IS the
 * settings document, and the settings service owns its persistence. If this
 * prints the separator from `config` below, the resolved-Config path works and
 * a restarted dsh WILL apply the same values.
 *
 * Run: node scripts/dev-verify.mjs
 */
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const repoRoot = new URL("..", import.meta.url).pathname;

const { Context } = require("@deepseek-ai/cordis");
const { installHashlineSettings, getEffectiveConfig } = require(
  join(repoRoot, "lib/config.js"),
);
const { getHashlineShape, fmtHashlineRow, lineHashesPure } = require(
  join(repoRoot, "lib/hashline/hash-assign.js"),
);

// What a profile's `- id: dsh-hashline-edittool` / `config:` block would carry.
// In production every field is `.volatile()`, so apply() receives live refs;
// plain values travel the same `resolveSettings` unwrap.
const config = { separator: "|", output_format: "text" };

const ctxA = new Context();
const ctxB = new Context();

// Simulate a fresh dsh boot where the profile DOUBLE-MOUNTS the plugin
// (bundles + dependencies both list it): apply() runs twice, on sibling
// scopes. The second install must NOT reset the effective config.
installHashlineSettings(ctxA, config);
installHashlineSettings(ctxB, config);

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
console.log(
  "settings service  :",
  ctxA.get("settings") === undefined
    ? "(unmounted — expected: the profile configuration is the document)"
    : "(present)",
);

if (cfg.separator !== config.separator) {
  console.error(
    `FAIL: the resolved config did not reach the snapshot (separator = ${JSON.stringify(cfg.separator)})`,
  );
  process.exit(1);
}
