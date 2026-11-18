/**
 * Project the wire key contract into the client source tree.
 *
 * `src/wire/keys.ts` is the SINGLE SOURCE (ADR-0040): this script copies it
 * to `client/src/wire/keys.generated.ts` so the client's acceptance gate and
 * the host's wire vocabulary are one list at build time. The copy carries a
 * GENERATED banner; a freshness test pins it against the source, so a stale
 * projection fails loudly instead of silently gating keys the host now sends.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const clientRoot = join(here, "..");
const repoRoot = join(clientRoot, "..");

const source = readFileSync(join(repoRoot, "src", "wire", "keys.ts"), "utf8");
const banner =
	"// GENERATED from src/wire/keys.ts by scripts/sync-wire.mjs — edit the SOURCE, never this file (ADR-0040).\n";

mkdirSync(join(clientRoot, "src", "wire"), { recursive: true });
writeFileSync(join(clientRoot, "src", "wire", "keys.generated.ts"), banner + source);
