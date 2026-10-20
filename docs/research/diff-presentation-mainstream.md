# Diff 在「模型可见文本」中的呈现：主流 Coding Agent 一手来源调研

> 票 #291 · 调研日期 2026-10-19
> 问题：当 `edit` 工具把 diff 返回给模型时，各工具给多少上下文、如何标注边界、是否给前后对照、有无摘要、模型文本与 UI 是否两套、预算怎么控、有没有「模型读不懂 diff」的实证。
> 纪律：只采信一手来源（官方文档/博客/源码/论文原文）。抓不到的明确写「未找到一手来源」。二手测评不作为机制证据。
> 本仓库侧的事实底稿见 [diff-presentation-repo-facts.md](diff-presentation-repo-facts.md)。

## 0. TL;DR

1. **上下文粒度**：没有任何主流工具默认把「整个外层函数」放进 diff 结果。主流是 ±3~5 行小窗口（Anthropic 族、Gemini CLI）；协议层面唯一会引入函数级标注的是 OpenAI V4A 的 `@@ class/def` 行（按需，替代行号做定位）。Aider 实测「整函数新旧两版」形态**不提示时错误率 +30–50%**，被放弃。
2. **边界标注**的四个流派：`@@` hunk 头（Aider/OpenAI，不带行号）、`cat -n` 行号片段（Anthropic 族/OpenHands）、「窗口前后省略了 N 行」计数（SWE-agent）、文件路径+统计（Goose）。几乎每个工具都会在结果里带**文件路径**。
3. **前后对照**：没有工具把改前+改后两份全文都给模型。给的是 diff 本身（Gemini CLI）或统计摘要（Goose）。Cursor 更激进：干脆不要 diff，让模型全文件重写。
4. **摘要**：机器生成的摘要只到「N added / M removed」统计行（Goose、Gemini CLI 的 diffStat）与「fuzzy 命中在第几行」（Gemini CLI）。**没有发现任何工具做函数级语义摘要**——本插件若做，是差异化而非补课。
5. **两表面分离是共识**：模型可见文本与人类 UI 几乎都是两套实现（Gemini CLI `llmContent` vs `returnDisplay`、Zed 文本结果 vs ACP diff 事件流、Cline `matchIndices` 仅供 UI 定位、VS Code 侧闭源）。
6. **实证**：Aider「Unified diffs make GPT-4 Turbo 3X less lazy」（懒惰率 20%→61%）；SWE-agent 消融（去 lint 门 −3.0 分、压历史 −3.0 分）；SWE-agent「给模型看太多搜索命中上下文反而有害」；Cursor「diff 对多数模型是 out-of-distribution」；OpenAI「用 apply_patch 匹配训练分布」。

## 1. 对比表

| 工具 | 上下文粒度（结果侧） | 边界标注 | 前后对照 | 机器摘要 | 模型侧文本形态 | 预算策略 |
|---|---|---|---|---|---|---|
| Aider | 无结果侧 diff（diff 是模型输出格式）；人类看全量彩色 diff | 输出侧：`@@ … @@` hunk 头，**无行号** | 否（SEARCH/REPLACE 或 udiff 单份） | 否（git log/commit 摘要另算） | edit format 即协议（whole/diff/udiff/editor） | udiff 只对改动区域出 hunk；宽容 patch 应用器 |
| Cline | 结果=保存确认（一手模板未取到） | 输入侧 SEARCH/REPLACE 块；UI 用 matchIndices 定位行号 | 否 | 否 | SEARCH/REPLACE 块流式解析 | 宽容匹配降级链 exact→行trim→块锚点 |
| Roo Code | 结果=确认+错误反馈（同族） | 输入块内强制 `:start_line:` 提示；UI diff view | 否 | 否（consecutiveMistakeCount 防连错） | SEARCH/REPLACE + 行号提示 | fuzzy 阈值 0.8–1.0；BUFFER_LINES=40 中间向外搜 |
| OpenHands | 改动点 ±4 行 `cat -n` 片段（新内容） | 行号前缀（`%6d\t`）+ 文件路径 + 片段标题句 | 否（只给改后片段） | linting 摘要（有则附） | cat -n 编号片段 + "Review the changes…" | SNIPPET_CONTEXT_WINDOW（常量值未验证）；MAX_RESPONSE_LEN_CHAR 截断 |
| Anthropic 参考实现 | 改动点 ±4 行 `cat -n` 片段 | 行号（`%6d\t`）+ 文件路径 | 否 | 否 | cat -n 编号片段 | SNIPPET_LINES=4；maybe_truncate |
| Claude Code | 未取到官方一手结果模板 | 工具描述要求「剥掉 Read 的行号前缀再匹配」 | 未取证 | 未取证 | old_string/new_string 精确替换 | 未取证（闭源） |
| SWE-agent | 编辑后 viewer 重开 100 行窗口（含行号） | 行号 + **窗口前后省略行数** + 文件路径 | 否（单份新内容） | lint 报错摘要（编辑门） | 行号 viewer + `edit <n>:<m>` | 100 行窗口；搜索 >50 命中不展示；历史压缩（有代价，见 §2.8） |
| Zed | 成功：一句话；失败：附 unified diff | 文本侧无标注；UI 侧 ACP diff 事件流 | 否（diff 仅失败时给模型） | 否 | "Edited {path} successfully" / 错误+```diff``` | 无匹配/多处匹配的定向报错；fuzzy 匹配 |
| Gemini CLI | 改动点 ±5 行 diff 片段（`getDiffContextSnippet`） | diff 片段+文件路径+fuzzy 行号反馈 | 片段内天然含 -/+ 对照 | "(N replacements)" + fuzzy 行号 + UI diffStat | llmContent（片段）≠ returnDisplay（全 diff），两条通道显式分离 | 片段限 ±5 行；匹配复杂度上限 4e8 |
| Goose | **不给 diff，给统计摘要行** | 文件路径 + added/removed 计数 | 否 | "Lines added: N / removed: M"（多文件列 created/modified/deleted） | 摘要行；diff 是**输入**（unified diff 参数，强制） | MAX_DIFF_SIZE=1MB；MAX_FILES_IN_DIFF=100；audience/priority 分流 |
| OpenAI Codex（apply_patch/V4A） | 默认每处改动 ±3 行上下文 | `@@ class …` / `@@ def …` banner（上下文不足以唯一定位时，可叠加）；**不用行号** | -old/+new 对照（单份 diff 内） | 结果固定 "Done!" + 前置 warning | V4A diff（Begin/End Patch） | 「上下文够定位就不给更多」；hunk 合并规则 |
| Cursor | 结果侧不返回 diff（模型全文件重写） | 无（输入侧曾参考 Aider `@@` 格式，仅 Opus） | 否 | 否 | 全文件重写 + fast-apply 模型对齐 | fast-apply speculative edits ~1000 tok/s；后来加 Search & Replace |
| VS Code（inline chat） | 模型侧闭源 | 人类 UI：编辑器内联 diff + Keep/Undo | UI 侧 diff | 否 | 未找到一手来源 | 未取证 |
| Continue.dev | 专用 apply 模型把 chat/edit 输出**再对齐**成精确 diff | 模板变量 original_code/new_code | apply 模型吃两份（旧+新） | 否 | apply 角色模型生成的最终代码 | 推荐小模型做 apply（Haiku 级） |

表格约束：每个格子均可在 §2 对应工具小节追溯到链接；「未取证/未验证」为诚实缺标。

## 2. 逐工具证据要点

### 2.1 Aider

- **Edit format 即协议**：`whole`（全文件）、`diff`（SEARCH/REPLACE 块）、`diff-fenced`、`udiff`（unified diff）、`editor-diff/editor-whole`（给专用 apply 模型用）。
  来源：[aider.chat/docs/more/edit-formats.html](https://aider.chat/docs/more/edit-formats.html)
- **udiff 形态**：hunk 头是 `@@ ... @@`，**不带行号**。设计原则四条：FAMILIAR（训练分布）、SIMPLE、HIGH LEVEL、FLEXIBLE。
- **实证（核心）**：博客《Unified diffs make GPT-4 Turbo 3X less lazy》（2023-12-21）。89 任务重构懒惰基准：gpt-4-1106-preview 懒惰率 SEARCH/REPLACE 20%（12 任务被懒惰注释污染）→ udiff 61%（4 任务）；gpt-4-0613 26% → 59%；纯「情感诉求」提示词反而更差。
  原话："GPT is terrible at working with source code line numbers"——所以去行号；"high level diff"（整函数新旧两版）**不加提示时编辑错误率 +30–50%**，故不默认；宽容（lenient）patch 应用机制关掉后错误 ×9（Exercism 基准）。
  来源：[aider.chat/2023/12/21/unified-diffs.html](https://aider.chat/2023/12/21/unified-diffs.html)
- **两表面**：diff 是模型**输出**格式；人类在终端看彩色渲染的 diff 与 git 提交。模型收到的反馈主要是 lint/test 与确认，不回传 diff。（终端产品，无独立 UI 通道；此处为文档+博客推断，机制本身一手。）
- 注：`aider.chat/docs/usage/udiff.html` 已 404（历史页面下线，以博客为准）。

### 2.2 Cline

- 源码 `src/core/assistant-message/diff.ts`（commit `9dea336c`，main 分支该文件已移走，用 commit 路径取到 raw）：
  [github.com/cline/cline/blob/9dea336c/src/core/assistant-message/diff.ts](https://github.com/cline/cline/blob/9dea336c/src/core/assistant-message/diff.ts)
- 输入格式常量 `------- SEARCH` / `=======` / `+++++++ REPLACE`（宽容正则 `[-]{3,} SEARCH`，兼容 legacy `<<<<<<< SEARCH`）。
- 匹配降级链：exact → 逐行 trim → 块锚点（≥3 行时用首末行做锚）。
- **两表面的直接源码证据**：`constructNewFileContent` 返回 `matchIndices`，注释写明 "used to determine the line numbers for each SEARCH/REPLACE block in the UI"——模型文本与 UI 行号高亮是两条独立通路。
- 空 SEARCH + 空文件=新建文件；空 SEARCH + 非空=整文件替换；支持流式增量应用。
- 成功时模型收到的结果文本模板：**未找到一手来源**（本调研未抓到该版本的响应拼装代码）。

### 2.3 Roo Code（Cline fork）

- 官方文档 `apply_diff` 页：
  [roocodeinc.github.io/Roo-Code/advanced-usage/available-tools/apply-diff/](https://roocodeinc.github.io/Roo-Code/advanced-usage/available-tools/apply-diff/)
  - 输入块内**强制 `:start_line:`** 行号提示（`:end_line:` 可选）；fuzzy 匹配=Levenshtein on normalized strings，阈值典型 0.8–1.0；`BUFFER_LINES` 默认 40，围绕提示行**中间向外**搜索。
  - "Shows changes in a diff view for user review and editing before applying"——人类 UI 是可编辑 diff view。
  - `consecutiveMistakeCountForApplyDiff` 追踪每文件连错次数。
- 策略源码：[multi-search-replace.ts](https://github.com/RooCodeInc/Roo-Code/blob/cb836567/src/core/diff/strategies/multi-search-replace.ts)、[search-replace.ts](https://github.com/qpd-v/Roo-Code/blob/0a32e24c/src/core/diff/strategies/search-replace.ts)（`fuzzyThreshold`、`bufferLines`）。
- PR [#6278](https://github.com/RooCodeInc/Roo-Code/pull/6278)：工具描述强调 "surgical edits"（外科手术式小改）；PR [#6642](https://github.com/RooCodeInc/Roo-Code/pull/6642)：为非 Claude 模型增加 simplified diff 策略——**不同模型吃 diff 的能力不同，需要按模型换格式**（一手 PR）。

### 2.4 OpenHands（openhands-aci）

- 源码 [editor.py（OHEditor）](https://github.com/All-Hands-AI/openhands-aci/blob/main/openhands_aci/editor/editor.py)（注释自称源自 Anthropic 参考实现）。
- `str_replace` 成功输出（模型可见）：
  1. `The file {path} has been edited.`
  2. `Here's the result of running `cat -n` on a snippet of {path}:` + `%6d\t` 行号前缀的**新内容**片段，窗口=替换行 ±`SNIPPET_CONTEXT_WINDOW` + new_str 行数；
  3. 可选 linting：`lint_file_diff(old, new)` 有问题则附 `Linting issues found in the changes:`
  4. 固定收尾 `Review the changes and make sure they are as expected. Edit the file again if necessary.`
- 匹配失败先 strip 空白重试；多处命中→报错并列出所有行号；`CLIResult` 携带 `old_content/new_content` 字段（供宿主/UI 用，与模型文本分离）；`undo_edit`；`maybe_truncate` 截断并通知。
- 预算常量 `SNIPPET_CONTEXT_WINDOW` 在 [config.py](https://github.com/All-Hands-AI/openhands-aci/blob/main/openhands_aci/editor/config.py)：**具体数值未验证**（raw 抓取两次失败，返回 67B 存根）；社区 issue [#7115](https://github.com/All-Hands-AI/OpenHands/issues/7115) 证实存在 `MAX_RESPONSE_LEN_CHAR` 响应长度截断配置。

### 2.5 Anthropic 参考实现（computer-use demo）

- [tools/edit.py](https://github.com/anthropics/anthropic-quickstarts/blob/main/computer-use-demo/computer_use_demo/tools/edit.py)：`SNIPPET_LINES: int = 4`；`_make_output` = "Here's the result of running `cat -n` on {desc}:\n" + 行号 `f"{i+init_line:6}\t{line}"`；`old_str` 必须唯一（多处命中→报错并列行号）；`maybe_truncate`。
- 这是「cat -n 编号片段」流派的源头（OpenHands、Claude Code 社区镜像与其同构）。

### 2.6 Claude Code

- 镜像仓库 [Piebald-AI/claude-code-system-prompts](https://github.com/Piebald-AI/claude-code-system-prompts)（自称从 npm `@anthropic-ai/claude-code` v2.1.303 提取，**非官方一手**）：
  [tool-description-edit.md](https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/tool-description-edit.md) 原文要点："Performs exact string replacements in files…"；"preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix… Never include any part of the line number prefix in the old_string or new_string"——**Read 输出带行号前缀，Edit 匹配时要剥掉**（行号是读侧坐标，不是编辑侧协议）。
- Edit 成功结果的官方模板（是否 cat -n 片段）：**未找到官方一手来源**；同族实现（Anthropic 参考 demo / OpenHands）均为片段形态，此处标注为同族推断而非证据。

### 2.7 Zed

- 源码（main）：[edit_file_tool.rs](https://github.com/zed-industries/zed/blob/main/crates/agent/src/tools/edit_file_tool.rs)、[edit_session.rs](https://github.com/zed-industries/zed/blob/main/crates/agent/src/tools/edit_session.rs)。
- 输入 `{path, edits: [{old_text, new_text}, …]}`，流式 JSON 解析；`Edit.old_text` 字段文档："matched using fuzzy matching… **Be minimal with replacements**: for unique lines, include only those lines; for non-unique lines, include enough context"。
- **模型可见结果**（`EditSessionOutput` 的 `Display`）：
  - 成功：`Edited {path} successfully`——**不给 diff、不给内容**；
  - 失败：`{error}\n`；若已有部分编辑落盘，则附 `Edited {path}:\n\n```diff\n{unified diff}\n``` `——**unified diff 只在失败时才给模型**；
  - 无匹配："Could not find matching text for edit at index {i}… Please read the file again"；
  - 多处匹配："matched multiple locations in the file at lines: {lines}. Please provide more context in old_text"。
- **UI 侧完全独立**：经 ACP 工具事件流 `update_diff` / `reveal_range` 把 buffer diff 推给编辑器渲染（diff 由 `language::unified_diff(old, new)` 生成）；错误匹配时还会 `locations` 上报行号供 UI 跳转。
- 读侧配套：`read_file` 输出行号右对齐 6 字符+tab，工具说明要求模型剥前缀（同 Claude Code 惯例）。

### 2.8 SWE-agent（论文 + 官方 ACI 文档）

- 论文：[arXiv:2405.15793](https://arxiv.org/abs/2405.15793)（HTML v3：[arxiv.org/html/2405.15793v3](https://arxiv.org/html/2405.15793v3)）；ACI 设计文档：[swe-agent.com/latest/background/aci/](https://swe-agent.com/latest/background/aci/)
- **file viewer**：100 行窗口，每行前带行号，**窗口上下被省略的行数会明确显示**（「下面还有 N 行」式边界标注）；`edit <n>:<m>` 基于 viewer 行号；编辑落盘后 viewer 自动展示更新后内容——「展示改后内容」就是它的结果侧形态。
- **编辑门（lint gate）**：flake8 选中规则（F821, F822, F831, E111, E112, E113, E999, E902）不通过则**整个编辑被丢弃**并回报。
- **消融数据**（SWE-bench Lite，GPT-4 Turbo，%resolved）：完整 ACI 18.00；去 linting 门 15.0（**−3.0**）；去 demonstration 16.3（−1.7）；历史处理改为「全量历史」（相对默认的「最近 5 条观察+其余折叠成单行」）15.0（**−3.0**）——注意方向：**给模型看更多历史上下文反而更差**。Claude 3 Opus 全量 13.00。
- 设计原则原话："Environment feedback should be informative but concise… when editing a file, updating the agent about revised content is helpful"；搜索结果 >50 条时**不展示任何结果**、要求更精确查询——"Showing the model more context about each match proved to be too confusing for the model"。

### 2.9 Gemini CLI

- 源码（main）：[packages/core/src/tools/edit.ts](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/tools/edit.ts)（EditTool 与 SmartEditTool 已合并，PR [#15857](https://github.com/google-gemini/gemini-cli/pull/15857)）。
- 输入 `old_string/new_string`（`allow_multiple` 可选）；匹配阶梯 exact → flexible（逐行 trim+缩进迁移）→ regex（token 化 `\s*` 连接）→ fuzzy（levenshtein，`FUZZY_MATCH_THRESHOLD=0.1`，复杂度上限 4e8）；失败再走 `FixLLMEditWithInstruction` LLM 自纠错（.json/.ipynb 除外）；`detectOmissionPlaceholders` **拒绝** new_string 里的 "rest of methods …" 占位注释。
- **模型可见结果（llmContent）**：`Successfully modified file: {path} ({occurrences} replacements).` + `Here is the updated code: {snippet}`——snippet 是 `getDiffContextSnippet(oldContent, finalContent, 5)`，即 **±5 行的 diff 片段**；fuzzy 命中时附 `Applied fuzzy match at line(s) X.`。源码注释原话："Return a diff of the file before and after the write so that the agent can avoid the need to spend a turn doing a verification read."——**结果里带 diff 片段的动机是省掉模型的一轮验证读**。
- **UI 侧（returnDisplay）**：`jsdiff Diff.createPatch(fileName, old, new, 'Current', 'Proposed', DEFAULT_DIFF_OPTIONS)` 全量 unified diff + `getDiffStat`（added/removed 行数）；结果对象 `{type:'diff', path, beforeText, afterText}`。**llmContent 与 returnDisplay 是显式两条通道**——两表面分离的第一手工程证据。

### 2.10 Goose

- PR [#4522](https://github.com/block/goose/pull/4522)（merged，text_editor 走 mpatch）：`str_replace` 新增 `diff` 参数（unified diff、可多文件）。工具指示原文：
  - "ALWAYS use the `diff` parameter with a unified diff for one or more files. Not using the `diff` parameter with str_replace is an error"
  - "Always batch file edits together by using a multi-file unified `diff` within a single str_replace tool call. Not batching file edits using `diff` is an error and wastes context, time, and inference."
- **结果=摘要而非 diff**：`Successfully applied diff to {path}:\n• Lines added: N\n• Lines removed: M`（多文件版列 created/modified/deleted）+ `Use 'undo_edit' to revert if needed.`；失败 hunk 报 `First expected line: '...'`。
- **audience 分流**（MCP 扩展）：摘要 `with_audience([Assistant])`，给人看的消息 `with_audience([User]).with_priority(0.2)`——同一工具结果按受众拆分的成套机制。
- 预算：fuzzy 相似度阈值 70%；`MAX_DIFF_SIZE=1MB`；`MAX_FILES_IN_DIFF=100`。
- 相关：PR [#4639](https://github.com/block/goose/pull/4639) "Soften str_replace instructions for weaker LLMs"（再次印证：强指令对弱模型是负担）；PR [#3093](https://github.com/block/goose/pull/3093) `view_range`。

### 2.11 OpenAI Codex / apply_patch（GPT-5 prompting guide）

- 一手来源：[GPT-5 prompting guide](https://developers.openai.com/cookbook/examples/gpt-5/gpt-5_prompting_guide)（含 Terminal-Bench 开发者提示词全文与 SWE-bench verified 附录）。
- **V4A diff 格式规格**（指南原文）：
  - 每处改动**默认上下文 3 行**（前 3 后 3）；相邻改动相距 ≤3 行时共享上下文、不重复；
  - "If 3 lines of context is insufficient to uniquely identify the snippet of code within the file, **use the `@@` operator to indicate the class or function** to which the snippet belongs"（`@@ class BaseClass` … `@@ def method():` 可叠加跳转）；
  - "**we do not use line numbers in this diff format**, as the context is enough to uniquely identify code"；
  - apply_patch 执行后**永远输出 "Done!"**，成败靠之前的 warning 行区分。
- 动机原话："we highly recommend using `apply_patch` for file edits **to match the training distribution**"（参考实现 [openai-cookbook/examples/gpt-5/apply_patch.py](https://github.com/openai/openai-cookbook/tree/main/examples/gpt-5/apply_patch.py)）。
- 这里的 `@@ class/def` banner 是**函数级边界标注**进入主流协议的唯一一手实例，但它出现在**输入**（模型要产的 patch）里，且功能是定位而非「帮模型读懂改动上下文」。

### 2.12 Cursor

- 官方博客 [Instant Apply](https://cursor.com/blog/instant-apply)（2024-05-14，Aman Sanger）：
  - frontier 模型在 "large edits" 上 "struggle… with problems of **laziness, inaccuracy, and high-latency**"；
  - 不用 diff 的三个理由（原文小节标题）："Thinking in Fewer Tokens"（diff 让模型思考 token 变少）、"**Diffs are Out of Distribution**"、"Outputting Line Numbers"（tokenizer+模型数不准行号）；
  - 除 Claude Opus（claude-3-opus-diff）外多数模型 diff 准确率差；格式参考 Aider 的 `@@ … @@` 无行号 hunk；
  - 默认解法=模型全文件重写 + 自训 fast-apply 70b（speculative edits ~1000 tok/s）；
  - GPT-4 还有 "deletes commented out code… tendency to 'fix/clean up' unrelated code"（越界改动）。
- 文档 [cursor.com/docs/agent/overview](https://cursor.com/docs/agent/overview)：agent 现有 Search & Replace 工具（changelog 第 15 页："Search & Replace edit latency reduced by 25%"）。Search & Replace 的模型侧结果形态：**未找到一手来源**（闭源）；`// ... existing code ...` 省略注释仅见于第三方转录，**未验证**。

### 2.13 VS Code（inline chat）

- 官方文档 [Inline chat and Quick Chat](https://code.visualstudio.com/docs/chat/inline-chat)："VS Code shows a diff with the code suggestion **inline in the editor**. Use **Keep** or **Undo** to accept or reject the changes."——人类 UI 侧一手证据（编辑器内联 diff 预览）。
- 模型侧文本形态：闭源，**未找到一手来源**。

### 2.14 Continue.dev

- 官方文档 [Apply Role](https://docs.continue.dev/customize/model-roles/apply) 原话："Chat and Edit model output **often doesn't clearly align with existing code**. A model with the `apply` role is used to generate a more precise diff to apply changes to a file."——承认 chat/edit 模型的输出与现有代码对不齐，用**专用 apply 模型**再对齐一次；模板变量 `original_code` / `new_code`（apply 模型吃前后两份）；推荐 Morph Fast Apply / Relace Instant Apply，或 Haiku 级小模型。
- Edit 流程：[How Edit Works](https://docs.continue.dev/ide-extensions/edit/how-it-works)；源码 [core/edit/lazy/applyCodeBlock.ts](https://github.com/continuedev/continue/blob/cb273098/core/edit/lazy/applyCodeBlock.ts)、[extensions/vscode/src/apply/ApplyManager.ts](https://github.com/continuedev/continue/blob/cb273098/extensions/vscode/src/apply/ApplyManager.ts)。

## 3. 七个问题的跨工具结论

1. **上下文粒度**：共识是**小窗口**（±3~5 行）。把整个函数贴给模型有两类反证：Aider 的 high-level diff 实验（+30–50% 错误）与 SWE-agent 的历史消融（更多上下文 −3.0 分）。函数级信息的主流注入方式是**一行 banner**（OpenAI `@@ class/def`），不是整函数正文。
2. **边界标注**：文件路径人人在给；行号区间、hunk 头、省略计数各有流派（见 §1 表）。注意行号的两种用途要分开：**定位坐标**（SWE-agent/Zed 读侧有效）与**编辑协议**（Aider/Cursor/OpenAI 一致认为模型写行号不可靠）。
3. **前后对照**：无人做两份全文。Gemini CLI 的 ±5 行 diff 片段（-/+ 对照共存一处）是「对照」的最强形态；Goose 干脆只给统计。
4. **摘要**：现有机器摘要全部是**计数**（added/removed/replacements/fuzzy 行号）。函数级语义摘要（「改了哪个函数、哪些分支」）在所有一手来源中均未出现。
5. **两表面**：证据链完整（Gemini llmContent/returnDisplay、Zed 文本 vs ACP 事件、Cline matchIndices、Goose audience、VS Code 闭源）。CLI 与 IDE 产品的差别只是 UI 通道形态。
6. **预算**：手段有窗口（SWE-agent 100 行）、截断（OpenHands MAX_RESPONSE_LEN_CHAR）、硬上限（Goose 1MB/100 文件）、**不展示**（SWE-agent 搜索 >50 条）与**摘要替代**（Goose）。SWE-agent 的消融提示：预算策略本身影响任务分数，压得太狠有代价。
7. **实证**：三组可引用的一手数据——Aider 懒惰基准（20%→61%）；SWE-agent 消融（lint 门、历史压缩）；Cursor/OpenAI 的「训练分布」论述（非基准数字，但是第一方动机声明）。**没有发现**直接以「diff 结果侧形态 → 编辑正确率」为自变量的受控实验；最接近的是 Aider（输出格式为自变量，自建基准）。

## 4. 对 dsh-hashline-edittool 的启示（形态候选）

硬约束：行形状 `<+|-><anchor>:<content>` 不变；模型文本与 web 卡片两表面；目标=让模型读懂被改的函数；token 次要。

### 候选 A：块头（hunk header）+ 省略计数 —— 对齐 `@@` 与 SWE-agent 惯例

- 形态：每个连续改动块的**第一行之前**插一行非 anchor 的块头（类似图例行），内容如 `@@ src/render/edit-diff.ts · myersRange() · lines 102-141 @@`；现有 `...` 折叠行改为 `… skipped 12 lines (jump to line 87) @@ myersRange() cont. @@` 之类。
- 依据：OpenAI V4A 用 `@@ class/def` 替代行号做定位；SWE-agent 明确显示省略行数；两者都是「一行解决边界」的先例。
- 代价：token 极低（每块一行）；兼容性中——新增了一种非 anchor 行，模型需从 guidance 学会跳过（repo 已有图例行先例，风险可控）；实现成本低——genDiff 已有行号，函数名需轻量符号检测（tree-sitter 基础设施已在 ast/ 存在，或正则近似）。
- 卡片侧：块头可作为 diffRows 的分组标题渲染，两表面共享同一 presentationMeta。

### 候选 B：尾部位置摘要行 —— Goose/Gemini 统计行升级

- 形态：结尾句（现有 `Successfully edited … Added N, removed M`）追加 `· edited myersRange() (1 hunk, lines 120-160)`。
- 依据：Goose 统计行 + Gemini fuzzy 行号反馈是该信息量的现有上限；本插件已有锚点→行号映射，成本近零。
- 代价：token 一行；兼容性无（纯追加）；实现低（符号检测与候选 A 共用）。**若只做一件事，先做这条**。
- 局限：一行装不下「分支逻辑变化」这种语义信息——语义摘要无先例，做的话属于自担风险的探索。

### 候选 C：失败路径附上下文 —— Zed 模式（失败才给更多）

- 形态：匹配失败/部分应用时，错误信息附带目标区域更大窗口（如整个外层函数的 anchor 行集），引导模型在**正确的坐标系**里重试；成功路径保持现状。
- 依据：Zed「失败才附 unified diff」；SWE-agent「编辑后自动展示更新后内容」（失败重读是它们验证过的反馈闭环）；Gemini 的错误文案会引导 "please use ReadFile to inspect the target lines"。
- 代价：成功路径 token 不变；兼容性无（错误文本自由）；实现中——需要从失败锚点反查外层符号范围（tree-sitter）。
- 与现有契约的契合点：错误文本属于 guidance 自由区，不动行形状。

### 候选 D：±5 行→可配置更宽的 diff 窗口（含函数边界扩张）

- 形态：把 `contextLines` 从「固定 3」升级为「3，但当块头检测到函数边界在窗口内时扩张到函数首/尾行」，即窗口**吸收整个函数**而不是裁剪到 3 行。
- 依据：这是对用户痛点（「改的是哪个函数、现在什么逻辑」）最直接的回应；但注意 Aider 的 +30–50% 反例是在「新旧两版全文对照」形态下测的，**单份 diff + 函数级窗口**无已知反证，也无正面实证——属于未知区域。
- 代价：token 中（函数小时≈几十行）；兼容性低（仍是 anchor 行，只是更多行带锚点；锚点惰性铸造机制已支持，见 ADR-0009/0010 与 served-rows.ts 的 ctxPad 逻辑）；实现中（需要语言感知的边界检测；无语言时退回固定 3）。
- 建议以 config 开关默认关，实测后再定默认。

### 被否决/需谨慎的形态

- **行号前缀加到每行**（cat -n 风格）：与「行形状不变」硬约束冲突（左列必须留给 anchor），且 Aider/Cursor/OpenAI 三家一致认为模型写行号不可靠；SWE-agent/Zed 的行号是**读侧**坐标，不能直接迁移到 diff 结果侧。若要行号，放块头（候选 A）。
- **整函数新旧两版对照**：Aider 实测错误 +30–50%（无提示时），默认形态不要做；若做，必须按 Aider 结论附带解释性提示。
- **全文件重写**（Cursor 路线）：与本插件「hashline 增量编辑」的根基冲突，仅作为背景认知保留。

### 两表面分工建议

维持「模型文本与 UI 各自从 presentationMeta 取数」的现有架构（与 Gemini CLI 的 llmContent/returnDisplay、Zed 的文本 vs ACP 事件同构）。候选 A/B 的块头与摘要行应同时进 presentationMeta，卡片渲染为分组头/统计徽标，而非让 UI 解析模型文本。

## 5. 未解决的问题

1. **Claude Code 官方 Edit 结果模板**：官方镜像不存在，社区镜像（Piebald-AI，v2.1.303）只有工具描述没有结果拼装代码。当前「cat -n 片段」结论对 Claude Code 本体是同族推断，非一手。
2. **OpenHands `SNIPPET_CONTEXT_WINDOW` 数值**：config.py 抓取两次失败（返回 67B 存根），窗口常量值未验证（机制本身有一手源码）。
3. **Cline 成功结果的模型侧文本**：9dea336c 版 diff.ts 只覆盖解析与 UI 定位，响应拼装文件未定位到。
4. **「diff 结果侧形态 → 编辑正确率」的受控实验**：未找到公开一手数据。Aider 基准最接近但自变量是输出格式；若要为本插件候选 A/B/D 定量背书，需要自建基准（可参考 Aider 的懒惰基准与 SWE-agent 消融设计）。
5. **Cursor Search & Replace 的模型侧结果**与 `// ... existing code ...` 惯例：闭源，未取证。

## 附：取证方法记录

- 平台内搜索（platform_search github）全程 0 结果，改用 exa 搜 blob URL → 取 commit 路径 → 抓 raw@commit；PR diff 用 `patch-diff.githubusercontent.com/raw/{owner}/{repo}/pull/{n}.diff` 直取。
- raw 404 的常见原因是文件在 main 上被移走（Cline diff.ts、Gemini SmartEditTool 同此），用 commit 固定路径可解。
- 论文长文（SWE-agent v3 全文、Goose PR diff）fetch 会溢出到临时文件，用 grep 提取消融表数字。
- 抓取失败的条目（openhands-aci config.py ×2）按纪律记为「未验证」，不用二手数值补位。
