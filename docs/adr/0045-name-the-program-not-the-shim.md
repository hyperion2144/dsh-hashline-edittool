---
title: "ADR-0045: A command is named by its PROGRAM, never by one of its shims"
type: decision
status: Accepted
date: 2026-11-24
issue: 453
supersedes: ""
---

# ADR-0045: A command is named by its PROGRAM, never by one of its shims

## Context

The #453 report: on Windows 11 the settings card's install button exited 1 with

```text
'npm.cmd' 不是内部或外部命令，也不是可运行的程序或批处理文件。
```

That machine gets npm from a Scoop-managed nvm. PATH carries
`D:\Scoop\persist\nvm\.nodejs\npm.exe` — a shim — and the real `npm.cmd` lives
in `D:\Scoop\persist\nvm\nodejs\v24.22.3\`, which is **not** on PATH.

`installLspServer` built its argv with

```ts
process.platform === "win32" ? "npm.cmd" : "npm"
```

so `platformSpawnArgv` produced `cmd.exe /d /s /c npm.cmd install …`, and cmd
looked for a file named exactly `npm.cmd`. It does not exist on that machine.
`cmd /d /s /c npm --version` answers `11.19.1` on the same box.

The same failure hits every environment where npm arrives as `npm.exe`:
Scoop, some nvm-windows installs, Chocolatey. A standard Node install (PATH
carries `npm.cmd`) is unaffected — which is why the bug survived: the machine
that develops the plugin is the machine where the hard-coded extension is
correct.

Two spellings of the same command already existed in the module, and that is
the structural half of the defect: `installCommandFor` / `formatInstallCommand`
answered `["npm"]` — the bare name, and the one the catalog's own shape
implies — while the spawn path substituted `npm.cmd`. The two functions are
internal (`canInstallServer` is the only thing that reaches the card, as a
boolean), so no user ever saw the disagreement; what it cost was the one
place a reader would look to learn the command, which said `npm` while the
code that ran it said `npm.cmd`.

## Decision

**A command is named by its PROGRAM, never by one of its shims.** The install
argv's first token is the bare `npm` on every platform, held in one constant
(`NPM_COMMAND`) that the catalog's answer and the spawn both read.

Supporting decisions:

- **The lookup belongs to the component that owns it.** A bare name has no
  extension and no separator, so `needsCommandShell` sends it through
  `cmd.exe` — and cmd's PATHEXT resolution is the only thing on the machine
  that knows whether this install produced `npm.exe` or `npm.cmd`. Spelling an
  extension here is the plugin guessing on behalf of a machine it cannot see.
- **No PATH probing, no `process.env.PATH` reading, no `which`.** The
  interpreter already does that lookup, correctly, with the same rules the
  user's own shell uses. A second implementation would be a second answer.
- **One constant, not two literals.** The catalog's answer and the spawn's
  argv are the same fact; two spellings of it is how this bug got in. A test
  pins that they agree on all three platforms.
- **The rule is about the PROGRAM, not about npm.** `npm` is the instance that
  bit; the same reasoning applies to any bare command this plugin spawns. An
  absolute path to a real executable is still passed through untouched — the
  caller named a file, and a PE image needs no interpreter. (An absolute path
  ending in `.cmd`/`.bat` is still a batch file, so `needsCommandShell` sends
  it through the interpreter too — that is the plugin's own server-launch
  shape, and it is the same rule, not an exception to it.)

## Consequences

- Windows installs work under a standard Node install, Scoop, nvm-windows and
  Chocolatey alike, because the resolution moved to the component that has the
  information.
- The catalog's answer and the command the install runs are now provably the
  same token — on Windows it is the interpreter's argument (`argv[4]`),
  elsewhere `argv[0]`. The regression test asserts it on `darwin`, `linux`
  and `win32`.
- The rest of the argv is unchanged: `--prefix`, `--no-audit`, `--no-fund`,
  `--loglevel=error` and the package still ride through the same translation,
  and the test pins the whole line rather than just the first token.
- **A bare name is only resolvable through a shell.** Off Windows that is
  irrelevant (`spawn` resolves PATH itself); on Windows it is exactly what
  `needsCommandShell` already arranges. A future caller that spawns a bare
  name with `shell: false` on Windows would get `ENOENT` — the same trap the
  module doc has warned about since the cmd.exe wrap landed.
- The `--loglevel=error` token reaches the subprocess as `--loglevel^=error`
  on Windows, because cmd escaping is applied to every argument. cmd consumes
  the caret, so npm reads `--loglevel=error`; the test pins the escaped form
  so a future change to the escaping cannot silently alter what npm receives.

## Alternatives

- **Probe PATH for `npm.cmd` then `npm.exe`.** Rejected: it re-implements
  PATHEXT resolution in the plugin, gets the ordering and the per-directory
  precedence subtly wrong, and still cannot see a shim that a shell function or
  a wrapper provides. The interpreter is already there and already correct.
- **Keep `npm.cmd` and fall back to `npm.exe` on failure.** Rejected: it turns
  a deterministic lookup into a retry loop, doubles the failure surface, and
  still fails for a shim that is neither.
- **Read `process.env.PATH` and pick the first match.** Rejected: same
  re-implementation problem, plus it freezes a decision that cmd makes at
  spawn time — a PATH edited between the read and the spawn would be missed.
- **Leave the two spellings and only fix the spawn.** Rejected: the card would
  keep advertising a command the install does not run, and the next person to
  touch either one re-opens the same gap.

## Evidence

- Field report: [#453](https://github.com/hyperion2144/dsh-hashline-edittool/issues/453)
  — Windows 11, npm from a Scoop-managed nvm, `npm.exe` on PATH and `npm.cmd`
  off it.
- The reporter's 10-second reproduction, run on the affected machine:
  `cmd /d /s /c "npm.cmd --version"` → `'npm.cmd' 不是内部或外部命令…`;
  `cmd /d /s /c "npm --version"` → `11.19.1`.
- The workaround that proved the rest of the path correct: installing the
  server by hand into the plugin's own prefix made discovery find it at
  `<dsh home>/plugins/dsh-hashline-edittool/servers/node_modules/.bin`, and
  `lsp warm typescript` answered `TypeScript is ready.` — so the prefix, the
  flags and the discovery path were never the problem.
- Regression test: `test/core/issue-453-lsp-npm-bare-name.test.ts` stubs
  `process.platform` to `win32` and asserts the spawned argv, the catalog's
  answer, and the two agreeing.
