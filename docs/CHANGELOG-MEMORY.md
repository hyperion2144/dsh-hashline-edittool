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

## 2026-10-25 — ADR-0022 added: toolview takeover priority `-2`

**Type:** new decision record + one-value change
**Confidence:** High
**Evidence:** shipped `app.asar`（DSH 0.2.1-rc.3）SlotCore 的 `register()` / `entriesOfSlot()`；`dsh-claude-style` 0.18.2 / 0.18.5（同为 `{tool.call.toolview, priority:-1}` 注册 read/edit/write）；`client/scripts/verify-bundle.mjs` 对九个 `<key>:<priority>:<locale>` 的断言；issue #321 诊断记录

### Why

#321 诊断定案：client 半区九个接管注册原用 `priority: -1`，而台账对 keyed slot 同 key 同 priority 直接 throw（后注册方那条不落账），`dsh-claude-style` 又把 read/edit/write 钉在 `-1`，两者同时启用必有一方掉三条注册。修法是把九个取值统一下调到 `-2`（仍低于内建的缺省 `0`），既让开已知邻居又保持接管；完整理由、备选方案与残余风险记录在 `docs/adr/0022-toolview-takeover-priority.md`。

### Path / Affected typed relationships

- `docs/adr/0022-toolview-takeover-priority.md` (created)
- `client/src/client/index.ts`：九个接管注册的优先级收进 `TAKEOVER_PRIORITY` 常量（`-2`）
- `client/scripts/verify-bundle.mjs`：预期注册清单九条改 `-2`（任一条漂回 `-1` 构建失败）
- `docs/adr/0005-grep-card-presentation-meta.md`：Status 下补一行指向 ADR-0022（`-1` 细节已被取代）
- `AGENTS.md` l0 decisions 行 0001–0021 → 0001–0022，追加 toolview takeover priority 主题
- `client/README.md`：接管优先级段改为 `-2` 并说明共享 shadow band
- `docs/research/toolview-slot-priority-collision.md` (created)：台账语义与邻居取证
- `CHANGELOG.md` `[Unreleased]` Fixed 段一行（#321）

## 2026-10-26 — ADR-0023 + delete tool spec

**Type:** new decision record + spec
**Confidence:** High
**Evidence:** `src/tools/tool-delete.ts`, `src/infra/fs-bridge.ts`, `src/domain/session/hash-store.ts`, `src/lsp/{manager,sync}.ts`, `test/core/delete-tool.test.ts`, `test/core/fs-bridge.delete.test.ts`, `test/core/hash-store-purge-path.test.ts`, `client/src/client/delete-card.tsx`, `client/test/delete-card.test.ts`, `npm run typecheck` / `npm test` / `npm run typecheck -w client` / `npm test -w client` / `npm run build -w client`

### Why

Map #322 的 `delete` 工具需要把「删文件」与「回收锚点库」做成一个契约：`ctx.fs` 在 dsh 0.2.x 没有删除面（研究记录见 `docs/research/dsh-removal-seam.md`），所以传输层是宿主 `node:fs.unlink` + 用 `writableRoots`/`fs.contains` 重建围栏；回收层是公开的 `HashStore.purgePath` 四族级联；物理层修好了 `pending_vacuum` 从未有生产者、关闭 VACUUM 异步未被等待的缺口。完整取舍与残余风险记录在 `docs/adr/0023-delete-tool.md`，实施契约在 `docs/specs/delete-tool-spec.md`。

### Path / Affected typed relationships

- `docs/adr/0023-delete-tool.md` (created)
- `docs/specs/delete-tool-spec.md` (created)
- `docs/adr/0010-bounded-anchor-storage.md` (amendment: producer + synchronous close VACUUM)
- `AGENTS.md` l0 decisions 0001–0022 → 0001–0023，追加 delete 主题
- `README.md` / `README.zh.md`：工具表、错误码、Store 回收段、架构工具数 8→9
- `CHANGELOG.md` `[Unreleased]`：delete 工具 + VACUUM 修复各一条
- `CONTEXT.md`：delete / path purge / already-absent / logical vs physical reclaim

## 2026-10-26 — format 缩进单位推断 + `.editorconfig` 默认开启 (#336)

**Type:** contract（ADR-0019 2026-10-26 修正案：缩进单位改按行间步长 + 重复宽度网格推断，`.editorconfig` 默认由 opt-in 翻为 on）
**Confidence:** High（根 + client typecheck/test 全绿；行为由 format-indent / format-settings / format-editorconfig / client 卡片用例锁定；真实 TLS 冒烟在本机跑到）
**Evidence:** 票 [#336](https://github.com/hyperion2144/dsh-hashline-edittool/issues/336)（诊断记录 + 真机全文/range 复现）；ADR-0019 修正段

### Why

`inferIndentOptions()` 把「绝对前导宽度众数」当缩进单位：4 空格但多数行在两层以上嵌套的文件，众数落在 8，真实 `typescript-language-server` 按 `tabSize: 8` 把类体重排成 8/16/24；range 模式下范围内外出现 4/8 混排。同一处 `.editorconfig` 默认关闭，项目声明被忽略，与「项目规范优先」相反。

### Path / Affected typed relationships

- `src/lsp/format/indent.ts`：`inferIndentOptions()` 改为「步长众数 + 重复宽度 GCD 两个读数，取有 ≥80% 网格支撑的较大者；都不成立退回旧主导宽度吸附」；新增 `inferUnit` / `stepUnit` / `gridUnit` / `onGrid` / `dominantWidth` / `snapToCandidate`。
- `src/infra/settings.ts` / `src/config.ts`：`format.editorconfig` 默认 `false` → `true`（`DEFAULT_CONFIG`；显式值仍优先）。
- `client/src/client/settings-model.ts`：`readFormatFlags` 的 editorconfig 缺省改为 true（显式 false 仍关），避免卡片把默认关写回。
- `client/src/client/settings-card.tsx`：开关 hint 改「默认开」。
- `src/domain/format/prompts.ts`、`src/lsp/format/options.ts`、`src/lsp/editorconfig.ts`：文案/注释同步。
- 文档：ADR-0019 2026-10-26 修正案、README ×2、`CHANGELOG.md` `[Unreleased]` Changed/Fixed 各一行。
- 测试：`test/core/format-indent.test.ts`（深 4 空格、3 空格单层、对齐噪声、单行错缩进的 4/6/8 矩阵）、`format-settings` 默认值、`client/test/settings-card.test.ts`、`test/core/format-real-server.test.ts`（深 4 空格与「4 空格文件里一行 2 空格」的全文/range 冒烟）。

### 本轮定案（复核时照此）

- **缩进单位来自结构**：绝对宽度是嵌套深度，不是单位；步长众数与重复宽度 GCD 两个读数取较大、且能覆盖 ≥80% 缩进行者，个别错缩进行不能定义单位。
- **`.editorconfig` 默认生效**：项目标准优先于文件启发式；显式 `false` 才关。
- **不读 rustfmt / gopls**：交给 server 自身（ADR-0019 原条款不变）。

## 2026-10-26 — ADR-0024 + rename tool spec

**Type:** new decision record + spec
**Confidence:** High
**Evidence:** `docs/research/dsh-rename-seam.md`, `src/tools/tool-rename.ts`, `src/infra/fs-bridge.ts`, `src/domain/session/hash-store.ts`, `test/core/{rename-tool,fs-bridge.rename,hash-store-repath}.test.ts`, `client/src/client/{rename-card.tsx,models.ts}`, `client/test/rename-card.test.ts`

### Why

Map #337 的 `rename` 工具需要在移动普通文件的同时把 hash-store 的四族行（`anchor_meta` / `anchor_lines` / `served` / `undo`）搬到新路径，使改名之前已分配、已服务的锚点无需重读即可继续使用。dsh 0.2.x 的 `ctx.fs` 没有改名接缝，传输层是宿主 `node:fs.rename` + 源/目标双侧围栏；`fs/observed` 必须发「旧 absent + 新 present」且 present 的 version 在 rename 后重新 stat（`ctime` 已变）；store 迁移用 `INSERT … SELECT` + `DELETE`（计数触发器只挂 INSERT/DELETE），绝不用 `UPDATE path`。完整取舍与残余风险在 `docs/adr/0024-rename-tool.md`，实施契约在 `docs/specs/rename-tool-spec.md`。

### Path / Affected typed relationships

- `docs/adr/0024-rename-tool.md` (created)
- `docs/specs/rename-tool-spec.md` (created)
- `docs/research/dsh-rename-seam.md` (created)
- `AGENTS.md` l0 decisions 0001–0023 → 0001–0024，追加 rename 主题
- `README.md` / `README.zh.md`：工具表、错误码、Store 迁移段、架构工具数 9→10
- `CHANGELOG.md` `[Unreleased]`：rename 工具一行
- `CONTEXT.md`：rename / path migration / anchor preservation across path
## 2026-10-27 — ADR-0025 + write 预览模式规格

**Type:** new decision record + spec
**Confidence:** High
**Evidence:** `src/tools/tool-write-shadow.ts`, `src/domain/write/model-text.ts`, `src/domain/format/write-section.ts`, `src/config.ts`, `src/infra/settings.ts`, `client/src/client/settings-card.tsx`, `test/core/write-preview-{confirmation,diff,settings}.test.ts`, `client/test/diff-rows.test.ts`, `npm run typecheck` / `npm test` / `npm run typecheck -w client` / `npm test -w client` / `npm run build -w client`

### Why

Map #354：`write` 的写后回显是输出行为，应归用户；默认从整文件回读改成统一 diff（只在 update 上生效），并给出「仅一行确认」的静默形态。决策票 #355/#356/#357，规格 #359。

### Path / Affected typed relationships

- `docs/adr/0025-write-preview-modes.md` (created)
- `docs/specs/write-preview-spec.md` (created)
- `README.md` / `README.zh.md`：工具表 write 行、Write preview 段、配置样例、设置卡片清单
- `CHANGELOG.md` `[Unreleased]`：`write.preview` 一条
- `CONTEXT.md`：Preview mode 词条
- `src/infra/settings.ts` / `src/config.ts`：快照默认 `diff`
## 2026-10-29 — 客户端卡片三项改造：换行开关 / read 窗口标题 / 卡片双语与 host 文案 key 化 (#366)

**Type:** contract（ADR-0026 host 文案 key 化 wire 契约；ADR-0027 read window `truncated`）+ 客户端词表基座
**Confidence:** High（根 1854 例 + client 291 例全绿；双 typecheck；build + verify-bundle 断言 11 处注册 locale 全为 `hashline.card`）
**Evidence:** 地图 [#366](https://github.com/hyperion2144/dsh-hashline-edittool/issues/366)（四张决策票 #369/#368/#370/#367 全收口）；规格 [#371](https://github.com/hyperion2144/dsh-hashline-edittool/issues/371)；实施票 #372–#376；`docs/research/ctx-locale-seat.md`（locale seat 一手源取证）

### Why

三项用户需求（卡片自动换行开关、read 卡标题窗口信息、卡片双语）落在一个机制事实上：dsh 的 `locale` 是 **client 侧** cordis 服务（host 读不到生效语言），所以 host 拼装文案必须 key 化过 wire；且插件此前借用 `conversation` 命名空间却有四个 key 失配、页面显示 key 字面量——自有词表是补洞而非锦上添花。

### Path / Affected typed relationships

- `client/src/client/locale.ts` (created)：NS `hashline.card`、en/zh 字典（现用 key 全量复制 + wrap/read.title/row.title/settings.*/delete.*/error.hintLabel/lsp.* 等新增，`satisfies` 结构类型自持，`TBench` 收窄为词表 key 联合）
- `docs/adr/0026-host-text-key-wire-contract.md` (created)
- `docs/adr/0027-read-window-truncated.md` (created)
- `docs/adr/0014-read-window-cursor-and-summary.md` (amendment：window 第四个可选字段 `truncated`)
- `src/render/wire-text.ts` (created)：`LocalizedText` + `rowTitle`（折叠行标题 key+params 产出处）
- `AGENTS.md` l0 decisions 0001–0025 → 0001–0027，追加 host 文案 key 化与窗口截断两个主题
- `README.md` / `README.zh.md`：Highlights 补卡片换行开关与卡片双语段（镜像）
- `CHANGELOG.md` `[Unreleased]`：#372/#373/#374/#375 各一条
- `docs/research/ctx-locale-seat.md` (created)

### 本轮定案（复核时照此）

- 自建词表 NS 后解析链无 `→ conversation` 跳：借用的 key 必须全量复制；`t` 的 key 类型收窄到词表联合，写错 key 即编译错误。
- host 拼装文案一律稳定 key + params 过 wire；未知 key 拒收回落行自带标签，屏幕永不出现 key 字面量；模型可见文本通道保持英文（`window.truncated` 布尔属协议可加项，不在此边界内）。
- `window.truncated` 只由 continuation 判定（`assembleServedRead`）；≠ `end < totalLines`（后者是 limit 给小，不是截断）。
- 换行开关是每卡实时渲染状态，非配置、不持久化；gutter 两态钉死 `pre`。

## 2026-10-30 — ADR-0028：grep 的搜索引擎改回 ripgrep（#384）

**Type:** contract（ADR-0028）+ 实现形态变更（预过滤退役）
**Confidence:** High（根 1919 例 + 2 skipped 全绿；client 300 例 + build 全绿；双 typecheck 干净；ripgrep 15.0.0 实测退出码与行号行为）
**Evidence:** 票 [#384](https://github.com/hyperion2144/dsh-hashline-edittool/issues/384)；官方实现 `deepseek-harness/packages/fs/tool-fs-search/src/{grep.ts,search-core.ts}`（`buildGrepCommand` / `parseGrepMatches` / `runRipgrep`）；ripgrep 15.0.0 本机实测（exit 0/1/2 口径、`--text` 对 NUL 行号的对齐、显式路径不受 ignore 规则影响）；`docs/line-hashline-spec.md`（v1 规格的 “ripgrep-flavour regex” 与 “ripgrep 产出命中”）

### Why

`grep` 此前有两个引擎：JS 逐行匹配决定“什么命中”，ripgrep 只做 `rg --files-with-matches` 预过滤。字面模式把模式拼成 `-F<pattern>` 传给 `rg -e`，ripgrep 于是去搜字面文本 `-F<pattern>`，恒 exit 1；而 exit 1 早已被升格为最终答案，于是命中与未命中一律回答 “No matches”（假阴性，#384）。维护者裁决：照抄官方 DSH grep 的形态，把 ripgrep 放回引擎位——`rg --json` 直接产出命中（文件/行号），插件只在其上接回锚点、上下文行、预算 spill/resume、二进制保真与漂移提示。

### 本轮定案（复核时照此）

- argv 固定为 `["--no-config", "--json", "--text", (--max-count=N), (--fixed-strings), "--regexp=<pattern>", "--", ...files]`：`--no-config` 必须第一个（宿主 RIPGREP_CONFIG_PATH 可注入 `--pre`）；字面量是独立 flag，**绝不**把 `-F` 拼在模式文本上（那正是 #384 本体）。
- `--text`（`-a`）是本插件对官方的必要偏离：ripgrep 默认把 NUL 当行分隔符并在 NUL 处停止搜索，行号会整体偏移、NUL 所在行的命中会报在错误行上（#268）；`--text` 让它的行号与插件自己的 reader 对齐。
- 插件自带的逐行 matcher 不再是主引擎，只在 ripgrep **根本跑不起来**时降级接管（二进制缺失 / 运行失败）：「grep 不会因为 ripgrep 出错而失败」这条契约仍然成立；而**模式被 ripgrep 拒绝**是坏模式，直接报 `E_BAD_SHAPE`（官方工具同样报 `SEARCH_INVALID_PATTERN`）——不静默换一个引擎作答，方言只此一种。
- **read line space（ADR-0008）是 ripgrep 复现不了的那一个契约**：read 空间把裸 CR 也折成 LF，ripgrep 只数 LF。带裸 CR 的文件行号会漂移，跨 CR 的正则甚至会误命中——命中**仍是 ripgrep 判的**，由「命中在行内的偏移量」定位到 read 空间的行号（`src/tools/grep-search.ts` 的 `indexLineSpaces` / `readSpacePosition`），不靠插件自己的 matcher 重新匹配，方言不分裂。
- **漂移窗口被关上**：ripgrep 读过文件、插件又读一次，两次之间文件可能变了。搜索看到的行文本与插件现在读到的行文本逐行比对，不一致即判该文件「搜索后已变」：该文件按**搜索当时的快照**作答（行不 serve、不给锚点），并在响应里点名 caution——「标成命中却已不是那一行」的假阳性就此消失（票面「漂移 caution 行」这一项）。
- 候选清单仍是插件自己的（ripgrep 的 `--files` 列举或插件走查），`grep_respect_gitignore` / `include` / 隐藏项与 node_modules 规则的语义不变；显式列在命令行上的路径不受 ignore 规则影响（ripgrep 15.0.0 实测）。

### Path / Affected typed relationships

- `docs/adr/0028-grep-rg-engine.md` (created)
- `docs/adr/0017-binary-refusal-stops-read-not-grep.md` (amended：预过滤退役，搜索自身改用 `--text`)
- `src/tools/grep-rg.ts`：预过滤接缝（`rgFilesWithMatches` / `classifyRgExit`）退役，改为 `rgSearchMatches` / `buildRgArgv`；命中记录带上行文本与行内偏移（官方记录形态）；`rgFiles` 不变
- `src/tools/grep-search.ts` (created)：搜索层——引擎调用、命中按文件分组、read 行空间定位、漂移比对、section 行构造；降级路径（插件 matcher）在同层
- `src/tools/tool-grep.ts`：管线改为「rg 产出命中 → 只读命中文件 → 锚点/context/预算/spill」；行构造与匹配下放到搜索层，工具层回到「工具面 + 预算/续取」
- `src/domain/edit/prompts.ts` / `src/render/grep-card.ts`：模式方言措辞改为 ripgrep 正则
- `README.md` / `README.zh.md`：grep 工具行（镜像）
- `CHANGELOG.md` `[Unreleased]`：#384 两条
- `AGENTS.md` l0 decisions 0001–0027 → 0001–0028，追加 grep 搜索引擎主题
- `docs/adr/0016-argv-length-budget.md` / `docs/adr/0017-binary-refusal-stops-read-not-grep.md` (amended：预过滤退役，搜索自身改用 `--text`)
- 测试：`test/core/issue-384-grep-engine.test.ts`（引擎）、`test/core/issue-384-grep-search.test.ts`（搜索层：定位 + 漂移）、`test/core/issue-384-grep-repro.test.ts`（复现矩阵）、`test/core/issue-384-grep-rg-unavailable.test.ts`（降级路径 + 模式被拒报错）、`test/core/grep-rg-argv-limit.test.ts`（迁移）、`test/core/grep-rg-prefilter.test.ts`（删除，接缝已不存在）

## 2026-10-30 — ADR-0029：grep 的命中数与截断口径（#386）

**Type:** contract（ADR-0030 grep 命中数/截断口径；canonical `total` 语义变更）
**Confidence:** High（根 1930 例 + 2 skipped 全绿——`hashline-limit` 那条在并行负载下超时、单跑 26.6s 绿，与本改动无关；client 303 例 + build/verify-bundle 全绿；双 typecheck 干净；ripgrep 15.2.0 本机实测 `--count` 受 `--max-count` 约束、单文件默认不带文件名；两轴评审（Standards + Spec）各一轮，结论已全部落地）
**Evidence:** 票 [#386](https://github.com/hyperion2144/dsh-hashline-edittool/issues/386)；ADR-0028（ripgrep 是引擎）、ADR-0013（响应预算）、ADR-0026（host 文案 key 化）；ripgrep 15.2.0 本机实测（`--count`、`--count-matches`、`--max-count` 交互、`--with-filename`）

### Why

`grep` 的每文件上限（ripgrep 的 `--max-count`）让「搜到的命中数」永远等于上限而非文件真命中数；这份数据又只在 canonical value 里躺着，模型文本与卡片标题两处都不说。结果是：被上限截断的搜索与完整搜索读起来一模一样，卡片脚注写「showing 100 of 100 matches」而文件其实有 300 处命中。票面要求把「真总数 / 已返回数 / 哪一刀截的」同时接到模型文本与卡片标题两条通道上。

### 本轮定案（复核时照此）

- **真总数是第二趟、且不限额**：触到每文件上限的文件补一趟 `rg --count`（**不带** `--max-count`，带了就等于上限）；没触顶的文件引擎已读全文件，其计数本身就是真数，常态零开销。模式仍是一个 argv 元素（`--regexp=<pattern>`），字面量仍是独立的 `--fixed-strings` flag（#384 的教训）。
- **计数口径是「命中的行」而非「命中次数」**：插件的粒位是行，数字必须与已返回的行数对得上，故用 `--count` 而非 `--count-matches`。
- **canonical `total` 改为真命中数**，另加 `totalExact`（是否精确；触顶文件的真数算不出来时只能给下界，模型文本写 `≥N`）与 `truncatedBy`（`limit` | `budget` | `limit+budget`）；`truncated` 的口径随之改为「有没有发生截断」，与 `truncatedBy` 一致。
- **模型文本逐文件报**：每节末尾一行 `[Matches: 300 total, 100 served. Truncated by the per-file limit (100).]`（计数属于文件，统计行就跟文件走）；**续取段同样逐文件报**——逐文件的计数随 spill 的 sidecar 一起走，所以续取里的每一节都以与首段同一句计数行收尾；预算溢出的 notice 带上全搜索总数（首段与续取段都带）。
- **卡片标题尾同步**：折叠行尾缀承载命中数与截断原因（与 read 行窗口同一槽位，#374 的形态）；过 wire 的是**事实 + 命名措辞的 key**（ADR-0026）：`row.title.grep.stats*` 四个 key + `hits`/`served` 两个参数；「被截断」是独立 key（模板没法无代价地说「而且还被截断了」）。宿主唯一自己拼的限定符是下界的 `≥`（数学符号，不是词；措辞仍在客户端词表里）。宿主不再发 `row.title.grep`，该 key 退出 WIRE_TEXT_KEYS（仍留在词表里——grep 卡的页签用它自称），旧会话里带着它的 meta 会被拒，行不会把「Grep」画两遍。

### Path / Affected typed relationships

- `docs/adr/0029-grep-hit-counts.md` (created)
- `CONTEXT.md`：新增「Grep hits」段（每文件上限 / 真命中数 / 下界 / 截断 / 计数行五个词），并改写「Continuation notice」条目（notice 可带真总数）
- `src/domain/grep/stats.ts` (created)：grep 命中的词汇层——命中数事实（`GrepFileHits`）、截断口径（`GrepTruncation` + 共享清单 `GREP_TRUNCATIONS`）、上限是否截断的判定（`limitCutFor`）、计数行（`formatGrepStats`）、下界写法（`hitCountText`）；工具层与 render 层都从这里取，词不再各写一份
- `src/tools/grep-rg.ts`：新增计数通道 `rgCountMatchingLines` / `buildRgCountArgv`（无 `--max-count`、`--with-filename`）；模式参数抽成 `rgPatternArgs`，搜索与计数两趟共用一份（ADR-0028 的 argv 形状只有一处改动点）
- `src/tools/grep-search.ts`：计划带出「触顶文件」（`cappedFiles`）；每个文件的命中事实（`GrepFileHits`，取自 domain 层）；降级路径的 matcher 扫到文件尾时计数即真数
- `src/tools/tool-grep.ts`：统计行、真总数、`totalExact`/`truncatedBy`、卡片标题、notice 带总数、逐文件计数随 spill 透传（首段与续取段同一句）
- `src/infra/response-stream.ts`：`formatOmittedNotice` 可选带总数
- `src/render/wire-text.ts`：`rowTitle` 对 grep 走计数 key
- `client/src/client/locale.ts`：`row.title.grep.stats*` 四个 key（en/zh 镜像）+ `WIRE_TEXT_KEYS` 放行；`row.title.grep` 退出 WIRE_TEXT_KEYS（宿主不再发它）
- `client/src/client/tool-row.tsx`：grep 行标题改回行自带词、尾缀承载计数（`readWindowSuffix` → `rowSuffixText`，两个行共用一个载体）
- `README.md` / `README.zh.md`：grep 工具行（镜像）
- `CHANGELOG.md` `[Unreleased]`：#386 两条
- `AGENTS.md` l0 decisions 0001–0028 → 0001–0029，追加 grep 命中数主题
- 测试：`test/core/issue-386-grep-hit-counts.test.ts`（新建：真总数 / 统计行 / 预算截断 / 续取逐文件统计行与 notice / 卡片标题 / JSON 路径 / 计数 argv 不带 `--max-count` / canonical value 过 output schema）；`test/core/presentation.test.ts`（`total` 口径随之变更）、`test/core/issue-246-tail-copy.test.ts`（notice 形状带上总数）、`client/test/wire-text.test.ts`（客户端把四个计数 key 渲染成读者语言）
## 2026-10-31 — 取证笔记：LSP 自动诊断的异步时序与「过期诊断」（#388）

**Type:** evidence（研究笔记；不含决策）
**Confidence:** Medium（结论来自代码路径推导；未做真机复现 —— 本会话无 LSP server 可用）
**Evidence:** 票 [#388](https://github.com/hyperion2144/dsh-hashline-edittool/issues/388)；`src/lsp/auto-diag.ts`（`:146` prepareWriteDiagnostics、`:190-219` deliverDiagnosticsAfterWrite、`:265-297` verifiedReport、`:308-321` waitPushMatching、`:428-474` startAsyncWait、`:489-518` buildInjectedMessage/formatInjectedText）；`src/lsp/session.ts`（`:169-191` push 入口、`:218-225` 文档版本）；`src/lsp/sync.ts:46-60`、`:106-119`；`src/tools/tool-edit.ts:334`、`:362-373`、`:613-636`；`node_modules/@deepseek-ai/dsh-agent/lib/types/runtime-types.d.ts:201-209`（`agent.inject` 契约）；`test/core/auto-diag.test.ts`

### Why

自动诊断的异步投递路径没有「过期守卫」：诊断结果不带版本/指纹/时间戳，`verifiedReport` 只保证「这份报告对得上本次写入时捕获的文本」，不保证「这份文本是该文件最新一次 edit 的文本」；同一文件连续两次写 = 两条后台等待并发注入。报告人现象（第二次 edit 先完成、第一次 edit 的延迟诊断后到，agent 收到旧文件内容的诊断）落在 `src/lsp/auto-diag.ts:451-468`。仓内此前**没有任何**讨论「诊断过期 / 异步诊断时序 / 诊断与 edit 顺序」的 ADR、研究笔记或报告，故本笔记是该主题的首篇取证；票 #388 待诊断（标签 bug + needs-triage）。

### Path / Affected typed relationships

- `docs/research/lsp-auto-diagnostics-staleness.md` (created)
- 票 [#388](https://github.com/hyperion2144/dsh-hashline-edittool/issues/388) (created)

## 2026-10-31 — ADR-0030：诊断新鲜度契约（晚到的诊断只说最新一次写，或不说）（#388）

**Type:** contract（ADR-0030）+ 实现形态变更（异步投递加「最新一次写」守卫）
**Confidence:** High（确定性红→绿回路；根 1921 例 + 2 skipped 全绿；client 300 例 + build 全绿；双 typecheck 干净）
**Evidence:** 票 [#388](https://github.com/hyperion2144/dsh-hashline-edittool/issues/388)；`src/lsp/write-tracker.ts`（新）、`src/lsp/auto-diag.ts`、`src/lsp/sync.ts`、`src/tools/tool-lsp.ts`；`test/core/issue-388-stale-diagnostics.test.ts`（红→绿回路）；`docs/research/lsp-auto-diagnostics-staleness.md`（取证笔记 + 复现记录）

### Why

自动诊断的「新鲜度」此前只有一层：`verifiedReport` 能证明「这份报告对得上我刚写下的文本」，证明不了「这份文本是该文件最新一次写的文本」。两次写同一文件 = 两条后台等待并发注入，第一条的延迟诊断排在第二次的编辑结果之后抵达，模型拿到旧文件的源码行与已经不存在的锚点；更糟的是探针把写时快照 `didChange` 回灌给 server，把 server 的文档视图回滚到模型已经离开的版本。仓内的 push 版本账本（`diagnosticsVersion` / `documentVersion`）本来能判新鲜度，但 tsserver 的推送不带 `version`，比不了 —— 守卫只能由插件自己记账。

### 本轮定案（复核时照此）

- **写路径是唯一知道「文件变了」的地方**：`notifyDocumentWritten`（四个写工具的唯一漏斗）登记每个文档最新一次写的内容 + 一个永不重复的 generation（`src/lsp/write-tracker.ts`，按文档数与字节双预算有界）。
- **一次写 = 一份报告**：交付层捕获自己那次写的 generation，被更新的写盖过时**丢弃**报告（新一轮交付会报最新一次写）—— 模型不会拿到过期的那份，也不会拿到两份同一内容的报告。
- **探针灌给 server 的必须是当前内容**：`verifiedReport` 的 text 由快照改为 resolver（每一步重新取当前内容），回退步推的永远是当前文本，server 的文档视图不会被旧文本回滚。
- **报告的行、锚点、served 集合按「被验证的那份文本」渲染**（`collectReport` 收 text 参数），三者永远描述同一个版本。
- **账本掉了就停**（fail-closed）：文档不在账本里时交付层认为「不是最新」→ 丢弃，而不是猜。

### Path / Affected typed relationships

- `docs/adr/0030-diagnostic-freshness.md` (created)
- `src/lsp/write-tracker.ts` (created)：最新一次写的账本
- `src/lsp/auto-diag.ts`：`deliverDiagnosticsAfterWrite` 捕获 generation；`verifiedReport` 的 text 改 resolver 并返回被验证的文本；`collectReport` 按该文本渲染；`startAsyncWait` 在探针前与注入前各查一次 generation
- `src/lsp/sync.ts`：写路径登记（`noteDocumentWrite`）、删除路径注销（`forgetDocumentWrite`）
- `src/tools/tool-lsp.ts`：手动 `lsp diagnostics` 改用 resolver（内容仍是它自己从磁盘读的快照）
- `test/core/issue-388-stale-diagnostics.test.ts` (created)：红→绿回路
- `AGENTS.md` l0 decisions 0001–0028 → 0001–0029，追加诊断新鲜度主题
- `CHANGELOG.md` `[Unreleased]` Fixed 一行（#388）

## 2026-11-02 — ADR-0031：活的工作目录契约（每次调用按会话「当前目录」解析相对路径）（#394）

**Type:** contract（ADR-0031）+ 实现形态变更（每次调用的 cwd 取点从会话头改为向宿主活取）
**Confidence:** High（确定性红→绿回路；根 1936 例 + 2 skipped 全绿；双 typecheck 干净）
**Evidence:** 票 [#394](https://github.com/hyperion2144/dsh-hashline-edittool/issues/394)；`src/domain/session/live-cwd.ts`（新 seam）、11 个工具的 execute 入口；`test/core/issue-394-worktree-cwd.test.ts`（红→绿回路，6 例）

### Why

会话头里的 `cwd` 是**创建时**的目录，按设计终身不变；而会话的**工作目录**是会动的（进入 worktree、`cd` 都会提交 `working-directory/change`）。插件此前一律按会话头解析相对路径，于是 worktree 切换后：`read` 读回的是旧检出的同名文件，`write`/`edit` 落在旧检出，锚点与 undo 账本也归档在旧检出的 workspace store 下 —— 模型以为自己在 worktree 里改，实际改的是另一棵树。宿主的内置 fs 工具每次调用都向 `workingDirectory` 服务活取，插件与它从这一刻起不再一致。

### 本轮定案（复核时照此）

- **唯一取点**：`src/domain/session/live-cwd.ts` 是插件对「这个会话现在在哪工作」的唯一答案；每次调用向宿主的 `workingDirectory` 服务活取一次（`ctx.get`，可选依赖），不再有第二处取 cwd 的写法。
- **宿主的答案连同它的失败一起算数**：`ensure(agent, signal)` 失败即抛出（内置 fs 工具同样如此），插件绝不替宿主换一个目录；只有**宿主根本没有该服务**（老 harness）时才回落到会话头的 `cwd`。
- **绝不探测磁盘找 worktree**：同一时刻可能有多个检出，只有宿主知道本会话在哪个。
- **一次调用只解析一次**：`withLiveWorkspace(exec, fn)` 把「解析当前目录 + 进入 workspace scope」合成一步，并把同一个值交给回调；ambient workspace、开哪个 store、路径解析、写诊断的 cwd 全部读它，彼此不可能对「在哪工作」产生分歧。

### Path / Affected typed relationships

- `docs/adr/0031-live-session-cwd.md` (created)
- `src/domain/session/live-cwd.ts` (created)：live working directory seam（`liveCwd` 由同步改为异步 + `withLiveWorkspace`）
- `src/domain/session/session-view.ts`：不再自带也不转出 cwd 取点（中间人已除）
- `src/tools/tool-{read,edit,grep,undo,delete,rename,format,write-shadow,ast-grep,ast-edit,lsp}.ts`：每次调用走 `withLiveWorkspace(exec, …)`（解析当前目录 + 进入 scope 一步完成）；`ast_grep` / `lsp` 无 scope body，只取 `liveCwd(exec)`；写诊断的 cwd 改用同一个值
- `CONTEXT.md` 「Language」段：新增 **Live working directory** 词条
- `test/core/issue-394-worktree-cwd.test.ts` (created)：红→绿回路（相对读 / 相对 edit / 相对写跟随当前目录 + store 隔离 + 无服务回落会话头 + 宿主失败即抛出）
- `AGENTS.md` l0 decisions 0001–0030 → 0001–0031，追加「活的工作目录」主题
- `CHANGELOG.md` `[Unreleased]` Fixed 一行（#394）

## 2026-11-03 — ADR-0032：工具注册分层（插件层 vs agent 层）+ `agent/created` 监听器等安装完成（#398）

**Type:** contract（ADR-0032）+ 实现形态变更（11 个工具的注册层按「是否需要遮挡同名内置工具」分开；监听器从同步改为 await 安装）
**Confidence:** High（宿主源码与宿主契约双向确认；6 例回归用例；根 1941 例 + 2 skipped 全绿；双 typecheck 干净）
**Evidence:** 票 [#398](https://github.com/hyperion2144/dsh-hashline-edittool/issues/398)；`src/index.ts`（注册分层 + 安装 promise）；`test/core/agent-tool-registration.test.ts`（新，6 例）；`docs/research/agent-scoped-tools-restart-resume-gap.md`（新，宿主生命周期与层语义的一手取证）

### Why

DSH 重启后恢复一个进行中的会话，**第一轮**的工具面是残缺的：插件的 11 个工具里只有 `edit` 在场，`read`/`write` 退化成内置版（行号语义、无锚点），`lsp` 是官方那个，另外 6 个（`ast_grep`/`ast_edit`/`undo_last_edit`/`format`/`delete`/`rename`）整个不见。下一轮起 11 个全回来。

根因有两条，缺一不可：

1. **注册层用错了**：11 个工具全挂在 agent 层。可只有 5 个（`read`/`write`/`edit`/`grep`/`lsp`）需要遮挡 preset 层的同名内置工具——也只有 agent 层（比 preset 更近）才遮得住；另外 6 个不遮挡任何东西，却跟着 agent 生命周期走：要先有 agent、再等一次 guidance 覆盖文件读盘，才出现在场。
2. **监听器提前返回**：插件的 `agent/created` 监听器是同步的，把安装丢进 effect 就返回。宿主契约明写「Return only after required asynchronous tool and prompt installation completes」，而宿主正是「await 完 `agent/created` 监听器，随后释放恢复会话排队的输入」——恢复路径的排队输入是从磁盘恢复出来的，没有人类打字那几秒的缓冲，于是第一个模型请求在插件其余工具注册前就组装了工具面。

### 本轮定案（复核时照此）

- **一个问句决定注册层**：这个工具需要遮挡同名内置工具吗？需要 → agent 层（`agent.ctx.tools.register`，随 agent 卸载，且只有它遮得住 preset 层）；不需要 → 插件层（`apply()` 里 `ctx.tools.register` 一次，与 `dsh-mnemon`/`tool-goal` 同一注册方式）。
- **插件层 = 宿主的 global 层**：插件自己的 context 没有 scope tag，`ScopedLayers.effect` 落到 `this.global`；`view(scope)` 以 global 层为底、agent 自己的层最后写（更近者胜）。
- **`agent/created` 监听器 await 完整安装**：工具注册排在第一次 `await`（guidance 读盘）之前，于是工具面在 agent 存在的那一刻就齐；监听器 await 完工具与 6 个 guidance 段才返回。
- **监听器绝不 reject**：宿主对监听器抛错是「创建失败」（`api-catalog` 的 `agent/created` 条目），而一次 guidance 读失败不该毁掉一个会话——它降级到编译好的默认文本。安装失败只记日志；`ctx.effect` 在 agent scope 已消失时抛错也必须让监听器返回（永不 settle 的监听器会把宿主的排队输入永久扣住）。
- **`lsp` 的层是「决定」出来的，不是固定的**：官方 `dsh-tool-lsp` 是按需启用的（不在默认组合里），所以「有没有内置 lsp 可遮」只有注册表知道，而它直接改变正确答案——有内置 lsp → agent 层遮蔽它；没有 → 插件层（没什么可遮，遮挡层只会让这个工具晚一轮）。**第一个 agent** 用 `tools.get("lsp", scopeOf(agent.ctx))`（注册之前，这个视图里装的正是内置工具）问一次，答案对之后所有 agent 生效；插件层一层只容一个名字，所以那次注册只做一次。

### Path / Affected typed relationships

- `docs/adr/0032-tool-registration-layers.md` (created)
- `docs/research/agent-scoped-tools-restart-resume-gap.md` (created)：宿主生命周期、层语义、`ctx.effect` 同步/异步行为的一手取证
- `src/index.ts`：拆成 `installPluginTools`（插件层，6 个）与 `installAgentScopedTools`（agent 层，4 个 + guidance 段）；`installAgentTools` 返回安装完成的 promise，监听器改为 async 并 await；`lsp` 走 `lspPlacement()` 动态决定层
- `test/core/agent-tool-registration.test.ts` (created)：9 例（插件层先注册 / 非遮挡工具不上 agent 层 / 只注册一次 / 监听器不早返回 / agent scope 已消失时仍返回 / lsp 三种情形）
- `test/core/agent-event-mount.test.ts`：fake root ctx 补上 `tools` 与 `fs`
- `AGENTS.md` l0 decisions 0001–0031 → 0001–0032，追加「工具注册分层」主题
- `CHANGELOG.md` `[Unreleased]` Fixed 三行（#398）

## 2026-11-03 — ADR-0033：lsp 导航操作（命中行按文件 serve，请求前先查能力）（#396）

**Type:** contract（ADR-0033）+ 新增能力（四个一等公民导航操作）
**Confidence:** High（双 typecheck 干净；全量 1968 例中仅新增用例与既有套件全绿；新增 29 例）
**Evidence:** `src/lsp/capabilities.ts`、`src/render/lsp-locations.ts`（新）、`src/tools/tool-lsp.ts`、`src/lsp/{session,provider}.ts`、`client/src/client/tool-row.tsx`；`test/core/{render-lsp-locations,lsp-navigation}.test.ts`（新，29 例）；内置对照组 `deepseek-harness@ce7073d512` 的 `packages/lsp/tool-lsp`

### Why

本插件的 `lsp` 只能 `symbols` / `code_actions` / `diagnostics` / `request` / `status` / `warm` —— 模型最常问的四件事（定义、引用、实现、悬停）只能走 `request`，还得自己写 0-based UTF-16 列号。DSH 内置 `lsp` 工具正好把这四个做成一等公民，但它的答案是 `path:line:character` 字符串，不可编辑——那不是本插件的契约（能答的行必须能直接 `edit`）。另有一层诚实性缺口：此前从不看服务器 advertise 了什么，未声明的方法会被真的发出去，回来的协议错误或空列表与「那里真没东西」长得一模一样。

### 本轮定案（复核时照此）

- **四个操作，一套光标规则**：`goToDefinition` / `findReferences` / `goToImplementation` / `hover` 成为 operation 值；`findReferences` 恒带 `includeDeclaration: true`。列号由 `symbol` 的 `indexOf` 决定，`character`（1 起）是显式回退——新旧位置操作共用同一个 `resolveColumn`。
- **命中行按自己的文件 serve**：答案指向别的文件，所以每个 distinct 文件读一次、给命中行铸锚并 serve（与 `read`/`grep`/`symbols` 同一对 `anchorForInWorkspace` / `observeServedRows`）。别的文件里的一行因此也可直接编辑。
- **铸锚有上限，位置没有**：单次最多读 `MAX_ANCHORED_FILES`（32）个文件；超出或读不到的文件行保留、锚点为空，文本回退到 `line:character`。丢锚点只是多一次 `read`，丢位置就是丢答案。
- **能力先于请求**：`supportsOperation` 未声明 → `[E_LSP_UNSUPPORTED_OPERATION]` 且一个字节都不发；显式拒绝 `didOpen`（`textDocumentSync: 0` 或 `{openClose:false}`）→ `[E_LSP_UNSUPPORTED_SYNC]`；`textDocumentSync` 缺失仍按未知处理（大量可用服务器不声明它）。
- **位置编码在握手里谈一次**：非 UTF-16 直接 `[E_LSP_BAD_ENCODING]`，manager 把这次抛错变成带原因的失败槽，退避不空转。
- **答案有界且写明**：`maxLocations`（100）+ `min(16 000, responseBudgetChars())`，省略/截断标记计入上限；`No results.` / `No hover information.` 与任何拒绝区分。
- **卡片复用多文件（grep）投影**：导航行属于别的文件，read 投影（单一 `path`）会撒谎；meta 用 grep 投影，客户端 `HashlineLspRow` 优先它、验证不通过再回退 read 投影，不新增组件。

### 未移植（有意）

- seam 的闭合联合与「禁 JSON-RPC 逃生口」：本插件保留 `request`——够到没人包过的方法，在这里比「保证没人够到未包过的方法」更值。
- 内置工具的「强制会话工作区」：本插件走 `liveCwd`（ADR-0031），更贴合。

### Path / Affected typed relationships

- `docs/adr/0033-lsp-navigation-operations.md` (created)
- `src/lsp/capabilities.ts` (created)：操作词汇表 + 方法映射 + 能力/同步/编码读取；`provider.ts` 改为从这里引用（去重）
- `src/render/lsp-locations.ts` (created)：`renderUri` / 位置归一化 / 分组 / 上限 / 悬停文本（纯函数）
- `src/tools/tool-lsp.ts`：四个导航操作 + `character` 参数 + `line`/`symbol` 参数补声明 + 输出 schema（`locations`/`groups`/`truncated`/`totalLocations`/`hover`）+ `timeoutMs` + grep 投影与 search 卡
- `src/lsp/session.ts`：握手后协商位置编码
- `client/src/client/tool-row.tsx`：`HashlineLspRow` 优先多文件卡
- `test/core/{render-lsp-locations,lsp-navigation}.test.ts` (created)：17 + 12 例
- `README.md` / `README.zh.md`：`lsp` 行重写、三个新错误码；删掉「降级启发式后端」这一不实说法
- `CHANGELOG.md` `[Unreleased]` Added 四行 + Fixed 一行
- `AGENTS.md` l0 decisions 0001–0031 → 0001–0033，追加「LSP 导航操作」主题

## 2026-11-03 — #397 评审三修：状态空卡、导航卡名字锁、冷启动索引

**Type:** 缺陷修复（两处显示层 + 一处语义层）+ ADR-0033 补 D9
**Confidence:** High（双 typecheck + 根 1975 例 + 客户端 306 例全绿；新增 9 例）
**Evidence:** #397 评审评论（真人实测四个操作均通，报告三个尾巴）；`client/src/client/models.ts`、`src/lsp/session.ts`、`src/tools/tool-lsp.ts`、`test/core/{lsp-session,lsp-navigation}.test.ts`、`client/test/{grep-card,lsp-status}.test.ts`

### Why

三项均为此前未实测到的洞：状态卡片在没启动任何服务器时画空卡（`slots: []` 仍被视为有效模型）；导航投影到不了卡片（`grepCardModel` 按工具名白名单，`lsp` 不在内，与当年 `ast_grep` 同名锁 bug 同源）；tsserver 冷启动期索引未完，import 符号的 `goToDefinition` 先回 import 说明符（形状与真实答案无法区分）。

### 本轮定案（复核时照此）

- **空列表不出卡**：`slots.length === 0` 时 host 不投影、client 也不认，行落到通用体把句子显示出来。
- **投影按形状不按名字**：`grepCardModel` 白名单加 `lsp`，并补客户端测试钉住（投影合法才穿卡，非法仍回 read/通用）。
- **冷启动有界等待**：`LspSession` 从构造起计数 `$/typescriptProjectLoadingStart` / `End`（首个括号通常在开机时就开了，晚订阅会漏），`projectLoading` + `waitForProjectLoad(15s)`；不发这对通知的服务器按就绪处理（与 D5 对缺席 `textDocumentSync` 的宽大一致）；超时照常发请求。
- **写错文件的教训**：本轮一度把 session 改动写到主检出（`src/lsp/session.ts`），已用 `undo_last_edit` + 定向删除全部回退并 `git status` 验证干净；后续一律用 worktree 绝对路径。

### Path / Affected typed relationships

- `src/lsp/session.ts`：`#projectLoading` / `#sawProjectLoading` 字段、构造期订阅、`projectLoading` getter、`waitForProjectLoad`
- `src/tools/tool-lsp.ts`：导航前有界等待（`PROJECT_LOAD_WAIT_MS`）、空 `slots` 不投影
- `client/src/client/models.ts`：`grepCardModel` 白名单 + `lspStatusCardModel` 空列表返回 null
- `test/core/lsp-session.test.ts`（+4）、`test/core/lsp-navigation.test.ts`（+3）、`client/test/grep-card.test.ts`（+2）、`client/test/lsp-status.test.ts`（+1）
- `docs/adr/0033-lsp-navigation-operations.md`：D8 补实施注记（名字锁）、新增 D9（冷启动索引等待）
- `CHANGELOG.md` `[Unreleased]` Fixed 三行

**更正（同日实测）**：`typescript-language-server` 根本不发 `$/typescriptProjectLoading*`（探针只收到 `window/logMessage` / `$/typescriptVersion` / `publishDiagnostics`），所以 D9 的括号等待对它无效。实测冷启动窗口：`didOpen` 后 ~280ms 与 ~530ms 仍答 import 子句，~790ms 才答真声明。真正生效的是 ADR-0033 D10：若定义答案落在查询文件的 `import` / `export … from` 行且恰好覆盖该符号（真定义不可能长这样），形状命中后每 500ms 重问，直到答案不再是 import 形状或到 15s 截止；`test/core/lsp-navigation.test.ts` 补 3 例（重问后正确 / 一次就正确时只问一次 / 一直浅答则停并如实返回）。根 1978 例 + 客户端 306 例全绿。

**补（同一轮，按用户要求不开新票）**：`lsp status` 无服务器时改为一张自带那句话的状态卡——host 在 `slots` 为空时把 `raw` 作为 `note` 投给 `card: "lsp-status"`，客户端 `LspStatusCardModel` 收 `note?` 并允许空 slots，`LspStatusBlock` 在该情形渲染一句 note（不再返回 null 导致空白体）。旧 meta（空 slots 无 note）仍返回 null 回落通用体。根 1978 例 + 客户端 307 例全绿。

## 2026-11-03 — #397 三轮评审：折叠行宽度 + ADR 让号 0033（#396）

**Type:** 显示层补完 + 文档协调（ADR 撞号）
**Confidence:** High（双 typecheck 干净；根全绿；客户端 309 例全绿；新增 3 例）
**Evidence:** #397 三轮评审评论；`src/render/wire-text.ts`、`src/tools/tool-lsp.ts`、`client/src/client/{locale,tool-row}.tsx`、`test/core/lsp-navigation.test.ts`、`client/test/wire-text.test.ts`

### Why

二轮实测剩两处：导航答案的折叠行只带查询文件路径，不展开不知道答案跳了几个文件；以及本 PR 的 ADR-0032 与 #399 合入的同号 ADR 撞车（两边 l0 都写着 0001–0032）。

### 本轮定案（复核时照此）

- **行尾弱色槽承载「有多宽」**：`rowTitle("lsp", { locations, files })` → `row.title.lsp.nav.stats`（英 `{locations} locations · {files} files`，中 `{locations} 处位置 · {files} 个文件`），params 由 host 携带、文案由客户端 `t()` 解析；查询路径仍是行的 summary。
- **投影不新增组件**：`lspPresentationMeta` 在 grep 投影上附 `rowTitle`，`HashlineLspRow` 的 `titleSuffix` 改走 `rowSuffixText`，与 edit 的 diff stat、grep 的命中计数同一个槽。
- **ADR 让号**：本 PR 的 ADR 改为 `0033-lsp-navigation-operations.md`（#399 先合入占住 0032），`AGENTS.md` l0 合并为 0001–0033，两个主题并存。
- **D10 是截止时间不是次数**：形状命中后每 500ms 重问，直到答案不再是 import 形状或到 15s 截止（三轮实测：冷机重启的索引尾巴超过 5s，预算由 5s 提到 15s）；暖机服务器一分钱不花。

### Path / Affected typed relationships

- `src/render/wire-text.ts`：`RowTitleKind` 加 `lsp`、`RowTitleFacts` 增 `locations` / `files`、`rowTitle` 增 lsp 分支
- `src/tools/tool-lsp.ts`：`lspPresentationMeta` 在 grep 投影上附 `rowTitle`
- `client/src/client/locale.ts`：`row.title.lsp.nav.stats`（en/zh）+ `WIRE_TEXT_KEYS`
- `client/src/client/tool-row.tsx`：`HashlineLspRow` 的 `titleSuffix` 接 `rowSuffixText`
- `test/core/lsp-navigation.test.ts`（+1）、`client/test/wire-text.test.ts`（+2）
- `docs/adr/0033-lsp-navigation-operations.md`：D8 补折叠行宽度注记；文件由 0032 改名而来
- `AGENTS.md` l0 decisions 0001–0032 → 0001–0033；`CHANGELOG.md` `[Unreleased]` Fixed 补一行、D10 措词按截止时间更新

## 2026-11-03 — lsp 的每个答案都有卡片：hover / code_actions / request + 空答案的一句话（#396）

**Type:** 显示层补完（ADR-0033 D11）
**Confidence:** High（双 typecheck 干净；根全绿；客户端 317 例全绿；新增 10 例）
**Evidence:** 用户实测反馈（`lsp hover` 仍是原始输入输出）；`src/tools/tool-lsp.ts`、`client/src/client/{types,tool-row,locale}.tsx`、新 `client/src/client/{lsp-answer,lsp-answer-block}.tsx`

### Why

`lsp` 里只有 `symbols` / `diagnostics` 有行（走 read 卡）、导航四操作有 grep 卡、`status` / `warm` 有状态卡；**hover、code_actions、request 三个答案根本没有行**，read 投影是空的，两个卡片模型都拒收，行就退化成原始输入输出。空答案（`No results.` / `No hover information.`）同理。

### 本轮定案（复核时照此）

- **答案的种类由 host 命名**：`lspPresentationMeta` 对 hover / code_actions / request 分别投 `hover` / `actions` / `json` 字段（连同 `operation` 判别器），不再让它们走 read 投影。
- **一句话也是卡片**：空导航答案投 `note`（`No results.`），空 hover 投 `note`（`No hover information.`），客户端用同一个框画出那句话；`card: "lsp-status"` 除外（那是状态卡的地盘）。
- **一块组件画三种形状**：`LspAnswerBlock` 按判别器画悬停文本（换行包裹）、动作清单（每行 title + LSP kind）、JSON；空动作清单说 host 那句 note，不画空框。
- **不新增 wire key**：这次只有客户端词汇表 `lsp.answer.noActions`（en/zh），host 不往线上发文案。

### Path / Affected typed relationships

- `src/tools/tool-lsp.ts`：`code_actions` 返回值增 `actions`；输出 schema 补 `actions`；`lspPresentationMeta` 增 hover / code_actions / request / 空答案四个分支
- `client/src/client/types.ts`：`LspAnswerModel`（hover|note / actions / json）+ `LspActionMeta`
- `client/src/client/lsp-answer.ts`（新）：`lspAnswerModel`，软校验，任何偏差回 `null`
- `client/src/client/lsp-answer-block.tsx`（新）：`LspAnswerBlock` + 自有样式表
- `client/src/client/tool-row.tsx`：`ToolRow` 增可选 `answer` 槽（在 `lsp` 之后、`diff` 之前），`HashlineLspRow` 接 `lspAnswerModel`
- `client/src/client/locale.ts`：`lsp.answer.noActions`（en/zh）
- `test/core/lsp-navigation.test.ts`（+5）、`client/test/lsp-answer.test.ts`（新，+7）
- `docs/adr/0033-lsp-navigation-operations.md`：新增 D11；`CHANGELOG.md` `[Unreleased]` Fixed 一行

## 2026-11-03 — #397 四轮评审：Windows 上重问循环从未触发（URI 身份比较）（#396）

**Type:** 缺陷修复（语义层）+ 文档重释
**Confidence:** High（双 typecheck 干净；根全绿；客户端全绿；新增 5 例）
**Evidence:** #397 四轮评审评论（Windows 实测 + node 一行实证）；`src/render/lsp-locations.ts`、`src/tools/tool-lsp.ts`、`test/core/{render-lsp-locations,lsp-navigation}.test.ts`

### Why

评审在 Windows 上抓到真因：`looksLikeImportBinding` 对「答案文件 == 查询文件」做**字符串**比较，而两侧拼写不同——tsserver 的答案是 `file:///d%3A/...`（盘符小写、冒号百分号编码），工具问的是 `file:///D:/...`（盘符大写、冒号明文）。解码后只差盘符大小写，`d:\...` !== `D:\...` → 形状检查永远不成立 → **重问循环在 Windows 上从未跑过**。

历轮观察由此重释：冷机/暖机的失败从来不是「预算耗尽」，是循环没跑；穿透成功的案例也从未依赖循环。前两轮的预算之争是伪问题（作者机器是 macOS，mock 两侧同一编码器，Windows CI 跑的是同一批 mock）。

### 本轮定案（复核时照此）

- **按文档身份比较，不按字符串**：`sameDocumentUri(left, right)` —— 两侧都解成路径，Windows 世界里 `win32.normalize` + 小写折叠，其他地方保持精确（大小写敏感的文件系统上 `a.ts` 与 `A.ts` 是两个文件）。`pathToFileURL(fileURLToPath(x))` 不修复大小写（Node 保留原 case），所以折叠必须显式做。
- **世界由 URI 自己决定**：`windowsWorld(uri)` 看 `/X:` 或 `/X%3A` 前缀——`file:` URI 不携带自己的 OS，所以判断只能来自 URI 的拼写。
- **平台无关的回归用例**：直接驱动 URI 字符串（`file:///d%3A/...` vs `file:///D:/...`），不依赖运行机器是不是 Windows；再一条形状检查用例证明「答案在别的文件时仍为 false」。
- **预算保留 15s**：现在是给一个真的会跑的循环的上限；到期时如实返回浅答（那是真答案，只是早的答案）。

### Path / Affected typed relationships

- `src/render/lsp-locations.ts`：新增 `sameDocumentUri`（导出）
- `src/tools/tool-lsp.ts`：`looksLikeImportBinding` 改用 `sameDocumentUri`；该函数导出以便直接测试
- `test/core/render-lsp-locations.test.ts`（+3）、`test/core/lsp-navigation.test.ts`（+2）
- `docs/adr/0033-lsp-navigation-operations.md`：D10 补「形状检查比的是文档身份」与「历轮观察重释」；`CHANGELOG.md` `[Unreleased]` Fixed 一行

---

## 2026-11-03 — `apply_patch`: a change-set tool beside `edit`

**Type:** new decision + new domain surface
**Confidence:** High
**Evidence:** `docs/specs/apply-patch-spec.md` (map #401, five sections),
`docs/research/apply-patch-official-parity.md` (first-hand read of the shipped
0.2.2-alpha.3 `apply_patch`), `src/domain/patch/`, `src/tools/tool-apply-patch.ts`,
`docs/adr/0034-apply-patch-tool.md`

### Why

dsh 0.2.2-alpha.3 ships an `apply_patch` tool (default-off in every shipped
composition, despite the docs), and this plugin has to answer it: same name,
same promise — one change set across files — or the model learns two dialects of
the same idea. The requirement is not parity of syntax; it is parity of the
contract, expressed in this repository's anchor vocabulary.

### What was decided

- **A separate tool, not a mode of `edit`.** The two failure models conflict:
  `edit` is per-file atomic and tolerates partial success, a patch is refused
  as a whole before anything is written and then applied in order, stopping at
  the first failure without rollback. One tool cannot promise both.
- **Grammar A′**: `file` / `new` / `move` / `remove` sections, `replace` /
  `insert` / `delete` hunks, every content line `+`-prefixed. No envelope, no
  `@@`, no old-content lines — the anchor addresses the line and the served set
  is the source of truth, so the patch never restates the file.
- **Default-on**, shadowing a same-name preset tool only when one is actually
  registered (the `lsp` placement rule); off removes the tool and its prompt
  section together on a hot settings flip.
- **Store**: completed updates re-serve through the same window `edit` mints,
- **Card**: one tab per completed section, including a `remove` (a row-less tab is
  still a file). Each `DiffRowGroup` carries the section's `kind` (`added` /
  `modified` / `renamed` / `deleted`) and, for a rename, its `from`; the shared
  diff card turns that into the tab's sentence (a rename's two paths, a removal's
  "file deleted") and the strip strikes a deleted label through. The folded row
  marks each path `+` / `~` / `-` — a bare path list cannot say which file was new
  and which was deleted.
  `remove` uses the delete tool's four-family purge, a move applies at the
  source then migrates rows with `renamePath`.

### Path / Affected typed relationships

- `docs/specs/apply-patch-spec.md` (created, five sections)
- `docs/research/apply-patch-official-parity.md` (created)
- `docs/adr/0034-apply-patch-tool.md` (created)
- `src/domain/patch/{types,parse,plan,preflight,commit,text}.ts` (created)
- `src/tools/tool-apply-patch.ts`, `src/render/patch-card.ts` (created)
- `src/index.ts`（`applyPatchPlacement` + the flag-driven install/rebuild）、`src/config.ts`（`applyPatchEnabled` + 重建触发）、`src/infra/settings.ts`、`src/domain/edit/prompts.ts`、`src/guidance/resolve.ts`
- `client/src/client/{index.ts,locale.ts,settings-card.tsx}`（toolview 键 + 三种标题 + 开关）、`client/scripts/verify-bundle.mjs`（10 个子插件 / 12 个键）
- `client/src/client/{types,models,diff-block,tab-strip,labels}.ts(x)`（`DiffRowGroup.kind` / `from`、`deletedIndexes`、tab 句子与删除线）
- `README.md` / `README.zh.md` / `CONTEXT.md` / `CHANGELOG.md`
- `AGENTS.md`（l0_domains：ADRs 0001–0034）

---

## 2026-11-04 — `apply_patch` 的每一段都复用单功能工具自己的方法（#416）

**Type:** contract（ADR-0034 修正案）+ 缺陷修复（新建文件的行没有锚点）
**Confidence:** High（双 typecheck 干净；根 2023 例 + 2 skipped 全绿；client 321 例 + build 全绿；#416 的三例实测）
**Evidence:** #416（首报 + 排查评论）、`src/domain/patch/commit.ts`、
`src/domain/write/{create-file,rendered-rows}.ts`、`src/domain/delete/remove-file.ts`、
`src/domain/rename/move-file.ts`、`docs/adr/0034-apply-patch-tool.md`（修正案）

### Why

`new` 段自己写了一套创建逻辑：写盘、清 store、用**空 hash 列表**渲染 diff —— 于是模型看到的新
文件内容**一个锚点都没有**（既不是带锚点的行，也不是 ADR-0017 规定的 `[line N] content` 形状），而
store 里该路径 `anchor_lines: 0 / served: 0`，模型想接着改就得先重读一遍。这违反 ADR-0009 的
「everything the model sees」硬规则，而根因是**同一个动作有两套实现**：`write` 的创建路径是好的。

### What was decided

- **每一段复用对应单功能工具自己的方法**：补丁只负责变更集本身（全量预检、按序执行、遇错即停、
  不回滚已成功的）。`new` 走 `write` 的创建路径（自动格式化 → 写盘 → 通知语言服务器 →
  用 `allocateForRenderedRows` 为新文件各行铸造并 serve 锚点），`remove` 走 `delete` 的删除步，
  `move` 走 `rename` 的迁移步。三步各自成为 `src/domain/` 下的一个共享模块，两边都调它。
- **沙箱拒绝是 `failed` 不是 `unknown`**：拒绝意味着「什么都没写」，而 `unknown` 的措辞是「可能写了」。
  patch 的错误分类补上 `sandbox.mapError`，模型因此拿到共享的 `[sandbox: …]` 标记与同轮升级提示。
- **规格随之改写**：`apply-patch-spec.md` 里「`new` serves nothing and allocates no anchors」撤回，
  ADR-0034 加修正案；发给模型的指引与工具描述从「只返回路径」改成「返回自己各行的锚点」。

### Path / Affected typed relationships

- `src/domain/write/create-file.ts`、`src/domain/write/rendered-rows.ts`（新；`allocateForRenderedRows` 从
  `tools/tool-write-shadow.ts` 下沉到 domain，两个工具共用）
- `src/domain/delete/remove-file.ts`、`src/domain/rename/move-file.ts`（新）
- `src/domain/patch/commit.ts`（三段改调共享方法；`CommittedOperation.servedHashes`；错误分类）、
  `src/render/patch-card.ts`（新建文件的 diff 用真锚点）
- `src/tools/tool-{write-shadow,delete,rename}.ts`、`src/infra/sandbox.ts`（`mapError` 容忍缺策略）
- `docs/specs/apply-patch-spec.md`、`docs/adr/0034-apply-patch-tool.md`（修正案）
- `README.md` / `README.zh.md` / `CHANGELOG.md` / `src/domain/edit/prompts.ts`
- 测试：`test/core/issue-416-patch-reuse.test.ts`（新，3 例：新建文件的锚点当场可用、混合补丁两边的锚点、
  沙箱拒绝判 `failed`）

---

## 2026-11-05 — 弃探针式动态定层：`lsp` / `apply_patch` 恒注册 agent 层（#418，ADR-0032 修正案）

**Type:** contract（ADR-0032 修正案，取代 §5 + 2026-11-03 Amendment 对这两个工具的裁决）+ 缺陷修复（重启后恢复会话第一轮两工具缺席）
**Confidence:** High（回归单 #418 一手机理 + 维护者拍板；根 + client typecheck/test 全绿；agent-tool-registration 套件改写 10 例）
**Evidence:** [#418](https://github.com/hyperion2144/dsh-hashline-edittool/issues/418)（报告 + 诊断 + 拍板）；[KannaKuron/dsh-gitbash-shell#38](https://github.com/KannaKuron/dsh-gitbash-shell/issues/38)（同型宿主行为与「同步占位」参考方案）；`src/index.ts`、`test/core/agent-tool-registration.test.ts`

### Why

探针式动态定层（首个 agent 用三值探针问注册表，有同名外来内置 → agent 层，否则 → 插件层）在「重启 + 恢复旧会话」路径上判错：实测两工具仍被放到 agent 层，而内置未开启的部署里 preset 无同名占位，agent 层新名字进不了第一轮 schema → 第一轮缺席，下一轮按步重组才回来。主嫌：`ownToolDefinitions` WeakSet 归属判定是进程内对象身份判定，跨重启对恢复回来的同名声明必然失效；首个 agent 的决策又被按插件上下文缓存的层决策记录放大到全进程。新会话探针判「无内置」→ 插件层 → 第一轮在场，所以只有恢复会话复现。

### What was decided

- **删探针机构**：`builtInToolPresent`（三值探针）、`lspPlacements` / `applyPatchPlacements`（按插件上下文缓存的层决策）、`ownToolDefinitions`（归属 WeakSet）、`LspPlacement` 记录（含插件层 disposer 记账）全部删除；`scopeOf` 导入随之移除。
- **恒注册 agent 层**：`lsp` / `apply_patch` 与 `read`/`write`/`edit`/`grep` 同一路径——agent 安装同步前缀里无条件注册到 agent 自己的层（该层是本插件端到端可控、且在宿主释放恢复会话排队输入之前同步填满的唯一层）。
- **`apply_patch.enabled = false` 简化**：语义不变（该次安装不注册工具、不装 `tool:apply_patch` 段），跨 agent 的插件层 disposer 记账删除。
- **ADR-0032 补记取代关系**：§5 + Amendment（2026-11-03）对这两个工具的动态定层被本票取代；其余裁决（四遮挡工具 agent 层、六非遮挡工具插件层、监听器 await）不变。
- 若隔离实例实测「内置不存在的部署」第一轮仍缺席（宿主第一轮 schema 的占位语义与假设不符），兜底方案 B（换名 + global 层）另行拍板，不在本票内自动执行。

### Path / Affected typed relationships

- `src/index.ts`：探针机构整体删除；`installApplyPatch` / lsp 安装分支简化为无条件 agent 层注册 + 开关判断
- `test/core/agent-tool-registration.test.ts`：探针三值/归属用例删除，改写为「无内置时 lsp/apply_patch 仍注册 agent 层」「开关关断不注册」「监听器 await 不回退（含 apply_patch）」等 10 例
- `docs/adr/0032-tool-registration-layers.md`：Amendment（2026-11-05）
- `docs/specs/apply-patch-spec.md`：注册段改写（不再探针，恒 agent 层）
- `AGENTS.md`（l0 decisions：apply_patch 注册层描述更正）
- `CHANGELOG.md` `[Unreleased]` Fixed 一行（#418）

---

## 2026-11-11 — LSP 一语言双 server 定案：格式化副 slot（#290 → ADR-0038）

**Type:** decision（新 ADR-0038；manager slot 模型的方向拍板，未改产品代码）
**Confidence:** High（票主在 #290 拍板「优先 C 案，其次 A 案」；前置 PR #288 已于 2026-10-19 合入）
**Evidence:** [#290](https://github.com/hyperion2144/dsh-hashline-edittool/issues/290)（决策评论）；[#276](https://github.com/hyperion2144/dsh-hashline-edittool/issues/276)（R1 能力事实）；`src/lsp/manager.ts`（`#slots` 单 slot 现状）；`src/domain/format/manual-format.ts` / `auto-format.ts`（两条格式化路由点）；`src/lsp/install-server.ts`（KNOWN_SERVERS）

### Why

#290 的领域事实：类型/诊断与格式化在 LSP 里是两个独立能力（pyright 无 formatter、rust-analyzer 显式 `false`、bash-language-server / csharp-ls 同样没有），而 manager 一语言一 slot——装 pyright 的 python 用户开 `format.auto` 只能静默跳过，想格式化就得换掉类型 server 丢诊断。票主在 A（多 slot 能力路由）/ B（文档化逃生门）/ C（目录内预配对）中拍板 C 优先、A 回退。

### What was decided

- 新 **ADR-0038**：per-language 格式化副 slot。新设置 `format.servers.<id>`（与 `lsp.servers.<id>` 同形同纪律）；slot 键加 role 轴（默认 primary），现有调用方零改动；只有格式化路由到副 slot（manual 允许冷启动、auto 保持 ready-only）；无设置 = 行为逐字节同今天。
- A 案（全量多 slot 能力路由）记录为回退方向；B 案否决（其逃生门正是 C 要消除的能力损失）。
- 实施拆票：[#424](https://github.com/hyperion2144/dsh-hashline-edittool/issues/424)（双 slot + 设置 + 路由）、[#425](https://github.com/hyperion2144/dsh-hashline-edittool/issues/425)（KNOWN_SERVERS formatter-only 条目 + 文档）、[#426](https://github.com/hyperion2144/dsh-hashline-edittool/issues/426)（python 双 server 真机冒烟）。

### Path / Affected typed relationships

- `docs/adr/0038-format-secondary-server-slot.md`（新）
- `CONTEXT.md`（新词汇区 LSP server slots：Primary slot / Format slot）
- `AGENTS.md`（l0 decisions 行：范围号更正 0001–0036 → 0001–0038（0037 落地时未更），补 0038 一句）
- 拆票 #424 / #425 / #426（wayfinder:task，未排队）
- `docs/CHANGELOG-MEMORY.md`（本条）
