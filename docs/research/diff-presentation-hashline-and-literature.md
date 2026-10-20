# 外部调研：hashline 同名物、锚点/符号寻址编辑面、diff 表示法文献

> 票 [#292](https://github.com/hyperion2144/dsh-hashline-edittool/issues/292) 的外部一半（仓库侧现状取证见 [`diff-presentation-repo-facts.md`](diff-presentation-repo-facts.md)）。
> 调研日期：2026-10-19。来源纪律：只采信一手来源（官方文档、GitHub 源码/README、论文原文、官方 API 元数据）；抓不到一手来源的结论明确标注「未找到一手来源」。所有页面于调研当日实抓，抓取失败或被截断处逐一注明。

---

## 0. 结论速览

1. **「hashline」不是本仓库自造名**：外部至少有 1 个产品特性（Codeform）和 5 个以上独立项目在用这个名字指「hash-anchored line editing」；可见的最早公开出处是 [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)（仓库创建于 2025-12-31，35.9k star），早于本仓库首个提交（2026-08-14）约 7.5 个月。各家是否同源，公开材料无证据。
2. **「让模型看到完整函数块」有外部共识**：Aider 的四原则之一 HIGH-LEVEL（以函数块为单位组织 diff，比逐行手术式 diff 应用错误率低 30–50%）；OpenAI Codex 的 patch 语法用 **`@@ 函数签名行`** 作为 hunk 锚点（无行号）；arXiv:2604.27296 提出把「控制结构/函数」作为 diff 的一致性单元（FuncDiff）。
3. **行号对模型不可靠是反复出现的一手结论**：Aider（「GPT is terrible at working with source code line numbers」，多次基准实验背书）；外部 hashline 项目全部因此改用内容 hash 锚点；Codeform 甚至按模型家族决定是否启用 hash 校验。
4. **没有找到直接研究「diff 呈现形态 → 模型读懂被改函数」的实证论文**。最接近的是生成侧（模型**产出**哪种 diff 格式更准）与应用侧（patch 能否成功 apply），理解侧是空白——这正好是本仓库可以自建实验（`docs/research/diff-presentation-experiment/`）回答的问题。
5. 本仓库的独特形态（**每行都带锚点** + diff 里**上下文行也可编辑**）在外部没有完全同款：外部「每行锚点」派（Codeform、quangdang46/hashline）在编辑返回里**只回变更行**；「无锚点」派（Codex、Aider、Anthropic、MCP filesystem）靠字符串匹配或上下文锚行。

---

## ① A 部分：同类工具逐个机制

### A1. 「hashline」名称考证

| 名称使用者 | 形态 | 锚点格式 | 证据要点（一手） |
|---|---|---|---|
| [Codeform（产品特性 "Hashline Editing"）](https://codeform.io/docs/features/hashline-editing/) | 商业 coding agent 的特性，默认按模型家族开关 | `<line_number>#<hash>\| <content>`，2 字符 xxHash32 hash | 官方文档页：读文件时**每行**附 hash；编辑前校验，不匹配则拒绝并要求重读；校验是**附加性**的（无锚点的编辑直接放行）；开销约 3 字符/行（500 行读入 ≈ +6% token）。页面更新于 2026-04-27 |
| [quangdang46/hashline](https://github.com/quangdang46/hashline) | Rust CLI + 6 工具 MCP server，可接管 Claude Code/Codex/OpenCode/pi 的文件工具 | `LINE:hash\|content`（如 `1:a1\|`），xxh32 | README（raw 全文实抓）：patch 语法 `SWAP 2:b2: + <new line>`；**编辑返回默认紧凑**：`OK path#hash edits=N changed=N` + 仅变更行（`~2:f9\| …`），`--verbose` 才回全文件，`--json` 回变更行数组；块操作 `SWAP.BLK/DEL.BLK/INS.BLK.POST` 按花括号/缩进/Ruby `def…end`（纯语法、**非 tree-sitter**）；stale-read 硬报错 |
| [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) | 独立 coding agent（Stencil Labs 出品） | —（本次未抓其 README 正文） | GitHub API 元数据：`created_at: 2025-12-31`、35,928 star、TypeScript。quangdang46/hashline 的 Credit 节写明「developed based on the idea of hash-anchored line editing. Thanks to can1357 for the original oh-my-pi」——是可见谱系里最早的「hash-anchored line editing」出处 |
| [coctostan/pi-hashline-readmap](https://github.com/coctostan/pi-hashline-readmap) | pi-coding-agent 扩展，接管 read/edit/grep/write/ls/find | `LINE:HASH`（如 `1:f0c\|`） | README（raw 全文实抓）：`set_line/replace_lines/insert_after/copy_lines/move_lines` + 精确文本 `replace` 逃生门；**read 支持 `symbol` 定位与 `map: true` 符号轮廓**（整文件读被截断时自动附 map）；支持**整符号替换**；「structured diffs」细节在其 docs/structured-output.md（本次未抓）。Credit：nicholasgasior/pi-hashline-edit + pi-read-map |
| [RimuruW/pi-hashline-edit](https://github.com/RimuruW/pi-hashline-edit/)、[rainmeter33-jpg/pi-tterhashlineedit](https://github.com/rainmeter33-jpg/pi-tterhashlineedit)、[hackerxj2010/Jean_Code](https://github.com/hackerxj2010/Jean_Code) | pi 扩展 / 独立 agent | 未抓正文 | 仅 GitHub 搜索条目（标题/描述）：「Hash-anchored read and edit tools」「7-stage pipeline with dual anchors + indentation validation」「hashline-anchored patches」。README 抓取 404/未做，正文未采信 |

**结论**：
- 「hashline」作为「hash-anchored line editing」的技术名**已有多个独立外部使用者**，其中 Codeform 是产品级特性、quangdang46/hashline 是带 MCP 的成品 CLI。写文档/提示词时不应假设该名字为本仓库独有，也不宜宣称「hashline 由本仓库首创」。
- 可见的公开谱系：oh-my-pi（2025-12-31，Credit 背书的「original」）→ quangdang46/hashline、pi 系扩展（2026）。本仓库首提交 2026-08-14，晚于 oh-my-pi。**彼此之间是否存在影响，公开材料无任何证据**——只陈述时间线，不下因果结论。
- 各家的锚点细节不同（2 字符 vs 4 hex；`行号#hash|` vs `行号:hash|`），但共同点一致：**锚点放在 read 输出的每一行**，编辑时校验，失配即拒绝。

### A2. 锚点/符号寻址的编辑面：一次改动怎么交给模型

按「锚点放哪、上下文带多宽、模型侧返回长什么样」逐个说明。

#### 1. OpenAI Codex CLI — `apply_patch`（模型产出 diff，hunk 锚 = 上下文行）
- 官方随发行版分发的模型提示词 [`codex-rs/core/gpt_5_1_prompt.md`](https://github.com/openai/codex/blob/main/codex-rs/core/gpt_5_1_prompt.md)（raw 实抓）定义了 patch 语言：`*** Begin Patch` 信封 + `*** Add/Update/Delete File:` 头；`Update` 内每个 hunk 以 **`@@` 行**开头，后跟上下文行：
  ```
  *** Update File: src/app.py
  @@ def greet():
  -print("Hi")
  +print("Hello, world!")
  ```
- **锚点是一段未改的上下文行（示例里就是函数签名），没有行号**——这实际上就是「函数级锚点」：改哪个函数，由 `@@ def greet():` 直接说明。
- 工具执行后**返回给模型的文本**：本次未抓到一手样例（见 ④ 未解决问题 2）。

#### 2. Aider — unified diff（去行号）/ SEARCH-REPLACE（模型产出，无 diff 回显）
- 官方文档 [aider.chat/docs/unified-diffs.html](https://aider.chat/docs/unified-diffs.html)（全文实抓，标题即「Unified diffs make GPT-4 Turbo 3X less lazy」）给出四条设计原则：**FAMILIAR（用模型熟悉的格式）、SIMPLE（避免转义与行号/行数这类脆弱指示符）、HIGH-LEVEL（把编辑组织成实质性代码块——函数/方法——的新版本，而不是对单行做一串手术式修改）、FLEXIBLE（应用时尽量宽容）**。
- 一手实验数字（同一页面）：laziness 基准上 SEARCH/REPLACE 基线 20% → unified diff **61%**（懒代码少 3 倍）；去掉「high-level diff」提示后**编辑错误增加 30–50%**（diff 无法 apply 或产生无效代码）；关闭宽容应用策略后错误**增加 9 倍**。
- 原文论断：「GPT is terrible at working with source code line numbers. This is a general observation about *any* use of line numbers in editing formats, backed up by many quantitative benchmark experiments.」——所以 aider 让模型**不写行号**，把每个 hunk 当作搜索/替换执行。
- 页面上的对照示例（变量重命名）与我们的痛点完全同构：**最小 diff 把旧新行交错在一起，而「high-level diff」呈现函数的两个连贯版本，「much easier to see」**。
- 上下文粒度：Aider 在对话中给模型整个文件内容，编辑落盘；diff 主要给人看（git）。模型侧**没有** diff 回显——与我们的「返回 diff」是相反的组织方式。

#### 3. Anthropic 官方 text editor tool（`str_replace_based_edit_tool`，无锚点）
- 官方文档 [platform.claude.com → Text editor tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool)（实抓，尾部示例被截断）：命令面为 `view`（支持 `view_range` **行号区间**）、`str_replace`（`old_str` 精确匹配）、`create`、`insert`（`insert_line` **行号**）。
- 寻址 = 精确字符串匹配 + 行号参数，**无任何锚点/校验机制**；编辑执行后「Perform the text replacement in the file. Return the results to Claude」——文档正文未写明返回体的具体呈现（示例区被截断，本次未采信任何转述）。
- 意义：Anthropic 自家的编辑面选择了「模型自己保证唯一性」，与 hash 锚点派（Codeform 的动机：「prevents stale file references and silent corruption from non-Claude models」）形成直接对照——Codeform 甚至对 Claude 家族默认关闭 hash 校验，理由是「Strong positional fidelity」。

#### 4. SWE-agent — ACI（Agent-Computer Interface，行号窗口 + 编辑 lint 闸）
- 论文 [arXiv:2405.15793](https://arxiv.org/abs/2405.15793)（NeurIPS 2024，摘要实抓）：接口设计显著影响 agent 表现，「custom agent-computer interface (ACI) significantly enhances an agent's ability to create and edit code files」。
- 官方文档 [swe-agent.com/background/aci](https://swe-agent.com/latest/background/aci/)（实抓）列出四条实证发现：① 编辑命令带 **lint 闸**，语法不正确的编辑不落盘；② 专用文件查看器**每回合只显示 100 行**（带行号）比 `cat` 全文件好；③ 搜索结果必须极简——只列命中文件名，「Showing the model more context about each match proved to be too confusing」；④ 空输出也要显式回话。
- 对我们的可用点：**上下文窗口不是越大越好**（查看器最优窗口是 100 行），以及**编辑闸门**（语法检查拒绝坏编辑）与 Aider 的宽容应用是同一个问题的两侧。

#### 5. MCP filesystem server — `edit_file`（oldText/newText，返回 git 风格 diff）
- 官方 README（[modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers) `src/filesystem/README.md`，raw 实抓）：`edit_file` 用 `oldText/newText` 匹配替换，支持多编辑、dryRun 预览；返回侧原文是「**Git-style diff output with context**」。
- 即：MCP 生态的默认编辑返回是**不带锚点、不带行号的统一 diff**，上下文行不可寻址（只作阅读）。这代表「模型直接改文件」类接口的最低公共形态。

#### 6. 外部 hashline 派的编辑返回（对照本仓库）
- quangdang46/hashline：**默认只回变更行**（每行带新锚点 `~f9|`），上下文要 `--verbose`（整个文件）或 `--json`（结构化变更行数组）才可见。即：锚点每行都有，但**默认 diff 窗口比我们还窄**。
- pi-hashline-readmap：编辑返回是「structured diffs」（README 声明，细节文档未抓），并且把**符号维度**接进读取面：`read({symbol: "registerReadTool"})` 直接按符号取窗、`map: true` 返回符号轮廓、支持整符号替换。
- Codeform：文档只写校验与拒绝形态（「Hash mismatch: … Please read the file again」），**编辑成功后的返回形态未公开**。

### A3. 对照表：锚点放置 / 寻址方式 / 上下文粒度 / 模型侧形态

每个格子都能回溯到上文对应小节的一手来源。

| 工具/接口 | 锚点放置 | 寻址方式 | 上下文粒度 | 改动返回给模型什么 | 作用域信息（函数名/签名） |
|---|---|---|---|---|---|
| **dsh-hashline-edittool（本仓库，现状）** | **read/grep/diff 每一行都带锚点**，diff 的上下文行也带新锚点 | `<+\|-><anchor>:<content>` 行锚点 | hunk ±3 行（`contextLines` 配置） | 图例 + 逐行 diff + 统计行（路径在 diff 之后） | **无**（`diff-presentation-repo-facts.md` §2 实测：函数名/签名不在文本里） |
| Codeform Hashline | read **每行** `行号#hash\|` | 行号+hash 双因子校验 | —（读取面） | 失配 → 拒绝 + 要求重读；成功返回形态未公开 | 无 |
| quangdang46/hashline | read **每行** `行号:hash\|` | hash 锚点（可带行号限定 `2:ab`） | 默认**仅变更行**；`--verbose` 全文件 | `OK path#hash edits=N changed=N` + 变更行（新锚点）；JSON 模式变更行数组 | 无（但块操作按括号/缩进定块边界） |
| pi-hashline-readmap | read/grep/ast_search **每行** `行号:HASH\|` | 行锚点 + 符号定位（`symbol`/`map`） | 按符号取窗或整文件；截断时附符号轮廓 | 结构化 diff（细节文档未抓） | **读侧有**（符号读 + map 轮廓）；编辑侧整符号替换 |
| OpenAI Codex `apply_patch` | 无行锚点；**hunk 锚 = `@@` 上下文行**（示例即函数签名） | 上下文锚行 + 文件头 | 模型自选（通常几行上下文） | 模型产 patch；工具返回体未抓到一手 | **有**——`@@ def greet():` 把签名写进 patch 本身 |
| Aider | 无锚点 | 模型产 diff，去行号，hunk 当 search/replace | 对话内全文件 | 无 diff 回显（直接落盘）；diff 给人看 | HIGH-LEVEL 原则鼓励**以函数块为单位**组织 diff |
| Anthropic text editor tool | 无锚点 | `old_str` 精确匹配；`view_range`/`insert_line` 行号 | 视图窗口（行号区间） | 编辑返回体：官方示例区被截断，未采信 | 无 |
| SWE-agent | 无锚点 | 编辑命令 + lint 闸 | **100 行窗口**（查看器） | 命令输出原样回传（含 lint 拒绝信息） | 无 |
| MCP filesystem `edit_file` | 无锚点 | `oldText/newText` 匹配 | dryRun 预览 / 返回 diff | **Git 风格 diff（带上下文）**，上下文不可寻址 | 无 |

**三个结构性观察**：

1. **锚点每行 vs 只回变更行是两个独立决策**。外部「每行锚点」派在返回侧反而更省（只回变更行）；本仓库是唯一「锚点每行 + diff 含可编辑上下文行」都做的。本仓库 diff 的信息量上限由 hunk 窗口决定，而**不带任何作用域信息是各家「行内形态」的通病**——作用域只可能来自行外（Codex 的 `@@`、pi 系的 symbol 读、Aider 的高层块）。
2. **「模型读懂被改函数」在外部有三条已验证的路径**：把签名放进 hunk 锚（Codex）；让 diff 以函数块为单位呈现两个连贯版本（Aider HIGH-LEVEL）；读取/编辑面直接按符号取窗（pi-hashline-readmap、AutoCodeRover 的检索侧同构）。三者都与我们「diff 行形状不变」的红线兼容——作用域信息可以全部放在**行外**。
3. **行号不可靠 + 精确匹配脆弱**是外部工具转向 hash 锚点的共同动机（Codeform、quangdang46、pi 系的 README 全部以此为卖点）；Aider 则从另一头（去掉模型侧行号）得出同样结论。

---

## ② B 部分：diff 表示法与 LLM 阅读的文献

### 文献清单（一手出处；结论一句）

| 文献 | 一手链接 | 结论一句 |
|---|---|---|
| **To Diff or Not to Diff? Structure-Aware and Adaptive Output Formats for Efficient LLM-based Code Editing**（ACL 2026 Findings） | [arXiv:2604.27296](https://arxiv.org/abs/2604.27296) | 对常规 diff 格式的系统研究发现「fragile offsets and fragmented hunks make generation highly unnatural for LLMs」；提出 **BlockDiff / FuncDiff**——把改动表示为**语法一致性单元（控制结构、函数）的块级重写**——加自适应格式选择 AdaEdit 后，准确率追平全文重写，长代码编辑的延迟与成本降 30%+ |
| **Aider: Unified diffs make GPT-4 Turbo 3X less lazy**（工具作者的一手基准实验，非同行评审） | [aider.chat/docs/unified-diffs.html](https://aider.chat/docs/unified-diffs.html) | 同一模型同一任务，diff 的**组织方式**（高层函数块 vs 交错行 vs JSON/函数调用）造成 20%→61% 的成绩差与 30–50% 的 apply 错误差；FAMILIAR/SIMPLE/HIGH-LEVEL/FLEXIBLE 四原则 |
| **SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering**（NeurIPS 2024） | [arXiv:2405.15793](https://arxiv.org/abs/2405.15793) + [官方 ACI 文档](https://swe-agent.com/latest/background/aci/) | 接口形态（查看窗口 100 行、lint 闸、极简搜索输出）是 agent 成绩的决定因素之一；「interface design affects the performance of language model agents」 |
| **AutoCodeRover: Autonomous Program Improvement**（ISSTA 2024） | [arXiv:2404.05427](https://arxiv.org/abs/2404.05427) | 以 AST/类/方法为检索单元的结构化上下文，比把项目当文件堆更能定位根因（SWE-bench-lite 19%，平均 $0.43）——符号级上下文对「理解问题在哪个函数」有效 |
| **Agentless: Demystifying LLM-based Software Engineering Agents**（2024） | [arXiv:2407.01489](https://arxiv.org/abs/2407.01489) | 分层定位（结构 → 文件 → 类/函数元素）+ 简单修复流程超过复杂 agent——「按代码结构组织上下文」不需要 agent 也有收益 |
| **GumTree: Fine-grained and accurate source code differencing**（ASE 2014） | [DOI 10.1145/2642937.2642982](https://doi.org/10.1145/2642937.2642982) | AST 树编辑距离产生结构化编辑脚本（增/删/移/改）的成熟基线算法；后继工作见 [Fine-grained, accurate and scalable source differencing（ASE 2024）](https://doi.org/10.1145/3597503.3639148) |
| **Change Distilling: Tree Differencing for Fine-Grained Source Code Change Extraction**（TSE 2007） | [DOI 10.1109/tse.2007.70731](https://doi.org/10.1109/tse.2007.70731) | 树 diff（变更类型分类）用于精确提取源码变更的早期经典——AST 级 diff 表示法在软工里有 18 年以上积累 |
| **Can It Edit? (EditEval)**（2023） | [arXiv:2312.12450](https://arxiv.org/abs/2312.12450)（经 [OpenAlex 题录](https://doi.org/10.48550/arxiv.2312.12450)确认） | 面向「按指令编辑代码」的基准（debug/翻译/合并等编辑类型），把「编辑能力」与「生成能力」分开度量 |
| **CodeEditorBench**（2024，ICLR 2025） | [arXiv:2404.03543](https://arxiv.org/abs/2404.03543)（经 [OpenAlex 题录](https://doi.org/10.48550/arxiv.2404.03543)确认） | 四类真实编辑场景（debug/translate/policy-switch/requirement）下评估编辑能力，发现领先模型在编辑上远不如其在生成上的声誉 |
| **Edit, But Verify: An Empirical Audit of Instructed Code-Editing Benchmarks**（2026） | [arXiv:2604.05100](https://arxiv.org/abs/2604.05100) | 指令式代码编辑约占真实编码助手交互的 19%，但直接评测该能力的基准极少；对 150+ 编码基准做审计 |
| **Lost in the Middle: How Language Models Use Long Contexts**（TACL 2023） | [arXiv:2307.03172](https://arxiv.org/abs/2307.03172) | 相关信息在长上下文中部时成绩显著下降——「带多宽的上下文」与「信息放在哪」是两个都要考虑的变量 |

**补充线索（仅题录，未深读）**：[InstructCoder: Instruction Tuning Large Language Models for Code Editing（ACL 2024 SRW）](https://doi.org/10.18653/v1/2024.acl-srw.6)；[When Models Edit Too Much: On the Fidelity of Minimal Code Edits（arXiv:2609.04061, 2026）](https://arxiv.org/abs/2609.04061)——从标题看与「最小 diff vs 模型实际需要的编辑幅度」直接相关，值得后续精读。

### 对我们决策可用的结论（与无关的分开）

**可用**：

1. **「碎片化 hunk + 脆弱偏移」是文献点名的反模式**（arXiv:2604.27296 原文）。我们实测样例（40 行 `myersRange()` 只见 9 行交错 patch）正是这个形态——不是模型变笨了，是表示法把一致性单元切碎了。
2. **一致性单元应该是语法块（函数/控制结构），不是行**：Aider HIGH-LEVEL（应用错误 −30~50%）、BlockDiff/FuncDiff（准确率追平全文重写且省 30%）、Codex `@@` 签名锚（把函数名直接编码进寻址）三条独立证据线收敛。
3. **作用域信息放行外不影响「行形状不变」红线**：Codex 的 `@@` 行、pi 系的 symbol 轮廓都证明「签名/函数名」可以作为独立于 diff 行的信息存在；Aider 把函数级呈现做成系统提示要求也成立。
4. **窗口宽度有非单调效应**：SWE-agent 的 100 行最优窗口与 Lost in the Middle 的中部衰减提示——「整函数带出」要配「函数太长就折叠/降级」的阶梯，不是越宽越好。
5. **编辑闸门有效**：SWE-agent lint 闸、Aider 宽容应用、Codeform hash 校验都在「把坏编辑挡在落盘前/修复于应用时」。本仓库已有对等物（锚点失配拒绝），文献支持继续保留。

**无关/仅背景**（避免误引）：EditEval 与 CodeEditorBench 度量的是「模型完成编辑任务」的成绩，**不区分输入呈现形态**，不能直接当作「diff 形态影响理解」的证据；GumTree/Change Distilling 是**工具侧** AST diff 算法（供生成结构化 patch 参考），不研究模型阅读；Lost in the Middle 是 QA/键值检索任务，外推到代码阅读是类比不是证据。

### 明确缺口

**未找到**任何直接以「同一改动、不同 diff 呈现形态 → 模型对被改函数的理解/后续编辑正确率」为自变量与因变量的实证研究。现有文献全部在生成侧（模型产 diff 的格式）、应用侧（patch 能否落盘）或任务侧（编辑任务成功率）度量。「理解」这个因变量目前没有公开的测量方法——`docs/research/diff-presentation-experiment/` 若做下去，就是在填这个空白。

---

## ③ 对 dsh-hashline-edittool 的启示（可落地形态候选）

前提红线（不推翻）：diff 行形状 `<+|-><anchor>:<content>` 不变；模型文本与 web 卡片两个表面同改；目标是被改函数可读，token 次要。仓库侧代价数据见 [`diff-presentation-repo-facts.md`](diff-presentation-repo-facts.md) §3（锚点惰性分配、48K 响应预算、AST→LSP→启发式降级阶梯）。

### 候选 1：作用域头行（hunk 前插入签名 banner）——便宜，先做

每个 hunk 前插入**非 diff 行**的作用域头，如：

```
Edited in src/render/line-diff.ts — inside myersRange() (defined at :110, 40 lines)
Diff rows: <+|-><anchor>:<content> — ...
```

或按 hunk 粒度：`-- in myersRange() (line-diff.ts:110-150) --`。

- **依据**：Codex `@@` 签名锚（寻址即作用域）、Aider 的对照示例（知道在 `factorial()` 里是读懂交错 diff 的最低要求）、arXiv:2604.27296 把「函数」作为一致性单元。
- **代价**：① 行外信息**不铸锚点**（不碰 ADR-0009/0010 预算）；② 需要作用域来源 → 走 AST→LSP→启发式→纯 diff 降级阶梯（repo-facts §4.2）；③ `src/domain/edit/prompts.ts` 的模型侧提示要同步解释这行新形态，否则模型读不懂（repo-facts §3.3）；④ 卡片侧同步：UI 画函数名比文本更容易（repo-facts §7 问题 4）。

### 候选 2：整函数带出（函数级上下文 + 无关分支折叠）——贵但直击目标

被改行所在函数整体作为上下文行带出；超长函数用 `elide.ts` 的 ElisionSpan 形状折叠未改分支，只展开被改分支所在的控制结构。

- **依据**：Aider 的「high-level diff」示例——函数两个连贯版本「much easier to see」；FuncDiff 的函数级重写在准确率与效率上双赢；本仓库痛点（40 行函数只见 9 行）的直接解法。
- **代价**：① **为整函数铸锚点 + 撑大 served 集**（ADR-0009/0010：渲染行必须与服务行一致，上下文窗口加宽 = 真实锚点消耗）；② 48,000 字符响应预算下，200 行函数 ≈ 12K 字符，多 hunk 会互相挤占（ADR-0013）——需要「函数太长 → 降级为 hunk + 签名头」的阶梯（repo-facts §4.2 已预判）；③ 共享渲染面的 `edit`/`write`/`undo_last_edit`/`ast_edit` 四处同改（repo-facts §3.3）。

### 候选 3：返回尾部的「符号链」一行——几乎免费

结尾统计行旁附一行所在符号链：`scope: src/render/line-diff.ts > myersRange() > (loop d)`。

- **依据**：pi-hashline-readmap 的 `map: true` 轮廓与整符号替换证明「符号坐标」是模型可消费的信息形态；AutoCodeRover 证明符号级上下文帮助定位。
- **代价**：与候选 1 相同的作用域来源问题，但**无窗口/预算影响**（一行文本）；缺点是只有「在哪」，没有「周围是什么」——不能独立解决 40 行函数的阅读问题，适合作为候选 1 的补强或降级档。

**建议的优先序**：候选 1（含符号链）先行——不改 diff 行、不铸锚点、立刻解决「改的是哪个函数」；候选 2 作为用户开关（复用 #244 `line_numbers` 开关模板，repo-facts §5），在长函数场景下实验验证收益后再定默认值。

---

## ④ 仍未解决的问题

1. **理解侧无测量方法**：文献没有「diff 形态 → 函数理解」的因变量定义。若要在本仓库内验证候选 2 的收益，需要自建判据（如「模型能否复述被改函数的分支逻辑」「能否正确发起后续编辑」），目前 `docs/research/diff-presentation-experiment/` 尚无此设计。
2. **两家一手返回体未抓到**：Codex `apply_patch` 工具执行成功后回给模型的文本、Anthropic text editor tool 编辑成功后的返回示例——官方页面/提示词文档均未含（或抓取被截断）。上面所有「模型侧返回形态」结论不含这两家，未用转述填空。
3. **hashline 谱系无证据**：oh-my-pi（2025-12）→ quangdang46 → pi 系与本仓库（2026-08）之间是否有影响关系，公开材料查不到；只能确认名字与思路并行存在。
4. **闭源 IDE 侧未覆盖**：Cursor、Copilot agent mode、Windsurf 的模型侧返回形态无一手文档（它们面向人的 diff 视图不等于给模型看的文本），本调研未采信二手转述。
5. **arXiv:2609.04061（When Models Edit Too Much）未精读**：标题直指「最小编辑的保真度」，可能是「最小 diff 是否符合模型实际需要」的直接证据，值得后续单独调研。

## 附：来源与抓取说明

- 一手来源共 14 个：Codeform 官方文档、quangdang46/hashline README（raw）、can1357/oh-my-pi（GitHub API 元数据）、coctostan/pi-hashline-readmap README（raw）、openai/codex `gpt_5_1_prompt.md`（raw，经 `gh search code` 定位）、Anthropic 官方 text editor tool 文档、aider.chat udiff 文档、swe-agent.com ACI 文档、arXiv 摘要页 ×5（2604.27296 / 2405.15793 / 2404.05427 / 2407.01489 / 2307.03172）、MCP servers filesystem README（raw）、Crossref DOI ×3（GumTree / GumTree 后继 / Change Distilling）、OpenAlex 题录 ×2（EditEval / CodeEditorBench）。
- 仅题录（标题/描述，正文未抓）：RimuruW/pi-hashline-edit、rainmeter33-jpg/pi-tterhashlineedit、hackerxj2010/Jean_Code、arXiv:2604.05100（摘要经检索引擎转写）、arXiv:2609.04061。
- 抓取失败记录：nicholasgasior/pi-hashline-edit 与 RimuruW/pi-hashline-edit README（404，主分支可能已改名）；arXiv export API 与 Semantic Scholar API（限流 429/超时），论文改经 arXiv 摘要页与 OpenAlex/Crossref 题录验证。
