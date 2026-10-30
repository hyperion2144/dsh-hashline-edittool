/**
 * grep's hit counts, and the cuts that take them away (#386).
 *
 * The search stops at the per-file cap, so the number of hits it COLLECTED is
 * the cap whenever the cap bit — never the file's hit count. These are the
 * words for the two numbers (the collected one and the true one), the word for
 * the cut that took the rest, and the sentence the model reads.
 *
 * The vocabulary lives here, above the tools and below the render layer: the
 * search layer reports what it knows about a file, the tool assembles the
 * facts, and the wire names the wording.
 *
 * @module dsh-hashline-edittool/domain/grep/stats
 */

/** Which cut took hits away from a grep's answer. */
export type GrepTruncation = "limit" | "budget" | "limit+budget";

/**
 * The truncations, in the order the tool's output schema declares them.
 *
 * ONE list, so the schema and the type cannot drift apart.
 */
export const GREP_TRUNCATIONS = ["limit", "budget", "limit+budget"] as const;

/**
 * What the search knows about one file's hits.
 *
 * `reported` is what the engine found; `total` is the file's TRUE number of
 * matching lines. The two differ whenever the per-file cap cut the search
 * short: the engine stops at the cap, so it cannot say how many hits the file
 * really carries. `total` is then absent — a lower bound, not a count.
 */
export interface GrepFileHits {
  /** The number of matching lines the engine reported (capped at the per-file cap). */
  readonly reported: number;
  /** The TRUE number of matching lines, when the search knows it. */
  readonly total?: number;
}

/** The facts one file's section ends with. */
export interface GrepHitStats extends GrepFileHits {
  /** The number of hit rows this response served for the file. */
  readonly served: number;
  /** Whether the per-file cap cut hits the response never saw. */
  readonly limitCut: boolean;
  /** Whether the response budget cut this file's rows. */
  readonly budgetCut: boolean;
  /** The per-file cap the search ran under. */
  readonly limit: number;
}

/**
 * Two cuts, combined: a limit cut and a budget cut together are both.
 *
 * @param a - the first cut.
 * @param b - the second cut.
 * @returns the combined cut, or undefined when there was none.
 */
export function combineTruncations(
  a: GrepTruncation | undefined,
  b: GrepTruncation | undefined,
): GrepTruncation | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  if (a === b) return a;
  return "limit+budget";
}

/**
 * Whether the per-file cap cut hits the response never saw.
 *
 * The cap cut when the file carries MORE hits than the search collected —
 * which the counting pass settles — or, when the count is only a lower
 * bound, when the search stopped AT the cap.
 *
 * @param hits - the file's hits, with the true total when it is known.
 * @param limit - the per-file cap the search ran under.
 * @returns whether the cap cut this file's hits.
 */
export function limitCutFor(hits: GrepFileHits, limit: number): boolean {
  return hits.total === undefined ? hits.reported >= limit : hits.total > hits.reported;
}

/**
 * The count as it is shown: the number itself, or a lower bound.
 *
 * A count the search could not settle is a LOWER BOUND, and a lower bound is
 * written with the mathematical qualifier. That qualifier is the one thing
 * the host composes that is not a number — and it is a SYMBOL, not a word: the
 * wording around it stays in the client's vocabulary (ADR-0026).
 *
 * @param total - the true count, when the search knows it.
 * @param reported - the count the search collected — the lower bound.
 * @returns the count as it is shown.
 */
export function hitCountText(total: number | undefined, reported: number): string {
  return total === undefined ? `≥${reported}` : String(total);
}

/**
 * The sentence a file's section ends with (#386).
 *
 * It says three things the model cannot otherwise know: how many hits the
 * file really carries, how many of them this response served, and WHICH cut
 * took the rest away. Without it a capped search reads exactly like a
 * complete one.
 *
 * @param facts - the file's counts and the cuts that happened.
 * @returns the sentence, without a trailing newline.
 */
export function formatGrepStats(facts: GrepHitStats): string {
  const hits = hitCountText(facts.total, facts.reported);
  const cut =
    facts.limitCut && facts.budgetCut
      ? ` Truncated by the per-file limit (${facts.limit}) and the response budget.`
      : facts.limitCut
        ? ` Truncated by the per-file limit (${facts.limit}).`
        : facts.budgetCut
          ? " Truncated by the response budget."
          : "";
  return `[Matches: ${hits} total, ${facts.served} served.${cut}]`;
}
