# 锚点单一真相源改造前的三项实测（重绑定 / served 行化 / Myers 跨度上限）

> 研究工单：#217（wayfinder map #214，规格票 #227，对齐票 #215）
> 测量脚本：`docs/research/single-source-anchor-state-measurement-scripts/`
> 运行环境：macOS arm64 / Node **v26.7.0** / sqlite 3（`node:sqlite`）/ 本机 V8 `heap_size_limit` = 4,395,630,592 B（4.09 GiB）与 12,985,565,184 B（12.09 GiB，加大堆的对照组）
> 被测代码：`lib/` 下由当前 `src/` 编译产物（`lib/*.js` 时间戳 2025-10-04 09:14，晚于全部 `src/**/*.ts`，即 `lib` 与工作区源码一致；测量期间**未修改 `src/` 与 `test/`**）
> 活动库快照：`/tmp/hashm/`（2026-10-04 11:32 从 `~/.dsh/plugins/dsh-hashline-edittool/` 复制的只读副本；活动库本身只读，未写入）

---

## 结论先行（TL;DR）

| 项 | 结论 | 数据依据 |
| --- | --- | --- |
| **1. 锚点重绑定** | **结构上真实可达，且已被构造性复现**：同一会话内，一个已被释放的锚点会被重新铸造到**另一行**上，`verifyServedRange` 的"锚点即身份"检查仍**接受**它，编辑静默落到错误的行。活动库里**没有**历史痕迹（0/34776 个 served 槽位重绑定到不同内容），但有 **514 个"模型仍持有、库里已消失"的槽位**——这正是重绑定的前置条件，且它每天的累积量级是 1.8%。 | §1.2–§1.4；`07-silent-wrong-line-proof.ts` |
| **1. 是否要按会话记退役锚点** | **要**。但不必是"每会话一张表"：最小成本是让会话内的 used-set **包含已释放锚点**（退役集），或在新写路径上把校验从「锚点 ∈ served」升级为「(锚点, contentKey) ∈ served」。理由见 §1.5。 | §1.5 |
| **2. served 行化** | 现状 `served` **完全不是瓶颈**：一次 read 200 行只写 **1 行 / 274 B**（整个 `served` 行族在真实库里只占 **77 KiB / 0.73%**）。改成每锚点一行后，同一次 read 要写 **200 行 / ≈51 KiB**（按真实库中位路径长 66 B 测算），**单次操作的写入放大 ≈187×**；真实库上 `served` 行族本身会从 **77,824 B（0.73%）涨到 7,057,408 B（10.5%）**，即 64 MiB 字节预算的 10.5%。**建议不要行化**，或行化后必须重估预算（300,000 行 × 256 B = 73.2 MiB，**字节预算会先于行数触顶**）。 | §2.3–§2.5 |
| **3. Myers** | 生产默认 `maxD = 256` 下，**Myers 的耗时与内存都不是风险**（800k 行、50% 行被改：5.80 s / 263 MB heapΔ；同一输入 `alignPreservedBounded` 要 13.77 s / **1.59 GB** heapΔ）。真正的风险有两个：**(a) 把 `maxD` 调大**（16384 → 一次调用分配 **1.31 GB** ArrayBuffer，`O(maxD²)` 的 trace）；**(b) 单块连续增删 ≥ ~20 万行时 `partsFromRuns` 的 `push(...array)` 直接 `RangeError: Maximum call stack size exceeded`**（与 Myers 无关，是渲染层的缺陷）。结论：**不需要给 op 跨度设上界，但要给 `maxD` 设上界（保持 256 或更低），并修掉 spread**。 | §3.3–§3.6 |
| **附带发现** | `anchor_lines` 的每次 `persistProjection` 都是 **DELETE 全路径 + 逐行 INSERT 全量重写**（`hash-store.ts:1786-1795`）。600 行文件第一次 serve 写 127.7 KiB WAL，其中属于 served 的只有 12.4 KiB。**真正需要关注写入量的是 `anchor_lines`，不是 `served`。** | §2.6 |

---

## 0. 方法与环境

### 0.1 测量原则

- **实测值** 一律来自命令输出；**推算值** 全部显式标注「推算」并给出推算依据（每行字节怎么来的、行数怎么数的）。
- 无法在现有代码上测量的项（新形状的行表**尚未实现**）不伪造，写明"能测的部分"与"只能推算的部分"的分界。
- 所有临时脚本放 `/tmp/hashm/`，交付副本放 `docs/research/single-source-anchor-state-measurement-scripts/` 并附完整运行命令（附录 A）。
- **未修改** `src/` 与 `test/`；`docs/research/` 只新增本报告与脚本目录。

### 0.2 三类被测对象

| 编号 | 对象 | 入口 | 备注 |
| --- | --- | --- | --- |
| M1 | 锚点分配 / 释放 / 淘汰 | `alloc.ts`、`session-anchors.ts`、`hash-store.ts` | 纯函数 + 真 sqlite 库 |
| M2 | served 写入量 | `session-view.ts` → `hash-store.ts` | 真 sqlite 库（`$DSH_HOME` 指向 `/tmp/hashm/home*`） |
| M3 | Myers 与有界 DP | `render/line-diff.ts`、`hashline/align-bounded.ts` | 子进程隔离，逐例各起一个进程 |

### 0.3 关于「新形状尚未实现」

`served` 的行化表 `(session_id, path, anchor, updated_at)` PK `(session_id, path, anchor)` **本次改造前不存在**（`hash-store.ts:570-579` 仍是 5 列 JSON blob 形状）。因此：

- **(a) 现状**：完全实测。直接调用 `recordServed` / `recordServedAfterEdit` / `reconcileServed` 等**生产函数**，存进真 sqlite，然后 `shutdownHashStore()` 关库、再开只读连接取行数/字节数。
- **(b) 新形状**：**物理实测**，不是纸面推算——在同一张真 sqlite 里 `CREATE TABLE` 出与规格票 #227 描述完全一致的新表（含 PK），把**真实的锚点集合**逐行 INSERT，再用 `page_count - freelist_count` 的差值读字节数。这样测的是 SQLite 真实的行格式 + autoindex + 页填充率，而不是我猜的公式。**未实测的部分**：新表接入 `upsertServed` 后的写路径（事务边界、sweep 交互）——需要先实现行表才能测。

---

## 1. 测量 1：锚点重绑定的实际发生率

### 1.1 活动库现状画像（只读）

两张库在 2026-10-04 11:32 被复制到 `/tmp/hashm/`，以下数字全部来自**副本**（命令 `01-store-inventory.mjs` / `04-store-inventory-frozen.mjs`）。复制后活动库仍在增长（我自己的会话也写它），故快照时刻已标注。

| 指标 | `--Users-mutou-projects-dsh-tool-hashline--` | `--Users-mutou-projects-dsh-desktop-app--` |
| --- | --- | --- |
| 主库文件字节 | 10,690,560 | 3,588,096 |
| `storeBytes` 预算口径 `(page_count−freelist)×page_size` | 10,690,560 | 3,588,096 |
| page_count / page_size / freelist | 2610 / 4096 / 0 | 876 / 4096 / 0 |
| `anchor_lines` 行数 | 23,593 | 6,054 |
| `anchor_lines` 不同 path 数 | 113 | 46 |
| `anchor_meta` 行数 | 113 | 46 |
| `anchor_meta.line_count` 合计（= 有锚点文件的总行数） | 234,919 | 16,356 |
| `served` 行数 / 不同 session | 165 / 8 | 50 / 5 |
| `served.hashes` 载荷总字节 | 39,542（单行 10–2,674 B） | 9,636（单行 10–858 B） |
| `undo` 行数 | 142 | 58 |
| `snapshots` 行数 | 0 | 0 |
| 锚点长度分布 | 2 字符 22,332 / 3 字符 1,261 | 2 字符 5,7xx / 3 字符 2xx |

**字节构成（`dbstat`，副本）**——注意 `served` 是库里最小的行族：

| 对象 | tool-hashline 库 | desktop-app 库 |
| --- | --- | --- |
| `undo` 表 | 3,076,096 B（751 页） | 1,449,984 B（354 页） |
| `anchor_lines` 表 | 2,764,800 B（675 页） | ~696,320 B（170 页） |
| `anchor_lines_by_anchor` 索引 | 2,510,848 B（613 页） | — |
| `sqlite_autoindex_anchor_lines_1`（PK path+line） | 2,363,392 B（577 页） | — |
| `anchor_lines_updated_at` 索引 | 487,424 B（119 页） | — |
| **`served` 表 + `served_updated_at` 索引** | **77,824 B（19 页，0.73%）** | **28,672 B（0.80%）** |

> 单文件锚点最多的 path 是 `node_modules/typescript/lib/typescript.js`，5,000 行锚点（= 该文件被服务过的行数），其余 ≤ 1,372。

### 1.2 代码判定：重绑定在结构上是否可能

三个模块的分工如下（结论：**可能**，而且是设计使然）：

**(a) 分配只避开"当前存活"的锚点集。** `allocateInto` 每次调用重建 used-set，来源是**内存里的 sparse state**：

```ts
// src/hashline/session-anchors.ts:245-248
const currentLines = splitLines(content);
const used = new Set<string>();
for (const [, entry] of state.entries) used.add(entry.anchor);
```

注意这里**没有**任何"本会话历史上铸造过什么"的记录。`state.entries` 是"当前活着的 (line → anchor, contentKey)"。

**(b) 内容变了的行会立刻把锚点交还池子。** 同一函数的 262-277 行：行内容与 `contentKey` 不符时，`used.delete(existing.anchor)` 然后 `allocateAnchor(used, text, gc)` 重新铸一个——**被释放的那个锚点在本次分配中立即可用**。

**(c) 淘汰会删行，删完没有任何退役记录。** `runSweep` 的 `deletePathCascade` 删掉 `snapshots/undo/served/anchor_meta/anchor_lines` 五个行族（`hash-store.ts:941-947`），`pruneMissing` 同样（`:1225-1231`）。被淘汰后锚点池完全回到空白，重新 serve 时按内容确定性重铸——**同样的内容会拿到同样的锚点**（这是安全的），但内容变了就不保证。

**(d) 校验只做集合成员判断。** `verifyServedRange` 的注释把这条不变量写死了：

```ts
// src/hashline/anchor-pipeline.ts:1091-1096
// Set-based verification: the anchor IS the content identity. If it's in
// the served set, the line was served and (because anchors are
// deterministic + stable across edits/inherit) the content hasn't changed.
// No position-indexed lookup, no content-key mirror — the anchor alone is the
// proof.
```

于是整条链是：**锚点 = 身份**（假设）＋ **释放后可复用**（事实）＝ **身份可以被重新指派**。这是一个假设与一个事实之间的缺口。

**是否需要按会话记退役锚点集合** → **需要**。理由与最坏情形见 §1.5。

### 1.3 实测：重绑定可达，且构造性复现

**(i) 可达性扫描**（`06-rebind-reachability.ts`）：对一个真实分配的 1,000 行文件，把第 401 行的锚点从 used-set 中删除（模拟"内容被替换释放锚点"），然后拿 20,000 条候选内容去跑**真正的** `allocateAnchor`：

```
warmed 1000 anchors; depth-2 count = 1000
released anchor at line 401: r2
candidate strings tried for the released slot r2: 11894
allocator returned the RELEASED anchor for a DIFFERENT content: 5 time(s)
first example: {"candidate":"const injected_3056 = alpha(3056) * beta_1;","key":7197388961532740,"got":"r2"}
```

即：**每约 2,400 条不同内容就有 1 条的天然槽位正好落在那个被释放的槽上**（理论值 1/3844 = 1/3,844 ≈ 0.026%，实测 5/11,894 ≈ 0.042%，同量级）。这不是"某个攻击者才能做到的构造"，而是**一次普通分配的固有碰撞概率**。

**(ii) 完整后果演示**（`07-silent-wrong-line-proof.ts`）：400 行文件，模型读完拿到每行的锚点；随后两次编辑（第一次由模型自己发起，第二次是文件另一处被改写）：

```
model read the file. line 201 -> anchor Dk; line 350 -> anchor 8V
edit #1 (line 201): the old anchor Dk was released; line 201 now holds n8
  is Dk still somewhere in the file? no (its slot is free)
edit #2 (line 350): searched 3705 candidates for the matching slot;
  line 350 now holds Dk (was 8V)
>>> the model's remembered anchor Dk is now bound to line(s) [350];
    the model believes it is line 201
    content at line 350: "const REASSIGNED_3705 = shard(3705) + "3705";"
served set still contains "Dk": true
verifyServedRange ACCEPTED an edit naming Dk: it resolves to line 350,
  while the model means line 201. SILENT WRONG-LINE EDIT.
```

这段输出里的每一次调用都是生产函数：`allocateForLines`、`updateAnchorsAfterEdit`、`recordServed`、`getServed`、`verifyServedRange`。`Dk` 的重复不是巧合——它是按 `contentKey(replacement) % 3844 == value("Dk")` 反查出来的（搜了 3,705 条候选），这正是 §1.3(i) 的概率在起作用。

**(iii) 会话内也会发生**：把"释放"和"重铸"放在同一个会话的两次编辑里就够，**不需要淘汰参与**。淘汰（7 天 served TTL / 30 天锚点 TTL / 预算 LRU）只是把概率放大：淘汰让**整个文件的锚点池重置**，重铸的锚点集合会与旧集合大面积重叠。

### 1.4 实测：活动库里的历史痕迹

用 `05-rebind-history-scan.mjs` 扫两张库。方法：对每个 path，从 `undo` 表的 `(content, hashes)` 快照重建"历史上每个锚点绑定到哪一行、哪段内容"（`hashes[i]` 对应 `content.split("\n")[i]`，空串表示该行从未被服务）；再拿 `served` 里每个会话实际持有过的锚点，与**当前** `anchor_lines`（live 绑定）逐一对账。

| 分类 | tool-hashline 库 | desktop-app 库 |
| --- | --- | --- |
| `served` 里的锚点槽位总数 | 28,087 | 6,689 |
| 仍绑定在**同一 (line, contentKey)** | 23,767 | 4,827 |
| 已从 `anchor_lines` 消失（被释放 / 被淘汰） | **222** ＋ 292（无 undo 历史可回溯） | 0 ＋ 40（同上） |
| live 但 (line, contentKey) 与任何历史记录都不同 | 3,806 | 1,822 |
| **其中 contentKey 也不同（= 真·重绑到别的内容）** | **0** | **0** |

**读法**：那 3,806 / 1,822 条**全部是同内容换行号**（插入/删除导致的行位移）。从输出里挑一条看：

```json
{ "path": ".../CHANGELOG.md", "anchor": "6q",
  "history": ["24:3264779155737850"], "now": "23:3264779155737850" }
```

contentKey 一模一样（`3264779155737850`），只是行号从 24 变成 23。**这不是重绑定**，这是设计承诺的"内容不变则锚点跟着行走"。

**结论（明确表述）**：**在现有两张活动库、约 34,776 个 served 锚点槽位里，找不到任何"锚点被重新分配给另一段内容"的历史痕迹。** 但这**不能**读成"不会发生"：

1. 淘汰会删行（§1.2c），被删掉的历史无从回溯——292 + 40 = **332 个槽位连"它曾经绑在哪一行"都查不出来**，天然是盲区。
2. `served` 的 7 天 TTL 会让"模型仍持有但库里已无记录"的窗口被反复重造。
3. 真正有信息量的量是那 **514 个"已消失"槽位**（222 + 292，占 28,087 的 1.83%）——它们是**重绑定的前置条件**：锚点已被释放/淘汰，而模型手里还拿着它。
4. §1.3 已经证明：只要前置条件成立、且释放后有一次分配，命中就是一个 ≈1/3,844 的固有概率事件，且**被接受**。

> 注：本节的两张活动库都是"两天内、113/46 个文件"的小样本，且 `served` 行只有 165/50 行。它不是"发生率"的统计估计，只是"有没有历史痕迹"的定性检查。真正的发生率需要在新写路径上加计数器才能长期观测。

### 1.5 对下游决策的直接影响：需不需要"按会话记退役锚点集合"

**需要**，理由是缺口的结构性质而不是概率大小：§1.2d 的校验是**集合成员判断**，而 §1.3 证明了集合里的元素**可以被重新指派**。在两者同时成立的前提下，"模型手里的锚点指向哪一行"就**不再是**一个可判定的事实，而只是一个高概率的猜测。这类失败是**静默**的（编辑成功、落到错误的行、返回成功），比 `[E_STALE]` 糟糕得多。

三个可选修法，成本递增、覆盖面递减：

| 方案 | 做法 | 成本 | 覆盖 |
| --- | --- | --- | --- |
| **A. 会话内退役集** | `allocateInto` 建 used-set 时**不删**被释放的锚点（保留在会话的 retired 集合里），跨会话仍可复用 | 每个会话每 path 多一份 Set；**确定性重算会失效**（同样的内容在不同会话拿到不同锚点，`anchor-state-persistence.test.ts` 一类"重启后同一文件同锚点"的假设要重新论证） | 会话内的释放→重铸（§1.3iii） |
| **B. 写路径校验升级** | 新行表天然带 `(session_id, path, anchor)`，再存一个 `content_key`（或直接复用 `anchor_lines.content_key`），校验时比对 contentKey | 每行多一列 + 每次校验多一次读 | 全部（含淘汰后重铸） |
| **C. 全局退役集** | 锚点一旦分配过就永不复活 | 最贵；`62^2 = 3,844` 槽位会被历史消耗光，锚点长度被迫上浮到 3–4 字符，read 输出变宽 | 全部 |

**推荐 B**：既然规格票 #227 本来就要把 `served` 改成 (session, path, anchor) 的行表，**顺手加一列 `content_key`** 就把"锚点即身份"从假设变成事实，而 §1.4 已实测这条不变量在 34,776 个槽位上**没有被违反过**，所以它是一条"为将来兜底、当下零误报"的校验。实现成本等于一个新列，而不是一套退役账本。

**最坏情形（不修）**：

- 单点：一次编辑落到错误的行，覆盖了本不该动的代码，工具返回成功；模型据此继续往下编辑，错误在下一次 read 时可能被"合理化"为"文件本来就长这样"。
- 放大：`edit` 的 `remove_from`/`remove_to` 是一个**区间**。`verifyServedRange` 只检查两端锚点与中间行的锚点是否在 served 集合里；两端都在集合里而中间行被重绑，就是一个**跨区间**的静默覆盖。
- 频率：稳态下每次"释放后重铸"命中概率 ≈ 1/3,844（2 字符层；文件超过 3,844 个已分配锚点后上浮到 3 字符层，概率降到 ≈ 1/238,328）。作为对照，一次 read 200 行会铸造 200 个锚点，其中每个都有这个量级的碰撞机会。

---

## 2. 测量 2：served 行化的写入量

### 2.1 三种典型操作的定义（口径写死，便于复现）

| 操作 | 场景 | 命中行数 | 触发路径 |
| --- | --- | --- | --- |
| **read 200 行** | 一个 200 行的 TS 文件，`read` 无 offset/limit，全部 200 行进入 served 窗口 | **200** | `readAndServe` → `FileView` 分配锚点 → `recordServed` |
| **grep 命中 50 行（±2 上下文）** | 510 行文件，命中点在第 11、21、…、501 行（间距 10），每命中带 2 行上下文 | **250**（= 50 × (1 + 2×2)，间距 10 > 2×2+1 = 5，上下文窗口两两不重叠） | `tool-grep` → `allocateForLines` + `recordServed` |
| **edit diff 返回 30 行** | 200 行文件，中间 30 行被替换；diff 渲染上下文 3 行 | **36 个 served 行**（30 个 `+` 行 + 前 3 + 后 3 上下文行；`-` 行不产生 served 行，因为 `hash === undefined`） | `updateAnchorsAfterEdit` + `genDiff` → `recordServedAfterEdit` → `reconcileServed` |

> 说明：`genDiff` 只把 `+` 行和 ` `（上下文）行推进 `servedRows`（`src/render/edit-diff.ts:184` 与 `:240`），`-` 行的 `hash` 是 `undefined`，不服务。所以"diff 返回 30 行"的锚点写入量是 36 行，不是 30 行。

### 2.2 (a) 现状：JSON blob 形态下的写入量

命令：`08-served-write-volume.ts`（每例都清空 `$DSH_HOME`、跑真函数、关库后开只读连接取数）。

| 操作 | `served` 写入行数 | `hashes` 列字节 | 单行最大 | `anchor_lines` 行数 | `anchor_lines` 内容字节 | 库字节（metric） |
| --- | --- | --- | --- | --- | --- | --- |
| read 200 行 | **1** | **274** | 274 | 200 | 8,563 | 102,400 |
| grep 50 命中 ±2（250 行） | **1** | **342** | 342 | 250 | 10,969 | 114,688 |
| edit 200 行 / 30 行被改（36 served 行） | **1** | **70** | 70 | 200 | 9,178 | 102,400 |

**结论**：`served` 的物理形态是 **(session_id, path) 一行**，载荷是 `~1` 前缀的 varint+base64 打包集合（`served-codec.ts:135-160`）。一次 read 200 行写 **1 行、274 B**，其中 200 个锚点共占 272 B（`~1` 前缀 2 B）——**平均 1.36 B/锚点**。这与真实库的实测一致：28,087 个锚点槽位共 39,542 B = **1.41 B/锚点**（副本实测）。

**写入是"原地更新"，不是"追加"**：同一 (session, path) 反复 serve 会把同一行重写（`INSERT … ON CONFLICT DO UPDATE SET hashes`，`hash-store.ts:631-633`）。实测重服务同一 200 行三次，`recordServed` 每次只产生 **8,240 B WAL**（§2.6），`hashes` 列字节不变。

### 2.3 (b) 新形状：物理实测 + 推算

**实测方法**：在真 sqlite 里建出规格票描述的表：

```sql
CREATE TABLE served_rowshape (
  session_id TEXT NOT NULL, path TEXT NOT NULL, anchor TEXT NOT NULL,
  updated_at INTEGER NOT NULL, PRIMARY KEY (session_id, path, anchor));
-- 实测会隐式创建 sqlite_autoindex_served_rowshape_1（PK 的 autoindex）
```

然后逐行 INSERT **真实**的锚点集合。字节数取 `(page_count − freelist_count) × page_size` 的差值（与 `storeBytes` 预算口径一致，`hash-store.ts:683-685`）。

**每行字节数（实测，`11-row-shape-bytes-per-row.mjs`，20,000 行/档）**：

| path 长度 | 纯堆表（无 PK） | 含 PK + autoindex | 索引带来的增量 |
| --- | --- | --- | --- |
| 58 B | 124.52 B/行 | **255.80 B/行** | +131.28 B（+105%） |
| 80 B | 146.84 B/行 | **301.88 B/行** | +155.04 B（+106%） |
| 135 B | 205.21 B/行 | **419.23 B/行** | +214.02 B（+104%） |

**每行字节的构成**（以 66 B 路径的中间档为例，**推算**，依据 = 上面两档实测的线性关系 `≈ 2.34 × path_len + 118`）：

| 分量 | 字节 | 说明 |
| --- | --- | --- |
| 行载荷（`session_id` UUID 36 B + `path` 66 B + `anchor` 2 B + `updated_at` 整数） | ≈ 124 B | 对应实测"纯堆表"档；含 SQLite 记录头与 varint 长度前缀 |
| PK autoindex 条目（同样三列 + rowid 指针） | ≈ 131 B | 索引把 `session_id`+`path` 各存一份；这是**最大单项** |
| **合计** | **≈ 256 B/行** | 与实测 255.80（58 B 路径）吻合 |

> 注意这里**没有**单列 `updated_at` 索引：`ensureMaintenanceIndexes` 建的 `served_updated_at` 只作用于现存的 `served` 表（`hash-store.ts:1267`）；新表如果要支持 `SERVED_TTL_MS` 的 TTL 剪枝，还需要一个 `updated_at` 索引，那会再加约 20–30 B/行（推算，依据 = `anchor_lines_updated_at` 索引 487,424 B / 23,593 行 ≈ **20.7 B/行**，副本 dbstat 实测）。

**真实库上的实测（`12-row-shape-on-real-store.mjs` / `13-row-shape-heap-vs-index.mjs`，副本 + `VACUUM`）**：

| 库 | `served` 锚点槽位 | 现状 `hashes` 载荷 | 新表实测总增量 | 结论 |
| --- | --- | --- | --- | --- |
| tool-hashline | 28,087 | 39,542 B（**1.41 B/槽**） | **7,057,408 B**（251.27 B/行） | 178 × |
| desktop-app | 6,689 | 9,636 B（**1.44 B/槽**） | **1,822,720 B**（272.50 B/行） | 189 × |

拆分（`13-…`）：tool-hashline 库 28,087 行中，纯堆表部分 3,629,056 B（129.21 B/行），PK+autoindex 部分 7,536,640 B（**268.33 B/行**）——**索引比数据本身还贵**。

**按操作换算（推算，依据 = 每锚点一行 × 上面每行字节）**：

| 操作 | 新形状写入行数 | 新形状写入字节（66 B 中位路径，256 B/行） | 现状 | 放大倍数 |
| --- | --- | --- | --- | --- |
| read 200 行 | **200 行** | ≈ **51,200 B** | 1 行 / 274 B | **≈ 187 ×** |
| grep 50 命中 ±2 | **250 行** | ≈ **64,000 B** | 1 行 / 342 B | **≈ 187 ×** |
| edit（36 served 行） | **36 行** | ≈ **9,216 B** | 1 行 / 70 B | **≈ 132 ×** |

### 2.4 (c) 对比结论：新预算阈值下能装多少次操作

预算常量（`src/infra/constants.ts:53-64`）：`HASH_STORE_MAX_BYTES = 64 MiB = 67,108,864 B`、`HASH_STORE_MAX_PATHS = 5,000`、`HASH_STORE_MAX_ROWS = 300,000`。

**先看现状（实测 + 推算）**：`served` 行族占 64 MiB 的 **0.12%**（77,824 B，tool-hashline 副本 dbstat 实测）；即使把 5,000 条路径 × 8 个会话全部装满（40,000 行 served），按最大实测行 2,674 B 算也只有 107 MB（推算，依据 = 40,000 × 2,674 B）——**会超**，但那需要每行都接近 2,674 B 的极端情形，而实测均值只有 1.41 B/锚点。**结论：现状下 `served` 不构成预算压力。**

**新形状（推算，依据 = 每行 256 B / 300,000 行 / 67,108,864 B）**：

| 约束 | 触顶时的 served 锚点行数 | 换算成 read 200 行 | 换算成 grep 50 命中（250 行） | 换算成 edit 30 改（36 行） |
| --- | --- | --- | --- | --- |
| **字节** 67,108,864 B ÷ 256 B/行 | **≈ 262,144 行** | ≈ **1,310 次** | ≈ 1,048 次 | ≈ 7,281 次 |
| **行数** 300,000（`HASH_STORE_MAX_ROWS`） | 300,000 行 | 1,500 次 | 1,200 次 | 8,333 次 |
| **实际先触顶者** | **字节**（262,144 < 300,000） | **≈ 1,310 次** | — | — |

也就是说：

- **如果 300,000 行预算是给 served 用的**，那么新形状下**字节预算会先耗尽**：262,144 行 × 256 B = 64 MiB，正好卡在阈值之下。想要 300,000 行满载，需要 **≈ 73.2 MiB**（推算：300,000 × 256 B ÷ 1,048,576 = 73.24 MiB）的字节预算。
- **但 64 MiB 是整个库的预算，不是 served 一家的**。在 tool-hashline 副本（10.69 MB）里，`undo` 占 3.08 MB、`anchor_lines` 行族占 8.13 MB，而 `served` 目前 77 KB。若 `served` 涨到 67 MB 独占满额，**`undo` + `anchor_lines` 将无预算可用** → sweep 会开始按 LRU 淘汰**整个路径**（含 `anchor_lines`），也就是**锚点状态开始被淘汰，而淘汰正是 §1 那个重绑定前置条件的制造机**。
- 更贴切的问法不是"能装多少次操作"，而是"**新形状把库的 64 MiB 预算从 0.12% 推到了 11%**"：tool-hashline 副本现在的 `served` 若行化 = 7.06 MB ÷ 67,108,864 B = **10.5%**；而在一台真实开发机上 `served` 会随会话数线性增长（实测：8 个会话 165 行 served；每多一个会话就多一份行），会话数一多就会把整库预算吃满。

### 2.5 建议（直接给下游决策）

1. **不要为了统一真相源而行化 `served`。** 现状 1.41 B/锚点 是**打包 delta**带来的，行化会把它变成 256 B/锚点——换来的是"每锚点一行可索引"，而 `served` 的唯一查询是 `WHERE session_id = ? AND path = ?` 后取整个集合（`hash-store.ts:628-630`），**根本不需要按锚点索引**。
2. 若规格票 #227 出于"唯一真相源"的一致性一定要行化，那么必须同时：
   - 把 `HASH_STORE_MAX_BYTES` 从 64 MiB 提到 **≥ 96 MiB**（推算：262,144 行 × 256 B + 现有 undo/anchor_lines 占用 ≈ 8.1 + 3.1 MB + 余量）；
   - 或把 `served` 行数从 `HASH_STORE_MAX_ROWS` 里**独立出来**（现在 300,000 是 `anchor_lines` 的行数，`anchorRowCount()` 只数 `anchor_lines`——`hash-store.ts:687`；行化后两个行族共用同一个计数，会让 `anchor_lines` **更早**被淘汰）；
   - 并让 §1.5 的 `content_key` 列一起落地（否则花了 187× 的写入量，换来的仍然是一个可被重新指派的身份）。
3. 若目标是"确定性"而不是"行化"，**保留 blob 形态 + 在新写路径上做 (anchor, contentKey) 校验**，是成本最低的组合。

### 2.6 附带发现：真正吃写入量的是 `anchor_lines`，不是 `served`

命令 `09-served-phase-decomposition.ts` / `10-store-write-volume-wal.ts`（WAL 增量 = 真正写进磁盘的字节）。

**(甲) 600 行文件增量 serve，每批 100 行**：

| 批次 | `allocateForLines` 的 WAL 增量 | `recordServed` 的 WAL 增量 | served 集合大小 |
| --- | --- | --- | --- |
| 1 | 41,200 B | 12,360 B | 100 |
| 2 | 57,680 B | 8,240 B | 200 |
| 3 | 70,040 B | 8,240 B | 300 |
| 4 | 94,760 B | 8,240 B | 400 |
| 5 | 107,120 B | 8,240 B | 500 |
| 6 | 123,600 B | 8,240 B | 600 |

**(乙) 单次操作整体 WAL 写入量**：

| 操作 | WAL 增量 | 折算页（4 KiB） |
| --- | --- | --- |
| read 200 行 | 74,160 B | 18.1 页 |
| grep 50 命中 ±2 | 86,520 B | 21.1 页 |
| edit 200 行 / 30 改 | 131,840 B | 32.2 页 |

**读法**：`allocateForLines` 的 WAL 增量**随已分配行数线性增长**（41 KB → 124 KB，600 行），因为它走 `persistProjection` → `persistence.put` → **`anchorLinesDeletePath` + 逐行 `anchorLineUpsert` 全量重写**：

```ts
// src/domain/session/hash-store.ts:1786-1795
withTransaction(entry.db, () => {
  entry.stmts.anchorMetaUpsert(path, state.checksum, state.lineCount, Date.now());
  entry.stmts.anchorLinesDeletePath(path);          // 删掉该 path 的全部锚点行
  for (const line of state.lines) {
    entry.stmts.anchorLineUpsert(path, line.line, line.anchor, line.contentKey, Date.now());
  }
});
```

而 `recordServed` 只有 **8.2–12.4 KB** 且**不随集合增长**（原地更新一行）。所以：**如果这次改造的目标之一是"降低写入量"，靶子是 `anchor_lines` 的全量重写，不是 `served` 的 blob。** 把 `persistProjection` 从"全删全写"改成"差量 upsert + 只删释放的键"，收益约 **5–15×**（按上表 41–124 KB → 约 300 行 × 一次 upsert 的量级，推算）。

---

## 3. 测量 3：op 跨度内 Myers 的耗时与内存

### 3.1 被测实现与输入构造

- **Myers**：`src/render/line-diff.ts` 的 `diffLinesBoundedResult(oldText, newText, maxD)`，默认 `maxD = DEFAULT_MAX_D = 256`（`:53`），超限则把区间二分重试，最多 `MAX_SPLIT_DEPTH = 16` 层（`:56`）。
- **有界 DP**：`src/hashline/align-bounded.ts` 的 `alignPreservedBounded(oldKeys, newKeys)`，前缀/后缀裁剪 → `mMid·nMid ≤ effective` 走全 DP，否则分块（块长 `floor(sqrt(effective))`）。默认 `effective = min(5e7, floor(heap_size_limit / 32))`（`:42`、`:62`）——本机 4.09 GiB 堆下 **实测 = 50,000,000**。
- 两边输入**逐位对应**：同样的 `oldLines`/`newLines`，Myers 吃文本（内部 FNV-1a 成 Int32Array），DP 吃每行的整数 key。三种编辑形态：
  - **纯插入**：N 行 → 2N 行（中间插入 N 行全新内容），D = N；
  - **纯删除**：N 行 → N/2 行（删中间 N/2 行），D = N/2；
  - **50% 行被改**：N 行 → N 行，偶数下标行整行替换，D = N。
- 每例 **独立子进程**，`--expose-gc`，先在小输入上做 JIT 预热，再取 2–3 次中的最小值。内存用 `process.memoryUsage()` 与 `v8.getHeapStatistics()` 在调用前后采样。

### 3.2 耗时与内存主表（实测）

`heapΔ` = 调用后 `heapUsed` − 调用前 `heapUsed`（同进程、调用前 `global.gc()`）。

| N | 形态 | Myers 耗时 | Myers heapΔ | Myers 峰值 | 有界 DP 耗时 | DP heapΔ | DP 峰值 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | 纯插入 | 0.07 ms | 2.9 MB | 17.5 MB | 0.007 ms | 0.9 MB | 15.2 MB |
| 100 | 纯删除 | 0.14 ms | — | 6.2 MB | 0.005 ms | — | 5.9 MB |
| 100 | 50% 改 | 0.18 ms | — | 6.9 MB | 0.067 ms | — | 6.7 MB |
| 1,000 | 纯插入 | 0.43 ms | — | 8.3 MB | 0.050 ms | — | 8.0 MB |
| 1,000 | 纯删除 | 0.32 ms | — | 7.0 MB | 0.035 ms | — | 7.0 MB |
| 1,000 | 50% 改 | 1.98 ms | — | 9.1 MB | 4.62 ms | — | 28.7 MB |
| 10,000 | 纯插入 | 4.32 ms | 2.9 MB | 25.2 MB | 0.39 ms | 0.9 MB | 24.8 MB |
| 10,000 | 纯删除 | 2.33 ms | 3.1 MB | 17.4 MB | 0.23 ms | 0.8 MB | 16.6 MB |
| 10,000 | 50% 改 | **37.1 ms** | **9.8 MB** | 21.4 MB | **41.4 ms** | **66.9 MB** | 83.4 MB |
| 100,000 | 纯插入 | 62.2 ms | 62.5 MB | 128.0 MB | 6.0 ms | 7.0 MB | 86.7 MB |
| 100,000 | 纯删除 | 31.6 ms | 30.7 MB | 71.7 MB | 3.1 ms | 3.5 MB | 59.4 MB |
| 100,000 | 50% 改 | 320.3 ms | 49.9 MB | 115.5 MB | **1,763.1 ms** | **392.1 MB** | 545.2 MB |
| 800,000 | 纯插入 | **RangeError**（§3.6） | — | — | 62.1 ms | 42.1 MB | 456.5 MB |
| 800,000 | 纯删除 | **RangeError**（§3.6） | — | — | 29.5 ms | 28.0 MB | 280.5 MB |
| 800,000 | 50% 改 | **5,797.4 ms** | **263.4 MB** | 548.5 MB | **13,772.7 ms** | **1,590.6 MB** | **2,112.3 MB** |

命令：`16-myers-vs-bounded-single-case.mjs`（矩阵）、`14-myers-vs-bounded-matrix.mjs`（配对复跑）。原始行：附录 B。

### 3.3 `maxD` 才是 Myers 的杠杆（实测）

同一个 10,000 行 / 50% 改的输入，只改 `maxD`：

| `maxD` | 耗时 | 内存（ArrayBuffer 峰值） | 语义等价？ |
| --- | --- | --- | --- |
| 32 | — | — | 等价（见下） |
| 64 | 20.0 ms | 0.22 MB | 等价 |
| **256（生产默认）** | **33.6 ms** | **2.12 MB** | 等价 |
| 1,024 | 82.9 ms | 15.1 MB | 等价 |
| 4,096 | 261.6 ms | 82.2 MB | 等价 |
| 16,384 | 380.6 ms | **1,311.2 MB** | 等价 |

800,000 行 / 50% 改，同样只改 `maxD`：

| `maxD` | 耗时 | heapΔ | parts | degraded |
| --- | --- | --- | --- | --- |
| **256（默认）** | 5,797 ms | 263.4 MB | 1,200,000 | false |
| 64 | **980 ms** | 360.4 MB | 1,200,000 | false |
| 32 | **865 ms** | 331.5 MB | 1,200,000 | false |

**为什么 `maxD` 越大越慢、越吃内存**：`myersRange` 每轮都 `trace.push(v.slice())`，即 `maxD + 1` 个长度为 `2·maxD + 1` 的 `Int32Array`（`line-diff.ts:157-161`）。`maxD = 16384` 时仅 trace 就是 `16385 × 32769 × 4 B ≈ 2.1 GB` 的分配总额（实测 ArrayBuffer 峰值 1.31 GB，剩下的被 GC 回收）。**文件头注释承诺的 "~0.5 MB at the default cap" 实测成立**（2.12 MB，含两侧 Int32Array 与 units）。

**反直觉但重要**：把 `maxD` **调小**（32/64）不但没变慢，反而在 800k 上快 **6×**，而且 `parts` 数与 `degraded` 完全一致。原因是二分重试把每个子区间的距离压到 cap 以下，从而**避免了大 D 的二次方 trace**。也就是说：现有实现的 `maxD` 256 是偏保守（偏慢）的，而**上限的风险来自调大，不来自调小**。

### 3.4 与有界 DP 的对比与「锚点保留退让幅度」（实测）

同一输入下两者保留的旧行数（"锚点能继承多少行"）：

| N | 形态 | 完全相同的行数 | Myers 保留（equal 行） | 有界 DP 保留（pairs） | DP 退让 |
| --- | --- | --- | --- | --- | --- |
| 10,000 | 50% 改 | 5,000 | **5,000（100%）** | **1,465（29.3%）** | **−70.7%** |
| 100,000 | 50% 改 | 50,000 | 50,000（100%） | 24,753（49.5%） | −50.5% |
| 800,000 | 50% 改 | 400,000 | 400,000（100%） | 198,505（49.6%） | −50.4% |
| 10,000 | 纯插入 | 10,000 | 10,000 | 10,000 | 0 |
| 10,000 | 纯删除 | 5,000 | 5,000 | 5,000 | 0 |

**有界 DP 的保留率对 `effective` 极度不敏感且非单调**（`20-retention-vs-dp-budget.mjs`，10,000 行 / 50% 改）：

| `effective` | 保留 pairs | 保留率 | 耗时 | 走的路径 |
| --- | --- | --- | --- | --- |
| 1e4 | 4,951 | 99.0% | 13.5 ms | 分块（块长 100） |
| 1e5 | 4,899 | 98.0% | 18.0 ms | 分块（块长 316） |
| 1e6 | 4,501 | 90.0% | 57.6 ms | 分块（块长 1,000） |
| 1e7 | 4,744 | 94.9% | 194.0 ms | 分块（块长 3,162） |
| **5e7（生产默认）** | **1,465** | **29.3%** | 68.4 ms | 分块（块长 7,071） |
| 1e8 | 5,000 | 100.0% | 852.9 ms | **全 DP**（10,001² ≈ 1e8 ≤ effective） |

这张表表明：**有界 DP 的保留率主要由"块长与变更密度的对齐程度"决定，不由预算大小决定**。生产默认的 5e7 恰好落在一个**最差的对齐点**上（块长 7,071，与 10,000 行的 50% 变更网格冲突，贪心配对只配出 1,465 对）。作为对照，全 DP 路径（1e8）能拿回 100%，代价是 852.9 ms / **765.6 MB heapΔ**。

### 3.5 结论：op 跨度多大时 Myers 会变成风险

**先说结论：Myers 本身不需要 op 跨度上界；需要上界的是 `maxD`，且"上界"就是保持默认 256 或更低。**

数字（实测）：

- **耗时**：默认 `maxD = 256` 下，800,000 行 × 50% 行被改 = **5.80 s**；100,000 行 = **320 ms**；10,000 行 = **37 ms**。而同一输入的有界 DP 在 800k 上要 **13.77 s**（是 Myers 的 2.4×）。**Myers 在"整文件一半都变了"这个极端下都不是耗时风险**（从 N=10k 到 800k，D 同步放大 80×，耗时放大 156×，接近 O(N·D) 但常数很小）。
- **内存**：默认 `maxD = 256` 下，800,000 行 = **263 MB heapΔ / 548 MB totalHeap**；**有界 DP 在同样输入上要 1,590 MB heapΔ / 2,112 MB totalHeap**（6× Myers）。在 12 GiB 堆限制下两者都不崩，但 DP 已经把堆推过 2 GB。
- **风险阈值（实测线）**：
  - `maxD ≤ 256`：**没有风险**（≤ 800k 行、任意 D 都测过）。
  - `maxD = 4,096`：一次调用 **82 MB** ArrayBuffer — 已经是应当警觉的量级。
  - `maxD = 16,384`：一次调用 **1.31 GB** — 在 256 MB / 512 MB 堆的工具进程里**必然 OOM**。
  - **判据（推算，依据 = trace 结构 `O(maxD²)`，每槽 4 B）**：`trace ≈ 4·maxD² B`。要让一次调用不超过 **32 MB**，需要 `maxD ≤ sqrt(32e6/4) ≈ 2,828`。建议把 `DEFAULT_MAX_D` 的**硬上限**钉在 **1,024**（≈ 4 MB trace），而不是"可以调"。
- **降级行为**：Myers 在测过的所有规模上都 `degraded = false`——它靠二分重试收敛，**没有退化成"一删一增"**。有界 DP 的退让才是真实存在的：50% 变更密度下只保留 **29.3%** 的锚点（§3.4），并且 **`degraded` 仍报 `false`**——即调用方无法从返回值判断"我丢了 70% 的锚点"。这是新设计选 Myers 的**有力理由**：`alignPreservedBounded` 的失败模式是静默的锚点丢失。

### 3.6 独立缺陷：`partsFromRuns` 的 spread 在大块连续增删上直接抛错（实测）

`refs`：`src/render/line-diff.ts:359` 与 `:362`

```ts
pendingDel.push(...oldUnits.slice(run.a0, run.a1));
pendingIns.push(...newUnits.slice(run.b0, run.b1));
```

`push(...array)` 会展开成实参，实参数量受引擎上限约束。实测（`17-myers-maxd-sweep.mjs` 变体）：

| N | 形态 | 结果 |
| --- | --- | --- |
| 100,000 | 纯插入（10 万连续新增行） | 通过（52.98 ms） |
| 100,000 | 纯删除 | 通过（27.14 ms） |
| **200,000** | **纯插入** | **`RangeError: Maximum call stack size exceeded`** @ `line-diff.js:317`（= `src/render/line-diff.ts:359`） |
| 300,000 | 纯插入 | 同上 |
| **300,000** | **纯删除** | 同上 |
| 500,000 | 纯插入 / 纯删除 | 同上 |
| 1,000,000 | 纯插入 / 纯删除 | 同上（实测复现，不是超时） |
| 800,000 | 50% 改（最长连续块 < 32 万行） | 通过（5.80 s，不触发） |

**这条与 Myers 无关**：`degraded = false`、差分本身算完了，是**渲染层把整块行数组展开进实参列表**时爆的。触发条件写清楚：**单次调用里存在一段 ≥ 约 20 万行的同向连续块**。对插件自身的工作负载（`edit` 一次改几十到几千行）概率极低，但 `write` 一个 20 万行以上的新文件、或 `undo` 一次跨 20 万行的回滚，会走到同一条渲染路径。

**最小修法**：把两个 spread 换成显式循环或 `for (const u of slice) pending.push(u)`（性能影响可忽略，实测耗时的大头在 Myers 搜索本身）。

### 3.7 结论：op 跨度要不要设上界

| 问题 | 答案 | 依据 |
| --- | --- | --- |
| Myers 需要 op 跨度上界吗？ | **不需要**（在 `maxD ≤ 256` 下）。10k/100k/800k 三档、三种编辑形态全部实测，最差 5.80 s / 263 MB，无降级。 | §3.2 |
| `maxD` 需要上界吗？ | **需要**，且应当是**降低**而不是保持可调。建议硬上限 1,024（82 MB → 4 MB trace）；默认值可以维持 256，或降到 64（800k 上快 6×，输出逐位相同）。 | §3.3 |
| 有界 DP 需要上界吗？ | 它**已经有**（`effective = min(5e7, heap/32)`），但**默认值恰好落在最差保留率点上**（29.3%）。如果继续用它，应把 `effective` 从 5e7 下调（1e4–1e5 档保留率 98–99%，耗时还更短）。 | §3.4 |
| 要不要为"对齐"保留有界 DP？ | 建议**只在差分渲染路径上留 Myers**；op 跨度对齐若采用 Myers，必须把"跨度"定义在**该 op 的旧范围 vs 该 op 的 `lines` 数组**（而不是整文件），此时 N = 跨度长度、D ≤ 2N，落在 §3.2 表里 N ≤ 10,000 的安全区。 | 规格票 #227 的设计 + §3.2 |

---

## 4. 对下游决策的直接影响（t3 / t5 / t7）

| 下游票 | 直接输入 |
| --- | --- |
| **t3（锚点身份 / 退役）** | 若要"锚点即身份"成立，必须让校验比对 **contentKey**，或让会话的 used-set 保留已释放锚点。实测：这条不变量在 34,776 个真实槽位上**尚未被违反**，所以加校验是"零误报的兜底"，而不是"修复已在发生的错误"。参见 §1.5 的方案 B。 |
| **t5（served 行化 / 预算）** | 行化的**写入放大 ≈ 187×**（1 行 274 B → 200 行 51,200 B）；真实库上 `served` 行族本身从 **77,824 B（库的 0.73%）涨到 7,057,408 B（库的 10.5%）**，且 262,144 行就会单独吃掉整个 64 MiB 字节预算。若仍要行化：`HASH_STORE_MAX_BYTES` 64 MiB → **≥ 96 MiB**（推算，为 undo/anchor_lines 留出余量），且 `HASH_STORE_MAX_ROWS` 需要把 `served` 与 `anchor_lines` 分开计数（否则 `anchor_lines` 会更早被淘汰，反而制造 §1 的重绑定前置条件）。**推荐：不逐锚点行化，或至少不把 `updated_at` 以上的索引一并加上。** |
| **t7（对齐算法 / 阈值）** | Myers 在 `maxD ≤ 256` 下不需要跨度上界（最差实测 5.80 s / 263 MB @ 800k×50%）。**要做的是**：① 给 `DEFAULT_MAX_D` 设硬上限（1,024，≈ 4 MB trace），② 修掉 `partsFromRuns` 的 spread（≥ ~20 万行连续块会抛 `RangeError`），③ 若保留 `alignPreservedBounded` 做兜底，把默认 `effective` 从 5e7 降到 1e5 量级（保留率 29.3% → 98%，耗时 68 ms → 18 ms）。 |
| **额外** | `persistProjection` 的"全删全写"才是写入量的大头（600 行文件首 serve = 127.7 KB WAL，其中 served 只占 12.4 KB）。若本次改造想同时降写入量，把 `put()` 改成差量是 **5–15×** 的收益（推算）。 |

---

## 5. 未能核实的事项

1. **新 `served` 行表的真实写路径**：`upsertServed` / `reconcileServed` / `pruneServedOlderThan` 接入逐锚点行表后的行为（事务边界、是否逐行 upsert、sweep 如何计入行数）**无法测量**——行表尚未实现。本报告的 (b) 部分是"表本身的物理字节"，不是"写路径的字节"。
2. **重绑定的长期发生率**：没有计数器，只能靠 `undo` 快照回溯。实测只是"两张两天龄、113/46 个文件的库上没有痕迹"。要得到发生率，需要在新写路径上加一个"释放后又重铸到不同 contentKey"的计数点。
3. **`served` 7 天 TTL 与模型上下文的关系**：`SERVED_TTL_MS = 7 天`（常量实测），但"模型手里还拿着旧锚点"的窗口由会话上下文决定，本次未测。两者重叠的时长决定了 §1 的重绑定前置条件有多常见。
4. **多进程并发**：两张活动库都由多个 dsh 进程共享（副本里 8 个 session）。`persistProjection` 的 DELETE+INSERT 在并发下的事务/锁行为未测。
5. **`alignPreservedBounded` 的保留率与块对齐的关系**：§3.4 的表显示了非单调性，但**没有**给出"哪种 `effective` 对哪种变更分布最好"的规律——需要独立的参数扫描才能结论化。
6. **Windows / Node 22 上的同款测量**：全部数据来自 macOS arm64 + Node 26.7.0。§3.6 的实参上限是引擎相关的（V8 上实测约 20 万），其他引擎/版本可能不同。
7. **`served` 行化后 autoindex 的真实行为**：本报告建表时 autoindex 名与列顺序均按规格票复刻，但**没有**测 `WITHOUT ROWID` 变体、也没有测 `session_id` 前缀压缩（`session_id` 是 36 B 的 UUID，在每一行与每一条索引里各存一份，占每行字节的相当比例——这是**可以优化但未测**的一项）。

---

## 附录 A：测量脚本与完整命令

脚本目录：`docs/research/single-source-anchor-state-measurement-scripts/`。所有脚本都从仓库根目录运行，并硬编码了本机的绝对路径（`/Users/mutou/projects/dsh-tool-hashline`、`/tmp/hashm/...`）——复现时按注释替换。

### A.1 预处理：把活动库复制到 /tmp（只读，不写活动库）

```bash
set -e
mkdir -p /tmp/hashm
for d in "--Users-mutou-projects-dsh-tool-hashline--" "--Users-mutou-projects-dsh-desktop-app--"; do
  mkdir -p "/tmp/hashm/$d"
  for f in hash-store.sqlite hash-store.sqlite-wal hash-store.sqlite-shm; do
    src="/Users/mutou/.dsh/plugins/dsh-hashline-edittool/$d/$f"
    [ -f "$src" ] && cp -f "$src" "/tmp/hashm/$d/$f" || true
  done
done
ls -la /tmp/hashm/*/
```

> 复制后 `01-…` 会以读写方式打开副本（让 SQLite 回放 WAL），因此副本是最新状态；**活动库全程只读**（`04-…` 用 `readOnly: true` 直接读活动库，复制后活动库仍在增长，两者数字略有差异，报告中已分别标注）。

### A.2 测量 1：库画像 / 重绑定

```bash
cd /Users/mutou/projects/dsh-tool-hashline
S=docs/research/single-source-anchor-state-measurement-scripts

# 1) 两张副本库的逐表行数 / 字节数 / 索引 / dbstat 分解
node $S/01-store-inventory.mjs \
  "/tmp/hashm/--Users-mutou-projects-dsh-tool-hashline--/hash-store.sqlite" \
  "/tmp/hashm/--Users-mutou-projects-dsh-desktop-app--/hash-store.sqlite"

# 2) served 与 anchor_lines 的细节（长度分布、时间范围、会话分布）
node $S/02-store-table-detail.mjs \
  "/tmp/hashm/--Users-mutou-projects-dsh-tool-hashline--/hash-store.sqlite" \
  "/tmp/hashm/--Users-mutou-projects-dsh-desktop-app--/hash-store.sqlite"

# 3) served 集合里有多少锚点已经不在 anchor_lines 里
node $S/03-served-vs-anchor-lines.mjs \
  "/tmp/hashm/--Users-mutou-projects-dsh-tool-hashline--/hash-store.sqlite" \
  "/tmp/hashm/--Users-mutou-projects-dsh-desktop-app--/hash-store.sqlite"

# 4) 活动库（只读）画像
node $S/04-store-inventory-frozen.mjs

# 5) 历史痕迹扫描：有没有锚点被绑到过不同的内容
node $S/05-rebind-history-scan.mjs \
  "/tmp/hashm/--Users-mutou-projects-dsh-tool-hashline--/hash-store.sqlite" \
  "/tmp/hashm/--Users-mutou-projects-dsh-desktop-app--/hash-store.sqlite"

# 6) 可达性：被释放的槽位会不会被别的内容命中
node --experimental-strip-types $S/06-rebind-reachability.ts

# 7) 完整后果：静默错行（构造性证明）
node --experimental-strip-types $S/07-silent-wrong-line-proof.ts
```

`03-…` 自己内联了 `~1` 打包格式的解码（Base62 + LEB128 varint + length 分组），与 `22-served-codec-decode.mjs` 是同一份逻辑的两种调用方式。

### A.3 测量 2：served 写入量

```bash
cd /Users/mutou/projects/dsh-tool-hashline
S=docs/research/single-source-anchor-state-measurement-scripts

# 8) 三种操作各自的 served 行数 / 字节数 / anchor_lines 行数
node --experimental-strip-types $S/08-served-write-volume.ts

# 9) 600 行文件增量 serve：allocateForLines 与 recordServed 分开计 WAL
node --experimental-strip-types $S/09-served-phase-decomposition.ts

# 10) 单次操作的整库 WAL 写入量（read / grep / edit）
node --experimental-strip-types $S/10-store-write-volume-wal.ts

# 11) 每行字节模型：20,000 行 × 三种路径长度，纯堆表 vs PK+autoindex
node $S/11-row-shape-bytes-per-row.mjs

# 12) 真实库上的行化增量（VACUUM 前后对比）
node $S/12-row-shape-on-real-store.mjs \
  "/tmp/hashm/--Users-mutou-projects-dsh-tool-hashline--/hash-store.sqlite" toolhashline
node $S/12-row-shape-on-real-store.mjs \
  "/tmp/hashm/--Users-mutou-projects-dsh-desktop-app--/hash-store.sqlite" desktopapp

# 13) 拆出「纯堆表」与「PK autoindex」各自的字节数
node $S/13-row-shape-heap-vs-index.mjs \
  "/tmp/hashm/--Users-mutou-projects-dsh-tool-hashline--/hash-store.sqlite" toolhashline
node $S/13-row-shape-heap-vs-index.mjs \
  "/tmp/hashm/--Users-mutou-projects-dsh-desktop-app--/hash-store.sqlite" desktopapp
```

`08-…` / `09-…` / `10-…` 都通过 `process.env.DSH_HOME = /tmp/hashm/home*` 把库重定向到临时目录；每例先 `rmSync(HOME)` 清空，跑完 `shutdownHashStore()` 关库（触发 WAL checkpoint）后再用只读连接取数——**只有这样才能读到已提交的真实字节数**，直接在写连接上查会看到未 checkpoint 的中间态。

### A.4 测量 3：Myers 与有界 DP

```bash
cd /Users/mutou/projects/dsh-tool-hashline
S=docs/research/single-source-anchor-state-measurement-scripts

# 14) 配对矩阵（两个算法在同一进程、同一输入，各取 3 次最小值）
for n in 100 1000 10000; do for s in ins del mix; do
  node --expose-gc --max-old-space-size=4096 $S/14-myers-vs-bounded-matrix.mjs $n $s 3
done; done

# 15) 同上但逐例独立子进程（argv: N shape repeat）
node --expose-gc $S/15-myers-bounded-paired.mjs 10000 mix 3

# 16) 单例测量（argv: tool N shape [maxD|effective]）——报告 §3.2 主表的来源
for n in 10000 100000 800000; do for s in ins del mix; do for t in myers bounded; do
  timeout 900 node --expose-gc --max-old-space-size=12288 $S/16-myers-vs-bounded-single-case.mjs $t $n $s
done; done; done

# 17) maxD 扫描（Myers 的唯一真实杠杆）
for md in 64 256 1024 4096 16384; do
  node --max-old-space-size=4096 $S/17-myers-maxd-sweep.mjs 10000 mix $md
done
for md in 32 64 256; do
  node --expose-gc --max-old-space-size=12288 $S/16-myers-vs-bounded-single-case.mjs myers 800000 mix $md
done

# 18) 受限堆子进程：找出每个算法的「最小可用堆」
for mb in 1024 512 384 320 288 272 264 256 240; do
  node --max-old-space-size=$mb $S/18-bounded-heap-subprocess.mjs 10000 mix $mb myers
done
for mb in 2048 1024 512 384 288 256 224 192 160; do
  node --max-old-space-size=$mb $S/18-bounded-heap-subprocess.mjs 10000 mix $mb bounded
done

# 19) 锚点保留率（相同输入下两者各保留多少行）
for s in ins del mix; do node $S/19-anchor-retention.mjs 10000 $s; done
node $S/19-anchor-retention.mjs 100000 mix
node $S/19-anchor-retention.mjs 800000 mix

# 20) 保留率 vs DP 预算（非单调性的证据）
node --max-old-space-size=12288 $S/20-retention-vs-dp-budget.mjs 10000

# 21) 单例内存（含 ArrayBuffer 峰值）
node --expose-gc --max-old-space-size=12288 $S/21-peak-memory-one-case.mjs bounded 10000 mix 50000000
node --expose-gc --max-old-space-size=12288 $S/21-peak-memory-one-case.mjs bounded 10000 mix 100000000
node --expose-gc --max-old-space-size=12288 $S/21-peak-memory-one-case.mjs myers   10000 mix 256
node --expose-gc --max-old-space-size=12288 $S/21-peak-memory-one-case.mjs myers  800000 small 256
```

### A.5 附：`~1` 负载的解码（供后续脚本复用）

```bash
node $S/22-served-codec-decode.mjs   # 导出 decodeServed(raw) -> {anchors:[...]}
```

格式（`served-codec.ts:135-160` 实现，本脚本独立复刻并已与库中 165 行真实负载对拍通过）：
`"~1"` + base64(varint(组数) + 每组[varint(锚点长度) + varint(数量) + 数量个「与前值的 delta」varint])，锚点按长度分组、组内按数值升序；解码时按长度零填充还原字符串。

---

## 附录 B：原始数据

### B.1 库画像（复制于 2026-10-04 11:32）

```text
========================================================================
DB: /tmp/hashm/--Users-mutou-projects-dsh-tool-hashline--/hash-store.sqlite
  file bytes (main only): 10690560
  page_size: 4096  page_count: 2610  freelist: 0
  storeBytes metric (pc-fl)*ps = 10690560
  tables: anchor_lines, anchor_meta, meta, served, snapshots, undo
  indexes: anchor_lines_by_anchor, anchor_lines_updated_at, anchor_meta_updated_at,
           served_updated_at, sqlite_autoindex_anchor_lines_1, sqlite_autoindex_anchor_meta_1,
           sqlite_autoindex_meta_1, sqlite_autoindex_served_1, sqlite_autoindex_snapshots_1,
           sqlite_autoindex_undo_1, undo_updated_at
  [meta]          rows=3     sumLenBytes=56        dbstat=4096 B / 1 page
  [snapshots]     rows=0     sumLenBytes=0         dbstat=4096 B / 1 page
  [undo]          rows=142   sumLenBytes=2977418   dbstat=3076096 B / 751 pages
  [served]        rows=165   (LENGTH(hashes) 合计 39542)  dbstat=73728 B / 18 pages
  [anchor_meta]   rows=113   sumLenBytes=10839     dbstat=16384 B / 4 pages
  [anchor_lines]  rows=23593 sumLenBytes=2413921   dbstat=2543616 B / 621 pages
========================================================================
DB: /tmp/hashm/--Users-mutou-projects-dsh-desktop-app--/hash-store.sqlite
  file bytes (main only): 3526656
  page_size: 4096  page_count: 876  freelist: 0
  storeBytes metric (pc-fl)*ps = 3588096
  [meta]          rows=3     [snapshots] rows=0
  [undo]          rows=58    sumLenBytes=1413369   dbstat=1449984 B / 354 pages
  [served]        rows=50    (LENGTH(hashes) 合计 9636)   dbstat=24576 B / 6 pages
  [anchor_meta]   rows=46    sumLenBytes=4592      dbstat=12288 B / 3 pages
  [anchor_lines]  rows=6054  sumLenBytes=638311    dbstat=696320 B / 170 pages
```

`served` 的 `updated_at` 范围（副本）：

```text
tool-hashline : anchor_lines 2026-10-03T01:30:56.908Z .. 2026-10-04T03:32:33.782Z（160 个不同时间戳）
                served       2026-10-03T01:30:56.909Z .. 2026-10-04T03:32:33.785Z
                meta         version=6, last_open_integrity_check=ran, maintenance_indexes=1
desktop-app   : anchor_lines 2026-10-03T00:55:05.710Z .. 2026-10-04T03:03:16.712Z
```

### B.2 重绑定扫描

```text
========================================================================
/tmp/hashm/--Users-mutou-projects-dsh-tool-hashline--/hash-store.sqlite
served anchor-slots=28087
  still bound to the SAME (line, contentKey) as the last recorded state : 23767
  not in anchor_lines at all (released / evicted)                       : 222  (incl. 292 with no recoverable undo history)
  LIVE at a DIFFERENT (line, contentKey) than any recorded state        : 3806
    ... of those, at a different CONTENT (true rebind to other content) : 0
  examples:
   { "path": ".../CHANGELOG.md", "anchor": "6q", "history": ["24:3264779155737850"], "now": "23:3264779155737850" }
   { "path": ".../CHANGELOG.md", "anchor": "Lc", "history": ["21:7201026528082266"], "now": "20:7201026528082266" }
========================================================================
/tmp/hashm/--Users-mutou-projects-dsh-desktop-app--/hash-store.sqlite
served anchor-slots=6689
  still bound to the SAME (line, contentKey) as the last recorded state : 4827
  not in anchor_lines at all (released / evicted)                       : 0  (incl. 40 with no recoverable undo history)
  LIVE at a DIFFERENT (line, contentKey) than any recorded state        : 1822
    ... of those, at a different CONTENT (true rebind to other content) : 0
  examples:
   { "path": ".../capabilities/default.json", "anchor": "1n", "history": ["54:2696686554374885"], "now": "55:2696686554374885" }
   { "path": ".../capabilities/default.json", "anchor": "2X", "history": ["36:3372892861381327"], "now": "37:3372892861381327" }
```

`served` 集合里"锚点已不在 anchor_lines"的统计（`03-…`）：

```text
tool-hashline: served anchors decoded=28087 still-in-anchor_lines=27573 MISSING=514  paths-without-anchor_meta=0
desktop-app  : served anchor slots=6689 ... MISSING=40（无 anchor_meta 的 path=0）
```

### B.3 行化表的物理字节

```text
path=58B   heap-only 124.52 B/row (+2490368 B)   with PK+autoindex 255.80 B/row (+5115904 B)
path=80B   heap-only 146.84 B/row (+2936832 B)   with PK+autoindex 301.88 B/row (+6037504 B)
path=135B  heap-only 205.21 B/row (+4104192 B)   with PK+autoindex 419.23 B/row (+8384512 B)
```

```text
=== toolhashline === rows=28087
base 9859072
CREATE TABLE (with PK): 8192 B; index_list=1
INSERT 28087 rows: 7536640 B  => 268.33 B/row (PK + autoindex)
flat heap table (no PK, same cols): 3629056 B => 129.21 B/row (row payload only)
after VACUUM: 20545536
=== desktopapp === rows=6689
base 3313664
CREATE TABLE (with PK): 8192 B; index_list=1
INSERT 6689 rows: 1978368 B  => 295.76 B/row (PK + autoindex)
flat heap table (no PK, same cols): 929792 B => 139.00 B/row (row payload only)
after VACUUM: 6066176
```

### B.4 Myers / 有界 DP 原始行

```text
myers    N=  10000 ins         6.8 ms  heapΔ=     2.9 MB  totalHeap=    17.5 MB  parts=3 degraded=False
bounded  N=  10000 ins         0.8 ms  heapΔ=     0.9 MB  totalHeap=    15.2 MB  pairs=10000 degraded=False
myers    N=  10000 del         4.1 ms  heapΔ=     3.1 MB  totalHeap=    12.6 MB  parts=3 degraded=False
bounded  N=  10000 del         0.4 ms  heapΔ=     0.8 MB  totalHeap=    11.4 MB  pairs=5000 degraded=False
myers    N=  10000 mix        37.1 ms  heapΔ=     9.8 MB  totalHeap=    21.4 MB  parts=15000 degraded=False
bounded  N=  10000 mix        41.4 ms  heapΔ=    66.9 MB  totalHeap=    83.4 MB  pairs=1465 degraded=False
myers    N= 100000 ins        62.2 ms  heapΔ=    62.5 MB  totalHeap=   128.0 MB  parts=3 degraded=False
bounded  N= 100000 ins         6.0 ms  heapΔ=     7.0 MB  totalHeap=    86.7 MB  pairs=100000 degraded=False
myers    N= 100000 del        31.6 ms  heapΔ=    30.7 MB  totalHeap=    71.7 MB  parts=3 degraded=False
bounded  N= 100000 del         3.1 ms  heapΔ=     3.5 MB  totalHeap=    59.4 MB  pairs=50000 degraded=False
myers    N= 100000 mix       320.3 ms  heapΔ=    49.9 MB  totalHeap=   115.5 MB  parts=150000 degraded=False
bounded  N= 100000 mix      1763.1 ms  heapΔ=   392.1 MB  totalHeap=   545.2 MB  pairs=24753 degraded=False
myers    N= 800000 ins   ERROR Maximum call stack size exceeded
bounded  N= 800000 ins        62.1 ms  heapΔ=    42.1 MB  totalHeap=   456.5 MB  pairs=800000 degraded=False
myers    N= 800000 del   ERROR Maximum call stack size exceeded
bounded  N= 800000 del        29.5 ms  heapΔ=    28.0 MB  totalHeap=   280.5 MB  pairs=400000 degraded=False
myers    N= 800000 mix      5797.4 ms  heapΔ=   263.4 MB  totalHeap=   548.5 MB  parts=1200000 degraded=False
bounded  N= 800000 mix     13772.7 ms  heapΔ=  1590.6 MB  totalHeap=  2112.3 MB  pairs=198505 degraded=False
```

```text
myers maxD=  64 N= 100000 mix       135.5 ms  heapΔ=   59.2 MB  totalHeap=  128.7 MB  parts=150000 degraded=False
myers maxD=  64 N= 800000 mix       979.7 ms  heapΔ=  360.4 MB  totalHeap=  630.4 MB  parts=1200000 degraded=False
myers maxD=  32 N= 100000 mix       112.6 ms  heapΔ=   59.2 MB  totalHeap=  128.9 MB  parts=150000 degraded=False
myers maxD=  32 N= 800000 mix       864.5 ms  heapΔ=  331.5 MB  totalHeap=  630.4 MB  parts=1200000 degraded=False
```

```text
N=10k mix maxD=64    : {"ms":20.03,"parts":15000,"degraded":false,"arrayBuffers":217687}
N=10k mix maxD=256   : {"ms":33.64,"parts":15000,"degraded":false,"arrayBuffers":2119891}
N=10k mix maxD=1024  : {"ms":82.94,"parts":15000,"degraded":false,"arrayBuffers":15142567}
N=10k mix maxD=4096  : {"ms":261.57,"parts":15000,"degraded":false,"arrayBuffers":82213195}
N=10k mix maxD=16384 : {"ms":380.65,"parts":15000,"degraded":false,"arrayBuffers":1311239803}
```

```text
{"TOOL":"bounded","N":10000,"SHAPE":"mix","OPT":50000000,"ms":58.4,"out":{"pairs":1465,...},"heapDeltaMB":66.9,"peakMallocMB":0.9}
{"TOOL":"bounded","N":10000,"SHAPE":"mix","OPT":100000000,"ms":743.6,"out":{"pairs":5000,...},"heapDeltaMB":765.6,"peakMallocMB":2.9}
{"TOOL":"myers","N":10000,"SHAPE":"mix","OPT":256,"ms":48.7,"out":{"parts":15000,...},"heapDeltaMB":5.0,"peakMallocMB":1.1}
{"TOOL":"myers","N":800000,"SHAPE":"small","OPT":256,"ms":376.3,"out":{"parts":4,...},"heapDeltaMB":154.8,"peakMallocMB":0.8}
```

> 最后一行是「80 万行文件、只有 30 行被改」：**376 ms / 155 MB heapΔ**——这是插件真实工作负载（小改动、大文件）的代表值，也是 op 跨度对齐应当对齐的那个量级。

### B.5 受限堆下的最小可用堆（实测扫描）

```text
myers   10000 mix @240MB ../@1024MB: 全部成功（36–44 ms，heapUsed 12–14 MB，peakMalloc ≤ 1.6 MB）
bounded 10000 mix @160MB ../@2048MB: 全部成功（57–190 ms，heapUsed 76–303 MB）
```

两列都没有触到"崩"，说明 **10,000 行这个量级还远不到各自的墙**；撞墙的是 800k 的 `bounded`（2.1 GB totalHeap，见 B.4）与 `maxD = 16384` 的 Myers（1.31 GB ArrayBuffer，见 §3.3）。

---

## 附录 C：代码位置索引

| 结论 | 代码位置 |
| --- | --- |
| 分配只避开当前存活锚点集 | `src/hashline/session-anchors.ts:245-248` |
| 释放后锚点立即可复用 | `src/hashline/session-anchors.ts:262-277` |
| 淘汰删五个行族、无退役记录 | `src/domain/session/hash-store.ts:941-947`、`:1225-1231` |
| "锚点即身份"的集合校验 | `src/hashline/anchor-pipeline.ts:1091-1096`、`:1100-1112` |
| served 表 JSON blob 形状 | `src/domain/session/hash-store.ts:570-579`、`:631-633` |
| served 打包编解码 | `src/domain/session/served-codec.ts:135-160`、`:169-198` |
| `served` 校验查询 | `src/domain/session/hash-store.ts:628-630` |
| 预算常量 | `src/infra/constants.ts:34`（7 天 TTL）、`:40`（30 天）、`:53`（64 MiB）、`:59`（5,000 路径）、`:64`（300,000 行） |
| `storeBytes` 口径 | `src/domain/session/hash-store.ts:683-685` |
| `anchorRowCount` 只数 anchor_lines | `src/domain/session/hash-store.ts:687` |
| 维护索引（含 `served_updated_at`） | `src/domain/session/hash-store.ts:1259-1269` |
| `persistProjection` 全删全写 | `src/domain/session/hash-store.ts:1786-1795` |
| 一次 read 的 served 记录 | `src/read-and-serve.ts:90-101`、`src/tools/tool-read.ts:342-353` |
| 一次 grep 的 served 记录 | `src/tools/tool-grep.ts:556-575`（`section.contextRows` → `recordServed`） |
| 一次 edit 的 served 记录 + reconcile | `src/tools/tool-edit.ts:752-767`、`src/domain/session/session-view.ts:86-103`、`:271-289` |
| edit diff 只服务 `+` 与上下文行 | `src/render/edit-diff.ts:184`、`:240` |
| Myers 的 trace（`O(maxD²)`） | `src/render/line-diff.ts:157-161` |
| `DEFAULT_MAX_D = 256` / `MAX_SPLIT_DEPTH = 16` | `src/render/line-diff.ts:53`、`:56` |
| 二分重试与 degraded | `src/render/line-diff.ts:292-306` |
| **spread 溢出点** | `src/render/line-diff.ts:359`、`:362` |
| 有界 DP 的预算与分块 | `src/hashline/align-bounded.ts:42`、`:62`、`:174`、`:193` |
| 有界 DP 的 degraded 判据 | `src/hashline/align-bounded.ts:411-419` |
| 被对齐器替换掉的历史（965 MB / 24.6 s @ 800k） | `src/render/line-diff.ts:23-26` |
| 受限堆回归测试（256 MB / 50k×50k） | `test/core/align-preserved.heap-subprocess.test.ts` |
