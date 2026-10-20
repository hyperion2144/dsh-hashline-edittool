# Spec — diff 呈现：统一 diff 形态 + `@@` 段头

> Status: **Draft** —— 形态已由用户拍板（2026-10-19），实现时校准细节。
> Scope: 模型可见 diff 文本 + web diff 卡片 + 模型提示段。**不含发布**。
> 证据底座：[`research/diff-presentation-mainstream.md`](./research/diff-presentation-mainstream.md)（主流 agent / IDE）、
> [`research/diff-presentation-hashline-and-literature.md`](./research/diff-presentation-hashline-and-literature.md)（hashline 同类 + 文献）、
> [`research/diff-presentation-repo-facts.md`](./research/diff-presentation-repo-facts.md)（仓库侧事实）、
> [`research/diff-presentation-experiment/`](./research/diff-presentation-experiment/)（验收实验台）。
> 实施票：#296 规格 · #297 模型侧渲染 · #295 卡片侧 · #294 段头作用域名 · #298 验收。

## 1. 目标

**让模型看完一次编辑的 diff 之后，能说清：改了哪几处、每处在文件的哪个行区间、每处属于哪个函数、每处的前后差在哪。**

省 token 是次要约束——不是目标。今天的浪费（上下文太窄、位置不明）只是症状。

## 2. 硬约束（红线，不得推翻）

1. **diff 行形状不变**：`<+|-><anchor>:<content>`（行号开关打开时为 `<+|-><anchor>:<line>:<content>`）。
   模型靠左列抄锚点；行形状变了整套锚点契约就要重写。
2. **只在线外加东西**：文件头与段头是行外的结构信息；行内的锚点语法不动。
3. **两个表面同时改**：模型可见文本与 web 卡片一起改。
4. **一段渲染多处共用**：`edit` / `write` / `undo_last_edit` / `ast_edit` 共用同一段渲染，四处一起受益也一起承担代价。
5. **不新造配置**：上下文行数沿用既有 `context_lines`（默认 3）；行号沿用既有 #244 开关（默认关）。

## 3. 形态定义（逐条可实现）

### 3.1 整体骨架

```
<图例>
--- <path>
+++ <path>
@@ -<oldStart>,<oldCount> +<newStart>,<newCount> @@ <作用域名>
 <未改行>
-<删除行>
+<新增行>
 <未改行>
```

### 3.2 文件头

`--- <path>` 与 `+++ <path>` 各一行。`<path>` 是仓库相对路径，与今天 `Successfully edited in <path>.` 用的是同一个 path。
多文件时每个文件一组文件头，组间空一行（见 §3.7）。

### 3.3 段头

```
@@ -<oldStart>,<oldCount> +<newStart>,<newCount> @@ <作用域名>
```

- `oldStart` / `oldCount`：该段在**改前**文件里的起始行与行数；`newStart` / `newCount`：改后。**计数含上下文行**（git 惯例）。
- 作用域名：**每一处改动**所在的最内层**命名符号**（函数 / 方法 / 类），形如 `myersRange()`、类写 `Foo`；去重后按改动出现顺序用 ` / ` 连接（`first() / second()`）。
- 作用域名按**改动自己的行**查，不按段首行 ⇒ 上下文行把邻居函数拉进来时不会借它的名字；段切分仍只按行距离（`context_lines`），不按函数边界。
- **检测不到就不写**（段头以两个空格结尾）。段头里的名字只是信息，不参与任何正确性判断。
- 段头**不铸锚点、不进 served 集**（ADR-0009 的惰性分配不受影响）。
- 段头以 `@@` 开头 ⇒ 不会被锚点行正则误认（`@@` 非 Base62），模型误粘时得到干净的 `E_BAD_REF`。

### 3.4 主体行

| 前缀 | 含义 | 锚点 |
|---|---|---|
| ` `（空格） | 未改行 | 改后的新锚点 |
| `+` | 新增 / 改动行 | 改后的新锚点 |
| `-` | 删除行 | **改前的旧锚点**（已失效） |

- 行号开着时锚点后多一段 `:line`（复用 #244 既有形状）。
- 锚点列沿用今天的右对齐逻辑。
- 段内**不再有 ` ... ` 省略行**：段与段之间由段头分隔，段头自带行区间。

### 3.5 旧锚点的 `~` 标记

`-` 行的锚点带 `~` 前缀（`~Tl`）⇒ 不是合法 Base62 ⇒ 模型误抄时直接落在锚点校验的第 3 级，
得到干净的 `[E_BAD_REF] Invalid anchor ...`（今天照抄会先被 salvage 救活、再死在 stale 检查上，错误信息绕一圈）。
已验证（`research/diff-presentation-repo-facts.md` §8）：行正则只认 `[+-]?` 前缀，`~` 不影响 `content_lines` 的剥前缀逻辑。

### 3.6 结尾状态行

保留今天的 `Successfully edited in <path>.` 与 ` Added N line(s), removed M line(s).`——它们是状态行，不属于 diff 形态。

### 3.7 多文件

每个文件一组 `--- path` / `+++ path`，组间空一行。今天的 `--- <path> ---` 分隔行由文件头取代。

### 3.8 图例（EDIT_DIFF_LEGEND）

```
Diff rows: <+|-><anchor>:<content> — a unified diff: `@@ -old,count +new,count @@ scope()` gives the line range and the enclosing function; `-` rows are the pre-edit lines (their `~` anchors are stale), `+` rows and unchanged rows are the post-edit code.
```

行号开着时形状写成 `<+|-><anchor>:<line>:<content>`。

### 3.9 模型提示段

`src/domain/edit/prompts.ts` 的 edit 指引要补三句：

1. 文件头与段头是**结构信息**，不是文件内容、不是锚点，不可粘进 `edit`。
2. `-` 行的锚点（`~` 开头）已失效，不要拿去编辑。
3. `+` 行与未改行的锚点可用于后续编辑。

## 4. 段怎么切（git 规则 + 既有配置）

- 两个改动块之间的未改行数 ≤ 2×`context_lines` → 合并成同一段；否则分成两段（git 的 compact 规则）。
- 段内：改动块前后各取 `context_lines` 行上下文。
- 段头区间 = 该段覆盖的行区间（含上下文）。
- 实测（`research/diff-presentation-experiment/`，F8 = 一个文件三处远距改动）：
  - `context_lines=3` → 三段：`@@ -7,7 +7,7 @@ alpha()` / `@@ -29,7 +29,7 @@ gamma()` / `@@ -71,7 +71,7 @@ theta()`。
  - `context_lines=40` → **一大段** `@@ -1,81 +1,81 @@ alpha()`，里面散布三处改动。
- ⇒ **段粒度不是新概念，就是 `context_lines` 的后果**（用户 2026-10-19：「上下文长度不是配置的么」）。

## 5. 作用域名怎么来（#294）

- 纯语法启发式：花括号配对出块的区间（跳过字符串 / 行注释 / 块注释）→ 分类 → 多行签名回溯声明行。
  原型见 `research/diff-presentation-experiment/scope.mjs`（`detectScopes` / `findDeclaration` / `enclosingScope`）。
- 只取**改后文本里仍存在**的符号：被删掉的函数名进不了段头（只能从删除行里看到）。
- AST 不作默认：改后文本几乎必然 miss worker 的 LRU 树缓存（`cacheKey = languageId + \0 + sha256(text)`），
  且 wasm 语法要现下载现装（`src/ast/registry.ts` PACKAGED）。LSP 只在 `readySessionFor()` 就绪时可用。
- 外部同类工具的块识别也是纯语法（quangdang46/hashline 的 `SWAP.BLK` / `DEL.BLK` 按花括号与缩进）。

### 5.1 语言覆盖（#301）

语言**按文件扩展名 / 文件名选**，机制与 git 选正则模式表一致：路径 → 语言描述符 → （**块族** + **声明模式组**）。加一种语言 = 语言表加一行 + 选一个已有的模式组。

| 块族 | 块边界 | 语言 |
|---|---|---|
| brace | 花括号配对 | TS/JS、Vue/Svelte、Rust、Zig、Go、C/C++/ObjC、Java、Kotlin、Scala、C#、Swift、Dart、Groovy、Solidity、D、PHP、Perl、Shell、PowerShell |
| indent | 缩进 | Python、Vyper、Ruby（含 `Rakefile` / `Gemfile` 按文件名） |
| keyword-end | `end` 计数 | Lua、Elixir、Julia |

- 声明模式组：`js` / `rust` / `go` / `c` / `php` / `perl` / `shell` / `python` / `ruby` / `lua` / `elixir` / `julia`。
- 明确不支持：Erlang、OCaml、Haskell、Clojure、Lisp、Fortran、Ada、Pascal、Cobol、SQL、R、Makefile、Dockerfile —— 检测不到就**不给名字**，不猜。
- 路径从 `genDiff` 的 `GenDiffOptions.path` 传到探测器（接缝 `ScopeLabelAt(text, line, path?)`）；**没有路径时**只走 TypeScript 读法（brace 族里的 `js` 模式组），保持 TS/JS 的旧行为 —— 故意不是所有 brace 组的并集：没说过自己是 Go 的文件不当 Go 读。
- 名字只是信息（不进任何正确性判断）：**宁可不给，也别给错**。
## 6. 卡片侧（#295）

卡片数据**只**来自 `presentationMeta.diffRows`（结构化），与模型文本互不解析 ⇒ 两侧各改各的，但形态必须一致。

- 宿主侧 `src/render/edit-card.ts` 的 `diffRowsFromMeta` 硬性要求 `kind ∈ {+, -, 空格}`，
  出现别的 kind 整体返回 `undefined`（卡片静默退化为无 diff）⇒ 新增「文件头 / 段头」kind 必须同时改这里，并钉测试。
- 客户端 `client/src/client/diff-block.tsx`：`buildDisplayRows` 增展示行类型（现有 del|add|ctx|gap）、
  `copyText` 排除头行（复制给模型的是内容，不是锚点）、折叠的 head/tail 数学要把头行算进去。
- 卡片 gutter 仍用旧 hash 形态（`-21:C7`），removed 行本就被注释为「stale but informative」⇒ 卡片侧不存在误抄旧锚点的问题，
  §3.5 的 `~` 是**模型文本侧专属**。

## 7. 边界情形

| 情形 | 形态 |
|---|---|
| 整文件新增（`write` 新文件） | 一个大段，`@@ -0,0 +1,N @@`（git 惯例） |
| 整文件回滚（`undo_last_edit`） | 同上反向 |
| 空 diff | 只出图例 + 状态行 |
| 只有删除没有新增 | 段头 `newCount` = 0 |
| 跨行删除 | `-` 行连续出现；旧行本身是「不配对的代码」（有 `{` 无 `}`），躲不掉，只保证位置明确 |
| 响应预算分段（ADR-0013，48K） | 段头整行随段走，不切半行 |
| 多文件部分失败 | 失败文件单独给错误，不进 diff |

## 8. 已否决的形态（附理由）

| 形态 | 否决理由 |
|---|---|
| 整函数带出（上下文主体） | 用户明确否：上下文要的是「改了啥 + 配置的头尾」，不是整个函数 |
| 「干净主体 + 删除块单列」 | 用户否：「跟原地 diff 没区别，多个 `removed (N line(s)):` 而已，没必要」 |
| 删除块挪到段尾 | 用户否：「删除的到底是哪里都看不出来」——位置丢失 |
| 整函数新旧两版对照 | Aider 实测错误率 +30~50% |
| 每行加行号前缀 | 破红线（行形状不变）；写侧行号不可靠是各家共识 |
| 让模型全文件重写 | Cursor 的做法；与本插件的锚点定位契约冲突 |
| 函数级语义摘要 | 无先例；插件内调不了模型，只能做启发式计数——留作后续探索，本轮不做 |
| 失败路径才给 diff | Zed 的成功 / 失败分流；本插件的成功路径本就要给 diff，先不动 |

## 9. 影响面

- 渲染：`src/render/edit-diff.ts`（要产段结构与 old/new 区间）、`src/domain/edit/edit-response.ts`（文件头 / 段头 / 图例 / 状态行）。
- 提示：`src/domain/edit/prompts.ts`。
- 卡片：`src/render/edit-card.ts`、`client/src/client/diff-block.tsx` 及其类型定义。
- 锚点一致性：`src/domain/edit/served-rows.ts`、`src/domain/edit/edit-engine.ts`（渲染行必须与服务行一致；文件头与段头不进 served 集）。
- 新增：纯语法作用域检测模块（`src/render/scope/`，纯函数、可单测）+ 接缝 `src/render/scope-registry.ts`；语言按扩展名/文件名选（#301）。
- 测试：`test/core/edit-diff-rows.test.ts`、`edit-diff.preview.test.ts`、`edit-diff.utils.test.ts`、`line-diff.test.ts`、
  `write-diff-bounded.test.ts`，以及新增的作用域检测与卡片头行用例。

## 10. 风险与回退

| 风险 | 缓解 |
|---|---|
| 段头行数算错（模型据此定位会偏） | 段区间从 diff 的行计数器推，不从文本反解；单测钉住 |
| 段头被模型误抄 | `@@` 前缀 + 非 Base62 字形 ⇒ 干净报错（§3.3 / §3.5） |
| 卡片白名单漏改 ⇒ 卡片静默退化 | 钉一条「头行 kind 能通过 `diffRowsFromMeta`」的测试 |
| 启发式误判作用域 | 名字只作信息，不参与正确性判断；不确定就不给 |
| 模型把头行当内容行 | §3.9 的提示段同步 |

## 11. 验收（#298）

- **臂**：`old`（今天的样子）vs `new`（本规格），同一份 fixture、同一批问题。
- **fixture**：5 个真实改动 + 3 个边界改动（整函数纯删除 / 同段两处独立删除 / 一文件三处远距改动），每个带四问的标准答案。
- **四问**：改了哪几处 / 每处属于哪个函数 / 每处在文件的什么位置 / 前后语义差在哪。
- **端到端**：模型读完 new 臂后能否给出正确的下一次编辑锚点、能否在真机上改对位置。
- 器材与口径见 [`research/diff-presentation-experiment/README.md`](./research/diff-presentation-experiment/README.md)。
