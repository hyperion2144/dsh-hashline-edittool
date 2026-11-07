/**
 * The cold-tool discovery state (#421 ②) — which sessions have unlocked the
 * plugin's advanced tools (`ast_grep`, `ast_edit`, `format`, `lsp`).
 *
 * HOW IT IS CONSUMED (#421 ② as reworked after review): the four cold tools
 * register ONCE with a host-level `when` predicate; the host evaluates the
 * predicate on EVERY step and only admits a tool into that step's wire schema
 * when it returns true (the dsh-ops pattern). So the read path here is
 * per-step hot: it must be fast (an in-memory cache answered from one file
 * read per process) and it must NEVER throw (a `when` that throws fails the
 * whole step's preparation — fail-open instead).
 *
 * Fail-open is the contract: a missing state file answers `false` (a fresh
 * session has discovered nothing), but an unreadable or corrupt file answers
 * `true` — the gate's purpose is saving schema tokens, and its failure mode
 * must never be a missing tool (#418's lesson restated).
 *
 * The state lives in `configDir()/discovered-tools.json`, NOT in the hash
 * store: the `when` predicate runs at step-preparation time (outside any
 * workspace scope), while an unlock write happens inside a tool call inside
 * one. The hash store resolves per workspace and the two writes would land in
 * different databases. The discovery state is a per-user model preference,
 * not file data — it sits beside the settings, global by design.
 *
 * @module dsh-hashline-edittool/domain/session/discovered-tools
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../../infra/paths.js";

/** The tools the discovery gate covers, in unlock order. */
export const COLD_TOOLS = ["ast_grep", "ast_edit", "format", "lsp"] as const;
export type ColdTool = (typeof COLD_TOOLS)[number];

function storePath(): string {
  return join(configDir(), "discovered-tools.json");
}

type Store = Record<string, string[]>;

/** Per-process cache: sessionKey → unlocked. First miss reads the file once. */
const cache = new Map<string, boolean>();

function readStoreFor(sessionKey: string): boolean {
  // Fail-open three-way (see module doc): absent file → false; corrupt or
  // unreadable → true; readable → whether all four cold tools are unlocked.
  const path = storePath();
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Store;
    const list = parsed[sessionKey];
    if (!Array.isArray(list)) return true;
    return COLD_TOOLS.every((tool) => list.includes(tool));
  } catch {
    return true;
  }
}

/**
 * Whether the cold tools participate in `sessionKey`'s CURRENT step. Hot path
 * (`when` runs every step): answered from the in-process cache, filled once
 * from the persisted state.
 */
export function isColdToolsDiscovered(sessionKey: string): boolean {
  let value = cache.get(sessionKey);
  if (value === undefined) {
    value = readStoreFor(sessionKey);
    cache.set(sessionKey, value);
  }
  return value;
}

/**
 * Unlock the cold tools for `sessionKey`: update the in-process cache
 * (the next step's `when` sees it immediately) and persist across restarts.
 */
export function unlockColdTools(sessionKey: string): void {
  cache.set(sessionKey, true);
  const path = storePath();
  let store: Store = {};
  try {
    if (existsSync(path)) store = JSON.parse(readFileSync(path, "utf8")) as Store;
  } catch {
    store = {};
  }
  store[sessionKey] = [...COLD_TOOLS];
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(path, `${JSON.stringify(store, null, "\t")}\n`, "utf8");
}
