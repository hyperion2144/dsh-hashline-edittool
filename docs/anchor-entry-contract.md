# 锚点入口契约（统一取锚与可写判定）

> **Status**: Decided 2026-10-04 on [契约 #218](https://github.com/hyperion2144/dsh-hashline-edittool/issues/218)
> (wayfinder map [#214](https://github.com/hyperion2144/dsh-hashline-edittool/issues/214)).
> Authoritative for the anchor entry point; implementation is tracked by the map's
> implementation tickets and the spec [#231](https://github.com/hyperion2144/dsh-hashline-edittool/issues/231) —
> **nothing here is implemented yet**.
> Measurements behind the rejected alternatives: [取证 #217](https://github.com/hyperion2144/dsh-hashline-edittool/issues/217) /
> [`docs/research/single-source-anchor-state-measurement.md`](research/single-source-anchor-state-measurement.md).
> Vocabulary: [`CONTEXT.md`](../CONTEXT.md).

## 1. Problem

锚点状态今天有四条取锚路径（`anchorsFor`、`allocateForLines`、`updateAnchorsAfterEdit`、`anchorsPure`），被 9 个工具模块各自调用，没有唯一入口；而**释放锚点时既不碰 served、也不留下痕迹** —— `hashline/session-anchors.ts` 的两处释放（`allocateInto` 的 `used.delete`、`applyEditToState` 的区间丢弃）只从锚点映射里丢，不通知任何会话。

后果：被释放的锚点立刻回到可用池，可被重新发给**另一行**；而模型手里的那份锚点仍在自己的 served 里 → 校验放行 → **静默错行编辑**。取证票已构造性复现（[#217](https://github.com/hyperion2144/dsh-hashline-edittool/issues/217) §1）。

还有一处不是缺陷但值得写下来：现状每次可写判定都要把整份 served 集合读出并反序列化。**这是被接受的设计**（`served` 保持整集 blob，见 §8）—— 校验的天然单位就是整个集合，不为了局部查询去改表示。

## 2. 两个原语，不是一个入口加模式开关

分配是**写**（改变持久状态、创建身份）；校验是**读**（永不写、只回答「能不能写」）。合并只会让每个调用方担心自己会不会意外分配。

### 2.1 `anchorFor` —— 取锚并记为已读（写路径）

给「即将返回给模型的行」取锚，并把这些锚点记入本会话的 served。

```ts
interface AnchorForInput {
  /** 绝对路径；workspace 作用域由调用方的 withWorkspace 提供。 */
  readonly path: string;
  /** 1-based 行号，**最终会返回给模型的行**（预算截断之后）。 */
  readonly lines: readonly number[];
  /** 该文件的当前正规化文本。调用方已读入，本函数不读盘。 */
  readonly content: string;
  /** dsh 会话键；served 按会话隔离。 */
  readonly sessionKey: string;
}

interface AnchorForResult {
  /** 与入参 lines 一一对应；越界行为 ""。 */
  readonly anchors: readonly string[];
  /** 本次新铸造的锚点（其余是复用既有的），供 diff / 统计 / 渲染分组用。 */
  readonly minted: readonly string[];
}

declare function anchorFor(input: AnchorForInput): Promise<AnchorForResult>;
```

行为：

1. 读该 path 的 `anchor_meta`；与 `content` 的校验和比对，不一致则按 §5 的「外部改动」路径先重映射。
2. 对 `lines` 中每一行：`anchor_lines` 有该行且 `content_key` 与当前内容相符 → **复用**，不分配。
3. 否则分配：候选来自 `allocateAnchor`，used-set 为
   **`anchor_lines` 该 path 的全部存活锚点 ∪ 本轮释放池**。
   **没有第三个源** —— 锚点属于文件，不同文件可以持有同一个锚点字符串，所以「避开别的文件的锚点」
   既会禁掉完全合法的值，也要付一次全表查询。本节早期版本写的「全库已分配锚点（兜底）」描述的
   其实就是该文件自己的行，已经是第一项了。
4. 分配结果立即加入 used-set，参与同一轮后续行的重复校验。
5. 全部完成后**一次写回** `anchor_lines` + `anchor_meta`，并把本批锚点记入 served（同一事务）。
6. **只为 `lines` 里的行分配** —— 被预算截断掉的行不在此列，绝不提前分配。

### 2.2 `probeLines` —— 可写判定（纯读）

回答「调用方给的锚点能不能写」，永不分配、永不落库。

```ts
interface ProbeInput {
  readonly path: string;
  readonly content: string;          // 同上，调用方读入
  readonly refs: readonly AnchorRef[]; // 调用方声明的锚点，可带行号
  readonly sessionKey: string;
}

interface AnchorRef {
  readonly anchor: string;
  /** 模型申报的行号（信息来源），只用于在响应里提示行号是否已漂，**不参与可写判定**（见 §2.5）。 */
  readonly line?: number;
}

type ProbeOk = {
  readonly ok: true;
  /** 与入参 refs 一一对应。 */
  readonly resolved: readonly { anchor: string; line: number }[];
  /** 范围外但已解析的锚点 → 行号，供重映射与 diff 使用。 */
  readonly mapped: ReadonlyMap<string, number>;
};

type ProbeFail = {
  readonly ok: false;
  /** 需重新显示的行（失效行 + 每行少量上下文），已经是 echo 渲染的输入。 */
  readonly rows: readonly InvalidRow[];
  /** 为什么失败，决定提示文案（§2.4 / §6）。 */
  readonly reason:
    | "never-seen"   // 该锚点从未在本会话服务过
    | "line-changed" // 该行内容已变：该位置现在是另一个锚点
    | "line-moved"   // 内容没变，但该锚点现在解析到另一行
    | "not-live";    // 该锚点已不在 anchor_lines 里（已释放 / 被淘汰）
};

interface InvalidRow {
  readonly line: number;      // 该行当前的行号
  readonly current: string;   // 该行当前的锚点（"" = 该行没有锚点）
  readonly given: string;     // 调用方给的那个
  readonly contentKey: number;
}

declare function probeLines(input: ProbeInput): Promise<ProbeOk | ProbeFail>;
```

**判定规则（三条全过才算可写）**：

1. each ref 的锚点**活在 `anchor_lines` 里**，且**它绑定的那一行**当前的 `content_key` 与锚点记的一致。
2. 该锚点在**本会话 served 集合**里。
3. 模型申报的行号**只作信息来源** —— 与锚点解析出的行不一致时**不拒绝**，只在响应里附一句「该锚点现在在第 N 行」（§2.5）。

任一不满足 → **整体失败**（不部分应用），`rows` 给出逐行清单。

**文件校验和不是拒绝条件。** 它是「文件被外部或他会话改动过」的信号，用来触发 §5 的重映射与状态刷新；某个锚点能不能用，只由上面三条逐行回答。否则别人改了这个文件的任何一处，我要改的那行即便没动也会被拒 —— 跨会话编辑就不可用了。

**因此校验和一致时什么都不做，不一致时也只做重映射**：重映射（行号位移）不会让任何未变行的锚点失效，只对**内容真的变了**的行释放 + 重分配。

### 2.3 为什么用「锚点 → 行」的解析

`anchor_lines` 的主键是 `(path, line)`，另有 `(path, anchor)` 索引，所以**反查锚点落在哪一行是唯一的**（分配器保证不重复）。这让校验可以完全按调用方给的东西走：拿锚点反查行 → 确认那行的内容键与锚点记的一致 → 确认在本会话 served 里。不需要先把该文件所有行的锚点都物化出来。

### 2.4 会话语义

**一个 dsh agent session 就是一个会话**：served 按其 id 隔离（键取自 `exec.agent.session.id`）。同一 cwd（同一 sqlite）里两个 dsh 会话各自一份 served；`anchor_lines` 与 `anchor_meta`（行号映射、校验和）**跨会话共享**。

**取不到 id 时退化为「每进程一个」**：`sessionKeyFor` 为该进程生成一次随机 UUID 并缓存，之后所有无 id 的调用共用它 —— 作用域是**进程**（预览与测试走这条），不是每次调用新生成。含义是「进程重启即新会话，旧 served 不继承」，与「模型看不见上个会话」一致。

**上下文行与失效行一样有锚点** —— echo 里出现的每一行也都是模型看得见的行，按 §2.1 的第 6 条同样要分配、同样记为已读。

**四种失败的文案要能分辨，但不新增错误码**（码始终是 `E_RANGE_UNVERIFIED`；区别只在提示语，见 §6）：

- `never-seen` → 「该锚点未被本会话读过」；恢复动作是**读**。
- `line-changed` → 「该行在你会话读过之后被改动，现在是 X」；恢复动作是**拿 X 重提**。
- `line-moved` / `not-live` → 「该锚点已不再指向那一行」或「已失效」；恢复动作同样是**拿当前锚点重提**。

判据是**校验和是否变过**：变过则优先说「读过之后被改动」，未变则说「未被本会话读过」。

### 2.5 edit 的 op 语义

**聚合与排序**：多 op 先按文件聚合，每个文件内按**原始文件坐标**降序（行号大的先应用），使得「应用靠后的 hunk 永远不会移动它上方的行」；整批因此等价于一次原子编辑。

**同一锚点行上有多个 op**：允许多个 op 共享该锚点行（它们不重叠），执行顺序为**同锚点的 `ins` 先跑**，这样随后对该行的 `replace` 仍能对上原始内容 —— `ins` 不改写它的锚点行。

**重叠即拒绝，语义不变**：两个 `ins` 撞同一锚点、或两个范围重叠，都在应用前拒绝（现有的范围冲突检测），模型应拆成两次调用。本次重构**不改这条模型可见的行为**。

> 注意：`del` 与「在该行 `ins`」共享同一锚点时**属于允许的非重叠组合** —— `ins` 是间隙插入、不改写锚点行，`del` 删的是锚点行本身，两者不重叠。契约在此点上以本节为准。

**行号漂移只提示、不拒绝**：模型申报的行号与锚点解析出的行不一致时，**以锚点为准**（锚点即身份），响应里附一句「该锚点现在在第 N 行」。这条是跨会话可用的关键：A 会话改了上方的行，B 会话手里的锚点仍然有效，不该因为 B 记的行号是旧的而被拒。

## 3. 模块落点

| 层 | 放什么 | 不放什么 |
|---|---|---|
| `hashline/`（纯域层） | 候选选择与探测（`allocateAnchor`）、内容配对与重映射、`(path,line)↔anchor` 的纯逻辑、释放事件的通知接口 | sqlite、workspace 作用域、会话 |
| `domain/session/` | store 作用域（`withWorkspace` / `openWorkspaceStore`）、**事务边界**、served 的读写、两个原语的实现 | 探测算法本身 |
| `tools/` | 只调 `domain/session/` 暴露的两个原语 | 直接调 `hashline/` 的分配器 |

依赖方向不变：`tools → domain → hashline`。`hashline/` **不引入** sqlite 依赖。

**释放通知接口**（让纯域层的释放能触达会话态）：`hashline/` 定义「某 path 的某些锚点被释放」这一事件，`domain/session/` 注册回调来执行 §4 的清理 —— 与既有的 `registerAnchorPersistence` 同构。

## 4. 释放：从三处移除 + 本轮封存

**释放意味着三件事同时发生**（这是本次补上的缺口）：

1. 从 `anchor_lines` 移除该行（或该区间）。
2. 从**本会话**的 served 集合里移除该锚点（**只动发起释放的那个会话** —— 其他会话没有释放，它们的记录不动，靠 §5 的 echo 提示处理）。
3. 加入**本轮释放池**。

### 4.1 释放池

- 作用域：**一次 `edit` 调用 × 一个文件**，纯内存。
- 语义：池中的锚点本轮**不得发给任何行**。
- 生命周期：调用结束即**丢弃**（不做永久退役集合 —— 否则会话一长锚点只增不减）。
- 清空时机必须明确：与调用的事务提交/回滚绑定，异常路径也要丢。
- 候选集：每次分配前，把该文件**当前存活**的锚点 ∪ **本轮释放池** 并起来作 used-set（见 §2.1 第 3 条：没有第三个源）。

### 4.2 为什么「释放」把跨轮次的缺口也关了

模型手里的旧锚点之所以危险，前提是它**仍能通过校验**：活在 `anchor_lines` 里、且在本会话 served 里。而**释放会同时清掉这两处**（`anchor_lines` 那条行删掉，发起会话的 served 也移除），于是：

- 即便某个会话的 served 里还留着这个键（只有发起释放的会话会被清），它也**无法通过第 1 条** —— 锚点已经不活在 `anchor_lines` 里了。
- 所以旧锚点不可能被静默放行；它要么落在「校验不过 → 拒绝 + echo」，要么已经被重新发放但旧键在别处无效。

- 第 k 轮 edit 释放 `Dk` → `Dk` 从 served 与 `anchor_lines` 双双消失。
- 第 k+1 轮分配器可以把 `Dk` 发给另一行（释放池已丢弃，这是**允许**的）。注意作用域：池是**每文件**的，所以文件 A 释放的锚点不会影响文件 B 的分配 —— 锚点本就按文件唯一，跨文件共用没有收益。

模型若在这期间重新读过那一行，它拿到的就是新锚点（`Dk` 是别的字符串）；若它没重读，就得不到新的服务记录 —— 两种情况都不会静默放行。

所以 used-set 需要的是**该文件自己的行** ∪ **本轮释放池**（§2.1 第 3 条）：释放后那个锚点已经不
在 `anchor_lines` 里，只有池还记得它 —— 而池只活一次调用。**不需要跨文件的源**：锚点属于文件，
别的文件持有同一个字符串既不冲突也不碍事。

> **修订记录（2026-10-04）**：本节与 §2.1 第 3 条早期都写着「全库已分配锚点（兜底）」。把它读成
> 「整个库的所有路径」是错的：那会禁掉本文件完全合法的候选值，还要付一次全表查询，而它想描述的
> 情形（释放后、尚未重读前的空窗期）已经由释放池盖住了。

### 4.3 重映射不释放、不清理

行号位移（插入/删除导致的下移上移）只改 `anchor_lines` 的行号，**锚点身份不变** → 不动 served、不进释放池。只有**内容真的变了**或**行被删除**才走 §4。

## 5. 外部改动（校验和不等）

1. **锚点的存亡与校验和无关。** 某个锚点能不能用，只由 §2.2 的三条逐行回答：它是否还活在 `anchor_lines` 里、内容键是否相符、是否在本会话 served 里。
2. 校验和与 `anchor_meta` 不一致时，工具层做一次**重映射**（行号位移 + 内容配对），而不是拒绝整次编辑：对**已有锚点的行**做内容配对（Myers，跨度两侧都由差异界定），内容键变化的行释放 + 重分配，其余原地保留行号位移。重映射完成后刷新 `anchor_meta` 的校验和。
3. **没有锚点的行绝不由这条路径分配** —— 它们要等模型真的读到。
4. 其他会话手里那些「已失效但仍在自己 served 里」的锚点，由**逐行判定**自然挡住，提示形态是 echo 出该行当前的锚点，而不是「请整份重读」。
5. **绝不因为「文件变了」就拒绝**：只有**这次要改的行**里出现失效锚点，才整体拒绝。

### 5.1 write 的语义

**两条路径，一套锚点规则**：

- **文件已存在（覆盖）**：先过沙箱/路径/权限校验，再走与 `edit` 的 `replace` **同一段** Myers 对齐（内容键相等则保留锚点，变了则释放 + 重分配），出 diff。不为 write 引入第二套语义。**内容完全未变时全部锚点保留**，不产生无谓的全量失效。
- **文件不存在（新建）**：先写入 → 按预算分段 → **只为返回的那一段分配锚点**（截断掉的部分不分配，模型读到才分配）。

**两条路径都截断、都复用 #201 的分段与续读能力** —— 不另设预算。覆盖一个大文件时 diff 本身可能超过预算（内容几乎全不同时 diff 就是整个文件），按同一套分段 + resume 处理。

**diff 的两侧各自带自己的锚点**：`-` 行给**编辑前**的锚点，`+` 与 context 行给**服务后**的锚点。这是 diff 的固有形式（`-`/`+` 表示哪行被删、哪行新增），不需额外说明。注意：**`-` 行的旧锚点是展示项，不是「分配」** —— §2.1 的「只为返回行分配」约束的锚点是**服务后的**那些；被删行的旧锚点已不在 `anchor_lines` 里，模型若真拿它去编辑会被逐行判定拒掉并拿到 echo。

**职责边界**：`write` 的写落盘仍走既有的 fs bridge（策略 + 观测保留，`FS_NOT_OBSERVED` / `FS_STALE_VERSION` 等失败路径不受影响）；它改变的是锚点记账部分 —— 改为调 §2.1 的 `anchorFor`，不再自己算锚点。

**父目录**：不存在时由既有的写路径递归创建（现成行为，本次不改）。

## 6. 错误语义与错误码

**保名改义**，不新增码：

| 码 | 旧含义 | 新含义 |
|---|---|---|
| `E_RANGE_STALE` | served 判定的产物（语义含混） | 文件校验和与 `anchor_meta` 不一致 —— 文件被外部或他会话改动过。**它是重映射的信号，不是拒绝的理由**（见 §5）。同一个码也用于宿主的 `FS_STALE_VERSION`（写入被版本守卫拦下），因为**补救手段完全相同**（重新 read 拿新锚点）；区别在于前者是重映射信号，后者是宿主的写权限/版本保护。 |
| `E_RANGE_UNVERIFIED` | 同上 | 范围内**有行的锚点不在本会话 served 集合里**，或该锚点已不活在 `anchor_lines` 里 |


- **⚠️ 实测补充（2026-10-04，实施 #223 时发现）：上面「失败始终是 `E_RANGE_UNVERIFIED`」并不成立。**当锚点**根本无法解析**（不在 `anchor_lines` 里，即 `probeLines` 的 `not-live`）时，管线在**定位阶段**就拒绝了，根本走不到 `verifyServedRange`（served 集合的判定发生在那里面），因此返回的是 `[E_STALE]`。
  - 这不是本次重构引入的：`README.md` 的错误码表本就写着「`[E_STALE]` — anchor unknown」，所以**代码与 README 一致，是本节当初描述漏了这条路径**。
  - 因此本节的正确读法是：`E_RANGE_UNVERIFIED` 覆盖**已解析但不在本会话 served 集合**的那一类；锚点不可解析归既有的 `E_STALE`。§2.4 的四类 `reason` 仍按原样分岔提示语，但不改变任何一个码。
  - 已由 `test/core/anchor-drift-cross-session.test.ts` 钉住：跨会话把某行替换掉后，原会话拿旧锚点重提 → 被拒、文件原样未动。
- **一个码、四种原因、文案不同**：本节范围内的失败始终是 `E_RANGE_UNVERIFIED`；`reason` 决定提示语（`never-seen` / `line-changed` / `line-moved` / `not-live`，见 §2.4），**码的集合一字不改**。（锚点不可解析那一条的例外见上一段的实测补充。）
- **行式 echo**：渲染**失效行 + 每行少量上下文**，而不是整个被拒范围 —— 一小段失效不应让模型消化上百行无关内容。总行数上限沿用 `SERVED_ECHO_CAP = 150`，超出则折叠并提示用 read 取更多（§2.4 已定：echo 里的上下文行同样要分配锚点）。
- 逐行失效清单随 `ServedRejectionError` 一起回，复用 `buildRangeEcho` / `fmtServedRows` 的渲染，不另写一套。

## 7. 事务边界

**每文件一个事务**（ADR-0003「按文件原子」），包住：

```
WITH file transaction:
  pread anchor_meta + anchor_lines(path)      # 预取
  pread served(sessionKey, path)              # 与校验同事务，见下
  probe / allocate                            # 校验 或 分配
  write anchor_lines + anchor_meta            # 写回
  write served(sessionKey, path)              # 取锚时写本会话；释放时只删本会话里的那个锚点
COMMIT
```

- **served 的读取必须与校验同事务**，否则「刚校验通过、锚点已被别的会话释放」的竞态会回来。
- 文件之间互不影响：一个文件失败不回滚其他文件（现状语义）。
- 释放触发的「从**本会话** served 移除」也在同一事务内完成（只动发起释放的那个会话；其他会话的记录不动，靠逐行判定 + echo 处理）。

## 8. 表结构（最终）

保持现状形状，**不做逐锚点行表**（#217 实测否决：写入放大 ≈187×、行表 300k 行 = 73.2 MiB 超 64 MiB 上限、且它解决的是一个没人提的查询）。

```sql
-- 文件级状态：校验和 + 行数（吸收原 snapshots 的语义）
CREATE TABLE anchor_meta (
  path       TEXT PRIMARY KEY,
  checksum   TEXT NOT NULL,
  line_count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 行 ↔ 锚点（锚点身份，跨会话共享）
CREATE TABLE anchor_lines (
  path        TEXT NOT NULL,
  line        INTEGER NOT NULL,
  anchor      TEXT NOT NULL,
  content_key INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (path, line)
);
CREATE INDEX anchor_lines_by_anchor ON anchor_lines (path, anchor);

-- 每会话「读过哪些锚点」：一整份集合，按 (session, path) 一行
CREATE TABLE served (
  session_id TEXT NOT NULL,
  path       TEXT NOT NULL,
  hashes     TEXT NOT NULL,   -- 本会话见过的锚点集合，varint/base64 打包（实测 1.41 B/锚点）
  reported   TEXT,            -- 侧带：漂移上报状态（「哪些漂移行已经告诉过模型」）
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (session_id, path)
);

-- 既有，保留不动
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE undo (/* 现列不变；锚点绑定快照由实施时定形态 */);
```

- **`snapshots` 表删除** —— 与 `anchor_meta` 重复；活动库中 0 行、只被 JSON 遗留导入器写入。
- 同一文件的「行↔锚点映射」与「已分配锚点集合」由**同一条写路径**原子更新：集合就是 `anchor_lines` 本身（`(path, anchor)` 索引即集合的查询面），不另设可能失同步的表。
- `undo` 需增加锚点绑定快照（让 undo 能连锚点一起回退）。

### 版本变更（`HASH_STORE_VERSION` 6 → 7）

**清理 `served` 这件事已经做过了 —— 不要重复实现。** 现有代码在版本变更时：

1. `DELETE FROM` 四张表：`snapshots` / `undo` / `anchor_meta` / `anchor_lines`（`hash-store.ts:555-560`）；
2. **紧接着 `DROP TABLE IF EXISTS served` 并重建**，条件是 `versionChanged || 缺少 session_id 列`（`hash-store.ts:561-579`）—— `versionChanged` 是第一个析取项，所以版本变更**必然**整表重建 `served`，比清行更彻底。

（先前本节曾写成「漏了 `served`、必须补上」—— 那是**错误结论**，源于只看了 `DELETE FROM` 那一段就下判断。已按代码事实更正。）

**版本变更不需要迁移任何数据**：锚点与 served 都是可重建的缓存，模型手里的旧锚点被一次性作废并被告知。

**清哪些 `meta` 键**：`version` 会被重写；`maintenance_indexes` 随库重建而重置；而 `clean_shutdown` / `last_open_integrity_check` / **`last_rebuild_at` 必须保留** —— 尤其 `last_rebuild_at` 是重建节流（`HASH_STORE_REBUILD_THROTTLE_MS = 24h`，`hash-store.ts:1513` 读它）的依据，清掉它会让一个库很大的工作区在同一次会话里被连续重建。

**重建要告知模型**（沿用现有的 `setRebuildWarning` / `takeRebuildWarning`，ADR-0010 的要求），且**版本升级触发的重建与容量触发的重建措辞要分开** —— 前者说明这是插件升级导致的一次性重建，让模型知道这不是异常；不区分会把一次正常升级说成像是出了故障。

## 9. 不变量（每条配测试）

1. **唯一性**：同一 path 任何时刻不存在一个锚点绑定两行。
2. **重映射不改身份**：内容未变的行在插入/删除前后锚点字符串完全相同，只有行号变。
3. **只对返回行分配**：被预算截断的行在库里没有 `anchor_lines` 行，也没有 served 记录。
4. **释放即三清**：释放后该锚点不在 `anchor_lines`、不在**发起释放的那个会话**的 served、且在本轮释放池里。
5. **本轮不重发**：同一次 `edit` 调用里释放的锚点，不会被该调用内的任何行拿到。
6. **取出即可用**：`anchorFor` 返回的每个锚点，同会话随后都能通过 `probeLines` 校验（除非期间内容变了）。
7. **拒绝即自洽**：`probeLines` 失败时，`rows` 里给出的 `current` 就是该位置当前真实可用的锚点。

## 10. 已知限制

- **`served` 的清理要重写一行 blob**：从本会话移除一个锚点意味着重写该 `(session_id, path)` 那一行的打包集合。以实测 1.41 B/锚点与活动库 28k 槽位量级（约 40 KB/行），单次代价很小；若某 path 的 served 集合异常大，这是可观测的退化点。**不跨会话**：其他会话的记录不动，靠逐行判定 + echo 处理。
- **锚点空间被更早占用**：跨会话共享 + 释放后仍需 served 兜底，意味着 2 字符层（3,844 槽）会比现状更早用尽，更早升到 3 字符锚点。这是可接受的（锚点变长不影响正确性）。
- **一个仍开着的小窗口（内容相同 + 跨会话）**：若某会话把锚点 `Dk` 读进 served、另一会话随后编辑该行导致 `Dk` 被释放并**重新分配给一行内容键恰好相同**的行，则第一个会话手里的 `Dk` 会指向那一行 → 校验放行。三条判定都拦不住它（锚点活着、内容键相符、served 里有）—— 现有信息无法区分「我见过的 `Dk`」与「新铸的同名 `Dk`」。要彻底关掉需要额外记住「哪些锚点是本会话见过并已释放的」，代价是与会话时长成正比的增长；维护者已裁定不做永久退役集合，故此处作为**已知限制**记录，不假装它不存在。
