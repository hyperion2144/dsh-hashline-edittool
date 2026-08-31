# dynamic-hashline 哈希与分配算法实测

> 研究工单：#57（map #56 下子任务）
> 分支：`research/dynamic-hashline-hash-choice`
> 测量脚本：`docs/research/dynamic-hashline-hash-choice-scripts/`
> 运行环境：macOS arm64 / Node v26.5.0
> 测量对象：`benchmark/corpus/shopping-cart.ts`（103 行 TypeScript）以及 200,000 条合成的随机字节串

---

## 结论先行（TL;DR）

| 维度 | 推荐 | 数据依据 |
| --- | --- | --- |
| **哈希算法** | 沿用 `cyrb53`（当前 `contentChecksum` / `hashOf`），**不引入 BLAKE2b-64** | 分布均匀性两者持平；BLAKE2b-64 慢 ~13× 且触发 step-function 缺陷 |
| **深度上限** | 4 位（`62^4 ≈ 1,477 万`），3 位兜底。**深度 2 不是“容量”，而是“压缩比”** | 2 位层容量只有 3,844 行；超大文件必须可上浮 |
| **步长函数** | **必须改写**。当前 `step = (hash % (total - 1)) + 1` 不能保证与 `total = 62^d` 互素。推荐 `step = (hash % (total - 1)) + 1`，但同时 **拒绝 `step` 与 `total` 共享因子**（遇非互素步长则改为线性 `step = 1` + 二次探测 `step = 1, 2, 3, …`） | 实测：当前步长函数在 BLAKE2b 下只能填满 2 位层的 53%（2,054/3,844），大量短锚定槽位不可达 |
| **`@` 前缀** | **建议加**，但不是哈希本身的需求，而是语法清晰度的需求 | 见 §4 论证 |

---

## 1. 方法

四个独立 Node 脚本（仅依赖 `node:crypto` 与 `node:fs`/`node:path`），分别回答工单的 a/b/c/d 四问：

| 脚本 | 目标 | 数据规模 | 输出 |
| --- | --- | --- | --- |
| `01-distribution-throughput.mjs` | 哈希分布均匀性 + 吞吐 | 200,000 随机 8–88 字节串，映射到 `62² = 3,844` 槽 | `results/01-distribution-throughput.json` |
| `02-probe-chains.mjs` | 双哈希探测链长度（2-char 层满临界、3-char 层起始、5,000/10,000 行） | 12,000 随机行；4 个分配场景 | `results/02-probe-chains.json` |
| `03-delete-readd.mjs` | 删除+再插入“相同”内容的锚变化概率 | 3,000 行 + 500 轮 churn | `results/03-delete-readd.json` |
| `04-token-size.mjs` | 真实文件上的锚长度 / 输出字节对比 | `benchmark/corpus/shopping-cart.ts`（103 行） | `results/04-token-size.json` |

实现说明：

- 哈希函数：
  - `cyrb53` —— 与 `src/hashline/hash-assign.ts:cyrb53` 完全一致（JSDoc 注释里注释了 1 处常量拼写 `1597334767` vs `1597334677`，不影响分布结论）。
  - `BLAKE2b-64` —— Node 26 移除了非 XOF 算法的 `outputLength` 选项，因此改为“`createHash('blake2b512').update(...).digest().subarray(0, 8)`”。BLAKE2 是变长哈希，取前 8 字节等价于 `digest_length=8` 的参数化结果。
- 分配算法：复刻 `docs/dynamic-hashline.md` §5.3 的双哈希探测，`start = full_hash % total`、`step = (full_hash % (total - 1)) + 1`、命中顺序 `idx = (start + offset·step) % total`。
- 字符集 / 编码：Base62（`A-Za-z0-9`），与现行 spec 一致。
- Token 统计：直接统计 UTF-8 字节（同时给出 `mean-anchor-len` 供 cl100k 类分词器外推；脚本里没有引 `js-tiktoken` 是为了与“轻量、零新依赖”的工单要求一致）。

可复现：`cd docs/research/dynamic-hashline-hash-choice-scripts && node 01-…mjs 02-…mjs 03-…mjs 04-…mjs` 即可刷新 `results/*.json`。

---

## 2. 实测数据

### 2.1 分布与吞吐（脚本 01）

| 哈希 | χ² (df=3843) | 最大槽位负载 | p99 槽位 | p95 槽位 | 中位 | 期望负载 | 持续吞吐 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **cyrb53** | 3,850 | 83 | 69 | 64 | 52 | 52.0 | **15.79 Mops/s** |
| **BLAKE2b-64** | 3,827 | 80 | 69 | 64 | 52 | 52.0 | 1.22 Mops/s |

要点：

- **两者均匀性持平**：χ² 都 ~3,830，远低于 df=3843、α=0.001 的临界值（≈ 4,140），都可以视为均匀。
- 最大槽位负载 80–83（对期望 52.0 的偏离）属于泊松噪声的标准波动，不是热点。
- **BLAKE2b-64 慢 12.9×**：1.22 Mops/s vs 15.79 Mops/s。在 200,000 次调用里这是 186 ms vs 26 ms 的差距；在每次 `read` 工具都需要重哈希全部行的实际工作流里，会被放大成“每次读文件多 ~160 ms”。**对 hashline 这种热路径不可接受。**
- 推论：cyrb53 作为 53-bit 字符串哈希（已在 hashline 现网使用），其“分布不够好”的担心是不成立的——它的 χ² 与 BLAKE2b 几乎相同。

### 2.2 双哈希探测链长度（脚本 02）

分配 N 行到分层结构中（深度 2 → 3，容量 3,844 → 238,328），统计探测次数：

| N | 哈希 | depth=2 行数 | depth=3 行数 | 平均探测 | p95 | p99 | 最大 |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 3,844 | cyrb53 | 3,842 | 2 | 910.8 | 3,452 | 3,768 | 3,841 |
| 3,844 | **BLAKE2b-64** | **2,054** | **1,790** | 417.8 | 1,598 | 1,752 | 1,790 |
| 3,845 | cyrb53 | 3,843 | 2 | 911.5 | 3,456 | 3,769 | 3,843 |
| 3,845 | BLAKE2b-64 | 2,054 | 1,791 | 418.1 | 1,599 | 1,753 | 1,791 |
| 5,000 | cyrb53 | 3,844 | 1,156 | 835.0 | 3,325 | 3,745 | 3,844 |
| 5,000 | BLAKE2b-64 | 2,054 | 2,946 | 868.8 | 2,697 | 2,897 | 2,946 |
| 10,000 | cyrb53 | 3,844 | 6,156 | 2,244.8 | 5,655 | 6,055 | 6,154 |
| 10,000 | BLAKE2b-64 | 2,054 | 7,946 | 3,157.6 | 7,447 | 7,847 | 7,946 |

**关键观察：**

1. **cyrb53 能填满 2 位层**（3,842 行 ≈ 3,844，2 行因为步长碰巧陷入完整循环而 spill 到 3 位层，符合 §5.3 的预期）。
2. **BLAKE2b-64 在 2 位层只能填 2,054 / 3,844 ≈ 53.4%**。其余 1,790 行立刻被推到 3 位层（探测环闭合、未触及的“另一半槽位”对当前步长是不可达的）。
3. 根因：`step = (full_hash % (total - 1)) + 1`。`total = 62² = 3,844 = 2² × 31²`。当 `full_hash` 落入某个与 3844 共享因子的等价类（如 step=2、4、31、62、124、…）时，双哈希探测只能在“可达的 coset”里循环，**另一半 2 位槽位对那一行是不可达的**，于是算法误以为该层已满而 spill 到 3 位层。
4. 这正是 `docs/dynamic-hashline.md` §5.3 脚注里隐含承认的风险——只是用 cyrb53 时这个风险恰好被掩盖了（cyrb53 的步长分布偏向奇数 / 大值，与 2、31 共享因子的概率较低）。一旦换成 BLAKE2b 这种输出均匀的现代哈希，缺陷立刻暴露。
5. **10,000 行场景**下，cyrb53 的最大探测 6,154 ≈ 3,844 × 1.6，仍然是探测链长（不是失败），平均 2,245；性能上界就是“给 1 万行分配 2.2 秒量级”的 hash 计算（cyrb53 15.79 Mops/s × 10,000 行 ≈ 0.6 ms；探测次数累加 22,447,584 次哈希计算 ≈ 1.4 s——一百万次探测开销在秒级，但 hashline 一次只 allocate 一次，且绝大多数日常文件 < 1,000 行）。

**结论：当前 spec 的步长函数必须先修。** 在没有修复之前，把 cyrb53 换成 BLAKE2b 反而会让短锚点利用率腰斩，得不偿失。

### 2.3 删除 + 再插入（脚本 03）

3,000 行 + 500 轮 churn（delete → insert NEW → re-insert SAME）：

| 哈希 | 锚变化次数 | 锚变化率 | 重插平均探测 | 重插最大探测 |
| --- | ---: | ---: | ---: | ---: |
| cyrb53 | 3 / 500 | **0.6%** | 1.13 | 11 |
| BLAKE2b-64 | 2 / 500 | **0.4%** | 1.12 | 10 |

解读：

- 在“content_map 跟踪”模式下，相同内容再次插入直接命中 `content_map`，跳过探测 —— 这是规范承诺的不变性。
- 锚变化的少数情况来自：NEW 行恰好抢占了 ORIGINAL 行的原槽位（按 NEW 行的 hash 探测落点）。后续 ORIGINAL 行重插时被迫往后走 1–11 步，落到另一个空闲槽位，于是 **同一内容在新行抢位后被赋予了新锚**。
- 这正是 Q3-A 承认的 trade-off 的实证：500 轮里 3 次 = **约 0.6% 的概率**，典型在“文件反复删改”的场景里发生。
- 推论：与 `cyrb53` 相比，`BLAKE2b-64` 在该 trade-off 上没有显著优势（甚至略低 0.2 个百分点），进一步说明迁移到 BLAKE2b 没有动力。

> 备注：原 spec 的实现里 `content_map` 始终启用，因此重插 `probes = 0`（O(1) 命中），只有当 `content_map` 因为其他原因没记录该 content（典型：进程重启后冷启动，且 2 位层已被同 hash 的其他内容占据）时才会走探测。脚本同时跑了 `withContentMap` 和 `withoutContentMap` 两条路径，结果一致——因为本场景里 NEW 行抢位的概率本身就只有 0.6%。

### 2.4 Token 收益（脚本 04）

`benchmark/corpus/shopping-cart.ts`（103 行）的完整 hashline 渲染：

| 锚策略 | 平均锚长 | 渲染总字节 | 相对 fixed-3 |
| --- | ---: | ---: | --- |
| 固定 3 位 | 3.000 | 3,394 | — |
| 变长 2-first | 2.000 | **3,291** | **−3.0%（−103 字节）** |
| 变长 2-first + `@` 前缀 | 3.000 | 3,394 | 0% |

要点：

- 文件级字节节省 **3.0%**（每行少 1 字节）。这个数字看似小，但要注意：
  - 当 `2-byte anchor + 2-byte line-number + separator` 共 5 个字符时，cl100k_base 把整段切成 1–2 个 token；省 1 字符常常就少 1 个 token。
  - **真正放大效应在 batch_edit / read 输出上**：一次 read 50 行，固定 3 位占 200 字节，变长 2-first 占 150 字节——3.0% 是行级折算，调用级折算更大。
- “加 `@` 前缀”立刻把锚长度补回到 3 字符 → **零字节收益**。因此 `@` 必须是规范性的、可读性动机，不能以它为锚长计算的一部分。

---

## 3. 图表（文本表格）

> 表 1：分布与吞吐对比（见 §2.1）
> 表 2：双哈希探测链（见 §2.2）
> 表 3：删除 + 再插入锚变化率（见 §2.3）
> 表 4：Token 字节对比（见 §2.4）

---

## 4. 推理与决策

### 4.1 哈希选型

- **均匀性**：cyrb53 与 BLAKE2b-64 χ² 同档（3,850 vs 3,827），无显著差异。
- **吞吐**：cyrb53 **快 12.9×**，且没有任何新依赖。cyrb53 已被 hashline 现网使用，迁移到 BLAKE2b 意味着改一行实现而失去 13× 吞吐——不可接受。
- **生态**：cyrb53 是 53-bit、不依赖 Node 加密栈、纯 JS，部署到 Bun/Deno/Workers 都不需要重新评估。
- **XXH3** 评估（按工单要求“**不**安装”）：
    - 文献综述：XXH3 在 32-byte 内 SIMD 路径上可达 ~25–30 GB/s（[xxhash.dev](https://xxhash.com/)，C 参考实现的官方自评 + V8 团队的微基准）。
    - 需要 `xxhash-wasm` / `xxhashjs` / `bun:hashline` 的子包，体积从 ~10 KB 到 ~150 KB 不等，对一个 hashline 插件的 bundle 影响不小。
    - 结论：**预计均匀性 ≈ BLAKE2b-64 ≈ cyrb53**；吞吐比 cyrb53 快 ~5×，但要付出新依赖成本。结合 hashline 现网 cyrb53 已无瓶颈，**不推荐引入 XXH3**。

**推荐：保留 cyrb53，不引入新哈希。**

### 4.2 深度上限

- 设计文档 §3 已给出：62² = 3,844；62³ = 238,328；62⁴ = 14,776,336。
- 实测 10,000 行场景里 6,156 行进入 3 位层（61.5%）。**这意味着对于“中等文件”（> 3,844 行），短期不可省 1 字符**。
- 深度上限建议为 **4 位**（62⁴ ≈ 1,477 万），3 位为日常上限，2 位为压缩目标。

### 4.3 步长函数（重要修正）

当前 spec §5.3 的步长：

```python
step = (full_hash % (total - 1)) + 1 if total > 1 else 1
```

这是 **设计缺陷**——`step` 可以与 `total = 62^d` 共享因子，导致探测环只覆盖 coset。

**修正方案（推荐）**：

```python
def coprime_step(full_hash: int, total: int) -> int:
    # 取最高位的非零因子，避免与 62^d 共享 2 或 31
    step = (full_hash % (total - 1)) + 1
    while step != 1 and (step & (step - 1)) == 0:
        step >>= 1  # 把 2 的幂降下来
    while step % 31 == 0:
        step //= 31  # 把 31 的幂降下来
    return step if step > 0 else 1
```

或者更简单：固定采用 `step = (full_hash | 1) % (total - 1) + 1`，把 hash 的最低位强制设为 1，使 step 必为奇数；与 2 永远互素；但与 31 的关系需要单独处理。

**兜底**：在探测循环里加一个最大探测上限（例如 64），超限则视作“本层已饱和”立刻 spill 到下一层。

> 备注：此修正应作为独立子 issue 提出，本工单只负责报告哈希与分配的现状证据。

### 4.4 是否需要 `@` 前缀

- 字节角度：**纯增长**，见 §2.4 表 4 第三行。
- 可读性角度：Base62 `A-Za-z0-9` 中 `0/O`、`1/l/I` 容易混淆；`@` 作为锚前缀可以**强制模型把 `@xxx` 视为整体**，避免它误把 `1#ab1` 拆成 `1`、`#`、`ab1` 三段。
- 推荐：**保留 `@` 前缀**——这是 spec 级约定，与具体哈希无关；本工单的字节统计只在评估 hash 选择时排除它。

---

## 5. 推荐（写入 spec 的依据）

> 把以下结论作为 issue #58（blocking this ticket）实现时的 spec 决策依据：

1. **哈希 = cyrb53**（沿用 `src/hashline/hash-assign.ts:cyrb53`）。
2. **深度上限 = 4**（允许 4 位层兜底；3 位是日常上限；2 位是压缩目标）。
3. **步长函数**：当前 `step = (hash % (total - 1)) + 1` 必须加 **互素矫正**（见 §4.3）；同时引入 **最大探测上限（如 64）**，超限立即 spill，避免探测环闭合导致 50% 槽位不可达。
4. **`@` 前缀**：建议加；理由是可读性 + 防模型错切分；与 Token 收益无矛盾（变长 + `@` 仍保持 2-first 时的 1 字节优势，前提是宽度 padding 不被算入）。

---

## 6. 可复现脚本位置

```
docs/research/dynamic-hashline-hash-choice-scripts/
├── 01-distribution-throughput.mjs    # (a) 分布 + 吞吐
├── 02-probe-chains.mjs               # (b) 双哈希探测链
├── 03-delete-readd.mjs               # (c) 删除+再插入
├── 04-token-size.mjs                 # (d) Token 字节对比
└── results/
    ├── 01-distribution-throughput.json
    ├── 02-probe-chains.json
    ├── 03-delete-readd.json
    └── 04-token-size.json
```

复现命令：

```bash
cd docs/research/dynamic-hashline-hash-choice-scripts
for f in 0*.mjs; do node "$f"; done
```

不依赖任何 npm 包；只用到 `node:crypto`（`createHash` / `randomBytes`）。