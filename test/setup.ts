/**
 * Global test isolation: point the harness home at a throwaway directory for
 * the whole run, BEFORE any test module loads.
 *
 * Why this exists: every store path resolves through `$DSH_HOME` (falling back
 * to `$HOME/.dsh`). Tests that never stubbed the environment — `tool-lsp`'s
 * symbol tests were the found offender — therefore read and wrote the
 * developer's REAL `~/.dsh` store: one machine accumulated 4,353
 * per-workspace directories (~293 MB) under
 * `~/.dsh/plugins/dsh-hashline-edittool/`, one per temp cwd a test ever used.
 *
 * One temp home per RUN closes the leak at the root. Tests that need a
 * specific home still override per-test via `fixtures.useTestHome()` /
 * `withHome()` — `vi.stubEnv` wins over this baseline.
 *
 * The temp home is deliberately left for the OS to clean (it holds only what
 * a run actually wrote; a run that writes nothing costs one empty directory).
 *
 * @module test/setup
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "dsh-test-home-"));
process.env.HOME = home;
process.env.DSH_HOME = join(home, ".dsh");
