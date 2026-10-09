# ADR-0016 — argv is budgeted by command-line LENGTH, never by item count

> **Status**: Accepted (2026-10-09; issue [#260](https://github.com/hyperion2144/dsh-hashline-edittool/issues/260) — implemented in the same change).

## Problem Statement

`grep`'s ripgrep pre-filter ([#183](https://github.com/hyperion2144/dsh-hashline-edittool/issues/183))
puts the candidate file list on the command line and chunks it so argv cannot
overflow. The first cut chunked by **count** (`CHUNK = 400`), and count is not a
bound on argv: 400 paths at 120 characters compose a ~48,000-character command
line, 48% past Windows' `CreateProcessW` cap (32,767).

The failure mode was worse than the size. A spawn the OS refuses throws
**synchronously** out of `execFile` — `E2BIG` on POSIX, `ENAMETOOLONG` on Windows
— instead of reporting through the callback. That throw landed inside a
`new Promise` executor, so the promise REJECTED, and the module's documented
fallback ("any failure returns `undefined`, the caller keeps its full list") never
ran. One over-long chunk took the whole `grep` down.

## Decision

Chunk by LENGTH. `infra/argv-limit.ts`'s `planArgvChunks(fixed, items, budget)`
prices every argument at `length + 4` (separator + quoting headroom), subtracts
the argv every invocation carries — the binary, its flags, and the pattern — and
emits chunks that fit. It never drops an item, never emits an empty chunk, and
refuses (returns `undefined`) when no slicing could be spawned at all — the fixed
argv alone already spends the budget, or one single item is wider than the whole
ceiling.

ONE budget for every platform: `ARGV_BUDGET = COMMAND_LINE_LIMIT (32,767) − 2,767
= 30,000`.

A spawn that throws synchronously is a FAILURE outcome of the seam: `undefined`,
never a rejection.

## Consequences

- The rule and its number are the same on every machine, and the number has one
  justification: the smallest platform's cap, minus quoting headroom. POSIX'
  `ARG_MAX` (1 MiB on macOS, 2 MiB on Linux) would allow a 10–20× larger budget;
  the price of using it is two numbers to keep honest, and a pre-filter that still
  puts hundreds of ordinary paths on one command line does not need it.
- A single path — or a pattern — wider than the whole budget is not spawnable at
  all, so the planner refuses the WHOLE list and the pre-filter abstains: the JS
  engine answers instead. The pre-filter stays an optimisation; it is never a way
  for `grep` to fail, and it never composes a command line the OS must refuse.
- Anything else that puts a caller-sized list on a command line should reuse the
  planner rather than invent a count. `rgFiles` does not need it: its argv is
  fixed and short.
