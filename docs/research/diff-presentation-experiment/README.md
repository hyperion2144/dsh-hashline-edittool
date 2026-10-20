# 实验：diff 呈现形态是否让模型「读懂被改的函数」

用户原话（需要解决的问题）：

> 让 agent 写代码的时候，有时候针对几十行的 diff，agent 好像很难理解它的函数（稍微复杂，逻辑分支多的）
> 哪里出了问题，觉得非常混乱。

⇒ 测的**不是**「哪行改了看不出来」（那个现在已经看得出），而是：
**只给模型看 diff 呈现，它能不能说出这是哪个函数、行为差在哪、生效条件是什么、影响面是什么。**

## 两臂

| 臂 | 渲染器 | 素材 |
|---|---|---|
| `old` | 改动**前**的生产代码渲染，产物冻结在 `baseline-old-format.md` | 同一份 `fixtures.mjs` |
| `new` | 改动**后**的生产代码渲染（`render.mjs --arm new`） | 同一份 `fixtures.mjs` |

两臂都是**生产代码**渲染的（旧臂是改动前那版的产物，已冻结），差别只在呈现形态本身。

## 素材（8 个 fixture）

每个 fixture 是一次「agent 式改动」，改在**有分支、逻辑不平凡的函数内部**：

| id | 文件 | 函数 | 改动 |
|---|---|---|---|
| `F1-myers-tiebreak` | `src/render/line-diff.ts` | `myersRange` | 相等元素的取舍 `<` → `<=` |
| `F2-salvage-branch-merge` | `src/hashline/anchor-pipeline.ts` | `salvageAnchorRef` | 两个警告分支合并成一个 |
| `F3-elide-drop-nested-order` | `src/ast/elide.ts` | `dropNested` | 排序第二关键字反向 |
| `F4-symbol-rule-order` | `src/ast/symbols.ts` | `ruleMatches` | 六个判定条件重排 |
| `F5-align-dp-budget-edge` | `src/hashline/align-bounded.ts` | `alignPreservedBounded` | DP 预算判定 `<=` → `<` |
| `F6-multi-line-delete` | `src/ast/elide.ts` | `spansAreDisjoint` | 整函数 8 行纯删除（跨行删除块） |
| `F7-two-deletes-one-hunk` | `src/ast/elide.ts` | `importRunSpans` | 同一段里两处独立删除 |
| `F8-multi-site-one-file` | 合成文件 `synthetic/multi-site.ts` | 三个函数 | 一个文件三处相距很远的改动（行 10 / 32 / 74） |

覆盖的难点：单字符语义变化、分支合并、排序语义反转、**行为等价**的重排、边界条件收紧。

答案（ground truth）在 `fixtures.mjs` 的 `truth` 字段里，**不能**给作答的模型看。

## 四问（每 fixture 四题，只给 diff 文本）

1. **定位**：这次改动落在哪个文件的哪个函数/方法？
2. **语义**：改前 vs 改后，这个函数的行为差异是什么？
3. **条件**：改动生效的条件/分支是什么？
4. **影响**：改动是否影响该函数的其他分支或外部调用者？依据是什么？

评分：每题 0/1（要点命中，对照 `truth`），每 fixture 0–4 分，两臂满分各 32。
判分要点：
- Q1 命中函数名才算对（文件可选但加分）。
- Q2 必须说到**语义变化**本身，不接受「改了一行代码」。
- Q3 必须给出**可判定的条件**（哪个分支、哪个比较、哪个阈值）。
- Q4 必须给出**方向**（等价 / 只影响某分支 / 影响调用者），并说清依据；
  「行为等价」类（`F4`）说成「有影响」算错，「有影响」类（`F1`/`F3`/`F5`）说成「完全等价」算错。

## 跑法

```bash
# 1. 渲染（需要先 npm run build 出 lib/）
node docs/research/diff-presentation-experiment/render.mjs --arm new

# 2. 作答：每臂派一个子代理，只给它渲染文件 + 四问，不给 fixtures.mjs、不给仓库源码
# 3. 判分：把两臂的答案对照 fixtures.mjs 的 truth 打分
```

**公平性要求**：两臂用**同一个模型**、**同一份提示**；作答者**不得**读 `fixtures.mjs`、
不得读仓库源码、不得调用工具（否则等于给了答案）。

## 第二部分：端到端

四问测的是「读懂 diff」。另一路是**真的改**：给模型一个真实任务（例如「把 `alignPreservedBounded`
的 DP 预算边界改成严格小于」），让它用插件改代码，然后看它**后续**的编辑是否落在正确的行上、
是否需要重新读文件才能定位。

- 端到端的判据：首次编辑是否命中正确的函数/区间（不需要先 `read` 全文）。
- 这一路要在隔离实例里跑（`DSH_HOME` + 独立端口 + `DSH_DESKTOP_NO_SINGLETON=1`），
  不动用户正在跑的桌面应用。

## 素材可复现性

`fixtures.mjs` 用**行块替换**表达改动（按 trim 后的行内容匹配，命中不唯一就报错退出）。
`src/` 的相关函数若被改动，素材需要跟着更新——改素材时先跑一次 `render.mjs --arm old`，
它会直接告诉你行块有没有匹配上。
