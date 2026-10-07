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
- ~~遗留文件通道清理（`settings.yaml` 直读、`parseSettingsYaml`、`dev-diag`、README 旧措辞）~~ → **已完成**（#237，2026-10-05；见本文档末尾条目）。

---

## 2026-10-05 — 多文件部分失败的卡片可见性：并列的 `failures` 通道 (#247)

**Type:** decision + contract documentation
**Confidence:** High
**Evidence:** 地图 [#234](https://github.com/hyperion2144/dsh-hashline-edittool/issues/234) 的通道票 [#240](https://github.com/hyperion2144/dsh-hashline-edittool/issues/240) / 形态原型 [#241](https://github.com/hyperion2144/dsh-hashline-edittool/issues/241) / 实施规格 [#247](https://github.com/hyperion2144/dsh-hashline-edittool/issues/247) 的逐轮裁定；新测试 `test/core/partial-failure-meta.test.ts`（6 例）与 `client/test/models.test.ts` 的「partial failure (#247)」段（6 例）；`npm test`（129 文件 / 1427 例）、`npm test -w client`（6 文件 / 158 例）与两侧 typecheck 均绿。

### Why
`edit` 的多文件批是每文件一笔事务（ADR-0003），一个文件落盘、另一个被拒时**整条调用是成功的**：canonical value 里 `success[]` 与 `fail[]` 并列明说了，但 web 行只拿 `presentationMeta`，而它只投射成功侧 —— 卡片选择先看 `errorBody`（来自 `meta.error`，按设计只在**整条调用零变更**时出现），行状态又是 `ok`，于是失败文件连路径都看不到。模型侧在同一时刻却什么都看得到。

排查中还发现两处**从未被报告**的陷阱：`presentationMeta` 的空 diff 兜底分支不带 `diffRowGroups`（唯一成功文件是整文件 no-op 时，失败与成功会一起消失）；per-file 失败码取自消息里**最后一个** `[E_*]` 字面量，而拒绝会原样带回 ±3 回声，被回显的源码行自带码字面量时会把卡片显示的码劫持掉（本仓库测试夹具里就有这种行）。

### Path / Affected typed relationships

- `docs/adr/0015-partial-failure-visibility.md` — new：`failures` 与 `error` 互斥且穷尽、per-file 码取头部字面量、回声留在 `context`、卡片形态（失败 tab + 单条 alert 横幅 + 行仍算成功）、零行分组合法。
- `src/infra/error-result.ts` — 导出 `FileFailureMeta`（`code?` 可选）与 `splitErrorText`，两个通道共用一个切分；`src/tools/tool-edit.ts` — `presentationMeta` 的 `failures` 投射与头部码规则。
- `client/src/client/models.ts`、`types.ts`、`diff-block.tsx`、`tool-row.tsx`、`error-card.tsx`、`tab-strip.tsx` — 两通道窄化、零行分组、失败 tab / 横幅 / 行摘要。
- `CONTEXT.md` — `meta.error` 词条改为「零变更」通道，并新增「Partial failure」；`AGENTS.md` — `l0_domains.decisions` 扩到 0001–0015。
- `CHANGELOG.md` — `[Unreleased] ### Changed` 中文条目。

### 本轮定案（复核时照此）

- 判据：`error` = 这次调用零变更；`failures` = 至少一个文件成功时的失败清单。空表不出现键（无损 JSON，禁 `{failures: undefined}`），顺序 = 输入顺序，不新增 counts。
- 失败项形状 = `ErrorMeta` + 必填 `path`，`code` 可选（取自内层失败的**头部**字面量、去方括号）。`fail[]` 仍按 ADR-0004 保留方括号 —— 两者同码不同形，测试同时钉住两边。
- 卡片：失败与成功同列 tab、横幅独占 `role="alert"`、行状态仍成功；计数文案由客户端从两个数组长度推导（不是宿主发的字段）。
- 事实备注（写给下一个改这块的人）：`edit` 的 `presentationMeta` 只能从 canonical value 的 `v.success`/`v.fail` 出发投射，`failures` 因而与成功侧**同一个分支**计算；把它嵌回「有 diff 才投射」的老分支，no-op 场景会再次静默丢失败。

---

## 2026-10-05 — 设置文件通道整体删除：插件不再自己读写设置文件 (#237)

**Type:** refactor + documentation
**Confidence:** High
**Evidence:** 地图 [#234](https://github.com/hyperion2144/dsh-hashline-edittool/issues/234) 的 A2 研究 [#236](https://github.com/hyperion2144/dsh-hashline-edittool/issues/236)（运行时自己导入 + 服务面没有私下通道）、A3 处置票 [#237](https://github.com/hyperion2144/dsh-hashline-edittool/issues/237)；`npm run typecheck` 与 `npm test`、`npm run typecheck -w client` 与 `npm test -w client` 全绿。

### Why
设置只剩一条路：profile 的插件配置（`Config` + `apply(ctx, config)` 活引用 + `settings/document-updated`）。旧模块的前提在 0.2.1 已不成立 —— `settings.yaml` 的 `hashline:` 节由运行时自己导入，而设置服务面（`describe/update/replace/mutate/configure/prepareDocument/writable/documentPath`）没有任何 API 能把遗留文档交给插件（`importLegacyDocument` 私有）；留着它只会与运行时并发写同一份配置，并且是全仓唯一一处「插件自己读写用户设置文件」——那正是用户硬约束禁止的事。

### Path / Affected typed relationships
- 删除整个模块：`src/infra/legacy-migration.ts`、`src/index.ts` 的 import 与 fire-and-forget 调用、`test/core/legacy-migration.test.ts`。
- `src/config.ts`：`settingsYamlPath()`（连同只被它用的 `node:os` / `node:path` import）与手写 `parseSettingsYaml()`（约 145 行）删除；文件头与 `HASHLINE_ENTRY_ID`、store-budget 注释里「直读 settings.yaml / 手写文件」的措辞改写为「条目配置」。
- `scripts/dev-diag.mjs`：自读 settings.yaml 打印原始段的那一段、以及第 4 段里 require `parseSettingsYaml` 的三行删除，改为 `applyEffective(undefined)`；`scripts/dev-verify.mjs` 整文件重写为 Config 缝的冒烟脚本（双挂载 + 有效快照断言），不再读文件，也不再要求 `ctx.get("settings")`（Config 缝下它必然 absent，原脚本因此必然 exit 1）。
- 测试：`ast-settings.test.ts` 的解析型用例改为 schema + `applyEffective` + `lspConfiguredServers()`（保留「嵌套而非平铺」「空命令被丢」「两棵子树共存」三个真行为）；`auto-diag.test.ts` 的 `lsp.auto_diagnostics` 用例同理。
- 文档：`README.md` / `README.zh.md` 的迁移段改写为「导入由 dsh 自己做、插件不再碰任何设置文件」；`client/src/client/settings-card.tsx` 的「已覆盖」提示不再点名文件（`settings.yaml` → 配置）。

### 本轮定案（复核时照此）
- `cordis.patch.yml` 的说法**不是**过时措辞：本机 `~/.dsh/profiles/{desktop,web}/cordis.patch.yml` 实测仍在 → README 只改迁移段，路径句保留（票面把它当「过时措辞」是证据不足）。
- 事实备注（工具教训）：在运行时目录里 grep `cordis\.patch` 得到 no matches **不能**当作「文件不存在」的证据 —— grep 工具跳过 `node_modules`；要查磁盘就 glob。
- `hash_length` 的 schema 容忍（legacy 键）属于 schema 形状，不在本票范围；`src/infra/paths.ts` 的 `legacyHashStorePath()` 是哈希库路径，不是设置文件。

## 2026-10-05 — 模型侧编辑文案改成逐文件口径 (#242)

**Topic:** `edit` 的 prompt / description / guidance / 错误文案不再宣称「整批原子、整批拒绝」，改为 ADR-0003 语义：单个文件内一个原子批次、文件之间互不牵连、部分成功逐文件上报。

**Confidence:** High

**Evidence:** 地图 [#234](https://github.com/hyperion2144/dsh-hashline-edittool/issues/234) 的 C3 票 [#242](https://github.com/hyperion2144/dsh-hashline-edittool/issues/242)；`npm run typecheck` 与 `npm test`（130 文件 = 129 passed + 1 skipped / 1421 例 = 1420 passed + 1 skipped）、`npm run typecheck -w client` 与 `npm test -w client`（6 文件 / 158 例）全绿；新增 `test/core/issue-242-atomicity-wording.test.ts`（7 例）。

### Why
引擎自 0.4.0 起就是**按文件**分组、文件内 all-or-nothing、多文件部分成功（ADR-0003 / ADR-0004），但模型侧文案从那时起一直写着「The batch is ATOMIC — any hunk failure rejects the WHOLE batch … and nothing is written」。多文件调用里一处失败时，模型据此以为整次调用什么都没发生（实际别的文件已落盘），于是既不会重试失败文件、也不会核对落盘结果 —— 这正是用户第③件事在模型侧的同源缺陷。

### Path / Affected typed relationships
- `src/domain/edit/prompts.ts`：`editDescription` 两态开头（`:34`/`:35`）与 `editGuidance` 两态原子性 bullet（`:60`/`:79`）改逐文件口径（`:79` 另补「已落盘的保留自己的 undo 槽」）；`:56` 申报不匹配句与 `:72` 的 `Classification: noop` 句同批收窄。
- `src/contract/contract.ts` 的 `edits` 参数 description 同口径，并写明「单文件内按序演进，但每个锚点对照同一次 read 的原始快照」。
- `src/domain/edit/edit-engine.ts` 与 `src/hashline/anchor-pipeline.ts` 的两条 `[E_ANCHOR_AMBIGUOUS]` 抛出文案：`nothing was written.` → `nothing was written for that file.`（该守卫在一个文件的解锚阶段抛，多文件调用里别的文件可能已落盘）。
- README.md / README.zh.md 的同款 bullet、`[E_BATCH_ABORT]` 与 `[E_ANCHOR_AMBIGUOUS]` 错误码行；`CONTEXT.md` 的申报门词条同句。

### 本轮定案（复核时照此）
- 引擎 `[E_BATCH_ABORT]` 的尾巴逐字保留：作用域就是一个文件的批次，单文件调用里字字为真；多文件响应由 ADR-0004 剥掉它（`src/tools/tool-edit.ts` 的 `/\nThe whole batch was rejected[\s\S]*$/`），三条测试已锁。改它要同时动剥壳正则与三条测试，收益为零。
- 票面 ③ 的「ADR-0005」是误标 —— ADR-0005 是 grep 卡片 ADR；对齐基准 = ADR-0003（per-file atomicity）+ ADR-0004（多文件响应形状）。
- `docs/edit-payload-spec.md:86` 等历史 spec 里的旧 description 引文就地不改（记录的是各自时代的原文），只改现行模型侧文案。
- `README.md:298` 的 `[E_ANCHOR_STATE_DUP]` 行也写着「Nothing was written.」但该码今天只走 `console.error` + 状态修复（`src/domain/session/anchor-state.ts:142-146`），未核实为模型可见的拒绝 → 未改，留待需要时单独核。
- 工具教训：`sed` 的锚点必须逐字复制（大小写敏感）—— 我误把 `SX:56` 写成 `sc:56`（正好是上一行的锚），工具按锚解析到第 55 行、模式不匹配而**静默 noop**，唯一信号是 `[E_LINE_HINT] line hint 56 does not match anchor sc (resolved to line 55)`。

## 2026-10-05 — 续读/分页文案收口成一句话 (#246)

**Topic:** 五个通道各自拼「还有更多」的句子（共享 spill 助手、grep 两处、read 的 `[Continued report]` 页脚、`write` 的自动读预览、`hashline/` 里一个死掉的 `paginationHint`）收成两个生成器：括号版通知 `formatOmittedNotice` 与 read 的窗口句 `formatWindowSummary`。

**Confidence:** High

**Evidence:** 地图 [#234](https://github.com/hyperion2144/dsh-hashline-edittool/issues/234) 的票 [#246](https://github.com/hyperion2144/dsh-hashline-edittool/issues/246)；`npm run typecheck` 与 `npm test`（131 文件 = 130 passed + 1 skipped / 1429 例 = 1428 passed + 1 skipped）全绿；新增 `test/core/issue-246-tail-copy.test.ts`（8 例：生成器字面量两态、与 spill 助手逐字相等、grep 真实溢出 + token 续读、read 报告段页脚、write 预览 text/JSON 两态、两句 guidance 引文）。

### Why
B 线（#245）只统一了 `read` 自己的窗口尾巴，同一句 `(Omitted …)` 仍有四处手写副本，且 `write` 的预览是「第四种」拼法 —— 它明明是文件窗口却发括号版通知。更糟的是 preview 的 JSON 模式把通知**粘在 JSON 字符串后面**，而 diagnostics 合并会对该文本再 `JSON.parse`，构成一条真实崩溃路径（JSON 模式 + 有 diagnostics + 预览被截断）。

### Path / Affected typed relationships
- `src/infra/response-stream.ts`：新增导出的 `formatOmittedNotice({omittedLines, omittedChars?, consumer, token})`；`spillModelTextOverflow` 的尾巴改为调用它（输出字节不变）。
- `src/tools/tool-grep.ts`：两处 spill 分支（`overflow` 与 `spillRows`）共用生成器（字节不变）。
- `src/tools/tool-read.ts`：`[Continued report]` 页脚走生成器（`more lines` → `lines`，唯一可见字节变化）。
- `src/tools/tool-write-shadow.ts`：预览先铸 token、算 `previewWindow`/`continuation`，text 模式收尾用 `formatWindowSummary`，JSON 模式把 `window`/`continuation` 放进 payload；删掉一条裸表达式死代码（原先每次 write 在 JSON 模式下会多跑一遍 `buildReadJson`）。
- `src/hashline/anchor-pipeline.ts`：删掉无人调用的 `paginationHint`（纯域层，不得反向依赖 `domain/session/`）。
- `src/domain/edit/prompts.ts`：read guidance 的引文改成现行窗口句、grep guidance 补 `(~C chars)`。
- 文档：`CONTEXT.md` 新增「Continuation notice」「Window sentence」词条；ADR-0013 / ADR-0014 各加一条 Amendment；`CHANGELOG.md` `[Unreleased]`。

### 本轮定案（复核时照此）
- 收口只做**同一个语义**：括号版通知归 `formatOmittedNotice`；read 的窗口句仍归 `formatWindowSummary`（窗口有 `start/end/totalLines`，通知没有）。`write` 预览按窗口句处理，因为它的处境与 read 的预算截断完全相同（同一个 `file-window` 令牌）。
- grep 只发括号版（无窗口数字可报）；read 的报告段页脚不知道字节数，故省略 `(~C chars)`；edit 的拒绝回声今天本来就没有分页句（生成器是死的，直接删）。
- `buildReadJson(...)` 返回的是 **`object`**（不是字符串），要放进 JSON payload 直接 `...buildReadJson(content, hashes, offset, limit, path, undefined, window)` 展开 —— 我第一版写成 `JSON.parse(buildReadJson(...))`，被 LSP 拦下。
- 测试教训：`takeTextContinuation(sessionKey, token, consumer, count)` 的第 4 个参数是**行数**（read 传 `RESUME_WINDOW_LINES = 4000`），不是字符数 —— 夹具要造 >4000 行才会得到 `done === false` 的部分段。
- 诚实缺口（另票）：read 的 report-segment 续读在 JSON 模式下仍返回散文（`totalLines:0` / `lines:[]` 占位），本票只记账不修，避免扩散。
