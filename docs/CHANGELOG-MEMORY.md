# Memory Change Log

Audit log of changes to this repository's **Project Memory layer** (the
agent-facing knowledge system: `AGENTS.md`, `docs/` domains, and the
navigation between them). It is not the product changelog — that is
[`CHANGELOG.md`](../CHANGELOG.md).

Each entry records what changed, why, the confidence in the underlying
evidence, and the evidence paths. Entries are append-only and never rewritten.

---

## 2026-09-26 — Initial Project Memory build

**Type:** initialization + accuracy correction
**Confidence:** High
**Evidence:** `package.json`, `npm test` (113 files / 1,330 tests, exit 0),
`npm run typecheck` (root + client, exit 0), `.github/workflows/ci.yml`,
`scripts/release.mjs`, `git status` (clean), `git log`

### Why

`/project-memory` reported that this workspace already had Project Memory
(`AGENTS.md` present). That was a false positive: the command resolves the
workspace by walking up to six parent directories looking for `AGENTS.md`, and
from the repository root it landed on `/Users/mutou/AGENTS.md` — a
`code-review-graph` MCP instruction file, not Project Memory. The repository
itself had **no** `AGENTS.md`, no `docs/` domain structure, and no memory audit
log, so the correct branch was **initialization**, not audit-and-update.

The audit that followed found the existing knowledge (`README.md`,
`CONTEXT.md`, `docs/adr/`, `docs/agents/`, `CHANGELOG.md`) accurate, well
separated by lifecycle, and richly sourced — but it also found three stale
claims in the two READMEs that current files and a live test run contradict.

### Path / Affected typed relationships

- `AGENTS.md` (created)
- `docs/workflows/release.md` (created)
- `docs/CHANGELOG-MEMORY.md` (created)
- `CLAUDE.md` (reduced to a thin pointer)
- `README.md`, `README.zh.md` (three stale claims corrected)

### Changes

1. **Created `AGENTS.md`** as the single canonical Level-0 entry point, with an
   `l0_domains` map. It carries only identity, critical rules, minimal
   orientation, verification and navigation — no duplicated detail.
2. **Created `docs/workflows/release.md`**, the tag-first release & publish
   procedure, moved out of `CLAUDE.md` so one document owns it.
3. **Reduced `CLAUDE.md` to a thin pointer** at `AGENTS.md` (Option A of the
   dual-entry-point reconciliation). It previously duplicated rules that now
   have one home; two competing primaries silently diverging is the defect
   being fixed.
4. **Corrected `README.md` / `README.zh.md`:**

   | Claim | Was | Now | Contradicted by |
   | --- | --- | --- | --- |
   | Compatibility mechanism | `@deepseek-ai/dsh-settings >=0.1.2-rc.0` peer dep, "enforced by npm" | `@deepseek-ai/schemastery >=3.18.3` peer dep | `package.json` `peerDependencies`; `CHANGELOG.md` 0.9.0 "`@deepseek-ai/dsh-settings` 依赖移除" |
   | Current build/test SDK line | `0.1.6-alpha.1` | `0.1.7-alpha.1`, plugin `0.9.x` | `package.json` devDependencies (all `@deepseek-ai/dsh-*` at `0.1.7-alpha.1`); `CHANGELOG.md` 0.9.0 "仅支持 0.1.7（0.8.x 留给 0.1.6）" |
   | Test count | `1,210` | `1,330` | `npm test` — 113 files / 1,330 tests |

5. **No new Solution/Lesson units.** The engineering learnings present in the
   working tree (#187 echo allocation, #151 `ins` anchor drift, #190 bounded
   Myers, #169 sparse anchors) are already owned by `CHANGELOG.md` and
   ADR-0006 / 0009 / 0010 / 0011. Compounding them again would be semantic
   duplication.

### Not done, deliberately

- **No empty domain scaffolding.** `docs/architecture/`, `docs/solutions/` and
  `docs/lessons/` were **not** created: their content is already owned by
  `README.md`, `CONTEXT.md` and `docs/adr/`, and a domain is created only when
  it has knowledge that benefits from separate retrieval.
- **No edit to the ADR set.** All eleven ADRs are `Accepted` or `Implemented`,
  each with an identifiable issue or spec, and the superseded specs
  (`docs/dynamic-hashline.md`, `docs/line-hashline-spec.md`,
  `docs/edit-payload-spec.md`, `docs/web-ui-structured-views-spec.md`) already
  point at their replacements.

---

## 2026-09-26 — Doc-push convention recorded

**Type:** process-rule correction
**Confidence:** High
**Evidence:** maintainer instruction, 2026-09-26

`AGENTS.md` § Critical rules #2 said "PR first" and left documentation to the
vague `git-std.md` carve-out ("changes too small to justify a PR"). The
maintainer's standing rule is sharper:

- **Code changes** → branch + PR against `main`, `Closes #NN` at the end of the body.
- **Documentation-only changes** (`.md`) → pushed **directly to `main`** — no branch, no PR.
- **Neither may release.** `npm publish` always waits for an explicit instruction.

### Path / Affected typed relationships

- `AGENTS.md` — rule 2 rewritten. No other document's reading changes.

---

## 2026-09-28 — ADR-0012 recorded: `lines` is a line array (#198)

**Type:** decision + contract documentation
**Confidence:** High
**Evidence:** `npm run typecheck` (root + client, exit 0), `npm test` (114 files /
1,342 tests, exit 0), `npm test -w client` (6 files / 148 tests, exit 0),
`test/core/issue-198-lines-semantics.test.ts` (new, 12 tests), live repro in
`.tmp/triage-198-*` (issue [#198](https://github.com/hyperion2144/dsh-hashline-edittool/issues/198))

### Why

Two defects in one report: (a) `lines` was flattened with `join("\n")` before the
engine saw it, so every all-blank array landed on the wrong side of the string
surface's `""` = delete marker — `[""]` deleted the line instead of clearing it,
`["",""]` lost a line, `ins` + `[""]` was a noop; (b) a diff's removal row took
its anchor from the text diff's head-first alignment, so with identical adjacent
lines it named the SURVIVOR instead of the line the engine spliced out.

The maintainer ruled the contract: in `lines`, one element is ONE line, only an
element's own newline becomes several, and no input may change the line count
silently. That is a durable, non-obvious invariant (the `"\n".repeat(n)` spelling
looks arbitrary without it) with real alternatives (carry the array deeper / change
`parseText`), so it is recorded as ADR-0012 rather than left in code comments.

### Path / Affected typed relationships

- `docs/adr/0012-lines-line-array.md` — new: the decision record.
- `AGENTS.md` — `l0_domains.decisions` now spans ADRs 0001–0012.
- `CONTEXT.md` — the `lines` glossary entry states the line rule (canonical vocabulary).
- `README.md` / `README.zh.md` — the `replace` row states it in both mirrors.
- `docs/edit-payload-spec.md` — the `[""]` bullet and the acceptance-table row.
- `CHANGELOG.md` — new `[Unreleased] → Fixed` section (in Chinese, per rule 4).

---

## 2026-10-03 — ADR-0013 recorded: refusing by size becomes flow control (#200 → #201)

**Type:** decision + contract documentation
**Confidence:** High
**Evidence:** wayfinder map [#201](https://github.com/hyperion2144/dsh-hashline-edittool/issues/201), decisions #204/#205, specs #209/#210, research #202 (host gate measured: single block ≤49,984 chars) and #203 (8-tool surface inventory), both refusal shapes reproduced in-session via the integration harness (issue [#200](https://github.com/hyperion2144/dsh-hashline-edittool/issues/200)); ADR + CONTEXT written on `main` per the docs-push convention.

### Why

#200 confirmed the #167 budget's gross-size billing produced false refusals
(a 68 MB file with one match reported "No matches"; folder scans truncated
with an under-reporting notice). The maintainer ruled the direction: refusals
retire entirely — oversized results stream in segments (48,000 code units,
`max_response_chars`) with session spill files and resume tokens, anchors
allocated at serve time (ADR-0009's model, unchanged). That is a durable,
non-obvious architectural reversal (a budget that refuses → a budget that
flows) with real rejected alternatives (served-row billing, higher caps,
host-spill reliance, resume-on-mutating-tools), so it is recorded as
ADR-0013 rather than left in issues.

### Path / Affected typed relationships

- `docs/adr/0013-streaming-segmented-responses.md` — new: the decision record.
- `AGENTS.md` — `l0_domains.decisions` now spans ADRs 0001–0013.
- `CONTEXT.md` — new "Segmented responses" cluster (per-response budget,
  segment, spill, resume token, version stamp).
- Implementation (constants retirement, resume params, spill store) is
  tracked by #207 against specs #209/#210 — not part of this entry.

---

## 2026-10-04 — 锚点模型修订与词汇重构：单一数据源、分配时机、跨会话边界 (#215)

**Type:** decision + contract documentation
**Confidence:** High
**Evidence:** wayfinder map [#214](https://github.com/hyperion2144/dsh-hashline-edittool/issues/214) 的对齐票 [#215](https://github.com/hyperion2144/dsh-hashline-edittool/issues/215)；维护者逐轮裁定（TTL 与有界淘汰保留、served 是锚点 set 且按会话隔离、分配时机在响应截断之后、Myers 只作用于 op 跨度、undo 快照深度 3 不跨会话）；代码核对确认锚点分配早已持久化（ADR-0006 的 #136 修正案），而 served 没有内存镜像，每次判定都要把整个集合从 sqlite 读出并反序列化；ADR-0010 活动库中 `snapshots` 0 行（死表）而 `anchor_meta` 106 行。

### Why
把「锚点从哪来」这件事收归一处。核对后发现要消掉的不是 served 这个概念，而是三条并存的路：取锚 API 有四个（`anchorsFor` / `allocateForLines` / `updateAnchorsAfterEdit` / `anchorsPure`）被 9 个工具模块各自调用，而没有哪一个能被称为唯一入口；可写判定每次 `edit` 都要把整个 served 集合读出并反序列化成 `Set<string>`（`loadServed`），没有内存镜像可依；而 ADR-0006 的 #136 修正案早已把**分配**持久化 —— 于是同一件事存在两个判定面，正是「刚读到的锚点被判没见过」那类故障的土壤。

两条裁定与既有 ADR 正面相撞，必须显式推翻而不是悄悄改实现：ADR-0010 的 Alternatives 写明「**Served as a row table** — rejected … it would need its own budget story」，而新设计采用行表（维护者裁决：集合语义由主键约束表达，成员资格必须可在库内按范围查询，否则每次 edit 仍要全量载入）；ADR-0011 的 Alternatives 写明「**Myers O(NP) banded DP as the main path** — rejected」。后者限缩适用范围即消解：Myers 只用于 op 跨度内（两侧输入都由该 op 界定），整文件 realign 仍归有界 DP，本 ADR 要保的内存上界不受影响。

另有三条新语义在此定型：分配时机在响应截断**之后**（只为真正返回给模型的行分配，不提前分配）；行号位移只是**重映射**、绝不重新哈希（未变行的锚点身份原样保留）；外部改动走 read 路径，只对**已分配锚点**的行做内容配对并重分配变化的行。

### Path / Affected typed relationships

- `docs/adr/0006-anchor-lifecycle-inheritance.md` — Amended：分配从两种情形扩为三种（首次服务 / 内容变化 / 外部改动），enforcement 载体由内存镜像改为持久化行族 + 按会话 served 集合，稳定性边界由「单个会话内」升为「同一工作区的所有会话」。
- `docs/adr/0009-sparse-lazy-anchors.md` — Amended：新增「分配只在真正返回的行上发生」条款（响应先按预算分段，见 ADR-0013）。
- `docs/adr/0010-bounded-anchor-storage.md` — Amended：**served 保持整集 blob，不做逐锚点行表**；行表经 2026-10-04 的实测（#217）被否决 —— 写入放大 ≈187×、行族占库 0.73%→10.5%、300k 行 = 73.2 MiB 超 64 MiB 上限，且它解决的是一个没人提的查询（校验的天然单位是整个集合）。预算、两层淘汰与 TTL 不变，无需放宽；Alternatives 的 row-table 条目标注为「已评估并第二次否决（这次基于实测）」。
- `docs/adr/0011-bounded-alignment.md` — Amended：澄清「main path」指整文件 realign，该拒绝成立；Myers 限定在 op 跨度内使用。
- `CONTEXT.md` — 词汇拆分与新增：Rendered 改为 Anchor entry point，Served 明确按会话隔离，新增 Allocation / Editability / Release pool / Remap / Echo。
- `CHANGELOG.md` — 契约变化（分配时机、跨会话稳定性与失效条件）随实施票落 `[Unreleased]`。
- `docs/agents/` — 无变化；实施与发布归 map [#214](https://github.com/hyperion2144/dsh-hashline-edittool/issues/214) 的 #224 / #226 / #227。

### 更正（2026-10-04，追加）

本条目 `### Why` 那一节里有一句**写错了、且已被实测与后续裁定推翻**：「而新设计采用行表（维护者裁决：集合语义由主键约束表达，成员资格必须可在库内按范围查询）」。
- **行表已被否决**：取证 #217 实测出写入放大 ≈187×（read 200 行从 1 行 / 274 B 变成 200 行 / ≈51 KiB）、行族占库 0.73%→10.5%、300k 行 = 73.2 MiB **超出 64 MiB 字节上限**；决定性理由是行表解决了一个**没人提的查询**（校验的天然单位就是整个集合）。最终裁定：**`served` 保持整集 blob**。以本条目上方的 Path 段（已正确写为「served 保持整集 blob，不做逐锚点行表」）与 ADR-0010 的 2026-10-04 修正案为准。
- 同时，本条目的 Path 段还漏了两块后来才定下的内容：**释放 = 三清**（含「只清发起释放的会话」）与**逐行三条判定 + 校验和不是拒绝条件**，以及**会话语义与四类 echo 原因**。完整定案见 [`docs/anchor-entry-contract.md`](../anchor-entry-contract.md)。

（按本文件的 append-only 约定，上面那句原文不改写；此更正条目生效。）

---

## 2026-10-04（实施期）— 契约 §6 更正：锚点不可解析走既有的 `[E_STALE]`

**Type:** accuracy correction
**Confidence:** High
**Evidence:** `src/hashline/anchor-pipeline.ts:321`（定位阶段抛出）、`README.md:144` 与 `README.md:282`（错误码表）、`test/core/anchor-drift-cross-session.test.ts`、`npm test`（123 文件 / 1396 例，exit 0）

### Why

实施 #223 / #224 时写「跨会话把某行替换掉、原会话拿旧锚点重提」的用例，实测拿到的是 `[E_STALE]`，而 [`docs/anchor-entry-contract.md`](../anchor-entry-contract.md) §6 写的是「失败**始终**是 `E_RANGE_UNVERIFIED`」。

追下去发现**代码与 README 一致，是契约那一节漏了一条路径**：锚点**根本无法解析**时，管线在**定位阶段**就拒绝了，而 served 集合的判定发生在之后的 `verifyServedRange` 里 —— 那条路径根本走不到。`README.md` 的错误码表本来就写着「`[E_STALE]` — anchor unknown」。

### Path / Affected typed relationships

- `docs/anchor-entry-contract.md` §6 — Amended：新增「实测补充」段，并把「失败始终是 `E_RANGE_UNVERIFIED`」限定为**本节范围内**。正确读法：`E_RANGE_UNVERIFIED` 覆盖「已解析但不在本会话 served 集合」；「锚点不可解析」归既有的 `E_STALE`。§2.4 的四类 `reason` 仍按原样分岔提示语，**不改动任何一个码**。
- 不涉及 `README.md`：它本来就是对的，改的是契约对它的复述。
- 不涉及错误码集合的增删 —— 本次重构的「错误码一字不改」承诺未破。

---

## 2026-10-05 — read 的行窗口：锚点游标与只剩一句的尾巴 (#245)

**Type:** decision + contract documentation
**Confidence:** High
**Evidence:** 地图 [#234](https://github.com/hyperion2144/dsh-hashline-edittool/issues/234) 的契约票 [#238](https://github.com/hyperion2144/dsh-hashline-edittool/issues/238) / 形态票 [#239](https://github.com/hyperion2144/dsh-hashline-edittool/issues/239) / 实施票 [#245](https://github.com/hyperion2144/dsh-hashline-edittool/issues/245) 的逐轮裁定；新模块 `src/domain/session/read-window.ts`；单一拼装点 `assembleServedRead`（`src/tools/tool-read.ts`）；`test/core/read-window.test.ts`（13 例）；`npm test`（129 文件 / 1421 例）与根 typecheck 均绿。

### Why
行号开关（#244）关掉之后 grep 只回裸锚点，而 `offset`/`limit` 只认数字：模型能说“再来十二行”，说不出“从这个锚点到那一行”。尾部同时有三个拼装点（渲染器 footer、`formatPaginationHint`、字符截断后重加提示的正则），text / JSON / web 卡片三通道可以各说一个窗口；`resume` 与 `offset`/`limit` 同时出现还会被静默偏向 `resume`（被忽略的参数看上去像是生效了）。

### Path / Affected typed relationships

- `docs/adr/0014-read-window-cursor-and-summary.md` — new：游标语义（闭区间、两种字段各收数字或锚点、倒置区间是唯一新增硬拒绝）、一句话尾部的四条形态与三通道同源、失败码按 `edit` 口径、空文件是真实服务。
- `docs/adr/0013-streaming-segmented-responses.md` — 文首加一行 See also 指针（分段与行窗口是两条轴，`resume` 与游标互斥）；本 ADR 关于 token / spill / 预算的结论一字未改。
- `CONTEXT.md` — 新增 “Read windows” 簇：**Window**（`window: {start, end, totalLines}`，`start`/`end` 恒为文件行号）与 **Anchor cursor**。
- `README.md` / `README.zh.md` — 错误码表补 `[E_RESUME_CONFLICT]`，并把三个**既有** `E_RESUME_*` 码一并登记：它们原先在 `src/infra/response-stream.ts` 由字符串插值生成，互锁测试（`test/core/error-codes.test.ts`）正则扫不到，于是从未进表；本轮改为 `RESUME_CODE_TAG` 字面量表，插值输出逐字不变。
- `CHANGELOG.md` — `[Unreleased] ### Changed` 一条中文条目。
- `AGENTS.md` — `l0_domains.decisions` 由 0001–0013 扩为 0001–0014。

### 本轮定案（复核时照此）

- 闭区间：`offset` 的锚点行**包含**在窗口内；`limit` 给锚点是“末行”而不是计数，给数字仍是计数；数字与锚点可混用。
- 失败码按 `edit` 口径：锚点已死（不在 `anchor_lines`）→ `[E_STALE]`；served 类异常（没服务过 / 行移动 / 内容变化，四因一码）→ `[E_RANGE_UNVERIFIED]`；`[E_RANGE_STALE]` 仍只留给校验和与版本守卫（它是重映射/版本断言，不是 served 判定）。
- 空文件是**真实服务**：`window {1, 1, 1}`、`lines` 保留 synthetic 空行、末行仍是空文件提示（提示单点在 `EMPTY_FILE_NOTE`）；越界才是「一行也没服务」，不产出 `window`。
- 尾巴只归宿主：模型侧 text 与 JSON 的 `window`、web 卡片的 `presentationMeta.window` 同源；渲染器不再自带 footer。其他尾巴（write 预览 / grep / edit 拒绝回声）归 #246。
- 事实备注（写给下一个改这块的人）：行文本有两种形状 —— `buildReadPresentation` 拼 `anchor:n:content`（无空格），渲染器 `fmtHashlineRow` 拼 `anchor:n: content`（有空格）。默认读路径一直用前者，只有稀疏（超大行提示）与 JSON 走渲染器的 `result.text`；本轮一度改成一律用渲染器文本，42 条解析型断言随即变红（`one.hash` 为 undefined），遂原样回退。
- 事实备注（与 #215 条目同题）：`[E_STALE]` 在 read 游标路径上仍走**定位阶段**那条既有路径（锚点不可解析 / 不在本文件），与 2026-10-04 的更正条目一致；`[E_RANGE_UNVERIFIED]` 继续覆盖「已解析但 served 判定不过」。

### 未做（留给后续票）

- write 的自动预览 / grep / `ast_edit` 的尾部仍是各自形态 → #246。
- 遗留文件通道清理（`settings.yaml` 直读、`parseSettingsYaml`、`dev-diag`、README 旧措辞）→ #237。
