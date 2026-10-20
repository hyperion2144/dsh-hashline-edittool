# 仓库取证：edit diff 呈现的现状、约束与可行手段

> 调研的一半：外部工具怎么组织 diff（#291 / #292 的子代理在做）。这一半是**我们自己仓库**的取证——
> 现状是什么、改动的约束在哪、作用域上下文能不能拿到。
>
> 范围：模型可见文本 + web 卡片两个表面。硬约束：diff 行形状 `<+|-><anchor>:<content>` 不变；
> 目标是让模型**读懂被改的那个函数**，token 是次要约束。

## TL;DR

1. 模型看到的 diff 是 **逐行 patch**，只带 ±3 行上下文，**不含任何作用域信息**——函数名、签名、行区间全都不在文本里。
2. 卡片是**另一条通道**（`presentationMeta.diffRows`），模型文本与 UI 互不解析；两边要改得分别改。
3. 「整函数带出」不是免费的：锚点是**只为渲染出来的行惰性分配**的（ADR-0009），把上下文扩到函数级 = 为整函数铸锚点、
   撑大 served 集；响应还有 48,000 字符的预算闸（ADR-0013）。
4. 作用域检测**有零件但没有现成通路**：`enumerateSymbols` 只在 AST worker 里被用过；wasm 语法要按语言**下载安装**，
   LSP 要有 ready 的 server，语言无关的只有启发式。⇒ 任何方案都得设计**降级阶梯**。
5. 「用户开关」有现成先例：#244 的 `line_numbers`（`z.boolean().volatile()` + 设置卡 switch + `infra/settings.ts` getter）。

## 1. 现状：模型侧 diff 是怎么产出的

### 1.1 管线

| 环节 | 位置 | 事实 |
|---|---|---|
| 行 diff 生产 | `src/render/edit-diff.ts:110` `genDiff` | 纯函数，入参 `(oldContent, newContent, contextLines, newHashes, oldHashes, lineNumbers, partsFor, changedRanges)` |
| 行 diff 算法 | `src/render/line-diff.ts` `diffLinesBounded` | 有界 Myers（#190/#182），不是 jsdiff |
| 响应拼装 | `src/domain/edit/edit-response.ts` `buildChanged` / `buildBatchResult` | 图例 + diff 体 + 结尾统计行 |
| 卡片投影 | `src/render/edit-card.ts` `computeHunkDiffs` | 卡片自己的 hunk 分组（`context: 3` 硬编码），与 `genDiff` 是**两套** |
| 卡片渲染 | `client/src/client/diff-block.tsx` | 结构化行 → DOM |

### 1.2 行形状（红线，不得改）

- `src/render/edit-diff.ts:84` `formatRowMarker(anchor, lineNumber, lineNumbers)`：行号关 → `<anchor>`；行号开 → `<anchor>:<line>`。
- 行前缀：`+` / `-` / ` `（一个空格）。上下文行前缀是**一个空格**。
- 实际行：`<+|-><anchor>:<content>`；行号打开时 `<+|-><anchor>:<line>:<content>`。
- `separator` 默认 `":"`（`src/infra/settings.ts:81` `DEFAULT_CONFIG`），`contextLines` 默认 `3`，
  `lineNumbers` 默认 `false`。

### 1.3 上下文是怎么裁的（`genDiff` 内）

- 改动前后的上下文各取 `contextLines` 行；
- 两个改动之间的未改内容超过 `2×contextLines` → 中间插一个 `...` 标记，**不写跳过了多少行**；
- 首个改动之前被跳过的行数由 `skipStart` 推进行号计数器（所以行号是对的，但「跳了多少」读者看不到）；
- 尾部上下文只保留紧邻改动的 `contextLines` 行。

### 1.4 文本外围

- 图例（`src/domain/edit/edit-response.ts:13`）：
  `Diff rows: <+|-><anchor>:<content> — + and context rows carry fresh anchors for follow-up edits.`
- 结尾（`:257`、`:260`）：`Successfully edited in ${path}.` + ` Added N line(s), removed M line(s).`
  —— **路径在 diff 之后**（多文件才有 `--- path ---` 头，`:364`）。
- `-` 行带**改前旧锚点**（该行已被释放/失效）；`+` 与上下文行带**改后新鲜锚点**。

### 1.5 卡片

- 卡片拿到的是 `presentationMeta.diffRows`，每行 `{ kind: "+"|"-"|" ", text, lineNumber, hash }`。
- gutter 由 `client/src/client/diff-block.tsx:166-172` 拼：`-${lineNumber}:${hash}` / `+${lineNumber}:${hash}` / `${lineNumber}:${hash}`。
- 行号不连续处插 `⋯` 占位行（`:194-196`）。
- 默认折叠：`maxLines = 16`（`:358`），头尾各半（`:426-429`）。
- 卡片**不解析模型文本**，模型文本**也不解析卡片**——两条独立通道。

## 2. 实测样例（用仓库自己的 `genDiff` 跑出来的，不是示意）

改 `src/render/line-diff.ts` 里 40 行的 `myersRange()` 中一个比较符（`<` → `<=`），文件共 464 行。模型看到的是：

```
Diff rows: <+|-><anchor>:<content> — + and context rows carry fresh anchors for follow-up edits.
 ...
 B1:		trace.push(v.slice());
 Yc:		for (let k = -d; k <= d; k += 2) {
 jt:			let x: number;
-Tl:			if (k === -d || (k !== d && v[mid + k - 1]! < v[mid + k + 1]!)) x = v[mid + k + 1]!;
+bj:			if (k === -d || (k !== d && v[mid + k - 1]! <= v[mid + k + 1]!)) x = v[mid + k + 1]!;
 5X:			else x = v[mid + k - 1]! + 1;
 Tg:			let y = x - k;
 nm:			while (x < n && y < m && a[aLo + x] === b[bLo + y]) {
```

**9 行。被改函数的函数名、签名、参数、返回类型全都不在文本里**；开头那个 `...` 也不说跳过了多少行。
另一个场景（4 行小函数重写成 9 行分支版）能看到 17 行，函数头在、函数尾不在。

## 3. 约束：改动的三条真实代价

### 3.1 锚点经济（ADR-0009 / ADR-0010）

- 锚点**只为响应真正返回的行惰性分配**；响应先按预算分段，被切掉的行不带锚点。
- 渲染出来的行与服务集必须一致，否则上下文行不可编辑：
  - `src/domain/edit/served-rows.ts:47` `const ctxPad = Math.max(2, contextLinesCfg());`
  - `src/domain/edit/edit-engine.ts:668` 同样的 `pad`。
- ⇒ **把上下文从 ±3 行扩到整个函数 = 为整函数铸锚点 + 撑大 served 集**。这是 ADR-0010 预算
  （5,000 paths / 300,000 anchor_lines / 64 MiB）下的真实消耗，不是零成本。

### 3.2 响应预算（ADR-0013）

- `src/infra/constants.ts:20` `RESPONSE_BUDGET_DEFAULT = 48_000`（上限 49,984），按**整行**切段，一行不切半。
- 一个 200 行的函数整体带出（~60 字符/行）≈ 12k 字符，多 hunk 同时出现会挤占预算。
- 上下文行的**渲染**和**服务**是两件事：渲染可以更宽，但要可编辑就得同步加宽服务窗口。

### 3.3 契约面

- 同一段渲染被 `edit` / `write` / `undo_last_edit` / `ast_edit` 共用——改一处，四处变。
- 模型侧提示（`src/domain/edit/prompts.ts`）已写死对 diff 行的理解方式（锚点抄自 read/grep/diff 行、diff 行是**最终位置**、
  没有 `Shift:` 块）。任何新增的行外信息都要在这里同步，否则模型读不懂新东西。

## 4. 可行性：作用域上下文能不能拿到

### 4.1 现成零件

| 能力 | 位置 | 说明 |
|---|---|---|
| 符号枚举 | `src/ast/symbols.ts:373` `enumerateSymbols(root, languageId)` | 返回 `SymbolRecord[]`：`name` / `qualifiedName` / `kind` / `startLine` / `endLine` / `blockStartLine` / `blockEndLine`（1-indexed 闭区间） |
| wrapper 爬升 | `src/ast/symbols.ts:350` `blockNodeOf(node, language?)` | 爬到同身份 wrapper（如 `export_statement`），保证块起点不把 `export` 落下 |
| 节点收集 | `src/ast/symbols.ts:330` `collectSymbolNodes(root, languageId)` | 按语言描述符的 query 收节点 |
| 符号解析 | `src/ast/symbols.ts:482` `resolveSymbol` | — |
| 语言描述符 | `src/ast/language.ts` | `languageById` / `queryNodeTypes`；`src/ast/kind.ts` 有 kindRules / wrapperNodeTypes |

### 4.2 三条可得路径（都不便宜）

1. **AST（wasm worker）**：`enumerateSymbols` 目前**只**在 `src/ast/worker.ts` 里被调用（主线程不建 `Parser`，
   见 ADR-0007）。wasm 语法**按语言现下载现安装**（`src/ast/registry.ts:70` 的 `PACKAGED` 只是目录；
   落地在 `grammarDir(id, version)`），用户没装过该语言语法 ⇒ 这条路直接不通。
   覆盖语言见 catalog：bash / c / cpp / elixir / go / haskell / java / julia / ocaml / php / ruby / rust / scala / svelte +
   typescript / tsx / javascript / python。
2. **LSP**：`src/tools/tool-lsp.ts` 有符号能力，`src/domain/format/auto-format.ts` 用的是
   `manager.readySessionFor(language.id)`——**只在 server 已就绪时可用**，不是保证。
3. **启发式**：纯文本扫描（括号/缩进），语言无关、零依赖、永远可用，但会误判嵌套/异常写法。

⇒ **任何依赖作用域的方案都必须写降级阶梯**：AST → LSP → 启发式 → 纯 diff。
「整函数带出」还要再加一档：函数太长就降级为 hunk + 宽上下文 + 函数签名头。

### 4.3 附带发现

- `src/ast/elide.ts` 已有「折叠区间（ElisionSpan）」的概念与去重逻辑（`dropNested`）——和「折叠掉函数里的无关分支」
  是同一类问题，可能能复用它的形状，但目前是 AST 卡专用。

## 5. 用户开关的先例

`#244` 的行号开关是最贴的模板（它是「用户可调、模型不可调」的那一类）：

| 位置 | 内容 |
|---|---|
| `src/config.ts:56` | `line_numbers?: boolean`（设置项） |
| `src/config.ts:144` | `z.boolean().volatile()`——**模型不可写**，只有用户能改 |
| `src/config.ts:423-424` | 读取时取 `settings.line_numbers`，缺省回 `defaults.lineNumbers` |
| `src/infra/settings.ts:85` | `lineNumbers: false`（默认关） |
| `src/infra/settings.ts:202` | `lineNumbersEnabled()`——渲染层读这里 |
| `client/src/client/settings-card.tsx:914` | 设置卡上的 switch，写回 `line_numbers` |
| `src/config.ts`（`flagChanged` 分支） | 开关变了要 `rebuildEditSurfaces()`——改了形状得重建 edit 表面 |

配套：`src/infra/settings.ts:75-93` `DEFAULT_CONFIG`（`separator: ":"` / `contextLines: 3` / `lineNumbers: false` /
`requireLineContent: false` / `outputFormat: "text"` / `maxResponseChars: RESPONSE_BUDGET_DEFAULT`）。
另有 `context_lines`（`src/config.ts` schema，`z.number().min(0).max(20)`，默认 3）——**README 没提、不在设置卡暴露**，
是纯配置文件项。

## 6. 测试面

改动会碰到的测试文件：`test/core/edit-diff-rows.test.ts`、`edit-diff.preview.test.ts`、`edit-diff.utils.test.ts`、
`line-diff.test.ts`、`write-diff-bounded.test.ts`、`line-hashline.test.ts`、`tool-ast.test.ts`。

## 7. 待决问题（等外部调研回来一起定）

1. 作用域信息放在**行外**（hunk 头 / 函数签名 banner / 折叠标记）还是**整函数带出**成普通上下文行？
   —— 前者不铸锚点、便宜；后者铸锚点、贵但模型看到完整逻辑。
2. 作用域从哪来：AST 优先还是启发式优先？降级阶梯长什么样？
3. `-` 行的旧锚点怎么标：视觉上不像可抄的锚点，但信息保留。
4. 卡片侧要不要同步表达作用域？（UI 侧其实更容易：可以画函数名 + 折叠整函数）
5. 默认开还是关？（用户已定：做成开关；默认值要定）

## 8. 误粘新形态时的行为（锚点解析的实测路径）

`salvageAnchorRef`（src/hashline/anchor-pipeline.ts）只有三级行为：

1. **快路径**：`hashRe()`（Base62 1–8 字符）或 `lineAnchorRe()`（`^\d+:<anchor>$`）命中 → 原样保留。
2. **行正则**：`hlRowAnchorRe()`（= 编译后的 `rowRe`，形状 `[+-]?<marker><sep>`）命中 → 剥掉前缀与内容并给警告：
   - `+` 行 → `[E_BAD_REF] stripped diff-preview "+" marker and trailing content — using "<anchor>".`
   - `-` 行 → `[E_BAD_REF] stripped leading "-" marker and trailing content — using "<anchor>".`
   （今天 `-` 行**能**被救活，救出来的是**已失效的旧锚点**，随后死在 stale 检查上——错误信息绕了一圈。）
3. **都不命中** → 原样交给锚点校验 → `[E_BAD_REF] Invalid anchor "<值>". Expected a variable-length Base62 marker (e.g. "aB3"), copied from the leftmost column of a read/grep/diff row.`

⇒ 三条由此推出的设计约束：

- 旧锚点只要**不是**合法 Base62 token（`~Tl`、`[Tl]` 都行），误粘就落在第 3 级 → 干净报错，
  不像今天 `-` 行那样先被救活再死在 stale。
- 头行若以 `@@` 开头，整行不会被行正则误认成「锚点行」（`@@` 不是 Base62），误粘同样是第 3 级干净报错。
  但**不要**让头行以「像 Base62 的路径段 + 分隔符」开头（`src/...` 这类），否则会被行正则当成锚点行剥前缀，
  救出一个错的锚点。
- 旧锚点加 `~` 不影响 `content_lines` 里的剥前缀逻辑：行正则只认 `[+-]?` 前缀，`~` 不在其内。

## 9. 卡片侧数据模型（加「作用域头行」要动的地方）

- 卡片数据**只**来自 `presentationMeta.diffRows`（结构化），模型文本与 UI 互不解析
  （client/src/client/diff-block.tsx 文件头注释）。
- 行形状：`DiffRowMeta` = `{kind: "+" | "-" | " ", lineNumber: number, hash: string, text: string}`。
- **宿主侧软校验**：`src/render/edit-card.ts` 的 `diffRowsFromMeta` 硬性要求 kind ∈ {+,-, }，
  出现别的 kind 就整体返回 `undefined`（卡片退化为无 diff）。⇒ 新增「头行 kind」必须同时改这里。
- 客户端渲染：`buildDisplayRows` 把行映成 `del | add | ctx | gap`（gap = 行号不连续处的 `⋯`）；
  `copyText` 复制时剥掉锚点列（`- text` / `+ text` / `text`）。
- 折叠：`maxLines = 16`（可传参），头尾各半（`headLines = ceil(maxLines / 2)`）；`hidden` 条数按**显示行**
  （含 gap 行）算——整函数带出后行数暴涨，折叠会吃掉更多。
- 卡片 gutter 用的是**旧 hash 形态**（`-21:C7` / `+21:h2` / `20:Cg`），不是 Base62 锚点；客户端注释自称
  removed 行是「pre-edit anchor, stale but informative」。⇒ 卡片本来就没有「误抄旧锚点」的问题，
  旧锚点的视觉标记是**模型文本侧专属**的问题。

## 10. 作用域来源的补充取证

- AST worker 有 LRU 树缓存：`src/ast/worker.ts` 的
  `cacheKey(languageId, text) = languageId + \0 + sha256(text)`，预算 `AST_RETAIN_NODE_BUDGET` /
  `AST_RETAIN_LIMIT_NODES`，parse 响应带 `cached: boolean`。
  ⇒ **只有「这份确切文本此前被解析过」才命中**；diff 拿到的是**改后**文本，几乎必然 miss ⇒ 要触发一次
  真解析，且该语言的 wasm 语法必须已安装。
- `src/ast/language.ts` 有 `languageForPath(path)`（按扩展名给语言描述符）——启发式可以据此选语言专属的
  作用域语法（Python 的 `def`/缩进、Ruby 的 `def...end`、Go 的 `func` …）。
- 外部同类工具的先例（#292 调研）：quangdang46/hashline 的块操作是**纯语法**（花括号/缩进/Ruby def…end），
  **不是** tree-sitter ⇒「启发式优先」不是权宜之计，是同类工具的既有做法。
