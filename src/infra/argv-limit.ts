/**
 * How long a command line this platform will actually spawn, and how to slice a
 * file list so an invocation stays under it (#260).
 *
 * `execFile` does not budget argv for you: a command line the OS cannot hold is
 * refused before the process exists, and Node surfaces that as a SYNCHRONOUS
 * throw out of `execFile` — `E2BIG` on POSIX, `ENAMETOOLONG` on Windows. So a
 * caller that puts a file list on the command line must size the list by LENGTH.
 * A file COUNT is not a bound on argv: 400 paths at 120 characters compose a
 * ~48,000-character command line, 48% past Windows' cap.
 *
 * The numbers, and why there is only one:
 *
 * **Windows** caps `CreateProcessW`'s `lpCommandLine` at `COMMAND_LINE_LIMIT`
 * characters — and that is the SMALLEST cap in play. POSIX measures `ARG_MAX`
 * over argv AND the environment instead: 1 MiB on macOS (`kern.argmax`), 2 MiB on
 * Linux, plus a per-argument cap on Linux.
 *
 * `ARGV_BUDGET` is one conservative number rather than a per-platform branch: the
 * Windows cap minus room for the quoting a spawn adds on top of the raw
 * characters (an argument holding a space or a quote is wrapped, and backslashes
 * before a quote are doubled), so the SAME rule holds on every machine. POSIX
 * would allow far more, and a larger budget there would mean fewer rg
 * invocations — but it would also buy two numbers to keep honest, for a
 * pre-filter that still batches hundreds of ordinary paths per invocation at
 * this one.
 *
 * @module dsh-hashline-edittool/infra/argv-limit
 */

/**
 * `CreateProcessW`'s `lpCommandLine` cap: the smallest cap any platform puts on a
 * command line, and the one every budget here answers to.
 */
export const COMMAND_LINE_LIMIT = 32_767;

/**
 * What the quoting a spawn adds on top of the raw characters can cost: an
 * argument holding a space or a quote is wrapped, and backslashes before a quote
 * are doubled. Named rather than inlined so the budget below reads as the
 * subtraction it is.
 */
const QUOTING_HEADROOM = 2_767;

/**
 * The command-line length ONE invocation is budgeted against:
 * `COMMAND_LINE_LIMIT` minus {@link QUOTING_HEADROOM} — 30,000 characters.
 *
 * Deliberately NOT per-platform — see the module note above.
 */
export const ARGV_BUDGET = COMMAND_LINE_LIMIT - QUOTING_HEADROOM; // 30,000

/**
 * One argument's cost on the command line: its characters, the separator that
 * follows it, and quoting headroom. Only ever an OVER-estimate — Node wraps an
 * argument that holds a space or a quote and doubles backslashes before a quote,
 * both of which make it longer, never shorter.
 */
function argCost(arg: string): number {
	return arg.length + 4;
}

/** What a whole command line costs under this module's model. */
function commandLineCost(argv: readonly string[]): number {
	let total = 0;
	for (const arg of argv) total += argCost(arg);
	return total;
}

/**
 * Slice `items` into the fewest trailing chunks that stay inside `budget`.
 *
 * `fixed` is the argv every invocation carries — the binary and its flags — so it
 * comes off the budget first: callers pass what actually gets spawned, and the
 * planner answers for the whole command line, not just the tail.
 *
 * The contract: every returned chunk can be spawned, or the answer is
 * `undefined`.
 *
 * - no chunk exceeds `budget`, so the caller never hands the OS a command line
 *   it must refuse;
 * - an item that cannot share the budget even on its own — a single path wider
 *   than the whole ceiling — makes the WHOLE plan `undefined`, because no
 *   slicing can spawn it: the pre-filter abstains instead of sending a doomed
 *   command line, and the caller keeps its full list;
 * - otherwise order is preserved, no item is dropped and no chunk is empty.
 *
 * @param fixed - the argv every invocation carries: binary first, then flags.
 * @param items - the variable tail to slice, in order.
 * @param budget - the ceiling for a COMPOSED command line, typically
 *   {@link ARGV_BUDGET}.
 * @returns the ordered chunks, or `undefined` when no slicing of `items` could
 *   be spawned — `fixed` alone spends the budget, or one item is wider than the
 *   whole ceiling. The caller must not pretend it got an answer.
 */
export function planArgvChunks(
	fixed: readonly string[],
	items: readonly string[],
	budget: number,
): string[][] | undefined {
	const head = commandLineCost(fixed);
	if (head >= budget) return undefined;

	const chunks: string[][] = [];
	let chunk: string[] = [];
	let cost = head;
	for (const item of items) {
		const itemCost = argCost(item);
		// A chunk always holds at least one item, so an item that cannot share the
		// budget with `fixed` has no spawnable chunk at all: no slicing of this list
		// can be spawned, and the caller must not be handed a doomed command line.
		if (head + itemCost > budget) return undefined;
		if (cost + itemCost > budget) {
			chunks.push(chunk);
			chunk = [];
			cost = head;
		}
		chunk.push(item);
		cost += itemCost;
	}
	if (chunk.length > 0) chunks.push(chunk);
	return chunks;
}
