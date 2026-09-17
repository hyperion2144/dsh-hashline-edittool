export const AUTO_READ_MAX = 2000;
export const SNIFF_BYTES = 8192;
export const MAX_BYTES = 100 * 1024 * 1024;
export const MAX_READ_LINE_BYTES = 200 * 1024;

export const HASH_STORE_BUSY_TIMEOUT = 1000;
export const HASH_STORE_VERSION = 6;
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
/** Structural-summary gates (spec §5.3). */
export const AST_SUMMARY_MIN_TOTAL_LINES = 100;
export const AST_SUMMARY_MAX_BYTES = 2 * 1024 * 1024;
export const AST_SUMMARY_MAX_LINES = 20_000;
export const AST_SUMMARY_MIN_BODY_LINES = 4;
export const AST_SUMMARY_MIN_COMMENT_LINES = 6;
/** Below this shrink ratio the outline is not worth replacing the source. */
export const AST_SUMMARY_MIN_SHRINK_RATIO = 0.6;
export const AST_SUMMARY_UNFOLD_UNTIL = 50;
export const AST_SUMMARY_UNFOLD_LIMIT = 100;
