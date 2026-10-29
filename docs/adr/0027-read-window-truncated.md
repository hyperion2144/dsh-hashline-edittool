# ADR-0027 — The read window says whether the response budget cut it (`window.truncated`)

Status: Accepted (2026-10-29)
Map: [#366](https://github.com/hyperion2144/dsh-hashline-edittool/issues/366)
Decisions: [#371](https://github.com/hyperion2144/dsh-hashline-edittool/issues/371) (spec), [#374](https://github.com/hyperion2144/dsh-hashline-edittool/issues/374) (the folded row's title suffix)
Issue: [#376](https://github.com/hyperion2144/dsh-hashline-edittool/issues/376)

## Context

ADR-0014 gave the read window its shape: `window: {start, end, totalLines}`,
projected into the persisted `presentationMeta` and into the model-side JSON
value, so the text tail, the JSON envelope and the web card all describe the
same range. ADR-0013 owns the other half: the per-response character budget
can cut a window, the rows that do not fit spill, and a **resume token** is
minted to fetch them.

The folded row's trailing suffix now shows the window the read served (issue
374). That suffix needs two facts, and the window only carries one of them:

- the **range** — the window has it;
- whether **this range was cut by the budget** — the window does not have it.

The second fact is not derivable from the first. `end < totalLines` is not the
test: a small `limit` ends the window before the file does, and then nothing
was cut, no token was minted, and there is nothing to resume. The "there is
more" sentence is the **model's** tail (ADR-0014) — it is prose, it is
assembled by the host, and the card must never parse model text (the model
text and the UI never parse each other).

So the gap is exactly one fact: **does a resume token exist behind this
window?**

## Decision

1. **The window carries a `truncated` boolean.** In the persisted `meta` and in
   the returned value, `window` gains `truncated: boolean`. The field is
   present only when the budget cut the window (then it is `true`); a window
   that merely ended early has no such field.
2. **One decision point: `assembleServedRead()`** (`src/tools/tool-read.ts`).
   The whole truth is one line — `truncated = (continuation !== undefined)` —
   which is the same fact as `continuation present ⟺ nextOffset propagated ⟺
   the character budget cut the window`. No other layer re-derives the
   boolean: the card does not count rows, and the client does not guess.
3. **`truncated` is not `end < totalLines`.** The semantic boundary is fixed:
   only the host minting a continuation (a resume token) sets it. A window
   that stopped early because `limit` was small is **not** truncated.
4. **A resumed read is judged again.** The resumed read, when the budget cuts
   it once more, is truncated too; when it reaches the end of the file there
   is nothing left to resume, so `truncated` is absent — and so is
   `continuation`.
5. **The JSON output mode carries it too.** JSON mode stays pure JSON — the
   window, the token and the warnings ride *inside* the object (ADR-0014) — so
   `window.truncated` rides inside it as well, and the model sees it.
   The boundary is settled: **a boolean field is a protocol addition, not a
   translation.** ADR-0026's "the model channel stays English" governs
   *sentences* (the window sentence, the anchor protocol, the error codes, the
   error card's `message`/`context`/`hint`); a boolean is not prose and needs
   no wording, and it is of direct value to a model deciding whether to read
   on.
6. **The output schema must declare it.** The read tool's output schema is
   `additionalProperties: false`, and the host validates the returned value
   against it when the tool is mounted: an undeclared field is refused
   outright, not ignored. The local nail is the schema validator
   (`schemaViolations(outputSchemaOf(tool), value)`), not the browser.
7. **The client shows the resume marker from it.** The collapsed row's trailing
   suffix shows the served range (`L12–61 · 共 240 行`) and, when `truncated`
   is true, the resume hint beside it. The flag is the host's own — never a
   count of rows the client did itself.

## Consequences

- The card's title no longer guesses: the meta validation
  (`readWindowFromMeta`) drops a window whose `truncated` is not a boolean
  rather than assuming what it meant.
- The read tool's declared output schema grew one optional field inside the
  `window` object. A session that mounts an OLD tool against a NEW schema
  refuses the value — the same class of change as any other schema extension,
  and the reason the schema is pinned by a test.
- The model-side JSON payload grew one boolean inside `window`: a fact about
  the response, not a rewording of anything.
- `truncated` is optional on purpose. A persisted `window` written before this
  ADR has no such field and still validates, and the client reads a missing
  flag as "not truncated".

## References

- ADR: `docs/adr/0013-streaming-segmented-responses.md` (the budget cut and
  the resume token), `docs/adr/0014-read-window-cursor-and-summary.md` (the
  window shape and the one tail), `docs/adr/0026-host-text-key-wire-contract.md`
  (the wire carries facts; the model channel stays English).
- Code: `src/tools/tool-read.ts` (`assembleServedRead`, the output schema),
  `src/domain/session/read-window.ts` (`ReadWindow`),
  `src/render/read-card.ts` (the persisted meta),
  `client/src/client/models.ts`, `client/src/client/read-meta.ts`,
  `client/src/client/locale.ts`.
- Tests: `test/core/issue-374-read-window-truncated.test.ts`,
  `client/test/read-card.test.ts`.
