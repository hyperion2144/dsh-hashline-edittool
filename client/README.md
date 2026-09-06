# dsh-hashline-edittool-client

Companion **dsh web client plugin** for [`dsh-hashline-edittool`](https://github.com/hyperion2144/dsh-hashline-edittool):
renders hashline-branded `read` / `edit` tool cards in the dsh web UI from the
presentation metadata the main plugin already persists — no dsh upstream
changes required (issue #71, direction B).

## What it renders

- **read** — the official `ReadBlock` card, with the one hashline difference:
  the gutter shows `<line>:<anchor>` (from the persisted `hashlines` meta)
  instead of the bare line number, so what you see matches exactly what the
  model edits through.
- **edit** — the official `DiffBlock` card fed from the persisted applied
  hunks (`meta.diffs`, the web `narrowDiffs` contract): multi-hunk edits render
  fully instead of degrading to the generic row. The collapsed row adds
  caption-styled anchor hints (`@2:b2 @9:c3`) read back from the call's own
  `edits[].anchor_start`.
- **degrades cleanly** — a call without hashline metadata (main plugin
  disabled, foreign tool with the same name, window truncation) falls back to
  the exact shipped presentation.

## Install

```sh
dsh plugin --profile <name> add dsh-hashline-edittool-client
```

Versions are independent of the main plugin's — upgrade either side alone.

## Uninstall / disable

`dsh plugin --profile <name> remove dsh-hashline-edittool-client` (or disable
the row): the host row unmounts, the browser bundle drops out of the web boot
graph, and the slot registrations unwind through the plugin's fiber — the
shipped read/edit cards render again. No residue.

## How it works

The package declares both faces:

- a **bundle** (`cordis.patch.yml`) whose single host-plane row exists so the
  dsh client module system scans the package and serves the browser half;
- a **client half** (`lib/client.js`, exposed as the `./client` exports
  subpath) built as a closure factory (`window.__ModuleLoader__.load`). It
  registers keyed `tool.call.toolview` entries for `read` and `edit` at
  `priority: -1` — the slot ledger shadows by ascending priority (lowest
  renders; equal priority throws), so the takeover is deterministic and never
  touches the shipped registration.

Externals (`react`, `react/jsx-runtime`,
`@deepseek-ai/dsh-client-ui-primitives`) resolve through the loader module
table's platform seed words, so the cards share the shell's exact primitive
instances — identical colors, fonts, and interaction.

## Development

```sh
npm install
npm run typecheck   # src + test
npm test            # vitest — card models
npm run build       # tsc (host half + types) + esbuild -> lib/client.js
```

Smoke-test an unpublished build:

```sh
npm pack --pack-destination /tmp
dsh plugin --profile scratch-hashline-client add /tmp/dsh-hashline-edittool-client-<version>.tgz
dsh web --profile scratch-hashline-client
```

Then trigger a `read` and an `edit` in the web UI and check the cards.

> Same-version re-`add` of a rebuilt tgz serves stale content (pnpm store
> dedup) — bump the version or `rm -rf node_modules/<pkg> && pnpm install
> --force` in the profile.

## License

MIT
