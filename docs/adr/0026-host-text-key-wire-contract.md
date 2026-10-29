# ADR-0026 — host 文案 key 化：稳定 key + params 过 wire，客户端经 `t()` 解析

Status: Accepted (2026-10-28)
Map: [#366](https://github.com/hyperion2144/dsh-hashline-edittool/issues/366)
Decisions: [#369](https://github.com/hyperion2144/dsh-hashline-edittool/issues/369) (ctx.locale 调研), [#367](https://github.com/hyperion2144/dsh-hashline-edittool/issues/367) (i18n 键位), [#371](https://github.com/hyperion2144/dsh-hashline-edittool/issues/371) (规格)
Issue: [#375](https://github.com/hyperion2144/dsh-hashline-edittool/issues/375)

## Context

The cards' chrome follows the interface language (ADR-0022's sibling work: the
plugin's own vocabulary namespace `hashline.card`, zh/en, registered with the
host's locale service). The host could not join that party: `locale` is a
CLIENT service. The host only ever stores the user's preference — the browser's
provisional locale is invisible to it (#369). A host that assembles a sentence
for a card has therefore already picked a language the reader did not ask for,
and no host-side cleverness can fix that: the host does not know the answer.

Two user-visible strings were composed by the host and shipped as prose:

- the read card's **lossy footnote** — `LOSSY_BYTES_NOTE`, an English sentence
  in the persisted meta, rendered verbatim by the card's footer;
- the **folded row's title** — `Read <path> (12 - 61)` and its siblings, the
  host's own composition of the row header.

Both were English in every session. The only way out is to stop sending prose.

## Decision

1. **The wire carries FACTS, never words.** A host text is
   `{ key, params? }` — `LocalizedText` in `src/render/wire-text.ts`. The key
   is a STABLE name of a wording (it lives in the client's vocabulary); the
   params are the values that fill the wording's template. The client resolves
   both through its own `t()` seat, in the language the reader chose.
2. **Two carriers today.** `meta.rowTitle` is the folded row's title;
   `meta.lossyNote` is the read card's footnote. Both are produced by ONE host
   function (`rowTitle()` for the title, `LOSSY_NOTE_TEXT` for the note), so
   the shape cannot drift per tool.
 3. **The templates live in the client's vocabulary**, never in the host:
    `row.title.read`, `row.title.read.window`, `row.title.read.window.truncated`,
    `row.title.read.total`, `row.title.edit`, `row.title.write`, `row.title.grep`,
    `read.lossy` — zh/en, parity-pinned by the vocabulary's own test.
4. **A window changes the KEY, not the template.** `row.title.read` says
   "Read"; `row.title.read.window` says "L240–319 · 374 lines total"
   (`{start, end, total}`); `row.title.read.window.truncated` adds the resume
   hint for a window the response budget cut; `row.title.read.total` says
   "374 lines total" for a read that served the whole file. A template that
   could swallow the window segment would need a conditional, and a template
   with an empty hole renders a stray space in the one case that has none. The
   window keys ride only when the served window is not the whole file — a
   whole-file read gets `row.title.read.total` instead (#370/#374).
5. **The path rides as a param, not as a title.** A path reads the same in
   every language, and the row already shows it as its summary — where it stays
   clickable. The title template names the tool; the trailing suffix names the
   window.
6. **The LEGACY shape survives.** A meta persisted before this ADR carries the
   lossy footnote as the English sentence (a string). The client's validator
   accepts BOTH shapes; the string renders verbatim, the key resolves through
   `t()`. Nothing that was already logged stops rendering.
7. **An unknown key is refused, not rendered.** The client's gate is its own
   dictionary: a key the vocabulary does not carry is dropped, and the row falls
   back to its own label. A key literal on screen is the exact failure the
   shipped `conversation` seat had (#369) — it must not come back.
8. **The model channel stays English.** The window sentence, the anchor
   protocol, the error codes, and the error card's `message`/`context`/`hint`
   are what the MODEL reads; the model speaks English. They are not card chrome
   and they are not key-ized.
9. **The platform's call view is a string, and stays one.** `presentCall`
   returns `ToolCallView`, whose `title` is typed `string` and which has no
   locale seat: a `{key, params}` there would render as `[object Object]` in
   every surface the platform owns (a CLI log line, a deployment without our
   client). So the platform title remains the host's English fallback, while
   the hashline client renders its own title from `meta.rowTitle`.

## Consequences

- A Chinese session now reads "读取（12 - 61）" and "无法解码的字节显示为
  U+FFFD…" where it used to read English; an English session is unchanged.
- The host gained one vocabulary of KEYS, not a vocabulary of words: the
  wording lives in one place (the client's dictionary), so a wording change is
  a dictionary edit, not a host edit.
- The host's `presentCall` titles remain hand-written English. They are the
  platform's fallback, not the cards' chrome; unifying them would mean
  shipping a second copy of the English templates on the host, which the
  dictionary would then have to be kept in sync with.
- The client's meta validator grew one shape (`string | WireText`) and one
  refusal (an unknown key). Both are pinned by tests.
- The read tool's declared output schema changed with the note (`lossyNote` is
  an object now): a session that mounts an OLD tool against a NEW schema
  refuses the value — the same class of change as any other schema extension,
  and the reason the schema is pinned by a test.
- The settings card's field labels were never host text: the host's schema
  carries no labels at all, and the card drew its OWN Chinese words. Those words
  moved into the same vocabulary (`settings.*`), which is what makes the page
  follow the interface language. The language MANAGER's own strings (the catalog
  states, the install buttons, the route failures) stay as they are — they belong
  to that feature, not to the settings fields.

## References

- Research: [#369](https://github.com/hyperion2144/dsh-hashline-edittool/issues/369) — the `ctx.locale` seat and why the host cannot localize
- ADR: `docs/adr/0022-toolview-takeover-priority.md` (the client owns these rows)
- Code: `src/render/wire-text.ts`, `src/tools/tool-read.ts`, `src/tools/tool-edit.ts`,
  `src/tools/tool-write-shadow.ts`, `src/tools/tool-grep.ts`,
  `client/src/client/locale.ts`, `client/src/client/models.ts`,
  `client/src/client/labels.ts`, `client/src/client/tool-row.tsx`
