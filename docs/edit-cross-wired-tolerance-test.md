# Edit 工具 Cross-Wired 容忍性测试报告

## 测试目的

验证 `require_line_content` ON 模式下，`edits[i].anchor_start` / `anchor_end` 的 `{ anchor, line }`
声明对**字段串位（cross-wired）** 的容忍性 —— 即当模型把整行 read/diff marker 直接拷贝进
声明对时，runtime 是否会自动剥离冗余前缀/后缀而不至于 reject edit。

## 测试环境

- **时间**：2025-09-07
- **工具**：本地 dsh edit 工具（`dsh-hashline-edittool`）
- **模式**：`require_line_content = ON`（当前 session 默认）
- **目标文件**：`.test/sample.txt`
- **关键源码**：
  - `src/contract.ts:148-197` — `assertAnchorField` 声明对形态校验
  - `src/declaration.ts:42` — `MARKER_PREFIX` 正则
  - `src/declaration.ts:55-61` — `declaredLineMatches` 两阶段比对

## 初始状态

`.test/sample.txt` 经前序编辑后共 4 行（read 拿到的 anchor）：

```
1:A7|这是一个测试文件。
2:ZA|插入的新首行（测试 ins）
3:d6|第二行已被修改！
4:WT|第三行：Hello Hashline!
```

## 测试用例与结果

### Case 0：基线对照（干净字段）

```jsonc
{
  "op": "replace",
  "anchor_start": { "anchor": "wL", "line": "第三行：Hello World!" },
  "lines": ["第三行：Hello Hashline!"]
}
```

- **结果**：✅ 成功
- **警告**：无

### Case 1：anchor 字段带 `|内容` 后缀

```jsonc
{
  "op": "replace",
  "anchor_start": {
    "anchor": "WT|第三行：Hello Hashline!",
    "line":   "第三行：Hello Hashline!"
  },
  "lines": ["第三行：Case1 OK"]
}
```

- **结果**：✅ 成功，第 4 行被替换
- **警告**：`[E_BAD_REF] stripped trailing content — using "WT"` x2
- **剥离行为**：`anchor` 字符串里的 `|` 之后内容被剥掉，剩 `"WT"`

### Case 2：line 字段带 `<line>:<anchor>|内容` 前缀

```jsonc
{
  "op": "replace",
  "anchor_start": {
    "anchor": "kA",
    "line":   "4:kA|第三行：Case1 OK"
  },
  "lines": ["第三行：Case2 OK (line 字段带了锚点前缀)"]
}
```

- **结果**：✅ 成功
- **警告**：无
- **剥离行为**：`line` 字段前缀 `4:kA| ` 被 `MARKER_PREFIX` 静默剥掉

### Case 3：两字段同时 cross-wired（最极端场景）

```jsonc
{
  "op": "replace",
  "anchor_start": {
    "anchor": "NN|第三行：Case2 OK (line 字段带了锚点前缀)",
    "line":   "4:NN|第三行：Case2 OK (line 字段带了锚点前缀)"
  },
  "lines": ["第三行：Case3 OK (两边都 cross-wired)"]
}
```

- **结果**：✅ 成功
- **警告**：仅 `[E_BAD_REF] stripped trailing content` x2（**只针对 anchor 字段**）
- **剥离行为**：两套剥离规则独立生效 —— `anchor` 字段剥 `|...` 后缀发 warning，
  `line` 字段剥 `<line>:<anchor>| ` 前缀静默无 warning

## 剥离规则小结

runtime 对 `{ anchor, line }` 声明对的两套独立剥离机制：

| 字段 | 触发形态 | 剥离规则 | 行为 |
|---|---|---|---|
| `anchor` | 含 `\|` 之后内容 | 剥到第一个 `\|` 前 | 发 `[E_BAD_REF]` warning，edit 仍应用 |
| `line` | 含 read/diff marker 前缀 | `MARKER_PREFIX = /^[ \t]*(?:\d+:)?[A-Za-z0-9]{2,4}\| ?/` 静默匹配 | 无 warning，纯透明剥离 |

**`MARKER_PREFIX` 容忍的前缀形态**：
- 任意前导空白（`[ \t]*`）
- 可选的 `<line>:` 行号段（如 `4:`）
- 2-4 字符的 anchor（v2.0 "2 位起步" 规则）
- 管道符 `|`
- 可选的单个空格

**额外的两阶段比对**（`declaredLineMatches`）：
1. **阶段 1**：verbatim 比对，仅 trim 尾部空白 —— 一行真实内容若长得像 marker 行，
   在此阶段已经匹配，剥前缀永远不会误触发
2. **阶段 2**：剥前缀后再次比对 —— 触发的是剥离的**全部价值**

## 局限与边界

- `line` 字段前缀中的 anchor 必须 **2-4 字符** 才被识别为 marker；1 字符 anchor
  （虽然 v2.0 后极少出现）会被当作内容保留，与实际行不匹配时触发 `[E_CONTENT_MISMATCH]`。
- `anchor` 字段剥离会发 `[E_BAD_REF]` warning —— 这是有意的提醒，让模型意识到
  自己塞了多余内容；模型应在新一轮 edit 时使用干净的 anchor 字符串。
- 两套剥离**不会递归** —— `line` 字段剥前缀后不会再剥后缀；如果模型同时把
  `line` 字段既带前缀又带 `|...` 后缀且实际行不在两端，结果会不匹配。

## 结论

✅ **Cross-wired 容忍机制双向、独立、可靠**：当模型把 read 行（含 anchor + 管道符 + 内容）
误贴到 `{ anchor, line }` 声明对的任一字段时，runtime 都能自动剥离并正常应用 edit，
不会因为字段串位而 reject。两条剥离规则**互不耦合**：anchor 字段的发 warning，
line 字段的静默；同时发生也各自生效。

这降低了模型在高频 read+edit 循环中的失误成本 —— 即使模型贪图方便直接拷贝整行
read marker，也不会因此中断编辑流。
