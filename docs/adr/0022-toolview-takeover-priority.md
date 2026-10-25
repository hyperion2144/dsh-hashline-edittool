# ADR-0022 — toolview takeover priority: `-2`, and why the shadow band needs one value

> **Status**: Accepted (issue #321; 2026-10-25). Governs the nine keyed
> `tool.call.toolview` registrations of the client half
> (`dsh-hashline-edittool-client`). Supersedes the priority detail recorded in
> ADR-0005.

## Problem Statement

The client half takes over nine wire tool names on the keyed
`tool.call.toolview` slot: `read`, `edit`, `write`, `grep`, `undo_last_edit`,
`ast_grep`, `ast_edit`, `lsp`, `format`. The shipped rows register the same keys
at the default priority `0`, so a lower value is how a takeover is expressed:
the ledger sorts entries ascending and `entriesOfSlot` keeps the first entry per
key ("lowest renders").

The client half has carried `priority: -1` on its takeover rows since the
companion package first shipped (0.4.2, with the `read`/`edit`/`write` rows;
`grep` and the AST rows arrived in later releases), so the value is the one
every takeover key has always shared. The ledger does not merely sort — it
**throws** when a keyed slot already holds an entry with the same key AND the
same priority
(`keyed slot "tool.call.toolview" already has an entry for key "read" at priority -1 ... — register at a different priority to shadow it (lowest renders)`),
and the throwing registration never lands. Negative priorities form a **shared
shadow band** — the ordering space below the default `0`, with no reservation
and no “occupied” query: any plugin may take `-1`, and `dsh-claude-style`
(0.18.2 and 0.18.5, same code) does exactly that for `read`/`edit`/`write`
with the same slot name, key and locale.

With both plugins mounted, one side loses three registrations as an uncaught
error, and which side loses depends on mount order — mounted first,
`dsh-claude-style` makes the hashline cards fall back to the shipped rows;
mounted second, its own file rows never appear. Neither outcome is acceptable
for a plugin whose selling point is composability.

## Decision

1. **All nine takeovers move to `priority: -2` together, as one constant.**
   `TAKEOVER_PRIORITY` in the client half is the single value the nine
   registrations read: the collision was never about a single key, and per-key
   values would give one plugin two meanings of "shadow the shipped row".
2. **`-2` is chosen against the known neighbours, not against a distant
   number.** The shipped rows are at `0`, the known competing takeover is at
   `-1`; `-2` clears both, whichever order the two plugins mount in. `-100`
   would buy nothing except a number that hides the reasoning.
3. **The build-time bundle check pins the value.**
   `client/scripts/verify-bundle.mjs` evaluates the built artifact and asserts
   the exact `<key>:<priority>:<locale>` list, so drifting any single key back
   to `-1` fails the build rather than the browser.
4. **No runtime detection.** Reading the ledger's `entries()` before
   registering was rejected: the failure belongs to the *later* registrant, so
   a value computed from what is already mounted protects only ourselves and
   makes the rendered result depend on mount order.

## Alternatives considered

- **Stay at `-1` and ask `dsh-claude-style` to move** — rejected as the plan of
  record: it is another project's value (we cannot ship it), it leaves the
  collision live until they release, and the throw belongs to whichever side
  mounts second, so "they move" does not remove ours. A courtesy report can
  still be filed; the fix cannot depend on one.
- **Detect occupancy at mount time and pick the lowest value in use minus one**
  — rejected: it cannot prevent the other side's throw, and the rendered card
  would depend on mount order.
- **Take a far-lower priority (`-100`)** — rejected: the same collision class
  one number lower, with no signal about why the number exists.
- **Expose the priority as configuration** — rejected: a user-facing knob for
  an internal shadow-band number invites exactly the collisions it cannot
  resolve.

## Consequences

- With `dsh-claude-style` mounted, its `read`/`edit`/`write` rows stay
  registered but never render (the hashline cards win), and it mounts without
  error. Its other behaviour is untouched.
- The takeover relationship against the shipped rows is unchanged: `-1` and
  `-2` both precede `0`.
- **Residual risk, recorded rather than fixed**: the shadow band has no
  reservation. DSH's own dynamic plugin packages allocate `-1`, `-2`, … for
  their own keys, and any future plugin that hardcodes `-2` for these keys
  reproduces the same collision one step down. Ending the class needs an
  occupancy query or a reserved range in the ledger — a runtime concern, not
  something a value in this plugin can guarantee.
- `docs/research/toolview-slot-priority-collision.md` records the ledger
  semantics and the neighbour survey this decision rests on.
- The claim that the hashline cards render is a ledger-level one (ascending
  dedupe puts these rows first). The browser-side console and the rendered
  card ownership were NOT re-verified on a real machine in this round: no
  browser was available in the diagnosing session. The research note carries
  the same caveat.
