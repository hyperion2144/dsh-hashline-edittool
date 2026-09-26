# Changelog

All notable changes to the `dsh-hashline-edittool` plugin will be documented in this file.

## [Unreleased]

### Docs

- **README 版本支持表与实测数据纠正**：三处陈述已被仓库现状证伪 —— ①当前构建/测试 SDK 基线写的是 `0.1.6-alpha.1`，实际 `@deepseek-ai/dsh-*` 全部为 `0.1.7-alpha.1`（0.9.0 起仅支持 0.1.7，0.8.x 留给 0.1.6）；②兼容性仍写“由 `@deepseek-ai/dsh-settings` peer 依赖 + npm 强制”，该依赖已在 0.9.0 移除，现仅 `@deepseek-ai/schemastery >=3.18.3`；③`test/` 注为 1,210 个测试，实测 113 文件 / 1,330 例。中英两版同步修正。
- **建立 Agent 记忆层**：新增根 `AGENTS.md`（Level 0 入口 + `l0_domains` 导航表）与 `docs/workflows/release.md`（tag-first 发布流程从 `CLAUDE.md` 迁出，单一归属）；`CLAUDE.md` 退化为指向 `AGENTS.md` 的薄指针，消除双入口；知识变更记入 `docs/CHANGELOG-MEMORY.md`。同时删去 `CLAUDE.md` 里早已移除的 `batch_edit` 工具名。

## [0.9.4] - 2026-09-26

### Fixed

- **拒绝回显不再改写已分配的锚点（#187 现场故障）**：回显窗口的分配曾用**重建串** `fileLines.join("\n")`（丢了尾换行）→ `ensureState` 判 checksum 不符 → 触发一次**虚假 realign**，把已分配的有效锚点释放、给同一行重铸新锚。现场表现：`read` 给 `ai:405`，edit 被拒后回显变成 `WQ:405` 并反过来报 `ai` 是 stale。现两处回显分配都改用**文件真实内容**（`verifyServedRange` 新增 `content` 参数、由已有该参数的 `applyEdit` 传入），拿不到真实内容时**跳过分配而不是近似重建**。全 src 排查：无重建串调用点残留；四个锚点入口内部规范化，raw/规范化混用无害。

## [0.9.3] - 2026-09-25

- **行 diff 换成有界 Myers（#190 / #192）**：edit 路径上两处 jsdiff 全文件 diff 都换掉了：`genDiff` 的 `diffLines`（模型看到的 diff）与 `computeHunkDiffs` 的 `structuredPatch`（web 卡片的 hunk），统一走基于行哈希的有界 Myers（单遍 + trace）。20 个形状逐字段对拍全绿。实测 80 万行：行 diff 144–162 MB / ~0.42 s；hunk 407→204 MB。
- **edit 拒绝回显每行都带真锚点（#187）**：E_RANGE_UNVERIFIED 和 E_STALE 回显中每行都分配真锚点、servedRows 记入 served，模型用回显锚点立即重试即可成功。
- **write 的 diff rows 进入 served（#187）**：write 的 diff rows 原来带锚点但没记入 served，现通过 recordServed 记入。
- **`@vscode/ripgrep` 声明为直接依赖（#195）**：rg 预过滤的二级解析在用户机器上三级都可能落空。声明为直接依赖后 rgPath 必然可解析；下载失败时安全回退 JS 引擎。
## [0.9.2] - 2026-09-25

### Fixed

- **`op:"ins"` 锚点漂移（#151/P1）**：`ins` 曾展开为「把锚点行替换为 `[锚点行, ...新行]`」的单行 replace，而 hunk 对齐的 LCS 走「末尾匹配优先」——对 replace 正确（它保留的是收尾行），对 ins 错误。当插入行与锚点行内容相同（在下一条 `}` 下面插入一条 `}`，最常见的形状），旧锚点被配给了**新插入的那行**，锚点行反而重新分配：模型缓存 `MC` 后再编辑，静默落到 div 的闭合括号上，无报错也无警告。现在 `ins` 的 hunk 是空 old 区间（锚点行在 hunk 之外，verbatim 保留），`del` 本就是空 new 区间，`alignPreserved` 任一侧为空即返回空配对——ins/del 不再走 LCS，只有 `replace`/`sed` 会对齐。单条路径、批量路径与 `mutation.ts` 遗留的 `execPipeline` 三处 hunk 计算同步修正，并在三处都补了 del 的纯删除语义。新增 `test/core/issue-151-ins-anchor.test.ts`（11 例：重复内容、块内/块首重复、已编辑文件、批内 ins、文件末尾 ins、del 释放与边界）。
- **单行编辑的重复告警与重复计数（#151/P2、#151/P3）**：单行 replace 的两个 bound 是同一个引用（`anchor_end` 折叠自 `anchor_start`），却被当成两次独立声明——行提示不符时打印两遍 `[E_LINE_HINT]`，锚点失效时报 `2 stale anchors … "UU", "UU"`（实际只有 1 个）。`pinBounds` 对同一 bound 只 pin 一次；`fmtMismatchWithServes` 的 `notFound` 按锚点去重（重复项中带行提示的那条胜出——行提示决定 echo 居中在哪一行）。
- **drift 提示把历史死锚点报成「漂移」（#151/P4）**：`scanDrift` 现在只把「本次编辑前仍有效」的锚点交给 `computeDrift`。会话的 served 集合是累积的，里面还留着更早编辑（或外部改写）释放掉的锚点；之前每次后续编辑都会报 `N anchor(s) outside the edited range drifted`，而实际上没有任何锚点移动——模型白读一遍。措辞同步改成 `are no longer valid`，不再说 drifted；真正被本次编辑在区间外释放掉的锚点仍会报（新增 `scanDrift` 两例钉住两侧）。
- **`undo_last_edit` 只能回退一层（#151/P5）**：`undo` 行族原本 `path` 主键、一行一条，而撤销本身又清空记录，因此最多回退一步。现改为按 path 的有界栈（`UNDO_STACK_DEPTH = 10`），`depth` 是追加计数（最高 depth = 最新，避免重编号撞主键）；成功回退消费栈顶而非清空历史，响应里给出剩余可回退步数。旧库**原地升级**：旧行成为栈顶，刻意**不** bump `HASH_STORE_VERSION`——那会连 `anchor_state` 一起清掉，让会话已服务过的锚点全部失效。新增 `test/core/issue-151-undo-stack.test.ts`（迁移、anchor_state 不受影响、损坏行清栈、连续两次撤销）。
- **`ast_grep` 把覆盖行数报成匹配数（#151/P6）**：`22 match(es)` 里的 22 是被匹配覆盖的**行数**，结构匹配只有 2 个。文本通道现在报 `2 match(es) covering 12 line(s)`（每个匹配恰好一行时保留短形式），JSON 通道同时给出 `matchCount` 与 `total`（`total` 仍是卡片用的行数，卡片「N of M matches」的算法不变）。
- **`lsp request` 丢弃 `textDocument`（#151/P8）**：带 `payload` 时默认参数被整体替换，`{position}` 这类 payload 到服务器手里就没有 `textDocument`（`Cannot read properties of undefined (reading 'uri')`）。现在按需合并：payload 没有 `textDocument` 时补齐，有但缺 `uri` 时补 `uri`，显式给出的文档/uri 原样保留，非对象 payload 原样透传。
- **`grep` 扫大内容造成宿主进程 OOM（#167）**：grep 过去把整棵树的文件**逐个读成完整字符串**再处理，而这条路径上一个尺寸闸门都没有——`read` 有 `MAX_BYTES`（100 MiB）兜底，grep 从未接上（`tool-grep.ts` 不引用该常量，`gatherFiles` 也无文件数/总字节预算）；命中上限只置 `truncated` 标志位、不 `break`，遍历照走到底。于是「读入体积」随命中文件数线性增长、无上限，宿主堆被吃光后进程被 OOM 杀掉、由桌面端拉起——表现为「grep 大内容时概率性崩溃重启」。现在单次 grep 跑在显式内存预算下（新增 `src/infra/read-budget.ts`，纯函数、可单测）：**读前先 `stat`**，单个文件超过 `GREP_MAX_FILE_BYTES`（4 MiB）一律**不读**；全次扫描总量上限 `GREP_MAX_TOTAL_BYTES`（64 MiB），触顶即**停扫**而非继续空转；stat 与实际读入不一致时按真实字节数重新入账，否则文件在 stat 与 read 之间变化就会让上限泄漏；model 侧文本另有 `GREP_MODEL_TEXT_MAX_BYTES`（1 MiB）上限，与卡片 meta 的 64 KiB 预算对齐（此前只有卡片侧有保护）。被跳过的文件绝不静默——`[grep budget]` 提示同时进 model 文本与 `truncated`，否则「被截断的部分结果」会被读成完整答案。新增 `test/core/grep-read-budget.test.ts`（13 例：两侧边界、release 钳位、默认值真为上限、surrogate 不截半）与 `test/core/issue-167-grep-budget.test.ts`（3 例：超限文件跳过但同目录正常文件照常命中、无可用命中时不得报成「无匹配」、普通树不出提示）。
- **Windows（D: 盘）上根套件的 18 项失败（#162）**：逐条定位后绝大多数是**测试侧与平台假设**，但新增的 Windows CI job 上线后又逼出**一个真产品 bug**（见下）：
  - **产品**：`matchInclude` 只按 `/` 切 basename，而 Windows 上 `relative()` 给的是反斜杠；`minimatch` 又是 POSIX 语义（`\` 在那里是转义），于是 `include: "*.ts"` 在 Windows 上**静默匹配不到根目录以下的任何文件**。现在先把相对路径归一成 `/` 再切/再匹配（`src/infra/file-scan.ts`），并新增单测钉住 Windows 形状的相对路径。
  - 模式匹配测试用 `URL.pathname` 解析 wasm 核心路径：Windows 下盘符前会留前导 `/`（`/D:/…`），wasm 文件层再按当前盘解析就成了 `D:\D:\…`，核心加载失败、该文件 7 例整体 skip。改用产品自身 worker 与同族测试都在用的 `fileURLToPath`。
  - 6 个测试文件把 `DSH_HOME` stub 成空串、指望回落 `$HOME/.dsh`；该回落走 `os.homedir()`，Windows 下读 USERPROFILE——于是直接按路径开库的用例报 `unable to open database file`，同文件其余用例则读写开发者**真实** `~/.dsh`（正是全局 setup 要堵的漏）。现一律显式指向 `<temp home>/.dsh`。
  - `~` 展开断言改用与实现同源的 home（环境变量优先），并补一条「无环境 home 时回落 `os.homedir()`」；`DSH_HOME` 用例改喂平台合法绝对根（`/custom/dsh` 在 Windows 是当前盘相对）；两处 grep 输出断言不再写死 `/`。
  - 两个 Windows argv 用例显式钉住 `ComSpec`（原先读机器上的 `%ComSpec%`，Windows 是绝对路径），并补一条「环境指定的解释器优先」用例。
  - 顺手改正一条失真的测试名：它声称 `grep` JSON 源码 bug（`matches dict values come back undefined`），而该断言本机通过，Windows 上真正倒在上一行的分隔符断言。
  - **Windows CI 上线后追加的 7 项**（GitHub runner 的环境差异：`D:\a\…` cwd + `C:\Users\runneradmin` home + 8.3 短名）：`tool-lsp`/`issue-147` 的假服务器用 `file://${FILE}` 拼 uri，而产品用 `pathToFileURL`——Windows 下 `file:///tmp/…` 与 `file:///D:/tmp/…` 不同，3 个诊断用例静默「没有诊断」；改用同一个 `pathToFileURL`。`fs-write` 的 `resolveTarget` 两例把 `tmpdir()`（runner 上是 `RUNNER~1` 短名）与 `realpath`（长名）对比，改用 canonical 的 fixture 根。


### Changed

- **锚点稀疏化重设计（PR #169 评审定案，ADR-0009）**：锚点只分配给**模型看过的行**，唯一性由**持久化的已分配集合**保证，不再依赖整文件预分配。核心变更：
  - **稀疏状态**：每个路径的锚点状态是 `行 → (anchor, contentKey)` 的稀疏映射，持久化在 sqlite 新行族 `anchor_meta`（path/checksum/line_count）+ `anchor_lines`（path/line/anchor/content_key，`(path, anchor)` 索引保证唯一性检查）；旧稠密 `anchor_state` 行族在开库时 **1:1 展开**迁移后删除，已分配锚点一个不丢、不重铸。
  - **惰性分配**：首次访问不再 `assignAnchors` 整文件分配——未服务行没有锚点（视图里是空串占位、不持久化）。每个工具在 serve 点为**恰好要渲染的行**分配：read 分配窗口行、grep 分配命中+上下文行、lsp 分配符号/诊断行、ast_grep/ast_edit 分配匹配行、edit 为 hunk 新行分配。大文件的锚点内存从 O(文件行数) 降到 O(返回行数)。
  - **hunk 感知的编辑后变换**（#151 语义在稀疏模型下的等价实现）：hunk 外的服务行按累积位移平移（锚点不变）；hunk 内内容存活的行经 `alignPreserved` 配对保锚（#122 的“不在 diff 里”不变量）；被替换的释放；hunk 新行由响应 serve 点新鲜分配。`runFileEdits` 对每次编辑和整批各调一次 `updateAnchorsAfterEdit`——稠密模型是纯重建故双调无害，稀疏模型有状态，故检测到状态已推进到 newContent 时早退，避免双重位移。
  - **外部变化走有界 LCS 重排**：无 hunk 结构时（磁盘被外部改写），已服务行按 contentKey 配对到新位置，内容消失的释放；只对已服务行做，未服务行无成本。
  - **BOM/CRLF 规范化保留**：稀疏模型的全部公共入口（`anchorsFor`/`allocateForLines`/`updateAnchorsAfterEdit`/`ensureState`）先规范化内容，raw io.readText（grep/lsp/ast）与 read 的规范化文本产生同一状态（ADR-0008 行空间契约不变）。
  - **grep 按大小硬跳过移除**：`GREP_MAX_FILE_BYTES` 的单文件硬跳过取消（惰性锚点后大文件只花返回行的成本，大文件照搜）；`GREP_MAX_TOTAL_BYTES`（64 MiB）总预算与 model 文本上限保留为内存护栏，触顶停扫并如实提示。
  - **per-content 探针游标保留**：连续同内容行的分配探针连续推进（与 `assignAnchors` 同设计），长重复行段不退化为 O(k²) 探测、不触探针上限。
  - 受影响测试同步重写：`anchor-state-persistence`（稀疏行族、部分服务状态合法性、undo 免 seed 自校正、行级剪枝/TTL）、`alloc`/`anchor-lifecycle-invariants`（serve 语义）、`issue-151-undo-stack`（迁移展开断言）、`issue-167-grep-budget`（大文件照搜 + 总预算停扫）。
  - **工具层完成迁移（评审实测表逐项钉住）**：上一轮只建了 `allocateForLines` 基础设施，read/grep/edit/undo 仍走全量兼容 shim（`lineHashes`），ast/lsp 则用纯函数分配、锚点根本不落库。现在：
    - **read**：`normFile` 只物化视图；窗口渲染器为 `[startLine..endIdx]` 精确分配，并把**已 patch 的数组随渲染结果返回**（工具层的 `read-card` 会用它重建 model 文本——它拿到的是另一份视图，这是“分配了却渲染成空锚点”的真因）。
    - **grep**：`grepFileContent` 在算出命中+上下文行集后精确分配（`context: 0` 时持久化行数 == 命中数）。
    - **edit / undo**：`buildServedRowsFromDiff` 与撤消流程改为“先写盘→按恢复/新内容的 diff 窗口精确分配→用 live 锚点渲染 `+` 侧”，窗口按 `max(2, context_lines)` 对齐实际渲染行；undo 的 `-` 侧保持纯视图（已释放的锚点不再伪造）。
    - **ast_grep / lsp**：分配改走新的 scope-aware 原语 `allocateInWorkspace`——这两个工具没有 `withWorkspace` 主体，裸分配会写进**共享** `$DSH_HOME` 库（served 侧早就有同因的 `serveRowsInWorkspace` 注释），实测 ast_grep 持久化行数因此从 0 变为“恰好命中行数”。
    - **行校验器接受 `""` 占位**：惰性模型会把带空占位的稠密数组交给存储层（undo/snapshot 行族），`isValidHashList` 原本把 `""` 判为损坏行而丢弃整条记录（表现为“历史凭空消失”）。
    - **新增验收测试**（`visible-rows-acceptance.test.ts` + heavy 侧的 `visible-rows-ast.test.ts`）：把评审实测表的每一行钉成断言——3000 行文件上 read 窗口只持久化 10 行、grep 只持久化命中行、edit/undo 只持久化窗口并永不等于整文件、ast_grep 持久化行数恰等于命中数。
- **大纲门槛 100 → 20 行（#151/P7）**：`AST_SUMMARY_MIN_TOTAL_LINES` 降到 20。这道门槛原本的理由是 `read {summary: true}` 会用大纲替换正文，而该能力已随重构删除，唯一调用方变成显式要求「看形状」的 `ast_grep`（不带 `pat`）；`summaryIsWorthIt` 的收缩比仍会拒绝「折了不值得」的文件。效果：31 行的双函数文件现在给出真实大纲（两处折叠区间、行仍可编辑），不到 20 行仍报 `no outline — too-few-lines`。
- **重型测试文件不再与并行池互抢（#162）**：跑 2s–17s 的 5 个文件拆到独立项目、串行执行并各给 30s 预算；**全局 `testTimeout` 保持默认**（抬高全局会把真实挂死一起掩盖），断言一条未删。
- **设置卡回到插件第一层（#171）**：设置卡曾注在行级 `plugins.row.config`（`<包名>#<行 id>`），要点开插件后**再点行上的「配置」**才能看到表单；而当初迁到行级的理由（“bundle 级不传 `form`”）其实不成立——真正的缺陷是卡片**独占依赖页面传的 `form`**。现在：
  - 注册回到 `plugins.bundle.config`，key = 宿主插件 **entry id**（即包名 `dsh-hashline-edittool`）：打开插件即可见配置。`whileServed([entryId], …)` 把注册限定在 Host 真的服务该 namespace 时，未组合 provider 的部署不会留下死卡片。
  - 卡片**自建 controller**：从 0.1.7 的 `configForms` 服务取该 entry 的 form（`configForms.get(entryId)`，与行页面 `form` 同源），经 slot 注册的 `inject` 作为 props 交付，并用 `useSyncExternalStore` 订阅（bundle 页没有 owner 帮我们重渲染）。不再有“设置尚未就绪”陷阱。
  - `verify-bundle.mjs` 同步钉住新槽位/key 与 inject 面（`["slots", "configForms"]`）；新增 controller 面的单测（快照直通、订阅与解绑、mutate 带上 revision、无 controller 时退化为 not-ready 门）。
- **稀疏锚点实机复测的三个缺口（#171 探针）**：重启 DSH 后按“锚点个数”逐工具复测，修掉三处：
  - **read 持久化 0 行**：锚点端口只向**已打开的库**写入（`currentStore()` 从不自己开库），而 `readAndServe` 的顺序是先渲染（分配锚点）后 `recordServed`（那时才开库）——于是 read 渲染出的锚点从未落盘，重启即丢。现在 `readView` 在分配前先开工作区库；同类“首次调用即分配”的缺口一并补上：grep / edit / undo / write 在各自 body 开头 `openWorkspaceStore(cwd)`（新原语），`allocateInWorkspace` 自身也先开库，覆盖 ast_grep / lsp。
  - **ast_grep 可见但不可编辑**：match 分支只分配了锚点、**漏调 `serveRowsInWorkspace`**，于是返回的行带锚点却不在 served 集，edit 一律 `[E_RANGE_UNSERVED]`。现在 match 分支像 outline 分支与 read 一样提交 served 行。
  - **edit / undo 的 served 比 anchor_lines 多 1**：served 是只增集合，而编辑会**释放**被替换行的旧锚点——死锚点留在镜像里造成长期 +1。新增 `reconcileServed(sessionKey, path, content)`：每次编辑/撤销后按 live 集回收镜像，使 served == anchor_lines（实测 read/edit/undo 三步均为 10/10）。
  - 验收测试随之收紧：不再手动开库（由工具自己开，测试才真正钉住修复），并新增 parity 用例（read → edit → undo 全程 served == anchor_lines）与 ast_grep served 用例（其锚点能直接起始一次编辑）。

### Added

- **CI 增加 Windows job（#162）**：矩阵此前只有 `ubuntu-latest`，上面那一类回归只能靠人肉在 Windows 上跑才会发现。新 job 以 `engines` 下限 Node 22 跑 typecheck + 全套测试（版本矩阵与构建仍由 POSIX 侧承担）。
- **锚点库有界化（#172/#180，ADR-0010）**：库曾无界膨胀到 **2.17 GB / 1049 万行 / 34,664 path**。现在三口径预算（**5,000 路径 / 30 万行 / 64 MiB**，任一超限即淘汰，字节按 **`(page_count − freelist_count) × page_size`** 算——物理页数永远回不到预算内）、两层淘汰（`undo` 单路径 2 MiB 上限 + 整路径 LRU、多删 10% 防抖）、TTL 7 天、**4× 淘汰 / 16× 秒级重建**（复用 quarantine 改名 + 24h 节流）、关库 `VACUUM`/WAL checkpoint + `pending_vacuum` 硬崩兜底。
- **冷开修复（#178/#180）**：打开库时**不再无条件跑 `PRAGMA quick_check`**——2 GB / 890 万行实测冷开 **1,674 ms（其中校验 1,345 ms）**，修正为“仅在 `clean_shutdown` 标记缺失（上次非正常退出）时校验”，维护索引挪到预算闸门**之后**建，打开决策记入 `meta.last_open_integrity_check`。验收：预算内的库**第二次冷开 ≤ 50 ms**；超预算的库首次打开自愈、下次收敛（均有新进程回归测试）。
- **表示变更（#176/#180）**：`undo` 的 `resultContent` 换为 **checksum**（最大文本项减半，旧行仍按文本校验）；`served` 从 JSON 数组换为**排序 + delta varint + base64**（实测 2,000 锚点体积 **< JSON 的一半**，且解码不再走 JSON.parse）——`served` **不设上限**，因为它是“这行内容被给模型看过”的防伪造凭证，丢一条就剥夺编辑权；旧格式懒迁移，三种历史形状仍可读。
- **大文件内存与对齐（#181/#182，ADR-0011）**：`alignPreserved` 不再分配完整 `8(m+1)(n+1)` DP 表——**公共前后缀剥离** → 动态阈值 `min(5e7, heap/32)` → 超阈值走**分块对齐**；返空时给模型一句可行动白话（不加新错误码、不打断编辑）。实测保留率：1% 改动 ≥99%、整段平移 100%；**50k×50k 在 256 MB 堆下不再 SIGABRT**（受限堆子进程回归）。
- **存储预算成为设置项（#179）**：`store.max_bytes_mb`（8–2048）/ `max_paths`（100–100000）/ `max_lines`（1万–1000万），越界由 schema 与 `applyEffective` 双层**报错并命名字段**（不静默回落），未设置=常量默认；客户端新增“存储”页签 + 恢复默认。改值在**下一次扫描**生效。
- **修：read 刚给的锚点被判“没服务过”（#180 现场回归）**：served 集合的打包编码把锚点当整数压缩，而锚点是**补零定长**铸造的（`0h`、`00x`），前导零因此被吃掉（`0h` 存成 `h`）——于是 read 返回 `0h:345`、紧接着的 edit 被判 “anchor 0h not in served set”（约 1/62 的锚点中招，表现为“时好时坏”）。现改为**按长度分组 + 组内 delta varint**，逐字节保真；格式标记升级为 `~1`，旧缺陷行判为不可读→自愈删除→下次 read 重新服务（每文件重读一次即可，无需手工修库）。
- **修：一行锚点重复不再作废整个文件的状态**：状态加载时若发现重复锚点（不变量“一个锚点只命名一行”被破坏），原先**丢弃该文件全部锚点行**——后果是模型刚读过的行全部变成 `[E_STALE] anchor no longer exists`。现改为**只丢重复的那些行、保留其余**（首次出现者胜，行列有序故确定性），修复后的投影回写，日志说明丢了几行。
- **noop 提示说清“逐字节相同”与缩进语义（#185 triage）**：`[E_NOOP_LOOP]` 的四条文案不再只说 “range already has this text”（现场被读成“工具归一化/改写了我的文本”，接着连试 ~15 次哨兵把戏）。现在明说：替换与当前区间**逐字节相同**（含空白，工具从不添加/去除/归一化），并给出可行的下一步——**要改缩进就把准确的前导空白写进 `lines`**；三条消息（单编辑提示/批量提示/第三次硬拒）与工具层同步。附 5 条回归测试钉住边界：只改缩进的替换（加宽 / Tab↔空格 双向）**必须落盘**，逐字节相同仍判 noop 且提示含字节与缩进说明。
- **修：write 的 diff 兜底不再做全文件分配（#188）**：写后预览失败时的兜底原走 `lineHashes(整文)`，即为**每一行**铸锚点并落库——80 万行实测 **394 MB 堆 / 29 秒**（稠密分配器无上界，与已被 #182 夹紧的 DP 表同类）。现改为**两遍**：先用稀疏会话视图跑一次文本 diff（便宜：43 MB / 112 ms）得出“将要渲染的行”，**只为这些行**分配（仍是同一个落库入口，只是少分配），再渲染出最终行。等价性有测试保证：同一 before/after 下渲染出的行逐字段（类型/行号/纯哈希/内容）与旧的全文件分配**完全一致**；另一条测试钉住“无变更可渲染时一行也不新分配”。
- **行 diff 换成有界 Myers（#190 / #192）**：edit 路径上**两处** jsdiff 全文件 diff 都换掉了：`genDiff` 的 `diffLines`（模型看到的 diff）与 `computeHunkDiffs` 的 `structuredPatch`（web 卡片的 hunk），统一走**基于行哈希的有界 Myers**（单遍 + trace）：公共前缀/后缀直接配对、距离超 `DEFAULT_MAX_D`（256）就二分重试、再超才退化为整块替换并置 `degraded`。hunk 按统一 diff 语义分组（2×context 内合并、两侧各带 context 行）。语义不失：**两组逐字段对拍全绿**——`genDiff` 13 个形状（`diff` 字符串 / `rows` / `servedRows` / `firstChangedLine`，含尾换行边界、整文件重写、空侧、重复行、重排式编辑）；`computeHunkDiffs` 7 个形状（与旧的 `structuredPatch` 实现逐字段一致，含合并/拆分 hunk 的临界间距）。实测 80 万行 / 45.6 MB：行 diff 144–162 MB / ~0.42 s（最坏情况从此有上界，jsdiff 无）；hunk **407 MB → 204 MB**（耗时 251→522 ms，仍亚秒级且可预测）。


## [0.9.1] - 2026-09-23

### Fixed

- **LSP 异步诊断注入不再中断会话（#165）**：注入消息的 `source.kind` 沿用了 v3 保留值 `"plugin"`，dsh 0.1.7 的 v4 会话准入拒绝该 kind（`format v4 message requires a producer-owned source kind`），消息在持久化前被拒、当轮会话随之中断——仅在异步诊断真正到达时触发，故发布冒烟（无 LSP 服务器）全绿、测试也因断言钉死了旧形状而全绿。现改为生产者自有 kind `plugin:<plugin-name>`（与 v3→v4 迁移对第三方插件的推导产物一致），并移除随旧包装一起废弃的 `plugin` 字段；钉死旧形状的断言同步更新并加防回归守卫（kind 非空且 ≠ `"plugin"`、无 `plugin` 字段）。

## [0.9.0] - 2026-09-23

### Changed

- **dsh 0.1.7 适配（wayfinder 地图 #152）**：host 设置面迁移到 Profile 插件配置——
`Config` schema 全字段 `.volatile()`，`apply(ctx, config)` 以活引用读值并在 `settings/document-updated` 重应用；旧
`settings.yaml` 的 `hashline:` 节一次性导入（宿主白名单不含第三方命名空间）；client 半边
`inject` 去 `settingsScope`，设置卡经行级槽位读 `form.state` / 写 `form.mutate`；`@deepseek-ai/dsh-*`
升级至 0.1.7-alpha.1、schemastery ≥3.18.3，`@deepseek-ai/dsh-settings` 依赖移除；
`settings-provider.ts` 死代码删除；client 图标改名跟进。仅支持 0.1.7（0.8.x 留给 0.1.6）。
- **内置 preset 种子对齐 0.1.7（#154 / #160）**：`DEFAULT_PRESETS` 中 `code` → `ptc`（0.1.7 内置为 `standard`/`ptc`/`minimal`/`cordis`，`code` 已不存在，保留只会生成永远无法命中的死目录）；guidance home README 双语文本量同步。调研依据：`docs/research/preset-ids-0.1.7.md`。

### Fixed

- **设置卡改注行级槽位（冒烟发现）**：0.1.7 的插件页只在**行级** `plugins.row.config`（key 为 `<包名>#<行 id>`）随 owner props 交付 `form`；bundle 级 `plugins.bundle.config` 仅传 `view`——注册在那里的设置卡永远停留在「设置尚未就绪」。卡片改注行级槽位（key `dsh-hashline-edittool#dsh-hashline-edittool`），`verify-bundle.mjs` 同步钉住新槽位/key。
- **折叠组内展开卡片闪烁（冒烟发现）**：`TabStrip` 的宽度追踪 effect 缺依赖数组，每次 render 重建 ResizeObserver，而 `observe()` 必先同步回调一次；0.1.7 折叠过程组隐藏时元素宽度报 0、展开报实宽，值振荡叠加 observe 自触发形成 set→render→重建→再 set 的闪烁死循环。修复：observer 只建一次；宽度为 0（隐藏态）视为无信息忽略；同值经 functional set 由 React bail 吸收。

## [0.8.1] - 2026-09-20

### Fixed

- **The settings card renders on the plugin manager's bundle page (#149)**: the client half registered its configuration card on the retired `settings.plugin.item` slot, which current DSH (0.1.6-alpha.2) consumes nowhere — so the plugin's entry in the plugin manager opened to a switch and component facts with no settings at all. The card now registers on the keyed `plugins.bundle.config` slot under the bundle's package name (`dsh-hashline-edittool`), the key the page indexes entries by, and answers the page's two views: `summary` renders the one-liner, `page` renders the form without the card chrome the page now draws (the card's own title/description header went with it). Declared behavior change: a runtime old enough to still consume `settings.plugin.item` shows no settings card — that slot is dead in every runtime this release targets. The view decision and summary text move to the new pure seam `client/src/client/settings-model.ts` so the unit suite stays free of the primitives import graph, and `verify-bundle.mjs` now pins the new slot/key against the shipped artifact.
- **The inline auto-diagnostics window is 1s (#131 follow-up)**: `INLINE_WINDOW_MS` 800ms → 1000ms — a hot typescript-language-server's push tail runs past 800ms, and 1s stays inside the human-perception band; a server with nothing to say still costs no more than the window once per write. Stale "300ms window" comments across the delivery call sites now name the window without a number that rots.

- **Every line-number-producing tool reports lines in read's line space (#147)**: `grep`, `lsp`, `ast_grep` and `ast_edit` used to split the raw `io.readText` text on `\n` only, while `read` (and the anchor allocator) normalize through `toLF` — on any file carrying bare CRs (progress-bar / ANSI overwrite logs), their line numbers, row contents and anchor pairings drifted from read's by the cumulative number of CRs above each line (a 1.14 MB log with 290 stray CRs read as 3774 grep lines vs 4064 read lines, offsets 173→198→229). All four now fold CRLF / bare CR / LF to LF at the read boundary and hand that one text to the matcher, the AST client, the language server and the row splitter alike, so a match row is byte-identical to the read row at the same number and directly editable. Declared behavior change: a regex that matched ACROSS a bare-CR boundary (`alpha.r` inside `alpha\rbeta`) no longer matches — the CR is a line boundary now; grep also stops showing invisible trailing CRs on CRLF files' rows. The LF-only `linesOf` duplicate in tool-grep is gone (`visLines` serves the json context lookup). New suite: `test/core/issue-147-line-space.test.ts` (9 cases: grep text/json/cross-CR/CRLF, lsp symbols/sync/diagnostics, ast_grep/ast_edit against a real in-process tree-sitter worker).

## [0.8.0] - 2026-09-19

### Added

- **Structured error values + error cards across all 8 tools (#137, #139, #140, #146)**: tools no longer throw domain errors (`[E_*]`) at dsh — each `execute` boundary catches and returns a success-shaped `{ modelText, error }` value whose persisted `meta.error` (`code` / `message` / `path` / `context` / `hint`) the client renders as a red-dotted ErrorCard (code chip, path, message, the ±context echo block, and the hint). Model-facing text stays byte-identical to the thrown messages; JSON output mode emits a pure JSON error object. Stale and declared rejections keep serving fresh anchors inline — the echo rides `error.context`. Legacy `isError` logs degrade to a synthesized card. Domain-error conversion is whitelist-scoped (ADR-0007): aborts, sandbox denials and unexpected crashes still throw for the host.
- **`lsp diagnostics` freshness guarantee (#141)**: manual diagnostics and the write/edit/undo auto-delivery now go through `verifiedReport` — pull-first (`textDocument/diagnostic`) when the server advertises it, otherwise a sentinel probe: a `didChange` referencing a per-call nonce whose syntax error the server MUST report proves the pipeline reached the probe state, the revert back to the real content settles a push without the nonce, and only that report is delivered. typescript-language-server 6.0.0 supports neither pull nor versioned pushes, and the old delivery accepted any unversioned push — which systematically served pre-change diagnostics. The budget can now time out to an honest "no answer yet" instead.
- **`read`'s header is line-numbers aware (#141)**: `ANCHOR:LINE|CONTENT` with an explicit "the line number is a positional hint only, NOT part of the anchor" legend when `line_numbers` is on; `ANCHOR|CONTENT` when off.
- New test suites: `test/core/error-result.test.ts` (25 cases: builder, recognizer, every tool boundary with in-place schema conformance, JSON mode, presentationMeta, end-to-end echo, abort rethrow, multi-file fail[]) and `client/test/error-card.test.ts` (15 cases: the degradation matrix and row states).

### Fixed

- **Error results pass the host's enforced required-fields validation (#141)**: `defineTool` hoists authoring-side `required: true` into object-level required arrays and the host rejects a value missing them — each tool's error value now carries its witness fields (e.g. grep's `files: [], truncated: false, total: 0`), so live errors render as cards instead of dying as `invalid output`.
- **Multi-file aggregate errors are lossless-JSON clean (#141)**: the all-failed aggregate omits the `path` key instead of carrying an explicit `undefined` (which the host's lossless check rejects), and the card header shows a path only when exactly one file failed.
- **Manual `lsp diagnostics` no longer serves the pre-change report (#141)**: the `arrivedAlready` short-circuit returned whatever was cached — now the same verified flow backs the manual operation.
- **`read`'s dynamic header is pinned by 14 test sites**; the legacy single-form header is retired.

### Docs

- ADR-0007: the domain-error whitelist conversion boundary (why aborts/sandbox/crashes rethrow while `[E_*]` returns).
- CONTEXT.md: structured error value, `meta.error`, domain error.

## [0.7.3] - 2026-09-18

### Fixed

- **Served mirror is an anchor set (#143)**: the per-session served mirror stored `(string | null)[]` positions, and every path that moved lines without migrating it (external-change inheritance, positional healing) left stale entries behind — the same anchor was then "served at two positions" and tripped the `[E_SERVED_DUP]` warning on each merge. The mirror is now a `Set<string>` of served anchors: anchors are content identity, not line-number aliases, position is always resolved live from the current anchor array, and the `[E_SERVED_DUP]` code is retired because the structure can no longer express a duplicate.
- **Multi-hunk anchor leak in `updateAnchorsAfterEdit` (#143)**: the incremental updater released every hunk-range anchor up front and re-claimed survivors per hunk, so with multiple hunks a new line in an EARLIER hunk could be allocated an anchor still owned by a surviving line in a LATER hunk. Survivors are now pre-computed across all hunks before any allocation, and a persisted state that already carries duplicate anchors is healed and the edit refused loudly with `[E_ANCHOR_STATE_DUP]`.

## [0.7.2] - 2026-09-17

### Fixed

- **Anchor state persisted per project (#136)**: the per-path anchor state no longer lives only in a 256-entry in-memory LRU. It is persisted per cwd + path in the sqlite hash-store (new `anchor_state` row family), the memory Map is a plain front-end with cross-process checksum invalidation, and every `assignAnchors` fallback path (LRU eviction, poisoned snapshot, legacy state) is gone: eviction and restarts recover the persisted state, external changes diff-inherit against it, and a damaged state heals positionally (keep surviving anchors, allocate only the gaps) with a loud `[E_ANCHOR_STATE_POISONED]` notice. This is the fix for large-file edits rejecting with `line was never served` / `served mirror is stale` after the model had touched many files.
- **`updateAnchorsAfterEdit` lineKeys bug (#136 follow-up)**: the incremental updater persisted contentKeys OF THE ANCHOR STRINGS instead of the new lines, so the diff-inheritance basis was garbage — the first external change after a tool edit could not align and reshuffled every line's anchor. It now persists the new content's real per-line contentKeys.
- **Served-mirror duplicates are evidence, not noise (#136)**: `_mergeServedRows` no longer purges a duplicate anchor binding (last-write-wins) — that silent nulling destroyed served records and manufactured `never served` rejections. Duplicates are kept, named by a `[E_SERVED_DUP]` warning, and verification stays positional.
- **Served-record failures are loud (#136)**: `recordServed` / `recordServedTruncated` / `recordServedAfterEdit` no longer swallow storage failures. Completed writes surface `[E_SERVED_RECORD]` as a response warning (edit/undo) or drift-notice line; rejection flows keep their primary error while logging the record failure.
- Anchor-state rows join `pruneMissing` (deleted files) and get a 30-day TTL sweep on store open; a hash-store version bump wipes them with the other row families.
## [0.7.1] - 2026-09-16
### Fixed
- **dsh 0.1.6 compatibility (#134)**: dsh 0.1.6 renamed the agent-start event `agent/session-start` → `agent/created`; the plugin registered a listener nobody emitted, so hashline tools never mounted and sessions silently fell back to the built-in tools. The plugin now registers BOTH event names (new harness emits `agent/created`, older ones emit `agent/session-start`; the other is a silent no-op, and a WeakSet keeps double arrival idempotent).
- dsh 0.1.6 moved `systemPrompt` from a Context property to a scoped service — the plugin now resolves `systemPrompt` per agent scope and degrades to a warn-and-no-op stub when absent, so prompt-section loss can never fail the tool install.
- dsh devDependencies bumped to `0.1.6-alpha.1` with the new peer packages (`dsh-scope`, `dsh-system-prompt`, `dsh-ptc-runtime`, `dsh-invariants`, `dsh-user-approval`, `dsh-sandbox-policy`, `dsh-session-projection`, `dsh-typert-protocol`, `dsh-brand`); `.npmrc` pins `legacy-peer-deps` for the 0.1.2-transitive peer conflict.
- CI: the client workspace suite resolved the ROOT vitest config and failed on a missing `client/test/setup.ts`; the client now ships its own setup file and the root suite excludes `client/**` (it has its own workspace job).

## [0.7.0] - 2026-09-16

### Added
- **Unified anchor lifecycle**: anchors are allocated only on first serve or actual content change; rewrites and external changes inherit by line alignment — unchanged lines keep their anchors, and there is no whole-file recompute for files that already carry anchors.
- **Anchor exclusivity**: one live anchor names one line — served-mirror single-ownership purge, dead ambiguity guard removed, and `[E_ANCHOR_AMBIGUOUS]` hard error on ambiguous resolution (kills the silent first-occurrence relocation).
- **Content-base normalization inside the lifecycle gate**: BOM/CRLF raw paths (grep/lsp/ast) now allocate identical anchors to read/edit.
- Served-mirror v2 persistence format with parallel content keys (backward compatible), `loadServedKeys`, and `applyEdit` `servedContentKeys` plumbing.
- README: card gallery image, DSH version-support matrix.

### Fixed
- `write` no longer poisons the session anchor store with pre-write anchors (`beforeHashes` captured chronologically).
- `undo` re-seeds the engine with `undo.hashes` — the revert diff's advertised fresh anchors are real.
- grep `recordServed` passed the anchor-pool bound as a line count; LRU now refreshes recency on hit (was FIFO).

## [0.6.2] - 2026-09-15

## [0.6.2] - 2026-09-15

### Fixed — 锚点与诊断实测修复（#131 字段反馈）

- **JSON 诊断格式与 diff 字典对齐**：`diagnostics` 改为 marker-keyed 字典 —— `"<锚点>:<行号>"` 作 key，`{ text, messages, severities }` 作 value，severities 文字化（`"error"`/`"warning"`），不再出现 `hash` 字段与裸行号字段。`edit` / `ast_edit` / `write` 三个 JSON envelope 统一。
- **锚点漂移修复（核心）**：`applyOne` 曾在每个 op 后经 `anchorsFor` 全量重算锚点 —— 同内容行组按出现顺序重排，导致 batch 后续 op 的锚点命中无关行（实测 `486:TX` 改到 708 行）。现改为单 hunk 增量迁移：内容不变的行锚点 verbatim 保留；hunk 行数由实际行数差推导（`countLineChanges` 对 sed 少算曾致丢行）。含「文件自带重复行 + 一次 edit 两 op」的回归验证。
- **诊断改触发式**：编辑落盘后主动向语言服务器 pull 一次诊断 —— 请求与 `didChange` 同连接按序处理，结果必然针对编辑后的最终内容；不再等推送碰运气（服务器异步分析的中间态推送曾导致满屏幻影错误）。不支持 pull 的服务器退回推送流 + 版本门控（过期版本推送被跳过）。
- **展示锚点入会话**：`lsp` / `ast_grep` / `ast_edit` / 诊断行的输出锚点从无状态重算改为会话增量状态 —— 同一行不再出现两套锚点，卡片/诊断上的锚点可直接用于 edit。
- **折叠按钮修复**：per-row 卡片的折叠按钮在展开后消失导致无法收起 —— 现在只要有隐藏行就保持渲染，文案随状态切换，并用空锚点 cell 缩进到代码列；grep 卡补上一直缺失的收起按钮。
- **卡片锚点列拖选**：四卡改为 per-row 结构，锚点 cell 与内容 cell 同行渲染；拖选起点在代码区时本次拖选跳过锚点列（起点在锚点列则连锚点一起选）。已知遗留：部分浏览器拖选路径仍会带出锚点文本，后续用 copy 事件劫持实现纯锚点复制。
## [0.6.1] - 2026-09-15

### Added — 写入后自动回送 LSP 诊断（#131）

- **`edit` / `ast_edit` / `write` / `undo_last_edit` 落盘后自动交付语言服务器诊断**：热服务器（推送 ≤ 800ms）内联进工具结果 —— 文本模式 `↳` 分节，JSON 模式 `diagnostics` 字段；冷/慢服务器走 10s 预算的后台等待，经 `agent.inject` 在下一自然 step 注入，**不唤醒** idle 会话；无就绪服务器则静默跳过并 fire-and-forget warm（冷启动首编不再跳过诊断管线）。
- **位置可直接编辑**：`<anchor>:<line>` 由与 `read` 同一分配器产出，且 served + observed —— 免重读即可 follow-up edit。
- **报告规约**：仅 error + warning，50 条截断并注明；诊断永不阻塞或使写入失败（post-hoc）。
- **设置**：`hashline.lsp.auto_diagnostics`（默认开），设置卡「语言服务器」页有开关；卡上写 servers 时保留该字段。
- **Web 卡片**：edit / write / undo 行新增严重度着色胶囊（红=有 error，黄=仅 warning），折叠标题并列 diff stat 与诊断 stat（`+1 -1 · 1 error`），点击展开 #128 诊断卡；clean 写入无胶囊。
- **`ast_grep` outline 卡片**：大纲行现在投进 grep 卡（此前渲染「无结果」），footer 显示 `outline · N lines`。
- **`write` / `undo_last_edit` 补发 `notifyDocumentWritten`**：此前不同步 LSP 文档，服务端回答停留在写前文本。

### Fixed

- **Windows 无关、两处回归**：`ast_grep` outline 返回值新增 `isOutline` 后曾未在 output schema 声明（DSL 在真实会话拒绝未声明字段）；冷启动经 `waitForSession` 拿到会话后主动 `didOpen`（LSP 服务器无磁盘 watcher，不补发则永远学不到写入）。

## [0.6.0] - 2026-09-14

### Added — AST / LSP 拆为独立工具（wayfinder #124）

- **`ast_grep`**（结构搜索 + 大纲；省略 `pat` 即大纲）、**`ast_edit`**（模式化结构改写）、**`lsp`**（`symbols` / `code_actions` / `diagnostics` / `request`）三个独立工具，双双带 **text + json 两种输出模式**；AST 与 LSP 能力均由设置门控，关闭时显式拒绝而非静默回退。
- **`ast_edit` 复用 `edit` 的全部机制**：同一个 `runFileEdits` 引擎、同一个 served-state 校验、同一个语法闸门、同一条 `commitFileResult` 事务 —— 因此 **undo 免费继承**（此前它写在别的 workspace 下，`undo_last_edit` 找不到条目）。模型侧输出**就是 `edit` 的 diff**（图例 + `-`/`+` 行 + 新锚点），卡片走 `edit` 的 diff 行。
- **`lsp` 自带客户端**（`src/lsp/`：会话、发现、传输、安装、状态路由）：`initialize` 声明 **push 诊断**（`publishDiagnostics`，与 pull 的 `textDocument/diagnostic` 是两件事）、诊断等待窗口 5s（冷启动实测 2.6–3.1s，等待循环在推送到达即返回）、**URI 规范化**（客户端 `pathToFileURL` 与服务器回声的 `d%3A`／盘符大小写是同一文件的两种拼法）。
- **`lsp diagnostics` 卡片**：自己的 block（与 diff 卡同套外框声明）+ 共享 `TabStrip` 头部（复制固定在右上角）——行是**原样源码行**（带 `anchor:line` gutter），诊断**缩进在下方**、红色引用块、**一条一行**；标题后是 `2 errors · 1 warning` 统计，计数取自宿主发出的 **severity 码**（不解析 `error:` 文本）；复制带走卡片所见（源码行 + 诊断）。
- 行标记格式改为 **`<anchor>:<line>`（锚点在前）**：模型最先拷贝的那个 token 就是锚点。旧顺序 `<line>:<anchor>` 仍接受（锚点永不含纯数字，两者不可能混淆），**裸行号**按「行引用」处理 —— 该行已服务且内容未变则自动修复为该行锚点并执行（附提示），否则拒绝并给出以该行为中心的 echo。

### Added — 其他

- `edit` 新增 **`op:"sed"`**：在锚点范围内做逐行正则替换（`pattern`/`replacement`/`flags`，支持 `gims`；sed 的 `\1`/`&` 与 JS 的 `$1`/`$&` 都识别，但 `replacement` 不得含换行）。
- `ast_grep` 捕获高亮：有捕获时高亮捕获，无捕获时高亮匹配节点（ADR-0005 的渲染通道），并修掉 `entry.install` 这类点号模式匹配 0 结果的隐藏 bug（`compilePattern` 解开 `expression_statement`）。

### Fixed

- **工具输出 schema**：`ast_grep` / `ast_edit` / `lsp` 的 `modelText`（及诊断行的 `messages`/`severities`）此前未在 output schema 声明 —— DSL 会在**真实会话挂载时**拒绝未声明字段（`value.modelText is not declared`），而单测直接调 `execute` 看不到。
- **观察策略**：所有「服务出去的行」现在都同时 emit `fs/observed`（read / grep / edit 回声 / diff / write auto-read / ast_* / lsp / drift）；**单文件编辑路径漏传 `exec`** 会让 `actor: undefined` 的观察**什么都记录不了**，导致回声给出的锚点写不进去（`[E_NOT_OBSERVED]`）—— 已修 + 回归测试。
- **分隔符审计**：`lsp` 曾用手拼的 `:` 而非配置的 `separator`；`undo` 的 diff 上下文硬编码为 1；`file-view` 的字节测量用旧 `line#hash` 标记 —— 均已改为配置值/同一渲染器。
- **`ast_edit` / `undo_last_edit` / `lsp` 的卡片**：分别缺 `presentationMeta` + `presentResult`、客户端行注册、独立 body —— 此前都回落为原始输入输出。
- **Windows（LSP 启动）**：`fs.access(X_OK)` 在 Windows 是「存在且可读」的假阳性，于是 npm 并排安装的**无扩展名 Unix shim** 被选中，`CreateProcessW` 起不了而真正的 `.cmd` 永远轮不到 —— 可执行判定改为「扩展名 ∈ `.exe`/`.com`/`.cmd`/`.bat` 且是文件」；启动命令经 `cmd.exe /d /s /c`，且**命令与参数保持独立 argv entry**（合并成一条会被参数层加引号，cmd 遂把整行当成一个程序名）。

## [0.5.2] - 2026-09-10

### Changed — edit/write 卡统一为 grep 卡的 tab 形态（wayfinder #91/#96）

- **已发布卡片的行为变更**：#82 定下的「仅多文件画 tab、多文件时换行」被推翻 —— edit / write 卡现在**单文件也画一个 tab**（`≥1`），溢出改为**按宽度折叠 + portal `Menu`**（不再换行、也不滚动），与 grep 卡同构。`DiffRowsBlock` 的 `groups.length > 1` 门槛与体内那行路径（`kind: "path"`）已移除 —— tab 已承载文件身份，体内重复画路径没有意义。
- **tab 条抽为公共组件** `client/src/client/tab-strip.tsx`（issue #96）：测量、`foldTabs`、溢出触发器与菜单、键盘切换、aria 接线全在组件内，grep 卡与 diff 卡共用同一份实现；组件为**受控**（active 索引与行数据仍由各自卡片持有）。
- **单文件 group 由 client 合成**（`models.ts` 的 `diffCardGroups`）：host 与 `presentationMeta` **零改动**；无 `diffRowGroups` 的单文件 meta（含**所有** 0.5.x 以前的历史会话）与新多文件 meta 走同一条路，各自都有且只有一个 tab。
- 无新增 locale 键：溢出菜单的可访问名仍复用 `common.more`；tab list 的名字用卡片自己的标题。
- read 卡不受影响（它没有 tab 栏）。

### Added — grep 卡片 web 渲染接管（wayfinder #88/#89/#90/#92）

- **`grep` 的 web 卡片由本插件 client 半区接管**（keyed `tool.call.toolview` × `key: "grep"`，`priority: -1`，与 read/edit/write 同机制）：卡顶**文件 tab 栏**（只有一个文件匹配时也保留一个 tab）、左 `行号:锚点` gutter / 右内容，**每行命中文本高亮**（含上下文行、一行多出现全高亮、正则整段匹配、零宽跳过）。
- **tab 栏按宽度折叠而非横向滚动**（真机效果评审后修订，取代最初的单行横滚规则）：`foldTabs()` 按实测宽度把文件分到可见区与溢出菜单，容器尺寸变化时用 `ResizeObserver` 重算；溢出按钮（`IconEllipsisOutline16`）开一个 **portal `Menu`** 列出被折叠的文件（portal 模式避开卡体自身裁剪），可访问名复用既有的 `common.more`；**正在阅读的 tab 永不被折叠**（它占最后一个可见位，被挤掉的那个进菜单）；仅一个文件时即使容器更窄也不折叠。
- **命中高亮改为常用高亮黄** `#ffe066` + 强制深色文字 `#1f1f1f`（两套主题下均可读）。主题**没有任何黄色 token**（暖色只有 amber 族，最浅档读起来是奶油色），所以颜色写死在插件自带样式表里。
- **host `presentationMeta` 结构化行契约**（ADR-0005）：`files[].rows[] = {number, hash, text, match?, spans?}` —— 行字段对齐 read 的 `hashlines`；`match: true` 只标真命中行（零宽模式下 `spans` 非空 ≢ 命中）；`spans = [[start,end),…]` 为 UTF-16 索引、由 host 计算，client 绝不重跑匹配、绝不解析 modelText。
- **meta 体积上限 64 KiB**（对齐内置 `SEARCH_META_MAX_BYTES`）：超出则从尾部丢弃整个文件组（至少留 1），`total` 保留、`truncated` 置真。
- **降级三档**：无 `rows`（旧会话/畸形 meta）→ 通用 I/O 卡；有 `rows` 无 `spans` → 新卡不高亮；有 `spans` → 高亮。
- 卡体自绘（fork `ReadBlock` 布局），**不含语法着色** —— 版本要求：`ReadBlock`/`CodeBlock` 的行内容只能是 `string`、着色 tokenizer 未导出、无行内 span 注入口，而高亮是本卡的核心；edit / write 卡本来也无着色。
- 移除旧字段：`files[].matches[]`（实测为「整段 section 文本」重复，非该行文本）与 `lang`；`presentResult` 保留但改为只喂真命中行（纯文本）。

### Added — grep 卡片测试与文档

- `test/core/grep-card-meta.test.ts`（22 项）：span 扫描边界、64 KiB 上限与丢组顺序、三档降级与畸形矩阵、上下文行标记/高亮、0 命中空卡、`presentResult`、模型文本不变。
- `client/test/grep-card.test.ts`（27 项）：卡模型与降级、切段（含「切段拼接恒等于原文」扫描）、gutter、footer 计数、grep 行 chrome（variant / `tool.title.grep` / pattern 摘要 / 无文件链接），以及 `foldTabs` 的 9 项边界（放得下不折叠、溢出从尾部折、active 钉住含「被顶替的 tab 更宽」与「一个都放不下」、单 tab 永不折叠、空/零宽/越界输入）。
- `client/scripts/verify-bundle.mjs` 断言新增的第 4 个 toolview 注册（`grep:-1:conversation`）。
- 新增 `docs/adr/0005-grep-card-presentation-meta.md`；`docs/web-ui-structured-views-spec.md` 标注为已被取代。

## [0.5.1] - 2026-09-10

### Fixed — 发布产物携带陈旧构建文件（0.5.0 打包缺陷）

- **根因**：`build` 只做增量 `tsc`、从不清理输出目录，且 `prepublishOnly` 只重建 client 半（`build --prefix client`）未重建主包——`src/` 中已删除的文件（本轮移除的 text 输入实现 `lib/text-input/*`、`lib/write-hook.js`、`lib/surface-rebuild.js` 及其 `.d.ts`，共 12 个）残留在 `lib/` 内并被 `files: ["lib", …]` 打进 0.5.0 的 npm 包。运行时无影响（`lib/index.js` 不引用它们），但属打包污染且会随每次发布复现。
- **修复**：新增 `npm run clean`（`scripts/clean.mjs`，清除 `lib/` 与 `client/lib/`）；`build` 前置 clean；`prepublishOnly` 改为完整 `npm run build`（typecheck + 全量测试 + 干净重建 + tag 门禁）。已验证 `npm pack --dry-run` 不再含任何陈旧文件。

## [0.5.0] - 2026-09-10

### Added — write 工具 shadow：模型侧 auto-read 内联 + web 卡片 `行号:锚点`（#53，PR #87）

- **`write` 由插件影子接管**（`src/tool-write-shadow.ts`，agent scope 层 `defineTool` 注册）：参数词汇 `{file_path, content, sandbox_permissions?, justification?}` 与返回值 `{path, operation, before, after}` 与内置工具完全一致，JSON 契约不变；`diffRows` / `modelText` 为增量字段。
- **模型通道内联 auto-read**：execute 内直接 `readAndServe`，写后立即返回 `行号:锚点` 预览，模型无需追加 read 即可继续编辑；原 post-execute `write-hook` 监听器删除（不再依赖 hook 管线）。
- **web 卡片左栏 `行号:锚点`**：`presentationMeta.diffRows` 携带结构化行（`kind` / `lineNumber` / `anchor` / `text`，由 `genDiff` + 会话锚点分配器计算）；client 新增 `HashlineWriteRow`，以 `priority: -1` 接管 `write` toolview，复用 edit 卡同一 `DiffRowsBlock` gutter——create 渲染全 `+` 行（每行带锚点），overwrite 渲染 `-`（旧锚点）/`+`/context（新锚点）。
- **降级路径**：无结构化行时 client 回落内置 intended diff；`presentResult` 在 create（无 hunks）时回落为整体新增视图，overwrite 沿用 applied hunks。
- 测试：write shadow 10 项（契约、auto-read 预览、diffRows 形状与混合行、presentationMeta/presentResult）+ client 卡片 5 项（gutter 行、混合行、降级、running、error）。

### Fixed — grep 长行静默截断（#53，PR #87）

- **grep 不再把每行截断到 200 字符 + `...`**：旧行为破坏「grep 命中可直接 edit」契约（`require_line_content` 下申报必然 `E_CONTENT_MISMATCH`），且与 README「mirrors read」表述不符。
- 修复后输出**完整行内容**；仅超过 `MAX_READ_LINE_BYTES`(200KB) 的单行隐藏并附 `read` 同款 `sed` 提示，绝不静默省略。README / README.zh 同步。
- 测试：3 项（全文与逐字一致、grep→edit 直达、200KB 隐藏与提示）。

### Removed — text 输入（text DSL）需求废弃

- 模型走 function calling 时工具参数必然被 JSON 包装传输，纯文本载荷在协议层不可达，text DSL（`input_format` 配置、`E_PARSE_*` 错误码、纯文本 schema 与解析器）整体作废并撤除（决策见 #85 / 地图 #50；实现留档于已关闭的 PR #86 与分支 `research/text-input-mechanism`）。

## [0.4.3] - 2026-09-07

### Added — edit 申报行内容校验（content echo，wayfinder map #74，契约定案 #76）

- **新配置开关 `hashline.require_line_content`（默认 false）**：开启后 `edit` 的 `edits[]` 锚点从纯字符串变为 `{ anchor, line }` 字典 —— `line` 是模型对该行当前全文的**申报**（单行、`""` 申报空行；行尾空白可省、复制 read 行的标记前缀可容忍），申报与锚点解析行的实际内容两级比对（逐字优先 → 标记前缀剥离回退，行首缩进永不 trim）一致才放行修改。三 op（ins/del/replace）全要求申报；`anchor_end` 缺省折叠时只申报 start。
- **schema 真动态**（机制实测：#75，分支 `research/edit-content-echo-schema`）：开关切换（settings 服务 onChange + `settings/updated`）触发所有存活 agent 的 edit 工具 + `tool:edit` guidance 区段 disposer→重注册，模型下一步即见新参数集（dsh 工具清单逐步重组、非会话快照；先例 dsh-tool-subagent）；`execute` 内保留运行时 config 校验兑底（陈旧 schema 会话不穿帮）。
- **双向硬拒**：开态传纯字符串 = 申报缺失（`E_BAD_SHAPE` 引导补 `line`）；关态传字典 = 形状错误（提示可开启配置）。schema 所见即校验所得。
- **新错误码 `E_CONTENT_MISMATCH`**：申报不匹配时回显实际行全文 + 「该内容当前位于行 N, M…」自动纠偏提示（主防线场景：模型拿错锚点）。校验时序 = 锚点解析 → served E_STALE → 申报校验 → 应用；任一 item 不匹配整调用拒绝（维持全原子语义）。
- **测试**：24 项新契约测试（开关两态 schema 形状、三 op × 单行/范围、双向硬拒、两级比对含标记样内容无误伤、回显与同内容提示、批量原子性、served 先行时序）。
## [0.4.2] - 2026-09-06

### Added — 伴随 client 插件：web 原生级 read/edit 卡片（issue #71，方向 B）

- **新伴随包 `dsh-hashline-edittool-client`（浏览器半内置于本包 `client/` 构建工作区）**：dsh web 的 Cordis client 插件，从已持久化的 `presentationMeta` 渲染 hashline 品牌卡片——read 卡复用官方 `ReadBlock`（唯一差异：gutter 渲染 `<行号>:<锚点>`，来自 meta `hashlines`）；edit 卡由结构化 `meta.diffRows` 驱动（fork 版 DiffBlock + gutter，官方配色）：`+`/context 行 gutter 显示 `<新行号>:<新锚点>`（链式编辑可直接复制），`-` 行显示旧行号（旧锚已失效不显示锚点），多 hunk 完整呈现不再退化为 generic；折叠行附 caption 级锚点提示（`@12:a3f`，读自调用自身 `edits[].anchor_start`）。注册走 keyed `tool.call.toolview` slot `priority: -1`（slot 台账按升序 shadowing，同 key 同优先级会 throw，显式 -1 确定性接管、不碰内建注册）。
- **渲染通道与模型通道彻底分离**：web 卡片数据一律来自 presentationMeta（结构化、可演进），绝不解析给模型看的 modelText（其格式/分隔符可随时调整）。本版同时移除 read 结果的 dsh 信封（方向 B 替代方向 A，模型每次 read 少 4 行包裹；json 模式恢复纯 JSON；`extractReadBody` 保留对旧会话历史的信封剥离容忍）。
- **单包单装**：浏览器半就是主包的一部分（`exports["./client"]`，`dsh.client` 声明在主包 manifest），`dsh plugin add dsh-hashline-edittool` 一次装齐 host 工具 + web 卡片；发布同版本同包，无第二依赖。
- **卸载/禁用无残留（已实测）**：client 行禁用后 web boot graph 完全不含该包（smoke profile 重启实测 46→0 提及）；slot 注册走调用方 fiber 的 `ctx.effect`，卸载级联清除，内建卡片即刻回归。
- **验证**：client 构建工作区测试 22 项（卡片模型）+ `scripts/verify-bundle.mjs` 无头评估构建产物（factory 形状、externals 绑定、注册行为）；CI 新增 `verify-client` job（node 22/24）。

### Changed — v2.0 dynamic anchors（dynamic hashline，wayfinder #56）

- **变长动态锚点（v2.0 契约，PR #65）**：锚点为变长 Base62（最短优先 2 位起步——2 字符层覆盖 3,844 行；分层上浮、删除回收复用、会话内跨编辑稳定）；行号退出锚点，旧 `line#hash` 格式直接 `[E_BAD_REF]` 拒绝；可选 `line_numbers` 输出参数（默认关闭）渲染 `<line>:<anchor>`；`hash_length` 配置删除；`Shift:` 块删除（编辑后从 diff 行取新锚点）；served 内容校验防线（`ServedRow {position, anchor, contentKey}`）。
- **真机冒烟缺陷修复（PR #67，wayfinder #66）**：
  - **B1** — json 输出模式的 read 视图按 v2.0 裸锚契约重建（旧分支按 `<number>#<hash>` 拆键产生 NaN，违反 lossless JSON 校验导致 json 模式全挂）。
  - **B2** — 粘贴行锚点前缀剥离：条件为「前缀锚存在于当前文件的锚集合」（post-edit diff 行可剥离；`sep: "|"` 等字面冒号行永不被改写）；行锚正则分隔符感知（`:` 并入），`:`/`|` 形态对称。
  - **B3** — grep 多文件命中时 `ANCHOR:FILELINE` 格式 header 仅出现 1 次（原先每文件一次）。
  - **B4** — 锚快照投毒自愈：`anchorsFor` 对缓存快照做长度校验（checksum 命中不再信任长度漂移的锚数组，失配即确定性重算）；增量锚更新对越界行防御性跳过（原 `undefined.replace` 崩溃路径）。
  - **B5** — `line_numbers` 参数在 read 全链路生效（`readView` 透传 + 工具层 `buildReadPresentation` 渲染，此前参数被静默忽略）。
  - **B6** — 带行号 hint 的锚一律按锚解析权威行号（`pinBound`；未验证 hint 流入批量簿记曾导致 `canon(undefined).replace` 崩溃）；hint 与解析结果不符时新增 `[E_LINE_HINT]` warning（不符仅提示，不拒绝）。
  - **B7（保真契约）** — 边界重复检测降级为 `[E_PASTE_DUP]` warning-only：删除了把「新内容与相邻行相同」的替换行静默 splice 掉的 auto-fix（该行为会把合法替换变成删除且零提示，并使增量锚簿记错位）。**除锚点前缀剥离（且仅当锚点真实存在）外，工具对模型提交的内容零修改。**
- 新错误码：`[E_LINE_HINT]`、`[E_PASTE_DUP]`（README 错误码表同步，`E_BARE_HASH_PREFIX`/`E_INVALID_PATCH` 措辞更新为新语义）。
- 文档：README / README.zh 全面向 v2.0 契约迁移（变长锚点、无 Shift 块、line_numbers、json 形状）；配置示例移除 `hash_length`；指南种子文件（`<preset>/*.md`）重播种。
- **grep `regex` 开关默认改为 true（v2.0.2）**：pattern 默认按 JavaScript 正则解析，`regex: false` 退回字面子串匹配（工具 schema / 描述 / guidance / README 同步）。
- **错误 UX 修复**：失效裸锚不再把 `-1` 哨兵泄漏进 `line -1..-1 is out of range` 消息——改由 mismatch 渲染器输出 `[E_STALE]` + ±上下文回显 + fresh markers；越界闸门仅在存在真实行声明（解析行号或显式 `<line>:<anchor>` 提示）时触发。

### Fixed — dsh 0.1.2 适配补全（issue #69）

- **read 卡片恢复（web 端 dsh 0.1.2 raw-events 卡片推导，实测通过）**：`read` 参数 schema 改为仅声明 `file_path` 规范拼写（`path` 参数移除——web 从 raw args 读 `file_path`，保留别名会导致卡片退化；执行层 `normalizeRequest` 仍容忍旧 `path` 调用，直接 API 调用方不受影响，只是无卡片）；modelText 包裹 dsh 原生 `<path>/<type>/<content>` 信封（信封正则只验存在、内容不校验，卡片数据仍走 `presentationMeta`；模型看到的内容不变，仅多 4 行包裹）。
- **settings 服务不可见的直接读兜底 + 后台重试接管（重启实测发现）**：`ensureSettingsService` 的“已在他处注册”容忍路径会返回 true 但 `ctx.get("settings")` 因提供 fiber 未启动（strict）而拿不到服务 → 旧代码静默跳过 section 注册。现在：不可见时直接读 `settings.yaml`（含 fs.watch 热更新、ctx 卸载清理）保持配置存活，并后台重试；服务可见后真正注册 section 并退役兜底（各阶段均有日志）。
- **edit `op:"del"` 容忍 `lines`（用户反馈）**：`del` 携带 `lines` 不再 `[E_BAD_SHAPE]` 硬拒——接受并忽略（删除仅由锚点定义），消除复制粘贴 replace 模式时的无谓重试。
- **settings 静默失败加固**：`settingsSvc` 解析为 undefined 时输出 console.error（不再静默跳过 section 注册——这正是 #69 问题 1 在 33fee0e 上难以定位的根因形态）；新增 `installHashlineSettings` × 真实 `@deepseek-ai/dsh-settings` 集成测试。
- **edit 呈现优化（generic 卡片可读性）**：edit/batch 响应文本的 `ANCHOR:FILELINE` 长 header 替换为单行紧凑 legend（`Diff rows: <+|-><anchor>:<content> …`；线上路径 `tool-edit.buildChangedModelText`）；锚点行格式不变，模型的锚点链编辑契约不受影响。
- **undo 提示措辞**：明确撤销 diff 中仅 `+` 行（恢复行）携带可用新锚点，`-` 行为已删除行（锚点失效）。
- **settings 集成测试扩至 6 场景**：publish 先后两种时序（含 scope.watch 自愈）、无宿主 service 直接读兜底、非法值容忍、separator 往返、服务不可见时直接读兜底 + 后台重试接管。
- **已知限制（记录）**：schemastery `z.union` 对非法值静默丢弃且整个 section 归零（如 `output_format: bogus` 连带 separator 失效），无日志——集成测试已钉住该行为，属上游语义。

## [0.4.1] - 2026-08-30

### Added

- **Multi-file `edit` dispatch** — per-item `path` now routes each edit item to its own file. Items are grouped by file; a batch touching ≥ 2 distinct files exercises the multi-file path, while a single-file call keeps the 0.4 `edit({path, edits:[…]})` shape verbatim. Top-level `path` becomes optional when every item carries its own `path` (the only new `[E_BAD_SHAPE]` case: top-level omitted and any item missing `path`); `item.path === topLevelPath` is auto-folded as an explicit normalization, not an error; the `editItemSchema` / `editsSchema` / `pathSchema` schemas enforce `additionalProperties: false`.
- **Per-file atomicity** — each file's sub-batch is processed through the existing single-file flow (read → normalize → apply → persist-undo → write) with all-or-none semantics within that file; files are independent and partial success is reported. Items targeting the same `absolutePath` auto-merge into that file's sub-batch, preserving the existing `[E_BATCH_CONFLICT]` overlap rules inside it.
- **Aggregated multi-file response** — text mode returns one `content[].text` with per-file `Successfully edited in <path>.` blocks (each with its ANCHOR:FILELINE diff) separated by `--- <path> ---` lines; failed files append `Error: [E_*] <message>` blocks. json mode returns the stringified envelope `{"ok": <bool>, "success": […per-file 0.4 JSON envelope…], "fail": […{path, code, message}…]}`. All-noop batches get a summary line.

### Changed

- Docs: ADR-0002 (multi-file schema contract), ADR-0003 (per-file atomicity), ADR-0004 (aggregated response shape) added under `docs/adr/`.

## [0.4.0] - 2026-08-27

### Added

- Configurable hashline shape via `~/.dsh/settings.yaml` (`hashline:` namespace): `separator` (default `:`), `hash_length` (default 3, 1..6), `output_format` (`text` | `json`), `context_lines` (default 3, 0..20 — unified across stale-echo, diff and grep context). No settings service installed in the deployment? The plugin mounts a read-only file-backed provider itself (`FileSettingsProvider`); `@deepseek-ai/*` packages are host-shared peer dependencies.
- **Pure-JSON output mode** (`output_format: json`): `read` returns `{path, offset, totalLines, lines: {anchor: content}}`; `grep` returns `{total, truncated, files: [{path, matches: [{anchor, text, contextBefore, contextAfter}]}]}`; `edit` returns `{ok, path, diff: {key: content}, hints, warnings, errors}` where `diff` is the text diff as an anchor-keyed dict (`-old#hash` / `+final#hash` change keys, bare-anchor context keys — aligned with read's `lines`); `grep`'s `matches` is likewise one anchor-keyed dict. Rejected edits fail loudly (throw, isError) in both modes.
- **Dual-anchor replace contract**: `replace` requires both `anchor_start` and `anchor_end` (`E_MISSING_ANCHOR_END`; single-line passes the same anchor twice); `lines` keeps **any length** — the whole range is swapped for it. `ins` inserts into the gap after its anchor line and may anchor on another hunk's range END line (half-open `N ∉ [hs, he)`), never its start/interior (`E_BATCH_CONFLICT`).
- `benchmark/text-json.mjs` — text vs json output-format token comparison.

### Fixed


- `edit` anchors (`remove_from` / `remove_to`) now accept a full read/grep/diff output row pasted verbatim — e.g. `12#aB3:const x = 1;` (optionally with `+`/`-` diff markers or surrounding whitespace) — and automatically extract the `line#hash` anchor while dropping the trailing `:content` noise. A row without a line number (bare `aB3:content`) is still rejected with a clear message, since the line number is what disambiguates identical content.
- `[E_BAD_REF]` messages no longer echo the whole pasted line/block: inputs are clipped (`clipLine`, 60 chars) in `diagRef` and the `resEdit` stripping warnings, and the bare-anchor rejection shows only a clipped hint. Multi-line blocks pasted into an anchor now warn that only the first row's anchor is used and the rest is ignored.
- Anchor contract sync: prompts, schema descriptions, and README error tables no longer advertise a "bare 3-char hash" as accepted — `line#hash` copied from the leftmost column is stated as the only valid anchor form (the code already rejected bare hashes).
- Fixed empty-file read rendering: the marker row was emitted as `1:<hash>:` (missing the `#` separator) instead of `1#<hash>:`; the byte-size computation in `fmtReadPreview` used the same wrong separator.

### Changed

- **Batch edits use snapshot-concurrency semantics.** Every hunk in one `edit` call resolves its `<line>#<hash>` anchor against the same original file snapshot, so all hunks may use ORIGINAL anchors — no more manual `newLine#oldHash` chaining. Hunks with overlapping row ranges are rejected up front with the new `[E_BATCH_CONFLICT]` code (replace/del × replace/del overlap; two `ins` at the same anchor line; `ins` whose anchor line lies inside a replace/del range). Non-overlapping hunks apply atomically, in one pass from the back, and remain all-or-nothing. New pure module `src/range-conflicts.ts` owns the conflict rules.
- Post-edit `Shift:` blocks now map each hunk's original range to its final position (e.g. `Shift: edits[1] lines 5..6 moved to lines 7..9 (+2)`), and the diff rows carry final line numbers + hashes throughout. The old `newLine#oldHash` chaining guidance is gone from prompts.
- `[E_BATCH_ABORT]` no longer duplicates the file echo: the failing hunk's anchored error (stale / unverified) is the single ±3 echo, recorded as served for direct fresh-marker reuse. The old appended "on-disk range" block (which rendered a virtual in-batch state, mislabeled as on-disk, with mismatched hashes vs content) was removed.
- **Deterministic content hashing.** The 3-char hash is now a pure content signature (cyrb53, dependency-free, synchronous) instead of a snapshot-unique allocation: identical lines share one hash and collisions are accepted by design — the line locates, the hash only verifies content (anchors stay strictly `line#hash`, no lenient auto-correction). This removes the `62^3` line ceiling (`MAX_HASH_LINES` / `E_FILE_TOO_LARGE` are gone; arbitrarily large files work), deletes the `mapStableHashes` stable-mapping pass (hashes after an edit are a plain O(n) recomputation), and drops the xxhash-wasm dependency. `CANON_VERSION` bumped to 3; hash-store snapshots recompute on the new checksum. Stale-anchor echoes now merge overlapping ±3 windows into one block.'


## [0.4.0] - 2026-08-21

### Added

- `line#hash` anchor (issue: line-anchored hashline upgrade). Every read / grep / edit row now carries the absolute 1-indexed line number alongside the 3-char content hash, e.g. `12#ve7:function hello() {`. The model passes the full `line#hash` (or a bare 3-char hash when it knows the file has not shifted above) as `remove_from` / `remove_to`.
- `ANCHOR:FILELINE` header line at the top of every hashline response, visually separating the marker column from the verbatim file content.
- Post-edit response carries a `Shift:` block describing how absolute line numbers below the edited range have moved: `Shift: lines > N shift by +K (original line X now at line Y, …). Use newLine=<N>#<oldHash> to edit the row immediately below without re-reading — copy the hash from the next "unchanged" diff row if one was rendered.` The model chains edits by reading the Shift block instead of re-reading.
- `[E_STALE_ANCHOR]` rejection echoes the target line in read format (`ANCHOR:FILELINE` + ±3 context rows). The echo rows are recorded as served, so a retry carrying the fresh `line#hash` marker passes served-state verification without a re-`read`.
- New `grep` tool. Hashline-aware substring (default) or regex (`regex: true`) search. Output mirrors `read`: each match is a `<line>#<hash>:content` row under a `ANCHOR:FILELINE` header, one section per file. Context rows (`-C N`) carry markers too. Every file read by grep is emitted as `fs/observed` and recorded as served, so a grep hit can be edited directly without a separate `read`.
- New `tool:grep` prompt section (default order `134`), overridable per agent preset via `<preset>/grep.md`.
- **Structured web-UI views.** Each tool now emits the typed `presentationMeta` + `presentResult` / `presentCall` projections from the `@deepseek-ai/dsh-tools` contract, so dsh-web (and any future UI that consumes the same contract) renders the read as a line-numbered code view (`card: 'read'`), each edit / batch_edit / undo as an inline diff card (`card: 'diff'`), and grep as a grouped-by-file search card (`card: 'search' shape: 'matches'`). The model-facing text contract is byte-identical to the pre-change version — the structured metadata rides alongside the existing `modelText`. The pattern is mirrored from `@deepseek-ai/dsh-tool-fs` (the official built-in fs tools, the authoritative reference for the contract). Pure helpers live in `src/presentation-helpers.ts` (`buildReadPresentation`, `buildDiffPresentation`, `buildSearchPresentation`, `computeHunkDiffs`, `langFromPath`, soft-validators). See `docs/web-ui-structured-views-spec.md` for the full design.
- **Cherry-picks (non-breaking).** Three non-breaking ticket-bundles cherry-picked from the upstream
  at `0.3.0`:
  - **T1 (ADR-0005) — whitespace-insensitive canon.** `canon()` now strips every run of `[ \t\r\n]+` instead of just `\r` and `trimEnd()`. A line that differs only by whitespace keeps its hash, so a reformat cannot rotate anchors. `CANON_VERSION = 2` is exported; the hash-store cache invalidates on version change. `getCanon(cache, line)` memoizes per call (input set bounded by file line count).
  - **T2 (ADR-0008) — orphaned serve healing.** `_mergeServedRows` builds an internal `Map<hash, position>` as it scans the existing array; when the same hash appears at a second position, the older position is nulled. This prevents a partial re-serve from leaving a stale duplicate behind. Both `recordServed` / `recordServedTruncated` short-circuit on no-op writes. `verifyServedRange` now uses **candidate-span enumeration** when `startPositions.length` or `endPositions.length` is not exactly 1: for each `s ∈ startPositions × e ∈ endPositions`, it checks `served[s..e] === fileHashes[startLine-1..endLine-1]`. If exactly one candidate matches, it's accepted. If multiple match, the closest to `startLine-1` wins. The new `[E_RANGE_UNVERIFIED]` message says "A full read will re-sync the served mirror" instead of the old "is never guessed at" boilerplate.
  - **T5 — terse notices + lean prompts.** All `[E_NOOP_LOOP]` / `[E_STALE_ANCHOR]` / `[E_AMBIGUOUS_ANCHOR]` / `[E_BAD_REF]` / `[E_BAD_OP]` / `[E_INVALID_PATCH]` / `[E_BARE_HASH_PREFIX]` messages shortened; the "Autocorrected: " prefix dropped from autocorrection notices. Model-facing output is shorter per rejection so the next edit prompt has more room for actual code context. Schema description one-liners land here too.

### Changed

- **Yet-evolving edit contract → `op` semantics.** Following the `absorb/t3-payload` merge (which
  bundled `batch_edit` into `edit({path, edits})`), this release goes further and adds an explicit
  `op` field to each `edits[i]`:
  - `remove_from` → `from`; `remove_to` → `to` (optional, single-line when omitted); `replacement_text` → `lines` (string array).
  - `op: "ins"` — insert `lines` AFTER the `from` line (the anchor line's content is preserved). `to` is forbidden.
  - `op: "del"` — delete the `from` line, or the `from..to` range. `lines` is forbidden.
  - `op: "replace"` — replace the `from` line, or the `from..to` range, with `lines` (required and non-empty). Use `lines: [""]` to clear a line to empty (not `del`).
  - `batch_edit` is **removed** — one `edit` with `edits:[]` handles single and multi-edit calls; the per-item optional `path` preserves multi-file edits in one call.
  - Errors: `edits[i].op` must be `ins`/`del`/`replace`; `ins` rejects `to`; `del` rejects `lines`; `replace`/`ins` require non-empty `lines`. An `[E_OP_INS]` notice records the moved anchor line for an `ins` (the "insert after line N" expands to a single-line replace that preserves N).
- Anchor parsing accepts both `line#hash` and a bare 3-char hash. Bare-hash form is the pre-existing hash-only fallback for cases where the model is confident the file has not shifted above.
- Post-edit response reorganised into a three-block layout: `ANCHOR:FILELINE` header, the `+- line#hash : content` diff rows, the `Shift:` block, and the unchanged trailing warnings / drift notice. Each hunk in the `edits` array emits its own `Shift:` block; the cumulative Shift (added − removed through each hunk) lets the model compose `newLine#oldHash` markers between hunks without a re-read.
- Output column position is no longer fixed across line-number widths (the column moves with the line-number digit count). The marker structure (`<prefix><line>#<hash>:<content>`) is invariant and is what the model parses.
- All five tools' `output.schema` upgraded from `{ type: 'string' }` to structured objects (`read` → `{ path, offset, totalLines, lines, hashlines, truncatedByBytes }`; `edit` → `{ path, before, after, modelText, … }`; `grep` → `{ files, truncated, total, modelText }`; `undo_last_edit` → `{ path, before, after, modelText }`). The model still gets a `text` content block (the same string as before) — the schema change is observable only to consumers that read `tool/result.value` (none in the model path).

### Tests

- 11 new tests in `test/core/line-hashline.test.ts` covering: `parseRef` accepting `line#hash`, the read header line, single-line edit (`op:"replace"` with only `from`), single-hunk `Shift:` block, cumulative per-hunk `Shift:` blocks in a merged `edits` array, stale-anchor echo in read format with ±3 context, grep output format, grep context rows, and `grepFileContent` no-match path.
- 10 new tests in `test/core/presentation.test.ts` covering: `read` returns a structured value with `lines` + `hashlines`; model text starts with header + ends with pagination footer; `grep` returns `files` + `truncated` + `total`; `grep` sets `truncated` when the per-file cap is hit; `edit` returns `{ path, before, after, modelText }`; multi-edit aggregation; `computeHunkDiffs` produces a 3-line-context hunk (mirroring `dsh-tool-fs`); `computeHunkDiffs` returns `oldText: null` for noop/create; `langFromPath` derives syntax-highlighting language from file extension.
- New `op`-semantics tests: `ins` inserts after `from` and rejects `to`; `del` deletes and rejects `lines`; `replace` requires non-empty `lines` and rejects empty; `replace` with `lines: [""]` clears a line (still exists).
- Existing test suite adjusted to the new `line#hash` / `op` contract: read-preview, read-and-serve, edit-diff-preview, edit-diff-utils, edit-engine-e2e, hashline-stable-duplicate, hashline-hash, hashline-recovery, hashline-strict-input, hashline-parse, guidance (tool:batch_edit section removed), presentation, line-hashline. The pre-existing hash-store / served-store / served-state / snapshot-store / reject-and-serve-seam failures are sqlite-environment issues unrelated to this change (verified on `main`).
- Test count: 664 passing (32 pre-existing sqlite-env failures excluded; was 615 pre-change).

## [0.2.2] - 2026-08-19

### Added

- Guidance reset & restore defaults (issue #17): emptying or deleting an override file — or deleting its whole `<preset>/` directory — restores that section's compiled default guidance and order: the default renders at session-start and the file re-seeds at next boot (shipped presets; a deleted custom-preset override stays absent). A whitespace-only file with no front-matter fence means "I want the default"; any well-formed fence (even keyless, even an empty body) is a deliberate-intent signal and is never reset. Malformed fences now fast-fail instead of degrading to prose: a missing closing `---`, a non-integer `order`, or an unknown key rejects the file — the compiled default renders, a warning names the file and the reason, and the file is left untouched on disk for repair.

## [0.2.1] - 2026-08-18

### Added

- Configurable per-preset tool guidance (issues #7, #8; tickets #9–#13): the four `tool:*` prompt sections resolve from plain-markdown override files keyed by agent preset — `$DSH_HOME/plugins/dsh-hashline-edittool/<preset>/<section>.md` — with an optional `order` front-matter. On first boot the plugin seeds each shipped preset (`standard`, `code`, `minimal`, `cordis`) with its guidance as editable files plus a root README documenting the scheme. Per section the chain is `<preset>/<section>.md` → compiled default; files are read once per agent at session-start, so edits apply to new sessions. Deployments without the `agentPresets` service keep the compiled defaults untouched.
Default orders sit at 130–133, above the built-in tool-guidance band (100–116 in the shipped
dsh), so a same-order section merge with unrelated tool guidance cannot occur out of the box; the
seeded preset files expose that `order` as editable front-matter.
- Default guidance text simplified per the writing-for-agents principles; the `*_GUIDELINES` constants unified on `*_GUIDANCE`.
- Thanks to [@R-LEI2536](https://github.com/R-LEI2536) for requesting configurable per-preset prompts and for the design input that shaped this release (issue [#7](https://github.com/hyperion2144/dsh-hashline-edittool/issues/7)).

### Changed

- Benchmark extended to a third arm, `@oh-my-pi/hashline`: same corpus, same 12 replacements, two modes (per-edit `seq` with renumbered lines + one-document `batch` fixed to original line numbers). Payloads are built from the package's published grammar and validated before counting (the package is Bun-only, so it cannot run under the Node benchmark). Honest result, reported as such: hashline saves 31% vs `str_replace` on the session (43% on multi-line ranges) and remains the plugin's claim; the compact patch language saves 42% per edit / 53% batched — and this README says so. `npm run benchmark` stays byte-deterministic (verified over repeated runs).
- READMEs (English and 中文) refined along ponytail-style lines: "How It Compares" gains an `@oh-my-pi/hashline` column plus a same-lineage/different-jobs comparison; the Benchmark section documents all three arms, adds an honest "regenerate, don't trust" reproducibility note, and widens the scope-and-honesty block with what the payload numbers do *not* capture (renumber/tag-chase cost, block ops, Bun-vs-Node, tool-pair vs patcher library).
- `package.json` keywords now include `oh-my-pi` alongside `hashline`.
- Roadmap gains a first-class decision item: close or justify the gap vs `@oh-my-pi/hashline` (payload-lighter by 42%/53% vs 31%, with block ops / registers / `REM`/`MV` / multi-hunk documents / pluggable fs we do not support — against correctness costs: unverified line numbers, renumber-per-edit, best-effort merge on stale tags, model skill floor). A reference record lives at `../oh-my-pi.md` (workspace-level, outside this repo): the token comparison, the correctness asymmetry, the ability-by-ability status, and the decision rationale.

## [0.2.0] - 2026-08-16

### Changed

- Architecture deepening across six refactors (GitHub issues #1–#6), with the model-facing contract unchanged — every `[E_…]` code and message byte-identical, full suite green (615 → 626 tests):
  - Served state (what the model has been shown) now lives in one async module: the doubled sync/async store interface (whose sync half had zero production callers) is gone, and the served-row merge invariant — stale tail / duplicate anchors — is one shared helper with a regression test.
  - `edit` and `batch_edit` run on one edit-sequence engine — apply-one, the multi-edit sequencer, the noop-loop guard, and the persist-undo → write → restore transaction — replacing `batch_edit`'s duplicated 685-line pipeline with a thin orchestrator. Batch apply, atomic batch rejection, and undo revert are now covered by end-to-end tests.
  - The hashline anchor math is a pure module (no store imports); persistence is a thin wrapper over it. The public hashline interface shrank to the consumer call surface.
  - The `read` tool and the write auto-read share one read-and-serve operation; canonical path resolution moved out of the write module into the path helpers.
  - All four tools validate requests through one contract module — field sets and the `[E_BAD_SHAPE]` vocabulary declared once.
  - The hash store exposes domain APIs (snapshots / undo / served) instead of raw prepared statements; corruption handling and cross-table cleanup are owned by the store, and the import graph is acyclic.

## [0.1.9] - 2026-08-15

### Changed

- READMEs (English and 中文): added a concise "Why you need this" opening section — the transcription cost and 46–51% patch-failure rate of `str_replace`, the 31%/43% edit-token savings, verified landing, and the leaner-context benefit (the model's attention stays on the code, not on re-transcribing it) — placed before Quick Start so the demo stays immediately visible. Fixed the stale static version badge.

## [0.1.8] - 2026-08-15

### Added

- This CHANGELOG (Keep-a-Changelog style, following the pi-interactive-shell layout), shipped in the npm tarball.
- Git tag / GitHub release automation: a `postpublish` hook (`scripts/tag-current.mjs`) reads the version from `package.json`, creates an annotated `vX.Y.Z` tag at HEAD and pushes it, so every successful `npm publish` stays in sync with git; a GitHub Actions workflow (`.github/workflows/release.yml`) turns any `v*` tag push into a release with auto-generated notes.
- Backfilled `v0.1.0`–`v0.1.7` git tags and GitHub releases at their version-bump commits.

## [0.1.7] - 2026-08-15

### Added

- `assets/logo.svg` and `assets/banner.svg` (file.ts → read → hashed lines → edit by hash → diff), shipped in the npm tarball.
- READMEs (English and 中文) restyled in a centered, image-led layout: badge row, harness-problem pull-quote, example-driven Quick Start, a hashline-vs-`str_replace`-vs-line-number comparison table, project-structure tree, roadmap, acknowledgments, and a star-history chart.

### Changed

- The published tarball now includes `assets/` alongside `README.md` and `README.zh.md`.

## [0.1.6] - 2026-08-15

### Added

- Chinese README (`README.zh.md`) — a full translation mirroring the English one (pillars, diagrams, benchmark, tools, error codes, lineage).
- Reciprocal language links at the top of both READMEs; `README.zh.md` shipped in the npm tarball.

## [0.1.5] - 2026-08-15

### Added

- Reproducible token-cost benchmark (`benchmark/run.mjs` + frozen 103-line corpus + methodology): hashline vs `str_replace` on the same file with the same 12 replacements — 31% fewer output tokens over the session (43% on multi-line ranges), ~1.4× cheaper on effective cost at the 5× output-token rate. Deterministic: content-addressed self-checking edit script, pinned `js-tiktoken` `cl100k_base` devDependency. Run with `npm run benchmark`.
- README rewritten around the three pillars — token-saving, correctness, and the modern content-addressed edit pattern — with Mermaid diagrams, a `str_replace` comparison table, and an inspiration/lineage section (The Harness Problem, pi-hashline-edit, pi-hashline-edit-pro).

## [0.1.4] - 2026-08-15

### Fixed

- `E_RANGE_UNVERIFIED` ("served at N positions") on edits after a shrinking write: the served-state array was upserted by position but never truncated to the file's current line count, so a stale tail kept a surviving line's hash at its OLD position while the current serve held it at its new one. `recordServed`/`recordServes` now take the current line count and truncate before upserting, threaded from every whole-file serve — read, write auto-read, drift rows, and all rejection-echo sites. Regression test covers the 8-line→2-line write case (issue #27).

## [0.1.3] - 2026-08-15

### Fixed

- Sandboxed sessions rejected in-workspace edits while the built-in `write` succeeded: the shadowed mutating tools called `fs.writeText` without the per-call sandbox policy, so a confined backend fell back to the deployment root. Tools now mirror `@deepseek-ai/dsh-tool-fs`'s `FsSandboxController` — resolve the policy with the session cwd as the workspace root, advertise `sandbox_permissions`/`justification`, pass the policy to `fs.writeText`, and map `FS_SANDBOX_DENIED` to the shared `[sandbox: …]` marker.

## [0.1.2] - 2026-08-15

### Changed

- The hash store moved from `$DSH_HOME/plugins/dsh-hashline-edittool` to a per-workspace location: `<workspace>/.dsh_hashline_edittool/hash-store.sqlite`, carried per tool call via an AsyncLocalStorage workspace context (`src/workspace.ts`). Parallel sessions in different workspaces no longer share anchors or undo history. The shared home path remains the fallback for tests/previews.
- Undo history from before 0.1.2 is not migrated to the new layout.

## [0.1.1] - 2026-08-15

### Fixed

- Shadowed tools silently never registering, leaving sessions on the built-ins: per-agent installation failed with `cannot get property "fs" without inject` at `session-start`. The plugin now declares `inject = ['tools', 'systemPrompt', 'fs']` and resolves the host `fs` service from the plugin's own `rootCtx` (the agent fiber chain does not carry the plugin's inject list).

## [0.1.0] - 2026-08-14

### Added

- Initial dsh port of the hashline editor: hash-anchored `read` / `edit` / `batch_edit` / `undo_last_edit` tools for DeepSeek Harness. Every line gets a unique 3-character content hash; edits target `remove_from`/`remove_to` hashes. The hashline core is ported byte-for-byte; the tool layer is rewritten on dsh's plugin API (batch_edit spec #19).
- Built-in replacement via scope-layered registry shadowing: on `agent/session-start` the tools and the `tool:read`/`tool:edit` prompt sections are registered on the agent's own layer (own-layer-wins), unwinding automatically on disposal; a `tools/post-execute` listener appends the auto-read to built-in `write` results.
- Served-state range verification with reject-and-serve: every line of the resolved range is checked against what the model was shown; stale/never-served/unverified ranges are hard-rejected with the current `HASH:content` rows echoed back (retry needs no `read`). Drift notices report served territory changed outside the edit range (reject-and-serve spec #13).
- Chained edits without re-reading: post-edit diff rows and rejection echoes count as serves, so follow-up edits verify cleanly.
- Error-code contract (`[E_*]` codes, README-documented and test-enforced) including the noop-loop guard (issue #18); `undo_last_edit` surviving restarts; and safe writes preserving permissions, line endings, BOMs, symlinks, and hard links via `ctx.fs`.
- Test suite ported from the original project (614 tests at release), driving the dsh tool builders directly over a local filesystem bridge.
