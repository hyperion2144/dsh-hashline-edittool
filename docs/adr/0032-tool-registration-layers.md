# ADR-0032 — a tool's registration layer is decided by ONE question: must it shadow a built-in?

> **Status**: Accepted (2026-11-03; issue [#398](https://github.com/hyperion2144/dsh-hashline-edittool/issues/398) — implemented in the same change).

## Problem Statement

The plugin's eleven tools were all registered on the AGENT's own scope layer,
from the `agent/created` listener. Two things were wrong with that.

**First, the layer was wrong for six of them.** `read`, `write`, `edit`,
`grep` and `lsp` shadow a same-named built-in the preset mounts; only the
agent's layer can do that, because the preset is the agent's PARENT scope and
the nearer registration wins. The other six — `ast_grep`, `ast_edit`,
`undo_last_edit`, `format`, `delete`, `rename` — shadow NOTHING. They
rode the agent's lifecycle for no reason: they waited for an agent to exist,
and they went away when one ended.

**Second, and worse, the listener returned too early.** The plugin's
`agent/created` listener was SYNCHRONOUS: it kicked the install into an
agent effect and returned. The host's contract is explicit — "Return only
after required asynchronous tool and prompt installation completes"
(`packages/core/agent/README.md:207`) — and the host acts on it: the loop
"await[s] serial `agent/created` listeners; then release[s] queued input"
(`packages/core/agent-loop/README.md:110`, and the event catalogue repeats
it: "AgentLoop holds queued input until all listeners finish",
`packages/extensions/tool-cordis/src/api-catalog.ts:4722`).

A RESUMED session is the case that shows it. Its queued input comes back
from disk with the session, so it is released the instant the listener
returns — there is no human typing delay to hide behind. A NEW session has
seconds between "create" and "send", which is plenty for a guidance file
read.

So on the first turn of a resumed session the model saw: the preset's
built-in `read` and `write` (line numbers, no anchors), the official
`lsp`, and exactly ONE hashline tool — `edit`, the only one registered
before the first `await`. Feeding a built-in read's output to a hashline
`edit` is rejected: the anchors it wants are not in what the built-in read
returned. The next turn was fine — the tool surface is re-assembled per step
(`packages/core/agent-loop/src/agent.ts:292`) — which is why the report says
"the tools come back one turn later".

## Decision

**1. ONE question decides the layer: does the tool have to shadow a
same-named built-in?**

- **Yes** → the AGENT's own scope layer (`agent.ctx.tools.register`). The
  agent's layer is nearer than the preset's, so it wins; the registration
  unwinds with the agent.
- **No** → the PLUGIN's own layer, registered ONCE in `apply()`
  (`ctx.tools.register`), the way every other dsh plugin registers its
  tools. The plugin's context carries no scope tag, so the registration
  lands on the host's GLOBAL layer
  (`packages/core/scope/src/store.ts:231-237`), which is the base of every
  agent's tool view (`packages/core/tools/src/index.ts:199-207`).

The plugin's tools are therefore split exactly once, by that question:

| Layer | Tools | Why |
| --- | --- | --- |
| agent | `read`, `write`, `edit`, `grep` | must shadow the preset's built-in |
| plugin (global) | `ast_grep`, `ast_edit`, `undo_last_edit`, `format`, `delete`, `rename` | shadow nothing; session-independent |
| decided (see 5) | `lsp` | shadows the official `lsp` when it is enabled; the plugin layer otherwise |

**2. The `agent/created` listener returns only after the agent-scoped
install is complete.** The install's promise is what the listener awaits. The
listener must never REJECT: the host fails agent creation on a listener
throw (`packages/extensions/tool-cordis/src/api-catalog.ts:4722`), and a
failed guidance read is not a reason to fail a session — it degrades to the
compiled defaults.

**3. The tool registrations happen BEFORE the first `await`.** The guidance
override read is the only asynchronous step, and it comes last: the five
shadowing tools are in place the moment the agent exists, and the prompt
sections land a tick later — both before the listener returns.

**4. The six plugin-layer tools need no agent context at all.** Their file
access and sandbox policy are host-plane products (`ctxFsIO(rootCtx.fs, …)`,
`new FsSandboxController(rootCtx)`), and the session's live working
directory is asked of the host per call (ADR-0031). Nothing about them is
per-agent.

**5. `lsp` is the one tool whose layer is DECIDED, not fixed.** The
official `dsh-tool-lsp` is OPT-IN: it is not in the default
composition, and a user enables it per preset. So "is there a
built-in `lsp` to shadow?" is a deployment fact only the registry can
answer — and it changes the right answer:

- A built-in `lsp` IS there → the AGENT's layer, shadowing it.
- No built-in `lsp` → the PLUGIN's layer, where the tool is present
  from the first turn of every agent. There is nothing to shadow, so
  the shadowing layer buys nothing and only costs the tool a turn.

The FIRST agent asks the registry — `tools.get("lsp", scopeOf(agent.ctx))`
is the view the agent sees, and BEFORE the plugin registers its own tool
that view holds exactly the built-ins — and the answer decides the layer
for every later agent: a built-in is a deployment fact, not a per-agent
one. The plugin layer takes one name per layer, so that registration
happens once.

## Amendment (2026-11-03) — the probe must answer OWNERSHIP, and "cannot tell" means the plugin layer

Decision §5 asks the registry whether a built-in `lsp` is there. Two
refinements make that answer trustworthy; both came from running the
probe for real. The first attempt asked only "is a same-named tool in
the view?" and got the answer wrong twice: it read the plugin's OWN
`lsp` as a built-in to shadow, and it had no way to say "the registry
would not answer me".

**A. The probe answers OWNERSHIP, not just existence.**
`tools.get(name, scope)` returns whatever is nearest in the view —
including a tool this plugin registered itself. Once the plugin layer
holds the hashline `lsp`, a later probe finds it and would call it a
built-in. So every definition the plugin registers is remembered in a
`WeakSet` (`ownToolDefinitions`), and a hit that is one of OURS counts
as "no built-in": our own tool shadows nothing, and the plugin layer
is where it already lives.

**B. The probe is THREE-valued, and only a confirmed answer buys the
agent layer.** The registry may simply fail to answer — a scope-less
context, an older host, a throwing getter. That is neither "there is
a built-in" nor "there is not": it is UNKNOWN. So the decision is:

| probe | layer | why |
| --- | --- | --- |
| `true` — a farther-layer tool that is NOT ours | agent | there is something to shadow |
| `false` — nothing there, or the hit is our own | plugin | nothing to shadow |
| `undefined` — the registry could not answer | plugin | the safe layer: the tool is in the surface from the first turn |

Only `true` reaches the agent layer. Everything else — absent, our own,
or unanswerable — registers on the plugin layer, where the tool is
present from the first turn of every agent.

The cost of the fallback is honest and bounded. If a built-in `lsp`
really does exist but the registry would not answer, the preset's
nearer layer wins and the model gets the OFFICIAL `lsp` instead of the
hashline one: a degraded tool, not a missing one. That is the right way
round — the bug this ADR exists for is a MISSING tool on a resumed
session's first turn.

## Alternatives rejected

- **Move all eleven to the plugin layer.** Rejected: the preset's built-ins
  live on the preset layer, which is NEARER than the global layer, so the
  hashline `read`/`write`/`edit`/`grep` would be shadowed and would
  silently never run. The bug would change shape — from "missing tools" to
  "the hashline contract never applies" — which is worse.
- **Move all eleven to the preset layer.** Rejected: the preset is the
  user's composition; a plugin does not get to choose what a preset mounts.
- **Keep the agent layer for the six, and only fix the await.** Rejected:
  the six would still be absent until an agent exists AND a guidance file
  has been read. The first turn of a resumed session would still miss them.
- **Register the six eagerly per agent, before the guidance read.**
  Rejected: this fixes the six but leaves the five shadowing tools behind
  the same read, and the mixed surface (built-in `read` + hashline
  `edit`) is the part that actually breaks the turn.
- **Move the guidance read out of the install.** Rejected: the sections are
  per-preset, and the preset id is only knowable from the agent's context
  (`agentPresets.composedPreset(agent.ctx)`). The read must stay per
  agent; what changes is that the listener WAITS for it.
- **Always put `lsp` on the agent layer.** Rejected: with the official
  plugin OFF there is no built-in to shadow, and the tool then misses a
  resumed session's first turn — the exact symptom #398 is about.
- **Always put `lsp` on the plugin layer.** Rejected: with the official
  plugin ON, the preset's nearer layer wins and the hashline `lsp`
  would silently never run.
- **Re-decide the layer per agent.** Rejected: the built-in is a
  deployment fact, not a per-agent one, and the plugin layer accepts
  one name — a per-agent decision would try to register it twice.

## Consequences

- The first turn of a resumed session sees all eleven hashline tools, and
  `read` is the hashline one (its output carries the `ANCHOR:FILELINE`
  header).
- The six non-shadowing tools exist from plugin load: they are enumerable
  before any agent exists, are registered once per app rather than once per
  agent, and do not disappear when an agent ends.
- The five shadowing tools still unwind with their agent, and still shadow
  the preset's built-ins for that agent only.
- `lsp` is on the agent's layer only when a built-in `lsp` is actually
  there; otherwise it is on the plugin's layer, next to the six. Either
  way it is in the tool surface from the first turn of a resumed
  session.
- The layer probe is ownership-aware and three-valued. Only a CONFIRMED
  built-in — one the registry named, and that is not the plugin's own —
  earns the agent layer; "absent", "our own" and "the registry would
  not answer" all land on the plugin layer. An unanswerable registry
  therefore degrades to the OFFICIAL `lsp` (the preset's nearer layer
  wins), never to a missing tool.
- Enabling the official `lsp` plugin MID-SESSION is out of scope: the
  layer was decided when the first agent was installed, and the plugin
  layer cannot yield a name to a nearer layer that appears later.
- The `agent/created` listener now waits for the install. The wait is
  bounded by the plugin's own file I/O (one guidance override read); it
  never waits for the agent to go idle.
- A failed install degrades instead of hanging: the listener logs and
  returns, and the host's queued input is released. The listener can never
  hang the session — a listener that never settles would hold the queued
  input forever.
- The six plugin-layer tools are now visible to a preset's `tools.restrict`
  filter (the global layer is what a restriction masks; an agent's own
  registrations are exempt). Before, a preset could not name them at all —
  `restrict` rejects unknown names — so this is the first time a preset
  can deny `format` or `delete`.
- The plugin now owns six names in the host's global tool layer. A
  deployment that mounts a second plugin offering one of those names gets a
  same-layer duplicate error instead of two coexisting layers — the host's
  rule for one layer (`packages/core/tools/src/index.ts:69`), and the same
  rule every other plugin's tools live under.

## Evidence

- Field report: [#398](https://github.com/hyperion2144/dsh-hashline-edittool/issues/398)
  — after a DSH restart, a resumed session's first turn had seven of the
  plugin's tools missing, and `read`/`write` presented as the built-in
  (line-numbered, anchorless) versions. Reproducible on every restart.
- Host semantics: `packages/core/tools/src/index.ts` — `view(scope)`
  starts from the global layer and writes the scope's own layer last
  (nearer wins); `packages/core/scope/src/store.ts:231-237` — an unscoped
  context registers on the global layer; `packages/core/scope/src/index.ts:154`
  — `scopeOf`; `packages/core/agent/src/index.ts:575` — `agent/created`
  is dispatched serially and awaited.
- Host contract: `packages/core/agent/README.md:207`;
  `packages/core/agent-loop/README.md:110`;
  `packages/extensions/tool-cordis/src/api-catalog.ts:4719-4724`.
- Research: `docs/research/agent-scoped-tools-restart-resume-gap.md` — the
  first-hand evidence for the lifecycle and the layer semantics, including a
  live probe of `ctx.effect`'s synchronous/async behaviour.
- Regression: `test/core/agent-tool-registration.test.ts` — the six land on
  the plugin layer before any agent exists and stay off the agent layer;
  the four land on the agent layer before the listener resolves; `lsp`
  lands on the agent layer when a built-in `lsp` is there to shadow and
  on the plugin layer when there is none (registered once); the listener
  does not return before the install ran; and it still returns when the
  agent's scope is already gone.
- Ownership-aware probe: `src/index.ts` — `ownToolDefinitions` (a
  `WeakSet` of every definition this plugin registered) and
  `builtInToolPresent` (three-valued: `true` / `false` / `undefined`);
  `test/core/agent-tool-registration.test.ts` covers a confirmed
  built-in, no built-in, and a registry that throws.
