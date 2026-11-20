/**
 * Backwards-compat barrel — the real seam lives in `src/guidance/resolve.ts`:
 * the compiled guidance sections (#447 review: the per-preset document layer
 * was removed; text comes only from the compiled defaults).
 * Keeping this file means existing `from "./guidance.js"` imports keep working.
 * @module dsh-hashline-edittool/guidance
 */
export * from "./guidance/resolve.js";
