export const AUTO_READ_MAX = 2000;
export const SNIFF_BYTES = 8192;
export const MAX_READ_LINE_BYTES = 200 * 1024;
export const MAX_BYTES = 100 * 1024 * 1024;
/**
 * Byte ceiling for the binary-tolerant read `grep` falls back to when the
 * backend refuses a file as text (#268). Deliberately the read layer's own
 * `MAX_BYTES`: the fallback exists to search a text file that happens to carry
 * a `\0`, not to buffer an arbitrary blob — and a file past this ceiling is
 * skipped exactly as it was before the fallback existed.
 */
export const TOLERANT_READ_MAX_BYTES = MAX_BYTES;
/**
 * Per-response budget (ADR-0013, specs #209/#210): UTF-16 code units one tool
 * response's model text may reach before the rest spills to a resume file.
 * 48,000 sits just under the host's measured 49,984-char inline gate
 * (dsh-spill-policy); the settings field `max_response_chars` overrides it
 * within [RESPONSE_BUDGET_MIN, RESPONSE_BUDGET_MAX].
 */
export const RESPONSE_BUDGET_DEFAULT = 48_000;
export const RESPONSE_BUDGET_MIN = 8_000;
export const RESPONSE_BUDGET_MAX = 49_984;
/** Spill sidecars and session dirs older than this are swept lazily. */
export const RESUME_TTL_MS = 24 * 60 * 60 * 1000;

export const HASH_STORE_BUSY_TIMEOUT = 1000;
/**
 * The store's schema/语义 version. A change WIPES anchor state on open
 * (see `buildStore`): nothing is migrated, because a half-migrated anchor
 * set is worse than a clean one — every anchor the model still holds has to
 * be re-read either way.
 *
 * **6 → 7** for the single-source-anchor refactor (map #214 / decision #222).
 * The bump is the deliberate part: the refactor changes what "served" MEANS
 * (a per-session anchor SET whose release is a three-way clear), so a set
 * written under the old rules cannot be trusted to answer the new per-line
 * verdict. Wiping is safer than reinterpreting.
 *
 * Operational `meta` keys survive it (`clean_shutdown`,
 * `last_open_integrity_check`, `last_rebuild_at`) — see the note in
 * `buildStore`: the wipe touches only the anchor state, never `meta`.
 */
export const HASH_STORE_VERSION = 7;
/**
 * How many successive edits `undo_last_edit` can walk back on one path
 * (#151/P5). The undo row family is a bounded STACK: the newest entry is the
 * one a call reverts, and the oldest beyond this depth is dropped on push.
 *
 * Three, per contract §2 (undo): the stack exists to recover from a wrong
 * edit, not to be a history. Each entry carries the pre-edit body, so a deeper
 * stack is a deeper text payload per path for a capability nobody asked for.
 */
export const UNDO_STACK_DEPTH = 3;
/**
 * Per-call cap on the `edits` array length. Same default (32) as the
 * pre-0.4 `batch_edit` cap. Above this, the call is hard-rejected with
 * `[E_BAD_SHAPE]` — the model must split the batch.
 */
export const EDITS_MAX_ITEMS = 32;
/** @deprecated — kept for backward compat with pre-0.4 callers. */
export const BATCH_EDIT_MAX_ITEMS = EDITS_MAX_ITEMS;
export const SERVED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Anchor-state row family TTL (issue #136). Anchor state is per cwd + path,
 * not per session: there is nothing to expire when a session ends, so rows
 * are swept for liveness only — a path not touched for this long loses its
 * persisted state and re-anchors on its next true first serve. */
export const ANCHOR_STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SERVED_ECHO_CAP = 150;

// ── anchor-store budgets (#180, spec #184, ADR-0010) ─────────────────────────

/**
 * Main-store byte budget, measured as `(page_count − freelist_count) ×
 * page_size`. NOT `page_count × page_size`: DELETE only moves pages to the
 * freelist, so a physical page count could never be brought back under budget
 * and the sweep would delete the same paths forever. 64 MiB is ~34× smaller
 * than the 2.17 GB store measured on this repository, and far above normal
 * single-workspace use (a full 2000-path session stays under 3 MB).
 */
export const HASH_STORE_MAX_BYTES = 64 * 1024 * 1024;
/**
 * Path-count budget. Measured cost is ≈1.1 KB of pages per touched path
 * (three row families + indexes + a write transaction each), so this is the
 * bound that catches "scanned the whole monorepo" growth.
 */
export const HASH_STORE_MAX_PATHS = 5000;
/**
 * `anchor_lines` row budget: catches "a few very large files served many
 * lines each" (the real store held 10.49 M rows).
 */
export const HASH_STORE_MAX_ROWS = 300_000;
/**
 * Cleanup runs at open and every this many writes; over-budget writes sweep
 * immediately. No timers: DSH is event-driven.
 */
export const HASH_STORE_SWEEP_WRITES = 200;
/** Evict this many times over budget (evict, then re-measure). */
export const HASH_STORE_EVICT_RATIO = 4;
/**
 * Above this many times over budget, rebuilding the store (rename aside,
 * fresh empty file) beats evicting: it is seconds-free, needs no second copy
 * of the file on disk, and is what the user did by hand.
 */
export const HASH_STORE_REBUILD_RATIO = 16;
/**
 * Rebuild throttle. A workspace that legitimately needs more than the rebuild
 * threshold must not lose every anchor on each launch.
 */
export const HASH_STORE_REBUILD_THROTTLE_MS = 24 * 60 * 60 * 1000;
/**
 * Per-path `undo` budget (#176). Each layer stores a full copy of the file
 * body, so an unbounded stack on one large file is the biggest single text
 * payload in the store; the newest layers are kept, and never fewer than one.
 */
export const UNDO_MAX_PATH_BYTES = 2 * 1024 * 1024;
/**
 * Cold-open budget (acceptance, #178): first open in a NEW process must stay
 * under this regardless of store size, which is why the open path no longer
 * runs `PRAGMA quick_check` on every start (it was 1.3 s of a 1.7 s cold open
 * on a 2 GB store).
 */
export const HASH_STORE_COLD_OPEN_BUDGET_MS = 50;
export const NOOP_LOOP_THRESHOLD = 3;
export const NEW_CONTENT_NOT_STRING_MSG =
	`[E_BAD_SHAPE] "replacement_text" must be a string with \\n line separators, not an array.` +
	` Do not pass an array of lines — pass the replacement text as one string: "line1\\nline2". Use "" to delete a range.`;

// ── AST capability (spec `docs/ast-read-edit-spec.md` §10) ──────────────────

/**
 * Hard ceiling of the Emscripten linear memory `web-tree-sitter` runs in.
 * Measured, not documented: 32768 pages, hardcoded in the build. Growth past
 * it surfaces as `RuntimeError: Aborted()` from inside wasm, not a JS error.
 */
export const AST_ARENA_CEILING_BYTES = 2048 * 1024 * 1024;
/**
 * Headroom kept below the ceiling for fragmentation, grammar modules and the
 * allocator's own growth requests — the abort happens when a *growth* request
 * cannot be satisfied, which is before the exact ceiling.
 */
export const AST_ARENA_RESERVE_BYTES = 512 * 1024 * 1024;
/**
 * Conservative bytes-per-node. Measured exact values are 77.25 / 78.99 /
 * 86.41 across the 1/5/20 MB tiers; ~1.5× the largest.
 */
export const AST_BYTES_PER_NODE = 128;
/**
 * Worst-case nodes per source byte, measured across 200 real files
 * (median 0.2297, p75 0.3607, max 0.4414). Used only for the pre-parse
 * admission estimate — that 10.2× spread is why retention uses the exact
 * `descendantCount` instead.
 */
export const AST_MAX_DENSITY = 0.4414;
/** Total retained nodes across cached trees. */
export const AST_RETAIN_NODE_BUDGET = 6_000_000;
/** A single tree larger than this is parsed but not cached. */
export const AST_RETAIN_LIMIT_NODES = 1_500_000;
/**
 * Source-size admission limit. Strictly below the read layer's `MAX_BYTES`
 * (100 MiB), so a band exists where line mode works and AST does not — that
 * band is what `E_AST_TOO_LARGE` names.
 */
export const AST_ADMIT_LIMIT_SOURCE_BYTES = 27 * 1024 * 1024;
/** Arena headroom nominally held by loaded grammar modules. */
export const AST_LANG_RESERVE_BYTES = 64 * 1024 * 1024;
/** Idle window before the parse worker is terminated (releasing the arena). */
export const AST_WORKER_IDLE_MS = 15 * 60 * 1000;
/**
 * High-water recycling trigger. The arena never shrinks, so a correct LRU
 * still leaves it inflated by historical peaks; recycling is the only way to
 * return that memory. Paired with the retained-node check so a genuinely
 * full cache is never thrown away.
 */
export const AST_WORKER_RECYCLE_HEAP_BYTES = 1024 * 1024 * 1024;
/** Second conjunct of the recycling rule: the peak is waste, not data. */
export const AST_WORKER_RECYCLE_RETAINED_NODES = 3_000_000;
/** Per-query bound on a language-server request (consumers own timeouts). */
export const AST_LSP_QUERY_TIMEOUT_MS = 10_000;
/**
 * Structural-summary gates (spec §5.3).
 *
 * The low gate is 20, not 100 (#151/P7): the only caller left is `ast_grep`
 * with no pattern — a model EXPLICITLY asking for the shape of a file — and
 * `read {summary: true}` (the reason the gate was high) no longer exists. A
 * file between the two numbers is one the model can see whole anyway, and
 * `summaryIsWorthIt` still refuses an outline that folds too little to be
 * worth replacing the source.
 */
export const AST_SUMMARY_MIN_TOTAL_LINES = 20;
export const AST_SUMMARY_MAX_BYTES = 2 * 1024 * 1024;
export const AST_SUMMARY_MAX_LINES = 20_000;
export const AST_SUMMARY_MIN_BODY_LINES = 4;
export const AST_SUMMARY_MIN_COMMENT_LINES = 6;
/** Below this shrink ratio the outline is not worth replacing the source. */
export const AST_SUMMARY_MIN_SHRINK_RATIO = 0.6;
export const AST_SUMMARY_UNFOLD_UNTIL = 50;
export const AST_SUMMARY_UNFOLD_LIMIT = 100;
