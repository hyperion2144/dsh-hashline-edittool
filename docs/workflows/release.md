---
title: Release & publish (tag-first)
type: workflow
status: current
stability: stable
scope: dsh-hashline-edittool
created: 2026-09-26
updated: 2026-09-26
evidence:
  - package.json
  - scripts/release.mjs
  - scripts/changelog.mjs
  - scripts/assert-tagged.mjs
  - scripts/tag-current.mjs
  - .github/workflows/release.yml
related:
  - .agents/skills/git-std.md
  - CHANGELOG.md
---

# Release & publish (tag-first)

The **git tag creates the GitHub release**, and `npm publish` is blocked until
that tag exists. Never the other way round.

## 1. Release — headless-safe

```sh
npm run release -- X.Y.Z [--dry-run]
```

`scripts/release.mjs` refuses before touching anything when:

- `X.Y.Z` is not a valid version;
- the version is **not newer** than the one in `package.json`;
- the **working tree is not clean** — it checks `git status --porcelain`, so an
  untracked artefact at the repo root blocks the release;
- tag `vX.Y.Z` already exists.

It then bumps `version` in `package.json` and `package-lock.json`, moves the
CHANGELOG `[Unreleased]` section to `[X.Y.Z] - <date>` and re-adds an empty
`[Unreleased]` (`scripts/changelog.mjs`), commits `chore: release vX.Y.Z`,
creates the annotated tag `vX.Y.Z`, and **pushes the branch and the tag**.

The tag push triggers `.github/workflows/release.yml`, which creates the GitHub
Release from that version's `## [X.Y.Z]` CHANGELOG section, falling back to
generated notes when the section is missing.

## 2. Publish — needs an interactive shell

`npm login` and `npm publish` open a browser for the 2FA/OTP step. An agent
without an interactive terminal cannot complete that step — hand it to a human.

```sh
npm login   --registry https://registry.npmjs.org
npm publish --registry https://registry.npmjs.org
```

- **Run `npm login` first when the stored token is stale.** This machine's
  `~/.npmrc` defaults to the `npmmirror.com` mirror and its npmjs token expires,
  which produces a 401/`ENEEDAUTH` — and the publish then fails with a
  misleading `E404 … do not have permission`.
- **Always pass the registry explicitly.** The mirror is not write-accessible.
- `prepublishOnly` re-runs `typecheck` + `test` + `build` +
  `scripts/assert-tagged.mjs`, which refuses to publish until tag `vX.Y.Z`
  exists.
- `postpublish` (`scripts/tag-current.mjs`) tags and pushes the current version
  only when the tag is missing; it is a harmless no-op otherwise, and skips
  entirely under `--dry-run`.

## 3. Verify the publish

```sh
npm whoami --registry https://registry.npmjs.org   # -> hyperion2144
curl -s https://registry.npmjs.org/dsh-hashline-edittool   # "latest": "X.Y.Z"
```

The npm account is **`hyperion2144`**. `rianico` owns the fork upstream's old
`dsh-better-edit` package — this package is independently maintained, so a
`rianico` result means the wrong account/registry answered.

## Related

- Day-to-day Git flow (branch, PR, `Closes #NN`) — [`.agents/skills/git-std.md`](../../.agents/skills/git-std.md)
- What each version changed — [`CHANGELOG.md`](../../CHANGELOG.md)
