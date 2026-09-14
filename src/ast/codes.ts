/**
 * AST error codes, bracketed exactly as they appear in model-facing messages.
 *
 * They are spelled out rather than composed from a bare code at throw time:
 * `test/core/error-codes.test.ts` pins **both** directions of the README
 * contract (every emitted code is documented, every documented code is
 * emitted), so each literal has to exist in the source, not only at runtime.
 *
 * @module dsh-hashline-edittool/ast/codes
 */

/** Source-size / arena / twice-aborted refusal; the exit is line mode. */
export const E_AST_TOO_LARGE = "[E_AST_TOO_LARGE]";
/** The wasm instance died; the client terminates and respawns the worker. */
export const E_AST_WORKER_ABORTED = "[E_AST_WORKER_ABORTED]";
/** Any other worker-level failure. */
export const E_AST_WORKER_FAILED = "[E_AST_WORKER_FAILED]";
/** The parser returned no tree at all. */
export const E_PARSE_FAILED = "[E_PARSE_FAILED]";
/** A structural pattern did not parse, or was not one node. */
export const E_AST_PATTERN = "[E_AST_PATTERN]";
/**
 * The AST capability is off, so a structural tool will not run.
 *
 * A REFUSAL, not an empty result: "you have this switched off" is a fact about
 * the session, and reporting it as "nothing matched" would be a claim about the
 * code. The message names how to turn it on, because a refusal the user cannot
 * act on is just a wall.
 */
export const E_AST_DISABLED = "[E_AST_DISABLED]";
