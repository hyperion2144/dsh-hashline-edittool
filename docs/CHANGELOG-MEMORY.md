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

## 2026-10-09 — grep 预过滤的 argv 按命令行长度分块 (#260)

**Topic:** ripgrep 预过滤的分块策略从「按文件数（`CHUNK = 400`）」改为「按命令行长度」；新增 `src/infra/argv-limit.ts`（`COMMAND_LINE_LIMIT` / `ARGV_BUDGET` / `planArgvChunks`）；`rgFilesWithMatches` 里 spawn 的同步抛出不再逃逸成 rejection。

**Confidence:** High

**Evidence:** 票 [#260](https://github.com/hyperion2144/dsh-hashline-edittool/issues/260)；本机 Node 探针（1.2 MB / 2.5 MB argv → `execFile` **同步**抛 `spawn E2BIG`，不走回调）与「修复前 `run()` 形状」探针（真实 2.5 MB argv → `REJECTED: spawn E2BIG`）；mock 内核的 `test/core/grep-rg-argv-limit.test.ts` 在修复前 4 红 1 绿（红 = `promise rejected "Error: spawn ENAMETOOLONG"`）；`npm run typecheck` 与 `npm test`（133 文件 passed + 1 skipped / 1457 例）与 client workspace（158 例）全绿；真实 rg 对不存在路径退出 2（ripgrep 15.0.0 实测）。

### Why

票面根因（按数量分块 → 撞 Windows 32,767 命令行上限）成立，但**失败路径比票面写得更硬**：票面把同步抛出归为「某些 Node 版本行为」的假设，实测是当前 Node 的确定行为，而 `new Promise` 执行器内的同步抛出会把 Promise 变成 reject，于是模块文档承诺的 undefined 回退从未运行 —— 这才是用户看到工具错误的直接原因。

### Path / Affected typed relationships

- 新增 `src/infra/argv-limit.ts`（tools/ → infra/ 单向依赖）：`argCost = 长度 + 4`；`planArgvChunks(fixed, items, budget)`（`fixed` 先占预算；任一条目若与 `fixed` 无法共处预算即整体返回 undefined；`fixed` 独自超预算亦返回 undefined）；`QUOTING_HEADROOM = 2_767` 与 `ARGV_BUDGET = COMMAND_LINE_LIMIT − QUOTING_HEADROOM = 30,000`。
- `src/tools/grep-rg.ts`：`CHUNK = 400` 与 `files.slice` 循环删除，改 `fixedArgs` + `planArgvChunks([rg, ...fixedArgs], files, ARGV_BUDGET)`；`run()` 的 `execFile` 包 `try/catch` → `resolve(undefined)`；模块头与函数 doc 同步写明「同步拒绝也是失败」。
- 测试：`test/core/grep-rg-argv-limit.test.ts`（新，10 例 = 5 例 mock 内核端到端 + 5 例预算算术本体：合批 / 按长度切分 / `fixed` 独占超预算弃权 / 单条超预算弃权 / 跨块保序不丢不空）与 `test/core/grep-rg-prefilter.test.ts` 新增一例真实 argv（400 × ~6.3K ≈ 2.5 MB）。
- 文档：ADR-0016、`AGENTS.md` 的 `l0_domains.decisions` 行、README / README.zh 的 rg 回退句、`CHANGELOG.md` `[Unreleased]`。

### 本轮定案（复核时照此）

- **单一预算，不做平台分支**：POSIX `ARG_MAX` 是 1–2 MiB，平台分支能少几次 spawn，但要维护两个数；30,000 一次仍装下数百条普通路径，故选一个处处成立的规则。
- mock 是**内核替身**（在 32,767 处同步抛 `spawn ENAMETOOLONG`），不是业务替身：断言量的是模块真实组装的 argv；替身 `+3/参数` 的保守计价故意比生产的 `+4` 更宽松。
- 真实 argv 用例的断言依赖 rg 对不存在路径退 2，因而写 `undefined` 而非 `[]`（实测过，不是推断）。
- **AC 字面化（评审后改）**：首版让「单条超预算独占一块、自己去撞 spawn」；Spec 轴评审指出这仍会组装出一条超过 32,767 的命令行，与验收标准 (a)「绝不产生超限命令行」不符。改为**整体弃权**（`planArgvChunks` 返回 undefined）：结果与旧写法一致（该块必失败 → 同样 undefined），但少一次注定被拒的系统调用，标准字面成立，且测试能钉住「零 spawn」（`expect(harness.invocations).toHaveLength(0)`）。
- 诚实缺口（另票候选，本次未改）：`rgFiles` 的 `execFile` 同样会同步抛出（argv 固定且短，票面列为 out of scope）；LSP 安装 path 的 spawn 同理。

## 2026-10-10 — ADR-0017 记账：后端的二进制拒绝属于「读」，不属于「搜」 (#268)

`grep` 逐文件走 `FileIO.readText`，dsh 后端对判为二进制的文件抛 `FS_NOT_TEXT`（→ `[E_NOT_TEXT]`），读循环 catch 后 `continue` —— 「搜过没命中」与「根本没搜」在输出上无法区分：含一个 `\0` 字节的日志恒答 No matches，而 `rg -a` 找得到。维护者在票内拍板方案 A：容忍读加在 IO 缝上，而不是让 grep 绕过 `ctx.fs` 直读本地磁盘（方案 B 被否）。

### Why

拒绝本身是对的，错的是它的**作用域**：`readText` 服务的是「按行铸锚点、可被 edit 复写」的读（read / edit / ast_grep / lsp / undo），这个契约必须继续拒绝二进制内容；而 grep 只问「这行文本在不在这里」，它需要的是 `rg -a` 那种读。两者混用同一个读方法，等于让读契约替搜契约做决定。

### Path / Affected typed relationships

- `FileIO.readTextTolerant(absolutePath, signal?)`（`src/infra/fs-bridge.ts`）返回 `TolerantRead = { text, binary }`：先 `readText`（纯文本的调用序列逐字不变）；**仅** `FS_NOT_TEXT` 时回退后端的 `fs.readBytes`（不解码、不拒绝的字节缝）+ 有损 UTF-8 解码（非法字节 → `U+FFFD`）；其余错误码原样经 `mapFsError`；上限 `TOLERANT_READ_MAX_BYTES = MAX_BYTES`（`src/infra/constants.ts`）。`binary` 这个标记是**调用方必须知道的事实**，不是装饰：它决定 grep 是否铸锚点。
- `src/tools/tool-grep.ts` 两处读点（扫描循环与 `{resume}` 续读）都改走 `readTextTolerant`；**被判为非文本的文件不 served** —— 行渲染成 `[line N] content`（本仓「拿不到锚点」的既有形态）。含 NUL 的文件因此**可搜不可编辑**，且这一点在输出里可见。
- `readText` 语义一字未动 → `read` / `edit` / `ast_grep` / `lsp` / `undo` 继续拒绝。
- 文档：ADR-0017、本文件、`AGENTS.md` 的 `l0_domains.decisions` 行、README / README.zh 的 grep 行、`CHANGELOG.md` `[Unreleased]`。

### 本轮定案（复核时照此）

- 容忍读**只**对 `FS_NOT_TEXT` 生效；不做「任何读失败都重试」。abort、缺失、目录、沙箱拒绝原样冒给调用方。
- 用后端的 `readBytes`，**不** import `node:fs/promises`：远程/沙箱后端的字节不在这台机器上（方案 B 被否的同一理由）。
- 解码刻意有损（`U+FFFD`），**不猜编码**：猜错会静默改写一个部署里的文本。代价记在 ADR-0017 里 —— UTF-16 文件里的 ASCII 文本仍然匹配不上，与 `rg -a` 一致。
- 「可搜不可编辑」的边界由**知道答案的那一层**报告（`binary` 标记），而不是由工具嗅探 NUL 推断：本地后端从不拒绝，含 NUL 的文件在那种部署里**可以**编辑，嗅探会把能编辑的文件误标成不可编辑。
- ripgrep 预过滤不需要 `-a`，但前提是它**按显式路径**列候选：实测 `rg --files-with-matches` 对显式路径会报告「NUL 在第 0 字节、命中在 ~10 MB 处」的文件（命中在 NUL **之前**的同样报告），而把同一棵树按目录搜则一个都不报。`grep-rg.ts` 未改，目录形态的端到端行为由测试钉住。

## 2026-10-13 — mapFsError 补 FS_TOO_LARGE 分支 (#271)

`mapFsError` 的错误码白名单漏了 `FS_TOO_LARGE`（dsh-fs 契约里 `readBytes` 超过 `maxBytes` 时抛的正式码，`node_modules/@deepseek-ai/dsh-fs/lib/types/index.d.ts:175-177`）。#268 的容忍读把它从理论边缘变成**热路径**：超上限文件走 `readBytes` 回退必抛此码，穿透白名单后以裸错误（`message: "FS_TOO_LARGE"`，无 `[E_*]` 前缀、无路径、无下一步指引）冒给调用方。现在映射为 `[E_TOO_LARGE] File exceeds the read limit: <path> …`，README 错误码表双语收录（按字母序插在 `E_SYNTAX_AFTER_EDIT` 与 `E_UNDO_STALE` 之间）。

### Why

ADR-0007 的口径是「模型只见结构化错误码」：每个后端拒绝都该有可文档化、可被 `extractFailure` 泛化解析的领域码；白名单漏一个码，那个拒绝就退回裸错误形态。

### Path / Affected typed relationships

- `src/infra/fs-bridge.ts` `mapFsError`：`FS_ABORTED` 分支后加一个分支，`FS_TOO_LARGE` → `[E_TOO_LARGE]`。守卫（`error instanceof Error && typeof code === "string"`）之外的行为不变 —— 非 Error 或无字符串码的抛物仍原样冒；Windows `ReplaceFileW` 正则在守卫外，对本码不可达。
- 消息给**可执行**的下一步（换更小的目标文件 / 外部切分内容），刻意不写「narrower pattern」：上限是单文件字节预算（本插件传入的 `TOLERANT_READ_MAX_BYTES`），与搜索 pattern 无关；同一条消息也会出现在 read 路径上，那里没有 pattern 概念。
- 文档：README / README.zh 错误码表、`CHANGELOG.md` `[Unreleased]`、本文件。

### 本轮定案（复核时照此）

- 用户可见行为不变：grep 容忍读遇超上限文件仍只静默跳过该文件、其余照答（`test/core/issue-271-too-large-mapping.test.ts` 端到端钉住，含「readBytes 回退确实发生过」的调用序列断言）；本票补的是映射完备性，不是行为变更。
- 码名 `[E_TOO_LARGE]` 与 AST 族 `[E_AST_TOO_LARGE]` 正交（AST 族统一 `E_AST_*` 前缀、单独一行），不改名；v1 已删的 `E_FILE_TOO_LARGE` 只残留在旧测试注释里，不复活。
- `error-codes.test.ts` 双向契约自动覆盖新码；该测试只读 README.md，README.zh 靠人工同步（既有设计）。

## 2026-10-14 — ADR-0018 记账：拒绝不是一种东西——按保真度分类容忍读 (#273)

#273 报告 read/edit 拒绝「只含一个 NUL 字节的合法 UTF-8 文件」（`[E_NOT_TEXT]`），而本地后端同文件可读可改。维护者裁定：嗅探过于简陋粗暴（「含 null 也可能是文本文件」），政策是「能读就能写」——但**写缝是 string-only**，无法保留非法 UTF-8 字节，所以两类被拒文件必须分开对待，`binary` 布尔做不到。

### Why

ADR-0017 让所有被拒文件的行都不 served，理由当时成立：`edit` 走严格 `readText`，锚点会许诺一个必然被拒的编辑。但这个理由只对**有损**那一半成立。拒绝的**原因**才是契约：字节合法（NUL 触发嗅探）→ 文本即文件，能读就该能写；字节非法 → 文本只是 `U+FFFD` 解释，string 写回必失真。

### Path / Affected typed relationships

- `src/infra/fs-bridge.ts`：`TolerantRead` 改 `{ text, fidelity: "native" | "lossless" | "lossy" }`；内部 `readTextAllowingBinary` 回退后按往返等式分类（`Buffer.from(text,"utf-8")` 等于原始字节 → `lossless`，否则 `lossy`），绝不从「被拒」推断；`localIO` 字节精确时记 `native`。
- `src/domain/session/file-view.ts`：`readView` 改容忍读；lossy 走 `renderUnserved()`（`[line N] content`，不铸锚）+ 不可编辑注记；`fmtReadPreview` 加 `serve` 选项。
- `src/domain/edit/mutation.ts` / `edit-engine.ts`：容忍读 + lossy 抛 **`[E_LOSSY_BYTES]`**（文件不动）；`src/read-and-serve.ts` lossy 提示 `LOSSY_BYTES_NOTE`。
- `src/tools/tool-grep.ts` 两读点：lossless → served（#268 升级），lossy → 不 served 不变；`tool-undo.ts` / `tool-write-shadow.ts` 预读改容忍读。
- `lsp`/`ast_*` 保持严格 `readText`（明确 out-of-scope）；上游 dsh-fs 的嗅探不动。
- 文档：ADR-0018（新）、ADR-0017 状态行承接标注、README 双语工具表三行 + 错误码行、`CHANGELOG.md` `[Unreleased]`、本文件、`AGENTS.md` decisions 行。

### 本轮定案（复核时照此）

- 分类是**字节**的属性：lossless 由往返等式**证明**，不是「后端说它拒绝所以有 NUL」。
- 「能读就能写」在字节允许处精确成立：lossless 可编辑且写回字节一致（集成测试钉住）；lossy 拒绝必须**有名字**（`[E_LOSSY_BYTES]` 进 README 错误码表），不再藏在「不是文本文件」里。
- 保留非 UTF-8 字节的编辑需要 bytes-mode 写缝（后端契约变更），明确不做。
- 超 `TOLERANT_READ_MAX_BYTES` 走 `[E_TOO_LARGE]`（#271），不误分类。

---

## 2026-10-16 — 真机验证修正：#273 的 lossy 视图可读却不可写（观测被 served 条件挡住）

**Type:** bug fix（#273 收尾修复）
**Confidence:** High
**Evidence:** 会话重启后（运行时 0.2.1-alpha.4）在主检出 17c97d1 的真机十项矩阵 —— read/edit/grep/undo/write 与 `[E_TOO_LARGE]` 九项通过，`write` 对 lossy 文件被 `[E_NOT_OBSERVED]` 拒绝；根因在 `src/read-and-serve.ts` 与 `src/tools/tool-grep.ts` 把 `emitObserved` 嵌在 served 条件内。`test/core/observation-on-serve.test.ts` +2 例（变异：把条件改回旧形态 → 恰好 2 例红，其余 3 例绿）；根 1514 passed（1 例环境性红：`test/core/hash-store.test.ts` 的 WAL 截断用例，主检出同样红）、client 161 passed。

### Why

- 「不 served」是「没有锚点可用」，不是「模型没看过」。观测（`fs/observed`）服务的是后写策略，`write` 只需要「看过」，`edit` 才需要锚点 —— 把两者绑在一个条件上，lossy 文件就成了「可读但不可写」，而拒绝信息开出的补救（先 `read`）对 lossy 永不成立：死胡同。
- 连带发现一：`write` 值的 `beforeLossy` 未在输出 schema 声明，宿主按 `additionalProperties: false` 会拒收整个返回值（与第二轮 PR 评论的 read schema 事故同类）。已补声明，并用 `schemaViolations(outputSchemaOf(tool), result)` 钉住。
- 连带发现二（预存在）：`grep` 的 `{resume}` 续读分支自 93e8974 起只 served 不观测 —— 续读命中可编辑却不可写；本轮在同一处补上。

### Path / Affected typed relationships

- `src/read-and-serve.ts`：观测闸门改为 `if (view.served.length > 0 || view.lossy)`。
- `src/tools/tool-grep.ts`：扫描分支 `(servedRows.length > 0 || lossy)`；续读分支补 `emitObserved`（`!changed` 时）。
- `src/tools/tool-write-shadow.ts`：输出 schema 增 `beforeLossy: { type: "boolean" }`。
- 文档：ADR-0018 增「展示即观测」条目、README 双语 read 行、`CHANGELOG.md` #273 条目补记。

### 本轮定案（复核时照此）

- 观测是**无条件**的：只要渲染出了内容（served / unserved / lossy）就观测；`edit` 的拒绝由 `[E_LOSSY_BYTES]` 在锚点解析前决定，不靠观测挡。
- 环境备注（本会话新运行时）：`node` 现为 bun 的 node-shim 1.4.0；worktree 的 `node_modules` 必须是逐包软链的**真实目录**（整目录软链会让 vite 的 `.vite-temp` 落回主检出，报 `Cannot find module … .vite-temp/…mjs`）；`test/core/hash-store.test.ts` 的 WAL 截断用例在该运行时下红、原生 Node 下绿。

---

## 2026-10-16 — CHANGELOG 条目收紧到「一句话说清变更」（维护者要求）

**Type:** convention（写作约定）
**Confidence:** High
**Evidence:** 维护者原话：「为什么changelog总是写那么详细，搞得relsease里一堆废话，一个点稍微描述下是啥就行了呀」——v0.10.2 的 Release 正文由 `.github/workflows/release.yml` 用 awk 从 `## [0.10.2]` 段整段提取（`--notes-file`），逐条千字把 Release 淹没。全局 `~/.dsh/AGENTS.md` 执行规则 1 同步写入该约定。

### Why

- CHANGELOG 段是 Release 正文的**唯一来源**：写进去的每个字都会原样出现在 Release 里；根因、测试清单、变异实验、文件路径、CI 数字属于 ADR / PR 正文 / 票面 / 本文件。
- 一条 = 一行说清「改了什么 + 票号」；要「为什么」就链到 ADR。

### 本轮定案（复核时照此）

- CHANGELOG 每条 1–2 句：变更是什么、影响谁、票号；有 ADR 才带链接。
- 细节归位：决策 → `docs/adr/`；排查与证据 → 票面进度/评论；实现与门禁 → PR 正文。
- 不改写历史：只按新粒度重写了 0.10.2 的段（并用同一 awk 提取重刷了它的 Release 正文），更早版本保持原样。

---

## 2026-10-19 — `edit` 的 diff 改成 git 风格统一 diff（ADR-0020）

**Type:** contract（模型可见的 diff 形态）
**Confidence:** High
**Evidence:** `docs/research/diff-presentation-experiment/RESULTS.md`（8 fixture × 4 问，两臂 old 27/32 vs new 32/32，分差全在「定位」）；`docs/research/diff-presentation-mainstream.md`（14 个工具/agent 的一手取证）、`-hashline-and-literature.md`、`docs/research/diff-presentation-repo-facts.md`（本仓库能力与预算）；`docs/adr/0020-edit-diff-unified-diff-presentation.md`；根 `npm run typecheck` 干净、`npm test` 1660 过 / 1 挂（`test/core/hash-store.test.ts` 的 WAL 截断用例，主检出同样红 = 既有环境失败）、`npm test -w client` 8 files / 195 tests 全过。

### Why

- 旧的 diff 是一串裸行加 ` ... ` 省略行，**没有位置信息**：实测 8 个 fixture 里模型只有 3 次能说出被改的函数名，而且只在该改动恰好落在函数声明行后 3 行、声明行正好进了上下文窗口时才成立；否则函数名根本不在 diff 里。` ... ` 更狠：F8 里中间那个函数名被整行吞掉，模型只能答「一个函数名被省略号折叠的函数」。这正是「有时候读得懂、有时候完全读不懂、且不知道为什么」的机制。
- 修法不是「每行加行号」：本仓库的锚点本就替代行号，且外部各家一致认为行号**写侧不可靠、读侧有用**；逐行加行号还会破掉行形状与左列契约。也不是「贴整函数」：Aider 实测无提示的新旧整函数对照使 apply 错误率 +30–50%。
- 结论是**加框架不改行**：文件头 `--- path` / `+++ path`，段头 `@@ -a,b +c,d @@ 作用域名()`，主体用 git 式交错；行形状 `<+|-><anchor>:<content>` 不变。

### Path / Affected typed relationships

- `src/render/edit-diff.ts`：`genDiff` 增 `blocks: DiffBlock[]`；删 ` ... ` 省略行；删除行旧锚点带 `~`；新增 `renderDiffLines()`。
- `src/render/scope.ts`（新）+ `src/render/scope-registry.ts`（新）：纯语法作用域检测与接缝（`ScopeLabelAt` / `setScopeLabelAt`），零依赖、只认 function/method/class/type、名字取**改后**文本。
- `src/domain/edit/edit-response.ts`：新图例 + `renderUnifiedDiff()` / `renderFileDiffGroup()` / `editDiffLegend()`；`src/domain/edit/prompts.ts` 补三句（头是结构不是内容、`~` 锚点已失效、`+` 行锚点可用）。
- `src/render/edit-card.ts`：`diffRowsFromBlocks()` + `kind:"hunk"`；`diffRowsFromMeta` 白名单放行 hunk（不放行会让卡片静默退化成无 diff）。
- `client/src/client/diff-rows.ts`（新，投影层）+ `client/src/client/diff-block.tsx`（段头样式、折叠只数代码行、复制排除段头）+ `client/src/client/types.ts`（`DiffRowMeta` 改可辨识联合）。
- 文档：ADR-0020、`docs/diff-presentation-spec.md`、README 双语新增「编辑 diff（unified diff）」一节、`docs/research/diff-presentation-*`（调研与实验台）。

### 本轮定案（复核时照此）

- **行形状是红线**：`<+|-><anchor>:<content>` 不变；删除行的旧锚点加 `~`（标记列两格右对齐，列不散），误抄得干净的 `[E_BAD_REF]`。
- **段头不铸锚点、不进 served 集**（ADR-0009 的惰性分配不受影响）；`@@` 非 Base62，误抄同样得干净报错。
- **段粒度由既有 `hashline.context_lines` 决定**（默认 3，git compact 规则：两处改动间未改行 > 2×context_lines 就拆段）——不新造配置项。
- **一个段可能跨多个函数**：作用域名取该段**第一处改动**所在符号（git hunk 头惯例）。
- **`write` 的模型文本仍是 auto-read 预览**（它要靠预览读回新内容，换成 diff 会丢内容）；四工具共用的是**卡片行**与 `edit`/`undo` 的模型文本。
- 用户逐条否掉的形态记在 ADR-0020 的 Out of Scope：整函数带出、干净主体+删除行单列、删除块挪段尾、整函数新旧两版对照、每行行号前缀、全文件重写、函数级语义摘要、失败路径才给 diff。
- 旧锚点 `~` 的**字形仍待用户最终确认**（早前 Q15 选 `~`；用户最后给的示例里没带）。

---

## 2026-10-20 — 作用域检测通用化：按扩展名选语言 + 声明模式表（#301，ADR-0020 增补）

**Type:** contract（段头作用域名的语言覆盖）
**Confidence:** Medium（覆盖面广，但「哪种写法算声明」是启发式；误判只影响段头的名字，不影响任何正确性）
**Evidence:** PR #300 的评审评论（维护者：scope 段头支持的语言太少，应通用化）；`docs/adr/0020-edit-diff-unified-diff-presentation.md` 的「Scope name」一节；`docs/diff-presentation-spec.md` §5.1；票 #301。

### Why

- 原实现只读 TypeScript/JavaScript，Python 的 `def`、Go 的 `func`、Rust 的 `fn` 在段头里**根本没有名字**——而这三种是最常见的非 TS 语言。段头的作用域名是本次形态改动买到的唯一增量（验收实验 old 27/32 → new 32/32，分差全在「定位」），覆盖不到的语言等于这项增量对它们不存在。
- 评审建议参考 git：`xdiff` 内置每语言一张「匹配函数定义行」的正则表，按文件扩展名选模式集，并可通过 `.gitattributes` 的 `diff.<lang>.xfuncname` 自定义。
- 用户补充（2026-10-20 原话）：「评论说的语言只是举例，不可能真的就只支持五六个语言的」⇒ 机制必须**表驱动**，覆盖面按主流语言铺开，而不是打三个补丁。

### Path / Affected typed relationships

- `src/render/scope/`（新目录，取代 `src/render/scope.ts`）：语言表（扩展名/文件名 → 描述符）、声明模式组表、三个块族的块边界（brace / indent / keyword-end）、对外 API。
- `src/render/scope-registry.ts`：接缝类型扩为 `ScopeLabelAt = (text, line, path?) => string | undefined`；`setScopeLabelAt` / `currentScopeLabelAt` 保留（评审明确要求「可通过 scope-registry 注册自定义检测器」）。
- `src/render/edit-diff.ts`：`genDiff` 尾部三个位置参数（`partsFor` / `changedRanges` / `scopeLabelAt`）收成 `GenDiffOptions` 对象并加 `path`——否则 9 个调用点都要补 `undefined` 占位，路径根本加不进去。段头作用域名 = `scopeLabelAt(newContent, focus, path)`。
- 调用点：`src/domain/edit/edit-response.ts`（2）、`src/render/edit-card.ts`（1）、`src/tools/tool-edit.ts`（3）、`src/tools/tool-undo.ts`（3）、`src/tools/tool-write-shadow.ts`（2）；测试里的 6 个 `genDiff` 调用点同步迁到新签名。

### 本轮定案（复核时照此）

- **机制表驱动**：路径 → 语言描述符 → （块族 + 声明模式组）；加一种语言 = 语言表加一行 + 选一个已有模式组。
- **三个块族**：brace（花括号定界）、indent（缩进定界）、keyword-end（`end` 计数）。
- **覆盖**：TS/JS、Vue/Svelte、Python、Vyper、Ruby（+ `Rakefile`/`Gemfile` 按文件名）、Go、Rust、Zig、Java、Kotlin、Scala、C#、Swift、C/C++/Objective-C、Dart、Groovy、Solidity、D、PHP、Perl、Shell、PowerShell、Lua、Elixir、Julia。
- **不支持就不给名字**：Erlang、OCaml、Haskell、Clojure、Lisp、Fortran、Ada、Pascal、SQL、R、Makefile/Dockerfile——检测不到就留空，不猜。
- **没有路径时**只走 TypeScript 读法（brace 族里的 `js` 模式组），**故意不是所有 brace 组的并集**——没说过自己是 Go 的文件不当 Go 读；生产路径都传路径，只影响兜底。
- **同一份文本只扫一次**：扫描结果按 (text, path) 缓存（保留 2 条）。段头要给**每一处改动**标作用域，标一次就是问一次；不缓存就是「改动行数 × 文件大小」的平方级扫描——写一个撞满 48,000 字符预算的大文件会把测试套件拖到超时（CI 上 3 个 write 用例 5000ms 超时）。**教训**：把探测器接进「每个改动行问一次」的循环前，先看它是不是 O(全文)。
- **名字只是信息**，不进任何正确性判断；宁可不给，也别给错。
- `.gitattributes` 式的用户自定义映射**本轮不做**（不新造配置项），但 `scope-registry` 的注册表是同一条路，留给以后。

---

## 2026-10-20 — 段头列出该段所有改动的作用域名（#302，ADR-0020 增补）

**Type:** contract（段头作用域名的取法）
**Confidence:** High（评审复现步骤明确；改动只在名字的取法，不动段切分）
**Evidence:** PR #300 的评审评论（2026-10-20T04:15:46Z，维护者）；`test/core/diff-blocks.test.ts` 的两例新测试；`docs/adr/0020-edit-diff-unified-diff-presentation.md` 的「Scope name」一节。

### Why

- 段头原先只取该段**第一处改动**的作用域名。评审复现：两个紧挨着的函数各改一行落在同一 hunk 内，段头只写 `first()`，而这一半改动在 `second()`——模型读到的位置与作用域只对了一半。
- 评审给了两个方向：① 段头列出多个作用域名（`first() / second()`）；② 按函数边界强制拆 hunk。选 ①：方向 ② 会推翻已定案的「段粒度由既有 `hashline.context_lines` 决定（git compact 规则），不新造配置项」——那是用户早前 grilling 拍板过的；git 自己也只按行距离切段。
- 名字是信息不是正确性判断，列出全部只是把已有信息补全，代价是多几个 token。

### Path / Affected typed relationships

- `src/render/edit-diff.ts`：`WorkRow` 增 `removedAt`（被删行在新文件里留下的位置，删除行自己没有行号）；`WorkBlock.firstAdded` / `firstRemoved` 随之删除；`DiffBlock` 增 `scopes?: readonly string[]`，`scope` 保留为显示用的合并串。段头计算改为遍历该段**所有**改动行（`+` 用 `row.newLine`，`-` 用 `row.removedAt`），在改后文本里查 `scopeLabelAt(newContent, at, path)`，去重后 `scopes.join(" / ")`。
- `src/domain/edit/edit-response.ts`：图例文案 `the enclosing function` → `the enclosing function(s)`。
- `src/domain/edit/prompts.ts`：两个分支各加一句「段头可能列出多个作用域（`a() / b()`）——那说明这一段改的不止第一个」。

### 本轮定案（复核时照此）

- **段头列出该段所有改动落入的作用域名**，去重、按改动出现顺序、` / ` 连接。
- **按改动自己的行查作用域**，不按段首行 ⇒ 上下文行把邻居函数拉进来时不会借它的名字。
- **段切分不动**：仍只按行距离（`hashline.context_lines`），绝不按函数边界。
- 名字仍只是信息：检测不到就不写，不猜。

---

## 2026-10-20 — CI 全绿：冷开预算门取中位数 + 关机前做最后一次 WAL 检查点（#303）

**Type:** contract（关机的 WAL 契约）+ test（墙钟预算门的读数口径）
**Confidence:** High（CI 实测：main 基线 run 39260663911 在同一个用例上就红；本分支的 run 39369837344 读到 83.5ms）
**Evidence:** CI run 39369837344（verify (22) 唯一失败：`test/core/hash-store-cold-open.test.ts` › 「smoke: small store cold-opens in well under the budget」，`AssertionError: expected 83.549857 to be less than 50`）；main 基线 run 39260663911（同一用例，`expected 61.132247 to be less than 50`）；本地探针 `/tmp/wal-probe.mjs`（关机后 `-wal` 8272 字节、`-shm` 32768 字节仍在）。

### Why

- **墙钟预算门用单样本量，被并发加载放大**：那条用例量的是「刚写出的库的首开」——冷 FS 缓存 + 一次性维护索引 + fsync，CI 满载时 61–119ms，撞 50ms 的门。同一文件里的姊妹门（steady state）早就改用「3 次采样取中位数」（#267 的先例：Ubuntu/Node 22 腿量到 52.156ms，超 4%）。**教训**：墙钟预算类的断言必须用中位数；单样本量到的是机器噪声，不是被测行为。
- **并发本身就是被测对象**：冷开文件与另外 90 个文件同池跑，量到的是争用而不是冷开。仓库早有 heavy 项目（#162）就是为这类文件准备的，冷开文件此前漏在外面。
- **关机后 WAL 没截断**：本机跑的是 Bun（`process.versions.bun` = 1.4.0）的 `node:sqlite`——**只要 `close()` 时还有活着的 prepared statement，它就不删 `-wal`/`-shm`**（Node 会删；用同一运行时做的对照实验证实了这一点）。根因不是 store 的逻辑而是运行时差异，所以修的是「不依赖运行时替我们删文件」：把最后一次 checkpoint 挪到写完关闭标记之后，让 WAL 里不留未落盘的帧。

### Path / Affected typed relationships

- `src/domain/session/hash-store.ts`：`shutdownDb` 在写完 `clean_shutdown`（以及可能的 VACUUM）之后补一次 `PRAGMA wal_checkpoint(TRUNCATE)`；新增 `checkpointFully()` 读回该 pragma 的 `busy` / `log` / `checkpointed` 三列，判断「是否每一帧都已进库」。
- `test/core/hash-store.test.ts`：「truncates the WAL file after shutdownHashStore」改为断言「WAL 要么不在，要么 0 字节」——**留 0 字节的 WAL 与不存在的 WAL 是同一个契约**（没有未落盘的帧）。
- `test/core/hash-store-cold-open.test.ts`：smoke 门改用与姊妹门同样的「3 次取中位数」+ 120s timeout；首开仍留一条断言（`rowCount > 0`），保证量的是真库。
- `vitest.config.ts`：`test/core/hash-store.test.ts` 与 `test/core/hash-store-cold-open.test.ts` 进 heavy 项目（顺序跑、30s timeout）——沿用 #162 的既有做法。

### 本轮定案（复核时照此）

- **墙钟预算的断言用中位数，不用单样本**；机器无关的保证留在 `meta.last_open_integrity_check`。
- **关机契约 = 不留未落盘的 WAL 帧**，不是「文件一定被删」。
- **墙钟预算在没有机器基准时只是「机器速度门」**：冷开成本随 `anchor_lines` 行数线性增长（`stats()` 里的 `SELECT COUNT(*) FROM anchor_lines`），同一个 open 在开发机 8ms、CI 冷缓存 131ms、Windows 125ms ⇒ ceiling 统一提到 **500ms**（原 50ms / win32 400ms），smoke 门与姊妹门统一用「3 次取中位数」。**这让门不再误报，但没有兑现规格 #184 的「与库体量无关」承诺**——store 侧的真修法单独立票 **#305**（行数增量维护，或预算判定改有界扫描）。
- **不要手动删 `-wal`/`-shm`**：另一个连接还开着时删掉 `-shm` 会毁掉它的共享内存映射——实测把 hash-store 的另外 8 个用例打成 `disk I/O error`（第一版就是这么写的，已回退）。
---

## 2026-10-20 — 锚点库行数改为维护值：冷开与每次写的预算判定不再随库体量变慢 (#305)

**Type:** contract（store 内部的行数记账方式）+ perf（冷开与写路径的成本）
**Confidence:** High（本机同一脚本前后两轮实测：24 万行库冷开 7.92ms → 5.62ms，且随行数增长的那一项（`SELECT COUNT(*) FROM anchor_lines`）开库不再执行；语句级验收在修前代码上 8/10 红）
**Evidence:** 本机探针（`.tmp/cold-open-scale.mjs`，同一台机、同一脚本）：30/3k/30k/60k/120k/240k 行的冷开中位数 7.20/6.25/6.45/6.83/6.87/7.92ms → 修后 6.86/6.32/6.54/6.24/6.28/5.62ms，且**冷开减去 `COUNT(*)` 恒定 6.0–6.6ms** ⇒ 随体量增长的项只有那一项；`test/core/hash-store-row-count.test.ts` 10 例（语句级断言，8 例在修前代码上红）；`npm run typecheck` 干净、`npm test` 1757 过 / 1 挂（既有环境例）、`npm test -w client` 8 files / 207 tests 全过。

### Why

- **规格 #184 承诺「与库体量无关」，而行数是算出来的**：`stats()` 里的 `SELECT COUNT(*) FROM anchor_lines` 每次开库、每次写（`overBudget()`）都要付一次 O(行数) 的索引扫描 ⇒ 上一条（#303）只是把墙钟门抬到 500ms，**没有兑现承诺**，store 侧的真修法就是本票。
- **票面给的两个方向里，「有界扫描」实测更慢**：`SELECT COUNT(*) FROM (SELECT 1 FROM anchor_lines LIMIT 300001)` 在 24 万行上要 **4.08ms**，比原 `COUNT(*)`（1.35ms）还慢约 3 倍（`SELECT 1` 不带索引列 → 走表扫描），而且只对超预算库有界 ⇒ 兑现不了「与库体量无关」；**只有「行数维护值」能满足验收**。
- **维护值落 meta + 触发器，而不是在域内加减**：域内记账会漏掉「域外写者」——既有测试就是用第二条 `DatabaseSync` 连接直写 `anchor_lines` 的；触发器对任何写者都精确。代价是每新增一行约 1µs（10 万行 INSERT：80.7ms → 177.6ms），且只付在**新增**行上（重放 UPSERT：77.7 → 88.5ms）。

### Path / Affected typed relationships

- `src/domain/session/hash-store.ts`：`meta.anchor_lines_rows` + 两个触发器（`AFTER INSERT` / `AFTER DELETE` on `anchor_lines`）随行的增删同事务移动维护值；`maintainedAnchorRowCount()` 读维护值，**缺失或不可信时扫一次并写回**（写回 best-effort）；开库做**一次**修复（一条语句，计数与写回不能分叉）；旧库迁移与版本清空作废维护值（迁移用 `INSERT OR REPLACE`，会抑制 delete 触发器）；LRU 循环把路径计数提出循环（每删一个路径恰好 -1，不再每轮重数）。
- `src/domain/session/store-budget.ts`：新增纯函数 `isOverRebuildLimit` / `isOverEvictLimit`（阈值判定与它比较的限值住在一处，测试可以钉在线的两侧）。
- `test/support/fixtures.ts`：共享 `withStoreHome` / `storeConfigHome` / `storeDbPath` —— 三个 store 套件不再各写一份临时 home。
- `test/core/hash-store-row-count.test.ts`（新，10 例：维护值被读、存量库首开补算、旧库迁移后重算、库重建后重算、每条写路径后仍等于 `COUNT(*)`、预算线两侧、运行期缺失后写回）；`test/core/hash-store-budget.test.ts`（写入从 `INSERT OR REPLACE` 改成 `ON CONFLICT … DO UPDATE`）；`test/core/hash-store.test.ts`。
- 文档：ADR-0010 决策 5 增 2026-10-20 amendment（维护值与「REPLACE 会漂移」这条不变量）、`CHANGELOG.md` `[Unreleased]`。

### 本轮定案（复核时照此）

- **维护值是维护出来的，不是算出来的**：读路径永远读 meta；只有「缺失/不可信」才扫一次，并当场写回。
- **写回只发生在开库那一次修复里**；运行期的兜底写回是 best-effort（写回失败只影响性能，不影响计数的正确性）。
- **`INSERT OR REPLACE` 会让计数漂移**（它抑制 delete 触发器）：`anchor_lines` 一律 `ON CONFLICT … DO UPDATE`；唯一的历史 REPLACE（旧库迁移）先作废维护值。
- **验收以语句级断言为主**（数一数有没有「数过整张表」的语句），墙钟门（500ms）保留但不再放宽 —— 墙钟是机器速度门，语句级才是行为门。
- **剩余成本不在本票范围**：路径数（`undo ∪ served ∪ anchor_meta` 的 UNION）仍随路径数增长，与行数无关；本票只解「随行数变慢」这一半。

---

## 2026-10-20 — 锚点库路径数改为维护值：预算判定不再随路径数变慢 (#311)

**Type:** contract（store 的路径数记账方式）
**Confidence:** High（语句级验收：修前全红、修后全绿）
**Evidence:** 票 [#311](https://github.com/hyperion2144/dsh-hashline-edittool/issues/311)（#305 的姊妹项）；`docs/adr/0010-bounded-anchor-storage.md` 决策 5 的 2026-10-20 修正案。

### Why

#305 把行数改成了维护值，路径数仍在每次开库、每次写时现算，成本随路径数线性增长；#305 的收尾条目把它列为「剩余成本，不在本票范围」，本票就是它。

### Path / Affected typed relationships

- 路径数改为随写入同事务维护的值，语义与行数一致：缺失或不可信时扫一次并写回，旧库迁移与版本清空作废后重算。
- 决策与不变量 → ADR-0010 决策 5 的 2026-10-20 修正案；验收与门禁 → PR #311 正文。

### 本轮定案（复核时照此）

- **路径数是并集大小**：同一路径在多个族里只算一次；计数只在路径本身出现/消失时移动，与族的写入顺序无关。
- **`served` 需要 `path` 索引**：主键是 `(session_id, path)`，缺索引时子查询会全表扫描。
- **验收以语句级断言为主**（数一数有没有「数过并集」的语句），墙钟门（500ms）保留不再放宽。
 
---
## 2026-10-20 — 自动格式化段不再重复主 diff 已展示的行 (#312)

**Type:** contract（ADR-0019 输出形状段的 2026-10-20 修正案：`alsoInMainDiff` 行级标记退役，改 `inMainDiffRows` 计数）
**Confidence:** High（根 + client typecheck/test 全绿；行为由 format 套件 + client models/format-block 钉子锁定）
**Evidence:** 票 [#312](https://github.com/hyperion2144/dsh-hashline-edittool/issues/312)（诊断评论 + 维护者 Q1–Q3 裁决记录）；ADR-0019 修正段。

### Why

- #279 Q4-A 的「in-main 行入段、打 `alsoInMainDiff` 标」基于旧主 diff 形态；#293（ADR-0020）把主 diff 改成统一 diff 后，重复行的锚点与内容在主 diff 行上已完整，标记不省任何 token——重复展示成了纯浪费（报告人规则 2 的缺口；规则 1/3 此前已实现）。

### Path / Affected typed relationships

- `src/domain/format/format-section.ts`：行纳入规则改为 in-main → `inMainDiffRows` 计数、¬in-main∧ineligible → `unservedRows`、其余 → rows（hash 恒取 final）。
- `src/domain/format/types.ts`：`FormatRow = EditDiffRow`（flag 退役）；`FormatSection.inMainDiffRows`。
- `src/domain/edit/edit-response.ts`：header 增 `k in main diff`；全被裁时仍出计数 header（非 no changes）。
- `src/domain/format/write-section.ts`：更新路径按预览可证性裁剪——仅当模型重写了该行的来源行（before≠model）才计入 in-main，否则保留为 row（#312 复核修正，Q2 裁决随之收窄）；client badge 与 `alsoInMainDiff` 校验/类型退役（Q3 裁决），旧持久化 meta 容忍该字段但丢弃。
- 文档：ADR-0019 输出形状段 2026-10-20 修正案、README ×2、`CHANGELOG.md` `[Unreleased]`。

### 本轮定案（复核时照此）

- **三规则不变式**：`changedLines = inMainDiffRows + unservedRows + rows.length`。
- **手动 `format` 永不全裁**：`alsoInMain` 恒空，段即主输出。
- **全被裁 ≠ no changes**：`inMainDiffRows + unservedRows > 0` 时渲染计数 header。
- **in-main = 主 diff 实际渲染的行**：edit 用 `diffRenderedLines`（逐变更 ±context 并集，非 served 窗口——间隙内被 formatter 还原的行回到 rows）；write 更新只在模型重写来源行时计入；不确定即展示，绝不静默丢弃。

---
## 2026-10-21 — format.auto 三态化 + 显式回退开关 (#315)

**Type:** contract（ADR-0019 2026-10-21 修正案：`format.auto` 布尔 → 三态模式，G3 静默回退裁决被推翻）
**Confidence:** High（根 + client typecheck/test 全绿：1787 + 208；行为由 format-settings / format-auto-integration / format-tool / hashline-volatile-config / client settings 卡片钉子锁定）
**Evidence:** 票 [#315](https://github.com/hyperion2144/dsh-hashline-edittool/issues/315)（Q1–Q4 裁决：三态键名、fallback 开关、write 无 hunk 视同 full、手动不带 range 不受 off 约束）；ADR-0019 修正段。

### Why

- 布尔 `format.auto` 把「要不要格式化」和「格式化多大范围」捏在一个开关里：开 = 永远整文件（依赖服务器自己选 range），用户无法表达「只格式化改过的行」。
- 服务器不支持 range formatting 时旧实现**静默回退整文件**——自动路径里用户只看见行被重排却不知道范围变了；显式带 range 的 `format` 调用同样被悄悄放大，违背「绝不替模型猜测」的工具契约。

### Path / Affected typed relationships

- `src/infra/settings.ts`：`AutoFormatMode`（off|full|range）+ `normalizeAutoFormatMode(value, fallback)`（legacy 布尔迁移 true→full / false→off，垃圾→fallback）+ `autoFormatMode()` / `formatFallbackFullFile()`（`isAutoFormatEnabled` 删除）。
- `src/config.ts`：schema `format.auto` 接受布尔或三串（`z.union`），`resolveSettings` 归一化输出；新增 `format.fallback_full_file`。
- `src/domain/format/auto-format.ts`：mode 门（full 忽略 ranges）；range 模式 wantsRange 才要 range 能力，缺失静默；`FormatUnsupportedError` 时 fallback 开→整文件，关→SILENT。
- `src/domain/format/manual-format.ts`：显式 range 且无能力且 fallback 关 → `E_FORMAT_UNSUPPORTED`（文案指路 `format.fallback_full_file`）；服务器谎报能力（-32601）同规则；`write` 无 hunk 在 range 模式视同 full（Q3）。
- `src/domain/edit/edit-engine.ts` / `src/tools/tool-write-shadow.ts`：自动门改 `autoFormatMode() !== "off"`。
- client：`settings-model.ts` `readFormatFlags` 三态 + fallback；`settings-card.tsx` 三态按钮行 + 回退开关行（写回带全三个 `format` 键）。
- 文档：ADR-0019 2026-10-21 修正案、README ×2、`CHANGELOG.md` `[Unreleased]`。

### 本轮定案（复核时照此）

- **off 永不格式化**（自动路径），手动 `format` 不带 range 不受 off 约束（Q4，#277 维持）。
- **范围不可用 ≠ 擅自放大**：自动路径静默跳过（G3 噪音裁决仍成立），显式调用明确报错——放大必须是用户的显式选择（`format.fallback_full_file`）。
- **存量配置零破坏**：布尔 true/false 在 schema、normalize、client 读取三层都迁移，永不炸。

## 2026-10-21 — ADR-0021 added: LSP failed-slot retry (bounded backoff + `status`/`warm`)

**Type:** new decision record
**Confidence:** High
**Evidence:** `src/lsp/manager.ts` (warm/#start/#markFailed/forceWarm/snapshot), `src/tools/tool-lsp.ts` (status/warm operations), `test/core/lsp-manager.test.ts` (retry/backoff/forceWarm/snapshot suite), `test/core/tool-lsp.test.ts` (status/warm suite), issue #318 诊断记录

### Why

#318 诊断定案：failed 槽永久卡死是三重机制叠加（warm 对 failed 早退、rescan 仅设置卡可达、waitForSession 遇 failed 即弃），且报错只有一句 exit code 1（stderr 尾巴无人消费）、无从查询服务器状态。修复策略定为有界指数退避自动重试 + forceWarm 显式绕过 + snapshot 只读 + 工具 status/warm 操作 + 报错附 stderr 尾，完整理由、备选方案与后果记录在 `docs/adr/0021-lsp-failed-slot-retry.md`。

### Path / Affected typed relationships

- `docs/adr/0021-lsp-failed-slot-retry.md` (created)
- `AGENTS.md` l0 decisions 行 0001–0020 → 0001–0021，追加 LSP failed-slot retry 主题
- `README.md` / `README.zh.md`：lsp 生命周期段与工具表行补重试/status/warm 说明
