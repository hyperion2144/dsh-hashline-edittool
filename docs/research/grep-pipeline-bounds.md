# `grep` 管道层的有界性 —— 官方 `tool-fs-search` vs 本插件（#414 诊断）

> 目的：为 [#414](https://github.com/hyperion2144/dsh-hashline-edittool/issues/414)「grep 对超大树 OOM」提供一手核对，并划清「管道层」与「锚点契约」两条边界。
> 一手来源：官方检出 `/Users/mutou/vault/projects/deepseek-harness`（`packages/fs/tool-fs-search/src/`）与本仓 `src/`；除源码外未引用任何二手材料。本笔记不做修复，只记录核对结果。
> 路径约定：官方路径相对官方仓库根，本仓路径相对本仓根；行号取自本次读到的文件内容。
> 核对日期：2026-11-04。

---

## 0. 结论速览

1. **官方 grep 的界不在「搜索」里，而在「搜索之外的四个帽」**：单次 `rg` 调用（path 上 argv，rg 自己走目录并吃默认 ignore）、全场 raw stdout 20 MB、inline 250 条命中（超出把**完整**结果 spill 并给 locator）、行文本 2000 字节。四个帽都作用于「已经发生的搜索」，与引擎无关。来源：`grep.ts:29,35,113-118,349-366`、`search-core.ts:36,139-155,244`。
2. **本插件把同样的四件事逐条换成了无界形状**：候选由 `rg --files --no-ignore-parent` 先枚举成 argv；按 30 KB 切 chunk（约 125 次 rg）；64 MB / 15 s 是 **per-chunk** 帽且跨 chunk 无总量；命中行文本全量进内存（无 2000 字节帽）；任一 chunk 失败 → 整场 `failed` → **静默降级**为「读遍全部候选 + JS 逐行匹配」；命中文件的 served 行与锚点靠**整文件重读**。来源见 §2。
3. **rg 层小规模复现成立**（本笔记 §3）：父级 `.gitignore` 管得住官方形状、管不住 `--no-ignore-parent`；`--text` 只有「行号 + 行文本形状」差异，**并不决定二进制文件是否被搜到**。
4. **#414 第 7 条（不再全文重读、锚点按行生成）卡在接口，不卡在哈希**：`contentChecksum` 就是 `cyrb53(normalizeContent(整文件文本))`——纯 JS 字符折叠，可流式计算；**没有**「给路径返回 checksum」的现成方法，`statVersion` 返回的是 host 的 `dev:ino:size:mtimeNs:ctimeNs`（stat 身份，不是内容哈希）。`anchorFor` 的入参是整串文本，`allocateInto` 也按整串切行。三件事都能改：cyrb53 可流式折叠（O(1) 内存，仍是一次 I/O），逐行入场口只差接口形状；真正要动契约的只有「完全不读文件」这一档。来源：`src/hashline/hash-assign.ts:198-236`、`src/domain/session/anchor-state.ts:89-120`、`src/domain/session/anchor-entry.ts:313-334`。
5. **#414 第 8 条的机制需要修正**：去掉 `--text` 不会让 rlib/pdb/exe「天然出局」——它们仍是命中来源，只是 rg 会以 `lines.bytes`（base64）报告并停在二进制边界，输出量级从「整段文本」掉到「一条记录」。真正的出局来自第 1 条（默认 ignore）与第 5 条（行文本帽）。

---

## 1. 官方形状（`packages/fs/tool-fs-search/src/`）

| 环节 | 官方做法 | 来源 |
|---|---|---|
| 调用形状 | **一次** `rg`，path 直接上 argv；`['--json', '--regexp=…', (--glob=…), '--', path]`；不预列文件、不切 chunk、不传 `--text` | `grep.ts:113-118` |
| 候选发现 | 由 rg 自己走 path，吃默认 ignore 语义（git 仓库内父级 `.gitignore` 生效；非 git 目录不吃 `.gitignore`） | 同上（无 `--no-ignore-parent` / `--no-require-git`） |
| 全场 raw stdout 帽 | `RAW_OUTPUT_MAX_BYTES = 20_000_000`，由 spawn seam 执行（`stdout: { maxBytes }`）；超限 → `SEARCH_RAW_OUTPUT_OVERFLOW`，文案 `narrow pattern, path, or include and retry`；**不部分解析** | `search-core.ts:36,139-155,244` |
| 命中帽 | `GREP_MAX_MATCHES = 250` inline；超出后 `tools/post-execute` 把**完整**结果写成 spill 并返回 locator（inline 仍 250 条） | `grep.ts:29,349-366` |
| 行文本帽 | `GREP_MAX_LINE_BYTES = 2000`，UTF-8 边界安全截断（`previewLine` → `TextRetainer`），spill 里也是预览行 | `grep.ts:35`、`search-core.ts:317-330` |
| 失败词汇 | `SEARCH_FAILED` / `SEARCH_ABORTED` / `SEARCH_RAW_OUTPUT_OVERFLOW` / `SEARCH_INVALID_PATTERN`；**没有第二引擎** | `search-core.ts:68-82` |

---

## 2. 本插件形状：六个无界点

按执行顺序，每一步都能单独把 heap 拉满：

1. **候选发现偏大**（`src/tools/grep-rg.ts:678-711`）：`rg --files --no-config --no-require-git --no-ignore-parent --glob '!**/node_modules/**' .`。`--no-ignore-parent` 是**故意**的（注释写明「点名路径时祖先规则不得清空列表」），代价是父级 `.gitignore` 不生效 → 被 ignore 的 `target/` 整树入列。列表失败（超时 / 超 64 MB / rg 缺失）返回 `undefined`，调用方 `?? await gatherFiles(...)` 回退到完全不认 ignore 的 JS 遍历（`src/infra/file-scan.ts:24-59`，只跳隐藏项与 `node_modules`）。
2. **调用形状切碎**（`src/infra/argv-limit.ts:51`、`grep-rg.ts:581-605`）：文件清单进 argv，按 `ARGV_BUDGET = 30_000` 切片；33,815 条路径 → 约 125 次 rg。每次 rg 都有自己的 64 MB / 15 s 帽，**没有跨 chunk 的总量**；`collected.push(...outcome.matches)` 把所有 chunk 的命中（含整行文本）攒进一个数组。
3. **引擎旗标放大输出**（`grep-rg.ts:176-191`）：`--no-config --json --text --max-count=<limit>`。`--text` 让 rg 把二进制当文本搜：一条没有换行的二进制「行」可以是几百 MB，`--json` 会把整行编进记录；`--max-count` 只限**每个文件的行数**，不限**每行的字节数**。
4. **任一分片失败 = 整场失败**（`grep-rg.ts:541-605`）：`timeout` / `output-too-large` / 退出码非 0/1/2 → `classifyRgProcess` 返回 `failed`，`rgSearchMatches` 立即 `return outcome`（注释：「A failed chunk is the whole search」）。
5. **静默降级读遍全树**（`src/tools/grep-search.ts:318-336`、`src/tools/tool-grep.ts:652-684`）：`failed` → `candidates = [...request.files]`（全部 33,815 条）→ 逐文件 `readTextTolerant` 全文读 + `visLines` 切行 + JS `matchPositions`。这是整条链里最耗内存的一步，且**不告知调用方**。`unavailable`（rg 二进制解析不到）走同一条路。
6. **预算问得太晚**（`src/tools/tool-grep.ts:648-652,869-872,885-906`）：ADR-0013 的 48k 是**响应拼装**预算；溢出行先 `spillRows.push(...)` 全量攒在内存，循环结束后才 `createResume(...)` 写盘。`fileSections` / `cardFiles` / `jsonFiles` 同样在循环里累积。ADR-0013 第 46-47 行「resident = current file buffer + returned segment」的声明，对 grep 的工作相不成立——无界阶段全部发生在预算被问到之前。

另有两个放大器，不在 #414 的清单里但同一量级：

- **锚点/漂移要求整文件内容**（`tool-grep.ts:730-738` → `anchorForInWorkspace({ content: text, lines: positions })`）：每读一个命中文件的目的就是为了 `content`。见 §4。
- **第二次无帽计数遍历**（`tool-grep.ts:183-206` → `grep-rg.ts:628-659`）：对触到 per-file 帽的文件再跑一次 `rg --count`（无 `--max-count`）。它不是 OOM 主因（只读计数行），但它与第 4 条「到帽即停」的官方形状相抵，ADR-0029 需要复审。

---

## 3. 有界复现（rg 层，不触发 OOM）

复现脚本（临时目录，父级 `.gitignore` + 一个 2 MB 二进制 + 一个含 NUL 的小二进制）：

```bash
R=/tmp/grep414-repro
mkdir -p "$R/src-tauri/target/debug" "$R/src-tauri/src"
printf 'src-tauri/target/\n' > "$R/.gitignore"
printf 'fn main() {}\n'   > "$R/src-tauri/src/main.rs"
# target/debug/libfoo.rlib: 64 个 NUL + NEEDLE + 64 个 NUL
# target/debug/big.bin:    2 MB 随机字节 + "NEEDLE in binary"
cd "$R" && git init -q .
```

结果：

| 形状 | 命令 | 结果 |
|---|---|---|
| 插件候选发现 | `rg --files --no-config --no-require-git --no-ignore-parent --glob '!**/node_modules/**' .`（cwd=`src-tauri`） | **列出** `target/debug/{libfoo.rlib,big.bin}`（+ `src/main.rs`） |
| 官方候选发现 | `rg --files --no-config .`（cwd=`src-tauri`） | 只列 `src/main.rs` |
| 插件搜索 | `rg --json --text --max-count=100 --regexp=NEEDLE -- target/debug/big.bin` | `match` 记录，`line_number: 8111`，`lines.text` 为一整行 |
| 官方搜索 | `rg --json --regexp=NEEDLE -- target/debug/big.bin` | **仍然是 `match` 记录**，`line_number: 16265`，`lines.bytes` = base64 |

两点推论：

1. `--no-ignore-parent` 与默认 ignore 的差异是**确定性**的，不依赖 31.2 GB 的规模——第 1 条要求可以被小样本钉死。
2. `--text` 的差异是「行号 + 行文本进不进字符串」，不是「搜不搜二进制」。去掉 `--text` 后同一行仍会命中，只是以 `bytes` 形式、且行号按 NUL 断行计数（这正是 #268 的旧前提）。所以第 8 条的正确表述是「二进制的**输出量级**出局」，不是「二进制文件出局」。

---

## 4. #414 第 7 条的真实边界：锚点入场吃「整串文本」，但没有「按路径取 checksum」的方法

现状是三个事实，不是一个「必须读文件」的规定：

1. `contentChecksum` = `cyrb53(normalizeContent(text))`——纯 JS 字符串哈希（逐 UTF-16 码元折叠），不是 crypto，也不吃 Buffer。
2. `anchorFor` 的入参是 `content: string`，内部 `splitLines(content)` 取 lineCount 与每个被 serve 行的 contentKey；`allocateInto` 同样按整串切行。这是**接口形状**，不是算法必需。
3. `FileIO` 没有「路径 → checksum」的方法。`statVersion` 返回 host 的 `dev:ino:size:mtimeNs:ctimeNs`，是 stat 身份，不是内容哈希；它与锚点库里持久化的 checksum 不是同一种值，混用会让 `ensureState` 每次都判「文件变了」而 realign。

所以「不读文件就没有 checksum」只在「照现在的实现原样复用」时成立。实际有三条路，成本差一个量级：

| 路线 | 整文件 I/O | 改锚点契约 | 说明 |
|---|---|---|---|
| A 维持现状 | 整串进堆 | 否 | 内存与文件等大 |
| B 流式折叠 | 完整读一次，O(1) 内存 | 否 | 分块解码 + 跨块处理 BOM/CRLF，算出一模一样的 14-hex；逐行入场口只需把「整串」换成「按行取文本」 |
| C 完全不读 | 无 | 是 | 复用库里的旧 checksum / 改用 statVersion / 允许无 meta 的行族，三选一都会改变 `ensureState` 的 realign 语义 |

B 满足「内存有界」，但不满足 #414 验收里「不再全文重读任何命中文件」的字面要求——那一条只有 C 能满足。这是本票真正要拍板的取舍，与哈希算法无关。

---

## 5. 与 #414 八条逐条核对

| # | 要求 | 核对结果 |
|---|---|---|
| 1 | 候选发现吃默认 ignore，失败不回退 `gatherFiles` | **成立**；两处都在（`rgFiles` 的 `--no-ignore-parent`、`tool-grep.ts:587-590` 的 `?? gatherFiles`） |
| 2 | 单次 rg 调用、path 上 argv、不切 chunk | **成立**；`buildRgArgv` 收的是 `files`，块切分在 `argv-limit` |
| 3 | 全场 stdout 帽 20 MB + 响亮 overflow | **成立**；现在只有 per-chunk 64 MB，且失败被吞进降级 |
| 4 | 全场命中帽 250 + spill + 到帽即停 | **成立**；现在无总量帽，且 ADR-0029 的第二次无帽计数与「到帽即停」冲突 |
| 5 | 行文本帽 2000 字节 | **成立**；`parseRgMatches` 原样保留整行 |
| 6 | rg 失败 = 响亮失败，删除静默降级 | **成立**；`grep-search.ts:318-336` 就是那条静默路径 |
| 7 | 不重读命中文件、锚点按 rg 记录生成 | **部分成立**：目标合理，但受 §4 的锚点入场口限制，#414 里的描述低估了这一条的改动面 |
| 8 | 去掉 `--text`，二进制「天然出局」 | **机制成立、表述不准**：见 §3 第 2 点 |

---

## 6. 对 ADR 的影响（供决策，不在本笔记里定案）

- **ADR-0013**：需要承认「工作层帽」是独立于 48k 流控预算的一类东西（20 MB raw / 250 命中 / 2000 字节行），并改写「resident = 当前文件 + 当前段」的声明；48k 保持纯流控不变。
- **ADR-0028**：`grep never fails because ripgrep did` 与 PLACEMENT/DRIFT 段被 #414 第 6/7 条取代；第 7 条还牵动「grep 的 served 行来自搜索快照」这一既有表述。
- **ADR-0029**：第 1 条「无帽计数遍历」与「到帽即停」冲突——官方只从已解析的受限输出报告计数。
- **ADR-0009 / #214（锚点单一数据源）**：第 7 条需要一个「不要求整文件内容」的入场口，属该契约的扩展，不是 grep 内部重构。

## 7. 未决（已全部拍板，见 §8）

- ~~分离度~~ → Q1：不拆票，三段全在本票做。
- ~~降级路径~~ → Q2：删除，响亮失败。
- ~~点名被 ignore 的目录~~ → Q3：保留 0 命中兜底重跑。

---

## 8. 拍板与行号核对（2026-11-04）

**拍板：走 B（保留一次流式读取），哈希用 `node:crypto` 的流式 sha256，不手写。**

- `contentChecksum` 的输入仍是 `normalizeContent(text)` 的 UTF-8 字节——**不是原始文件字节**，否则 CRLF 文件上 grep 与 read 会算出不同的值。
- grep 的流式实现：`createHash('sha256')` + 分块解码 + 跨块处理 `\r\n`（chunk 以 `\r` 结尾时把 `\r` 留到下一块），得到的值与 read/edit 从字符串算出的完全相同。
- 同一次流式读取顺带产出 lineCount 与「是否含裸 CR」标记，不给第二遍 I/O。
- 值从 14 hex 变 64 hex ⇒ `HASH_STORE_VERSION` bump（升级即清空锚点状态，现成机制）。
- 验收口径随之调整：「不再全文重读任何命中文件」→「不再把命中文件整串驻留内存」。

**行号核对**（rg 实测，LF / CRLF / 裸 CR / BOM 四个文件）：

| 文件 | rg 行号 | read 行号 | 行文本差异 | 结论 |
|---|---|---|---|---|
| LF | 2 | 2 | 无 | 一致 |
| CRLF | 2 | 2 | rg 带尾部 `\r`；`canon` 把 `[ \t\r\n]` 全去掉 | 行号一致，锚点 key 一致 |
| 裸 CR | **1** | **2** | rg 只按 `\n` 切 | **错位**，见下 |
| BOM | 1 | 1 | rg 会吃掉 UTF-8 BOM（实测 `lines.text` 不含 BOM） | 一致 |

裸 CR 是唯一错位的情形。现在靠 `hasBareCr` → `indexLineSpaces` + `readSpacePosition`（用 submatch 的字节偏移反查 read 行号）兜住，这需要整文件文本。不读文本后兜不住，两个选项：

- **推荐**：校验和那次流式读取顺手记「是否出现 `\r` 且后一字节不是 `\n`」。命中则把这个文件降级为「按文本读一遍、走现有落位逻辑」——只有裸 CR 文件付这一遍。
- 不做降级：grep 给的行号是 rg 的，`edit` 会以 `E_STALE` 拒绝（假 stale，不会写错内容）。

**行空间的分歧与代价**：LF / CRLF / BOM 本来就一致（上表），唯一分歧是裸 CR；对齐 rg 会让「一个 CR 一行」变成「整个文件一行」——裸 CR 的常见来源是 ANSI 进度条日志（ADR-0008 的原案就是一个 1.14 MB 日志）。ADR-0008 当初为了保住这类文件的逐行可读性，把 read 行空间定为契约；2026-11-04 维护者重新拍板：接受这类文件退化为一行，换取全仓一个行模型（见下）。

**最终拍板（2026-11-04，决定 A）**：行空间取 rg 的 `\n` 模型——`toLF` / `normalizeContent` 只折 CRLF，不折裸 CR；删除 `hasBareCr` / `indexLineSpaces` / `readSpacePosition` 与跟空间 DRIFT 比较；ADR-0008 由新 ADR 取代。锚点内核的入口从「整串 content」改为「行号+行文本 + 文件身份」，整文件调用方保留 adapter。裸 CR 文件（ANSI 日志）在 read 里变成一行，这是已知的行为变化。三段（管道 / 行空间 / 锚点内核）全在本票做完。
