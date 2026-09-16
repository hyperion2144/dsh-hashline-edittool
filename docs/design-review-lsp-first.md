# 设计评审：按「LSP 优先、对齐 omp」重看 #29 整张图

> 参考实现：`@oh-my-pi/pi-coding-agent@17.2.2`（本地 `~/.bun/install/cache/@oh-my-pi/`）。
> 所有关于 omp 的陈述都来自读它的源码与提示词，不是印象。

## 一、omp 的形状

### 工具面（`src/tools/builtin-names.ts`）

```
ast_edit · ast_grep                          ← 结构层
lsp                                          ← 语义层
read · edit · write · grep · glob · find     ← 文本层
```

**注意：没有 `ast_read`。** 结构层只有两个工具，都收 **ast-grep 模式**。

### `ast_grep` / `ast_edit` 收的是模式

```ts
const astGrepSchema = type({ pat: type("string").describe("ast pattern"), "path?": … })
const astEditOpSchema = type({ pat: "ast pattern", out: "replacement" })
```

元变量：`$NAME` 捕获一个节点 · `$$$NAME` 零或多个 · `$_` 匹配不绑定。

**它自己的示例里就有 import**：

```
pat: 'import { $$$IMPORTS } from "old-package"'
out: 'import { $$$IMPORTS } from "new-package"'
```

### `lsp` 的操作（`src/prompts/tools/lsp.md`）

```
symbols        file 列出该文件符号；file: "*" + query 搜整个工作区   ← 符号来源
diagnostics    path / glob / 工作区
rename         apply 默认执行，apply:false 预览
rename_file    移动文件并重写所有 import 与引用
code_actions   列出；apply + query 执行一个   ← import 相关走这里
reload         重启服务器（reload * 重读 LSP 配置）
request        裸 LSP
```

### 集成规则（提示词的 `<critical>` 段，逐字）

> - **Symbol-aware work (rename, references, definition, code actions) MUST use `lsp` whenever a server is available.** It follows shadowing, re-exports, and cross-file usages text tools miss.
> - **NEVER** do a cross-file rename with `ast_edit`/`sed`/hand edits when `lsp` `rename`/`rename_file` can — text renames silently drop callsites.
> - Reach for `code_actions` on **imports**, quick-fixes, and server-known refactors before editing by hand.

### 带一张服务器目录（`src/lsp/defaults.json`）

每个服务器：`command` · `args` · `fileTypes` · `rootMarkers` · `settings` · `capabilities`。
已配 `rust-analyzer` · `clangd` · `gopls` · `zls` · `tlaplus` …

**「LSP 优先」在 omp 里成立，是因为它保证有服务器可用** —— 目录是开箱即用的，不靠用户自己装。

## 二、我们现在的形状

| 面 | omp | 我们 |
| --- | --- | --- |
| **符号从哪来** | **`lsp symbols`** | `kindRules` —— 每语言一张节点类型表 |
| **结构查询** | **ast-grep 模式** | kind 过滤（`SYMBOL_KINDS` 十个值） |
| **import** | **`lsp code_actions`** + 模式 | 正在给 15 门语言逐个配 `imports` |
| **LSP 服务器** | **内置目录**（fileTypes + rootMarkers + settings） | 探测 `project bin → PATH → configured`，**无目录** |
| **每语言语法配置** | **没有** | `kindRules` · `nameFields` · `nameChildTypes` · `nameChildExclude` · `wrapperNodeTypes` · `imports` … |
| **工具面** | `ast_grep` / `ast_edit` / `lsp` 独立 | AST **折进** `read`/`edit`（`ast.enabled` + `symbol`/`summary` 参数） |

### 三条结论

1. **`import` 这个 kind 在错误的层。** omp 里它由 `lsp code_actions` 与 ast-grep 模式回答，**两边都不需要 kind 表**。#118 不是「import 怎么修」，是**层放错了**。

2. **「每语言语法表」这条路 omp 没走。** 它用**通用机制**：LSP 协议（符号/语义）+ ast-grep 模式（结构）。**我们十几种每语言字段，是在给这两个通用机制能回答的问题造专用机器** —— 而且每加一门语言都要再配一次，**配漏了没人会发现**。

3. **「LSP 优先」要先有服务器。** omp 靠内置目录保证这一点。**我们没有目录，`discovery` 只能找已经装好的** —— 所以现在照搬「优先 lsp」，在多数环境里会退化成「没有 lsp」。

## 三、建议的目标设计

### A. LSP 侧（先补目录，才能谈优先）

- **内置服务器目录**：`command` / `args` / `fileTypes` / `rootMarkers` / `settings`，形制对齐 omp 的 `defaults.json`
- `discovery` 保留三级探测，**目录作为第四级**（找不到已装的就用目录里的命令名去 PATH 找）
- 子命令 `lsp` 增 `symbols` / `code_actions` / `diagnostics`，**对齐 omp 的操作名**

### B. AST 侧（结构，不碰语义）

- **保留** tree-sitter 与内置文法 —— **这是本插件相对 omp 的既有优势**（零配置、同步、无进程）
- **新增 ast-grep 风格的模式匹配**（`pat` + `$NAME`/`$$$NAME`），作为 `kindRules` 之外的**通用查询路径**
- **`kindRules` 保留为符号列表的实现**，但它**不再是唯一入口** —— 模式能问的问题不必进 kind 表

### C. 优先级（这是 omp 的规则，逐字对齐）

**符号感知的工作（定义、引用、重命名、诊断、import 动作）有服务器时必须走 LSP；AST 负责结构形状。**

### D. 契约（`import` 与其它 kind）

- **移除 `import` kind** —— 它从来没产出过符号（#118 实测），且归属 LSP
- 其余 kind **保留**：它们由 AST 从语法结构得出，**在无服务器时是唯一来源**，这是本插件的价值

## 四、对地图上各票的影响

| 票 | 影响 |
| --- | --- |
| **#118** import 粒度 | **作废重开**：结论是「层放错」，不是「粒度没定」。改为**移除 kind** + 记录归属 LSP |
| **#120** LSP 管理 | **扩大**：加**内置服务器目录**（A 段），否则「LSP 优先」无服务器可用 |
| **#121** 更新检测 | 不变，但目录引入后**多一个要维护的东西**（服务器命令版本） |
| **#104** LSP 诊断 | 与 omp 的 `diagnostics` 对齐，**操作名与语义照抄** |
| **#112** 冒烟 | 不变 |
| **#117 / #122** | 已关，不受影响 |
| **新票** | **ast-grep 模式匹配**（B 段）——这是本次评审**新暴露的最大工作项** |

## 五、我不确定的地方（需要你定或需要再验）

1. **模式匹配的实现路径**：omp 用原生模块 `pi-natives`（Rust）。我们在 Node 里，要么引 `@ast-grep/napi`，要么在 tree-sitter 之上自建。**这是显著的工作量与依赖决定。**
2. **工具面是否拆分**：omp 是 `ast_grep`/`ast_edit`/`lsp` 三个独立工具，我们是折进 `read`/`edit`。**拆开更对齐，但动的是模型看到的整个面**（提示词、卡片、冒烟清单全要改）。
3. **内置目录的维护**：服务器命令名与参数会变，**目录本身成了要更新的东西**（与 #121 的更新检测是同一族问题）。
