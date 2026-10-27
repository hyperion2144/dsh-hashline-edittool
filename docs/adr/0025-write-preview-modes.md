# ADR-0025 — `write` preview modes (`write.preview`: full | diff | confirmation)

> **Status**: Accepted (wayfinder map #354; decisions #355/#356/#357, spec #359; 2026-10-27). Supersedes the README's "auto-read preview is what `write` returns" statement from before 0.10.4.

## Problem Statement

`write` returned the whole file after every call: `--- Auto-read (hashline anchors) ---`, every
line, and its anchor. On an overwrite that echo restates content the model just supplied — only
the anchors carry new information — while `edit` had already replaced its own whole-file echo with
a unified diff (ADR-0020). The same call also has no quiet form: a model writing a file to hand to
a human still pays for an echo nobody reads.

The mode is an OUTPUT behaviour, so it belongs to the user (like `line_numbers` and `format.auto`),
not to a per-call tool parameter the model chooses for itself.

## Solution

One plugin setting, `write.preview`, with three values (default `diff`):

- **`full`** — the old behaviour: re-read via `readAndServe`, serve every written row, the read
  window sentence and a resume token when the preview is truncated.
- **`diff`** — an UPDATE is rendered by the SAME unified-diff renderer every edit tool uses
  (`--- path` / `+++ path`, `@@ -old,count +new,count @@ scope`, `context_lines`, `+`/`-` rows;
  `-` rows carry the pre-write anchor marked `~`). Only the rows the diff renders are minted and
  served, so the `+`/context anchors are writable immediately. A CREATE has no before side, so it
  stays read-style. An oversized diff spills through EDIT's segment channel (ADR-0013), never
  through read's `[Lines X-Y of N]` window. JSON output answers with the marker-keyed diff
  dictionary `edit`/`ast_edit` use.
- **`confirmation`** — `Wrote <path> (create|update).` and nothing else: no re-read, no window, no
  resume token, no anchors minted or served. A format pass that changed the text still reports a
  header-and-counters section, because the model must know the disk text differs from what it
  wrote — but with no rows, since a row must quote an anchor the model can address. Diagnostics
  are untouched (inline window, then bounded async delivery).

The card channel: `full`/`diff` keep the `行号:锚点` gutter; `confirmation` still draws the diff
but its rows carry blank hashes, so the gutter shows line numbers only.

## Consequences

- The default flips to `diff`. The behaviour change is bounded to **updates**; creates echo
  exactly what they did before.
- Nothing about the tool surface changes with the mode — name, description, parameters and output
  schema are constant, so a switch hot-reloads without re-registering the tool.
- Under `confirmation` the model can only edit lines whose anchors it already holds and whose
  content has not changed; anything else is refused (the stale/unverified family) until a `read`.
  The refusal echo carries a fresh marker, so the recovery does not always need a re-read.
- A mode that serves nothing must not ALLOCATE either: otherwise "no anchors" would be a text
  promise the store contradicts. The card's diff rows are built from the sparse view instead.

## Alternatives considered

- **`create → confirmation` in diff mode** (#355): rejected — a create followed by an edit would
  pay for a read that the echo could have avoided, and it would make one mode render two different
  things for the same operation.
- **all-`+` diff for creates** (#355): rejected — same content as the read-style echo with one
  extra character per line and a header that says "new file"; nothing gained.
- **`write.echo` / `write.auto_read` as the key** (#357): rejected — `echo` collides with the
  established "content echo" term (`require_line_content`), `auto_read` names only one of three
  states.
- **`--- /dev/null` for a new-file header**: rejected — the renderer keeps ONE file-header shape
  (`-0,0` in the hunk header already says new file), and under this ADR a create never renders a
  diff at all.
- **Adaptive mode by file size**: not in this decision; still fog on map #354.
