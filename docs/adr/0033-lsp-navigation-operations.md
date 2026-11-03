# ADR-0033 — navigation results are served rows, and capability is checked before a request

> **Status**: Accepted (2026-11-03; ported from DSH's built-in `lsp` tool — `packages/lsp/tool-lsp` — at `deepseek-harness@ce7073d512`; implemented in the same change).

## Problem Statement

This plugin's `lsp` tool could ask a language server six things: `symbols`,
`code_actions`, `diagnostics`, `request`, `status`, `warm`. The four questions
a model asks most often — where is this defined, who uses it, what implements
it, what does it mean — were reachable only through `request`, which means the
caller had to know the LSP method name AND hand-write a `position` in the
protocol's zero-based UTF-16 columns.

DSH ships its own `lsp` tool (`@deepseek-ai/dsh-tool-lsp`) with exactly those
four operations as first-class citizens, one-based `line` + `character`
parameters, workspace-relative location rendering, and `maxLocations` /
`maxResultChars` caps. That tool is an OPTIONAL package — it is absent from
the desktop app's dependency set — but its surface is the better one for the
questions that matter most.

Two shapes of the gap, then:

1. **Operation gap.** The four navigation operations were second-class here.
2. **Protocol-honesty gap.** Nothing checked what the server advertised. A
   method a server never advertised came back as a protocol error, or worse as
   an empty list that reads exactly like "nothing there" — and the plugin's
   whole design says "no server" and "no results" are different facts.

Copying DSH's tool verbatim would have been the easy answer and the wrong one:
its answer is a list of `path:line:character` strings, which is not editable.
This plugin's contract is that everything it answers about a line is a SERVED
row — an anchor `edit` accepts without a second read.

## Decision

**Adapt the operation surface; keep the plugin's row semantics.**

D1. **Four operations, one shape.** `goToDefinition`, `findReferences`,
`goToImplementation`, `hover` become operation values. `findReferences` always
asks with `includeDeclaration: true` — the declarations must not be missing
from an impact answer.

D2. **A column the caller does not have to count.** `symbol` names the text on
the line and its `indexOf` IS the column; `character` is the explicit
one-based UTF-16 fallback. Both the existing position operations and the new
navigation ones use the same `resolveColumn`, so there is one cursor rule, not
two.

D3. **Every hit is served on ITS OWN file.** A navigation answer points at
other files, so the rows cannot be the queried file's. Each distinct file in
the answer is read once, its hit lines minted and served through the same
`anchorForInWorkspace` / `observeServedRows` pair `read`, `grep` and `symbols`
use. A hit on another file is therefore directly editable — which is the only
reason a navigation answer belongs in this plugin at all.

D4. **Anchoring is bounded; the location is not.** At most
`MAX_ANCHORED_FILES` (32) files are read per answer. Past that ceiling, and
for any file that cannot be read, the row survives with an empty anchor and
the text view falls back to `line:character`. Losing an anchor costs the
caller a `read`; losing the location would cost the caller the answer.

D5. **Capability is checked BEFORE the request.** `supportsOperation` reads
the `initialize` capabilities; an unadvertised method is refused with
`[E_LSP_UNSUPPORTED_OPERATION]` and nothing is sent. A server that explicitly
refuses `didOpen` (`textDocumentSync: 0` or `{ openClose: false }`) is refused
with `[E_LSP_UNSUPPORTED_SYNC]`. An ABSENT `textDocumentSync` stays unknown
rather than "no" — many working servers omit it, and this plugin has always
opened documents for them.

D6. **Position encoding is negotiated once, at the handshake.** UTF-16 is the
protocol default and the unit this plugin measures everything in; a server
that advertises anything else would have every column land on a different
character, silently. The session refuses it (`[E_LSP_BAD_ENCODING]`), the
manager turns that throw into a failed slot with the reason, and the retry
backoff does not spin on it.

D7. **The answer is bounded, and the bound is stated.** `maxLocations` (100)
cuts by count with an omission notice; the rendered hover/location text is
bounded by `min(16 000, responseBudgetChars())`, notice included. `No results.`
and `No hover information.` stay distinct from every refusal.

D8. **The card is the multi-file (grep) projection.** Navigation rows live in
other files, so a read-shaped projection (one `path`) would have to lie. The
meta is the grep projection — the same one `grep` and `ast_grep` already emit —
and the client's `HashlineLspRow` prefers it when it validates, falling back to
the read projection otherwise. No new card component.

**Implemented 2026-11-03 after the #397 review — the first attempt was
unreachable.** `grepCardModel` gated on the tool NAME (`grep` / `ast_grep`),
and the same name lock had already made `ast_grep` render as raw IO once
before. The projection is a shape question, not a name question: the gate
now admits `lsp` too, and a client test pins it.

**Folded-row width added 2026-11-03 after the same review.** The card was
reachable, but the COLLAPSED row still said nothing about the answer's reach:
it carried the queried path and nothing else, so a two-file answer looked
like a one-file one until it was expanded. The width now rides in the row-end
slot the diff stat and the grep counts already use —
`row.title.lsp.nav.stats`, with `locations` and `files` as params — so the
host names the fact and the reader's language renders it. The queried path
stays the row's summary.

D9. **A navigation answer waits for the server's own index, boundedly.**
`$/typescriptProjectLoadingStart` / `End` bracket a project load; while the
bracket is open, `goToDefinition` on an imported symbol comes back as the
IMPORT section — the same shape a correctly-absent symbol produces, so the
answer cannot be told apart from the truth until the index lands. The
session counts the bracket from CONSTRUCTION (the first one usually opens
during boot, before any tool call could subscribe) and the navigation path
waits up to `PROJECT_LOAD_WAIT_MS` (15 s) before asking. A server that never
sends the bracket is `unknown`, and unknown is READY — the same leniency D5
gives an absent `textDocumentSync`. The wait is bounded because a bracket
that never closes must not own the call; past the budget the answer is the
partial one, which is still real, just shallow.

**Measured 2026-11-03: `typescript-language-server` sends no such bracket.**
A probe against the real server (`--stdio`, `initialize` + `didOpen` + timed
`textDocument/definition`) received only `window/logMessage`,
`$/typescriptVersion` and `textDocument/publishDiagnostics` — never a loading
start or end. So the bracket counter is inert on the one server this was
written for, and the reviewer's real restarts still got the import clause.
The same probe measured the actual window: the request made ~280 ms after
`didOpen` answers with the import clause, at ~530 ms it still does, and by
~790 ms it returns the real declaration.

D10. **A shallow answer is re-asked, by shape.** The cold answer is
recognizable without any server signalling: every target sits in the QUERIED
file, on an `import` / `export … from` line, and covers exactly the symbol
asked about. No real definition looks like that, so the tool re-asks by
SHAPE: every 500 ms (`SHALLOW_RETRY_DELAY_MS`) until the answer stops being
an import clause or a 15 s budget (`COLD_RETRY_BUDGET_MS`) runs out. A warm
server pays nothing: its first answer is already a declaration, so the retry
never fires. If the server keeps answering shallowly the shallow answer is
returned honestly — it is a real answer, just an early one.

**The budget is fifteen seconds, and it is TIME — not a retry count, and not
the diagnostics push.** A server that was already booted answers correctly by
~790 ms; an APPLICATION restart (cold page cache, startup I/O still settling)
pushed the index tail past five seconds, which is how the first version of
this decision was caught being too small. Fifteen is a quarter of the tool's
60 s budget, and it is spent only on an answer already known to be shallow,
so a warm or merely slow server pays nothing either way. The reviewer's
alternative — wait for the file's next `publishDiagnostics` and ask then —
was not taken: a diagnostics push reports that a CHECK ran, not that the
project finished indexing (the protocol carries no ready bit), so an early
push is indistinguishable from the final one; and a server that pushes
nothing would leave the wait with no signal at all, falling back to the same
budget anyway. A clock is the one input that cannot arrive early.

**The shape check compares DOCUMENT IDENTITY, not strings — and that was the
whole bug on Windows.** A server may spell the very same file differently from
the host: tsserver answers `file:///d%3A/vault/projects/x.ts` (encoded colon,
lower-case drive letter) while the host asks about
`file:///D:/vault/projects/x.ts` (plain colon, upper-case drive letter). Both
decode to the same path except for the drive letter's case, and a Windows path
IS case-insensitive — so the compare has to fold it. The old string compare
said "different file", the shape check never fired, and the retry loop never
ran AT ALL on a Windows host. The canonical form is explicit about it:
`pathToFileURL(fileURLToPath(uri))` does NOT repair the difference, because Node
preserves the original case. `sameDocumentUri` therefore folds the case
ONLY in the Windows world — outside it the comparison stays exact, since on a
case-sensitive filesystem `a.ts` and `A.ts` are two files.

**What the earlier rounds measured, re-read.** Every failure this decision was
chasing on Windows was the LOOP NOT RUNNING, not the budget running out: a
server that was already booted answers correctly by ~790 ms, and the cases that
never showed the import clause never depended on the retry either. The budget is
still fifteen seconds, but it is now a bound on a loop that actually runs — and
the honest answer when it expires is the shallow one, which is a real answer,
just an early one.

D11. **Every answer is a card — including the ones with no rows.** Three of the
tool's answers are not line-anchored at all: a hover's contents, the actions a
server offers at a range, and a raw `request` JSON. Projecting them through the
read card gave a body with zero rows, so BOTH card models rejected the meta and
the row degraded into a raw input/output dump — a JSON pile where a card
belongs. Each now projects its OWN shape (`hover` / `actions` / `json` beside
the discriminating `operation`), and one client block draws all three: the
hover contents as wrapped text, the action list one row per action with its LSP
kind, and the `request` payload as JSON. An EMPTY action list is still the
answer, and its sentence rides in `note` — a card with no rows would otherwise
be an empty frame.

## Consequences

- The four most common semantic questions are one call each, with a cursor the
  model can name (`symbol`) instead of counting.
- A `findReferences` over a large workspace reads up to 32 files per call.
  Bounded and documented, but it is real I/O — the cap exists for exactly that
  reason.
- A server that cannot serve UTF-16 positions is now UNUSABLE rather than
  subtly wrong. No known server advertises that without being asked, so the
  blast radius is a broken server, not a working one.
- `capabilities.ts` now owns the operation vocabulary and the method map; the
  `ctx.lsp` provider imports them instead of keeping a second copy. One
  vocabulary, two consumers.
- Not ported, on purpose: the seam's closed union and its ban on a JSON-RPC
  escape hatch. This plugin keeps `request` — reaching a method nothing else
  wraps is worth more here than the guarantee that no one reaches an
  unwrapped one.

## References

- Built-in counterpart: `deepseek-harness` `packages/lsp/tool-lsp/src/index.ts`,
  `packages/lsp/lsp/src/types.ts`, `packages/lsp/lsp-stdio/src/translate.ts`.
- This plugin: `src/lsp/capabilities.ts`, `src/render/lsp-locations.ts`,
  `src/tools/tool-lsp.ts`, `src/lsp/session.ts`, `src/lsp/provider.ts`.
