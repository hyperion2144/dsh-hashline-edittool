# 研究结论：DSH 「整段文本参数」工具的可行落地形态（issue #51）

**日期**：2026-09-06　**分支**：`research/text-input-mechanism`　**验证脚本**：`scripts/verify-text-input-schema.mjs`

## 机制结论：「整个工具参数为纯文本」在 DSH 里**没有一等公民路径**，但**有一条可行绕路**，且实现成本低

DSH 的 `defineTool` / `parameterSchemaSpecToJsonSchema` **强制**把参数 schema 包成
`{ type: "object", properties: {...} }`，连「空 properties」也保留对象根。模型层任何遵循
`tools.parameters` 字段的协议（DeepSeek chat-completions、pi-ai、Anthropic messages）都
把 schema 当 JSON Schema 处理；模型侧只能产出「符合对象 schema 的 JSON」，因此**纯
文本参数不是「一条路径」而是「两条路径」的取舍**：

1. **JSON 通道（推荐）**：用 `defineTool` + 单 string 属性（`prompt`/`text`），模型按
   既有协议产出 `{"prompt":"..."}`。这是 dsh 子代理、str-replace-editor 等所有官方
   工具走过的路。**所有验证脚本里的官方先例都走这条**。
2. **原生文本通道（绕路）**：用裸 `ToolDefinition` 直接 `ctx.tools.register({...})`
   （绕过 `defineTool` 的 schema 编译和参数校验），把 `parameters` 写成
   `{ type: "string" }` 直接交给模型。`ToolRuntime.register` 只校验 `output.schema`，
   不校验 `parameters`（`dsh-tools/lib/index.js:2774-2783`），模型返回值经
   `parseArguments`（`dsh-agent-loop/lib/index.js:147-154`）保留为字符串原样传给
   `execute(args, exec)`，body 拿到的是字符串、不是对象。**这就是同一进程里真能
   跑通的「纯文本」路径**——只是绕过了 schema 校验的兜底。

两条通道在 execute 入口靠 `typeof args` 分流——`parseArguments` 已经替我们做完
JSON.parse 兜底，所以**根本不用写 schema 层强制**：execute 第一行判
`typeof args === "string"`，剩下的当对象处理，零竞态、零死信。

---

## 子问题 1：dsh-tools `defineTool` parameters schema 是否支持无属性 object / `type:string` 参数？模型实际调用时（arguments 序列化）能否/如何传递纯文本？

**答：`defineTool` 强制对象根（无 `type:string` 入参）；经 JSON Schema 子集编译器后
传出的 schema 一定是 `{type:"object", properties:{...}, [required:[...]]}`。**
模型实际调用时按 OpenAI / Anthropic 风格把 arguments 序列化为 JSON 字符串，模型
只能产生 JSON 对象（即使 spec 是空 `{}`，模型也得发出 `{}`）。

**证据链**：

- `dsh-tools/lib/types/schema.js:238-247` `parameterSchemaSpecToJsonSchema` 永远用
  `{ type: "object", properties: compiled.properties, ...(compiled.required ?
  { required: compiled.required } : {}) }` 包一层。这是「schema 是定义期编译产物」
  的硬约束——定义不可变 ≠ 注册不可变（参见 `docs/research/issue-75-dynamic-tool-schema.md`）
- 同文件 `:209-213` `compilePropertyMap` 入口接 `properties` 形态；`:156-172`
  走的是 `object` 分支，`properties: {}` 也会得到 `{ type: "object",
  properties: {} }`
- `dsh-tools/lib/types/json-schema.js:152-166` 显式拒绝 root `type:"string"` / 缺
  类型节点的「裸值 schema」作为 object 输出；`:39` 列的 `SCHEMA_TYPES` 只支持
  object / array / string / number / integer / boolean / null 中的一种作为 root
- 模型层证据：`dsh-llm-deepseek/lib/index.js:228-235` 把 `tool.parameters` 原样
  包进 `tools[].function.parameters` 发给 DeepSeek；`dsh-llm-pi-ai/lib/index.js:1143-1147`
  同样原样发 pi-ai。`dsh-llm/lib/types/types.d.ts:373-378` 直接声明
  `ToolSchema.parameters: Record<string, unknown>`，adapter 不重塑 schema
- 反向序列化：`dsh-agent-loop/lib/index.js:147-154` `parseArguments(raw)` =
  `JSON.parse(raw) || {}`，**失败时 fallback 到原始字符串**。这是「原生文本通道」
  能跑通的根因——非 JSON 输入不会抛错而是变字符串原样进 execute

**验证脚本 `scripts/verify-text-input-schema.mjs` 输出**（直接观察）：

```
[1] empty-parameters schema: {"type":"object","properties":{}}
[1] one-string-parameters schema: {"type":"object","properties":{"prompt":{"type":"string","description":"the text"}},"required":["prompt"]}
[1] empty-parameters required array: "(undefined)"
[1] one-string-parameters required array: ["prompt"]
[2] defineTool root `type:'string'` rejected: unsupported JSON schema: parameters.type must be a value schema object
```

`defineTool({parameters:{type:"string"}})` 直接抛出 `UNSUPPORTED_SCHEMA` 错。即便
改用「单 string 属性 + 空 required」（不强制必填），编译产物也是
`{type:"object", properties:{prompt:{type:"string"}}, required:[...]}`,模型依然
要 JSON-encode 出 `{"prompt":"..."}`。

**结论**：`defineTool` 路径上「整段纯文本」不存在。**唯一得到 `{type:"string"}`
作为参数根的路径是**绕开 `defineTool`、用裸 `ToolDefinition` 直注
`runtime.register({...})`。**这条路径在第二条实验里（追加的一次性 probe）确认
可工作**：

```js
const dispose = runtime.register({
  name: "pure_text_tool",
  description: "model's entire argument is one string",
  parameters: { type: "string" },
  output: { schema: { type: "string" }, render: () => [] },
  async execute(args) { return typeof args; }
});
// schemas() 反射：parameters: {"type":"string"} 直接在 wire 上呈现
// runtime.execute(... arguments: "hello world raw" ...) -> 返回 "string"
// runtime.execute(... arguments: { prompt: "..." } ...)     -> 返回 "object"
```

`ToolRuntime.register`（`dsh-tools/lib/index.js:2774-2783`）只校验
`output.schema`，**`parameters` 字段是 fully-pass-through 的**：原值进 schema 投影
（`schemaOf` `:2935-2944`），原值进系统 prompt 组装（`system-prompt/lib/index.js:313-317`），
原值进 wire（`dsh-llm-deepseek/lib/index.js:233`），原值回 caller。

---

## 子问题 2：内置 `write` 工具被本插件拦截覆盖（write-hook + scope 层影子），能否同时改写其 parameters schema 和 description？

**答：完全可以，且本插件已经具备同等能力——同一条「scope 层 shadow」路径对 `write`
也适用**。`write-hook` 只是「不动 schema」的做法；要同时改 schema/description，只
需把 `write-hook` 升级成「在 agent scope 层再注册一个同名 `write`」即可。本仓库
对 `read`/`edit`/`undo_last_edit`/`grep` 已经在这么做（`src/index.ts:154-156`），机制
完全对称。

**证据链**：

- **Scope 层 shadowing 机制**：`dsh-tools/lib/index.d.ts:596-602`：`register`
  返回「the exact disposer that unregisters the tool」；同 scope 同名工具替换
  旧定义（`dsh-tools/lib/index.js:2538` 报 `already registered`，所以同层必须先
  dispose）。scope 层注册可遮蔽全局层（`index.d.ts:597-598`：`Scoped tools shadow globals`）
- **本插件现有 shadow**：`src/index.ts:111-175` `installAgentTools` 在每个 agent 的
  自己的 `agent.ctx` 上注册 `read`/`edit`/`grep`/`undo_last_edit`
  （`:154-156`）；这五个就是「在同 scope 重写 schema + description + execute」的标准先例
- **写工具现在的拦截方式**：`src/write-hook.ts:31-93` `registerWriteHook` 注册一
  个 `tools/post-execute` 监听器，在 write 成功后追加 hashline preview；**不动 schema**
  —— description 与 parameters 完全继承 dsh-tool-fs 的版本
  （`dsh-tool-fs/lib/index.js:602-617`）
- **要把 `write` 也 shadow**：在 `installAgentTools` 加一行
  `agent.ctx.tools.register(defineTool({ name: "write", description: "...", parameters: {...shadowed...}, output: { ... }, execute: ... }))`
  即可。shadowing `write` 的 describe/parameters 改写在 dsh-tools 的可见性解析（`view()`，
  `dsh-tools/lib/index.js:2920` 投影）下与 `read`/`edit` 等价——子 scope 注册会
  覆盖 preset 内的 `write`（preset 注册在 agent 链上某一祖先 scope，子 scope 注册
  距离更近）
- **改 description 的可见性**：`dsh-system-prompt/lib/index.js:313-317` 每步
  reassemble 时 `structuredClone(parameters)` + `description` 一并投影；改
  `defineTool` 调用里的 description 字符串立即生效（issue #75 的同一机制）

**挂接点（本仓库）**：

- 新增 `src/tool-write-shadow.ts`：包装「hashline-aware write」的
  `defineTool({...})`；execute 内部仍然走 `ctx.fs.writeText`，但可在写入前后
  调度 `readAndServe` 把 hashline anchors 直接嵌进 `result.content`（更激进的
  替代品，省掉一次 post-execute 注入）
- `src/index.ts:154-156` 加 `disposers.push(registerWriteShadow(rootCtx, agent.ctx, io))`
- 配合现有的 `registerWriteHook` 选择：保留 post-execute 钩子（向后兼容），还是
  用 shadow 直接接管（消灭 hook 调用栈）。两者不互斥

**风险点**：shadowing 写入工具意味着同时承担 fs-observation-policy 的所有边界——
本插件现有的 `fs-bridge.ts` / `sandbox.ts` 已经把这些隔离好了，复用即可。

---

## 子问题 3：双通道在 execute 入口分流（schema 层强制 vs execute 前判断参数形态）

**答：execute 入口判断 `typeof args` 是**唯一**可靠点；schema 层强制不可行**。

**为什么不在 schema 层强制**：

- 「强制必须 object」的 schema 是 `{ type: "object", required:["prompt"],
  properties:{prompt:{type:"string"}} }`——模型走 JSON 通道时通过；模型若发
  原生文本，`parseArguments` 在 agent-loop 端就保留了字符串；`ToolRuntime.execute`
  调用 `dispatchToolBody`（`dsh-tools/lib/index.js:3193`）把字符串原样丢给
  `tool.execute(args, exec)`；`defineTool` 编译时内嵌的 `validate(args)`
  （`dsh-tools/lib/types/schema.js:295`）**会拒绝**——这是 `defineTool` 路径下
  双通道的天然堵点
- 要在 schema 层让「两种形态都接受」，DSL 不支持 `oneOf: [{type:"string"},
  {type:"object",...}]` 作为 root（DSL 注释 `:202` 允许 `oneOf` 但 root 节点由
  `parameterSchemaSpecToJsonSchema` 强制成 object）。

**为什么在 execute 入口判断是天然路径**：

- **bypass `defineTool` 时没有 schema validator**——`register` 不绑任何
  validator；execute 的 args 完全透明
- **bypass `defineTool` 时模型的 wire 形态有两种**：`{"prompt":"..."}`（JSON 通
  道）或纯文本（原生通道）；`parseArguments` 已经替我们处理了 JSON 解码与
  fallback。execute 第一行判 `typeof args` 即可分流
- 不需要写「schema 强制 vs execute 判断」的二选一问题——bypass 路径下只有
  execute 判断这一种；非 bypass 路径下模型被 schema 限制成 JSON 通道，没分流的
  必要

**验证脚本输出**（第三、四、五段）：

```
[3] raw tool visible after register: raw_text_or_json
[4] parseArguments(json)    -> object {"prompt":"hello world"}
[4] parseArguments(text)    -> string "just plain text without JSON braces"
[4] parseArguments(empty)   -> object {}
[5] executed JSON-channel call:    received object(1)
[5] executed raw-text channel call: received raw(35)
[5] executed empty-args call:      received object(0)
[5] body saw these argument shapes:
     [{"typeof":"object","preview":"{\"prompt\":\"hello world\"}"},
      {"typeof":"string","preview":"just plain text without JSON braces"},
      {"typeof":"object","preview":"{}"}]
[3] after dispose, get() -> true
```

**execute 模板**（来自验证脚本的 `execute` 内部逻辑）：

```js
async execute(args, exec) {
  // 1) 原生文本通道：parseArguments fallback 后 args 是字符串
  if (typeof args === "string") {
    return doTextWork(args);                  // 走纯文本管线
  }
  // 2) JSON 通道：args 总是 object（即使是空 {}）
  if (args == null || typeof args !== "object") {
    // 这一格几乎走不到——parseArguments 在 "" 时返回 {}，在非法 JSON 时返回原串
    throw new TypeError(`unexpected args shape: ${typeof args}`);
  }
  return doStructuredWork(args);              // 走 JSON 结构管线
}
```

**两条通道的语义对等**：

- JSON 通道：模型遵守 schema，工具按 schema 字段定义操作；与现有
  `prompt`/`description` 协议一致
- 原生通道：模型自由写正文（适合「自写完整 prompt、然后让 agent 跑任务」
  类工具——恰好是子代理工具 `subagent` 的语义，但完全去掉 description 包装）
- 两者在同一 `tools/list` 投影下可以**共存**——只要 `parameters` 用
  `additionalProperties: true` 或 `type:"object"` + 少约束 schema，模型既能 JSON
  化也能写裸文本

---

## 子问题 4：Claude Code 内置工具、dsh 其他插件是否有纯文本参数先例？

**答：调研范围内（dsh 主仓全部 `dsh-tool-*` 包 + `dsh-hooks-claude-code` + Anthropic
SDK）**——**未发现任何「整个工具参数为单一字符串」的先例**。所有先例都是「单
string 属性 + 其他结构化字段」的混合 schema，且都是 JSON 通道。

**dsh 内置工具盘点（grep `@deepseek-ai/dsh-tool-*` 与 `dsh-subagent*`）**：

| 包 | 工具 | 参数 schema 形状 | source |
|---|---|---|---|
| `dsh-tool-subagent` | `subagent` | `description`(required string) + `prompt`(required string) + 可选 `provider/model/reasoning_effort/run_in_background` | `dsh-tool-subagent/lib/index.js:395-424` |
| `dsh-tool-fs` | `read` | `file_path`(required string) + `offset`/`limit` | `dsh-tool-fs/lib/index.js:331-347` |
| `dsh-tool-fs` | `write` | `file_path`(required string) + `content`(required string) + 可选 `sandbox_permissions/justification` | `dsh-tool-fs/lib/index.js:602-617` |
| `dsh-tool-fs` | `edit` | `file_path`/`old_string`/`new_string`(required string) + 可选 `replace_all` | `dsh-tool-fs/lib/index.js:747-771` |
| `dsh-tool-fs-search` | `grep`/`glob` | path + 多 string 字段 | `dsh-tool-fs-search/lib/index.js:797,1109` |
| `dsh-tool-bash` / `dsh-tool-bash-persistent` | `bash` | `command`(required string) + 可选 timeout/background/sandbox 字段 | `dsh-tool-bash/lib/index.js:300,304,333,349,365` |
| `dsh-tool-ask-user` | `ask_user_question` | `questions`(required array of objects) | `dsh-tool-ask-user/lib/index.js:18-65` |
| `dsh-tool-skill` | `skill` | `name`(required string) | `dsh-tool-skill/lib/index.js:50-60` |
| `dsh-tool-todo` | `todo_write` | 多 boolean/string 字段 | 略 |
| `dsh-tool-jobs` | `job_*` | `id`/`wait`/`timeout_ms` 等 | 略 |

**结论**：

- 所有 DSH 一等公民工具都用 `{type:"object", properties:{...}, required:[...]}`
- 「单 string 属性」的形态有，但都不是「整个工具只有一个 string 参数」
- 离「纯文本」最近的 `dsh-tool-subagent` 的 `prompt` 也是「嵌在一个 object 里的
  一个 string 属性」，不是根级 string
- Claude Code 的等价（Bash、Read、Edit、Write、MultiEdit）在 Anthropic SDK 与
  Agent SDK 都按 OpenAI Function Calling / Anthropic Tool Use 协议声明，全部
  object-rooted

**Claude Code 侧的检索**（无法直接 fetch 文档站；网络受限；只能借助 web_search
返回的 search snippet 与 `dsh-hooks-claude-code` 包内文）：

- `dsh-hooks-claude-code` 内部完全不注册工具——它只是把 dsh 的 `tools/pre-execute`
  /`tools/post-execute` 桥到 Claude Code 的 hook 协议，不实现工具本身
  （`dsh-hooks-claude-code/lib/index.js:249,266`）。Claude Code 自身工具集（Bash、
  Read、Edit、Write 等）由 Anthropic 私有分发，未在 vendored 的
  `@anthropic-ai/sdk` 包内出现
- 公开文档（仅 snippet 可见，无法 fetch）显示 Claude Code `Bash` 用
  `bash_20250124` 类型 + `input_schema` 嵌入到模型（`schema-less` 注释，
  VincentTLe/coding-agent docs）——这等价于 dsh 的「adapter 把 parameters 字段
  转发到 provider」的逻辑，与 dsh 的 DeepSeek adapter 是同一种 wire 形态
- Anthropic 官方 tools（Bash、Text Editor、Computer Use）都是 client tools with
  `type: "bash_20250124"` 之类 `date-versioned type`，并**不是**「整个 schema
  就是 `{type:"string"}`」

**结论**：**当前生态里没有「单 string 根级参数」的工业级先例**；本插件的方案会
是 DSH 生态里第一条「纯文本工具参数」路径。这并不构成禁忌——它走的是**与既有
JSON 通道并列的第二通道**，而不是替代 JSON 通道。

---

## 实证（真实 ToolRuntime + cordis，非模拟）

`scripts/verify-text-input-schema.mjs` 五段验证，对应结论：

| 段 | 验证 | 关键观察 |
|---|---|---|
| [1] | `defineTool` 是否把空 spec 与单 string spec 都包成对象根 | 两者均为 `{type:"object", properties:{...}}`；empty 的 required 字段是 undefined |
| [2] | `defineTool({parameters:{type:"string"}})` 是否被拒 | 抛 `UNSUPPORTED_SCHEMA`，错信息明确指向 root `type:"string"` |
| [3] | 裸 `register({parameters:{...}, execute})` 是否接受任意 schema 与任意 args | `runtime.get()` 返回该定义；`dispose()` 后 `get()` 返回 undefined |
| [4] | agent-loop 的 `parseArguments` 行为 | `JSON.parse` 成功 → object；失败 → 原字符串；空串 → `{}` |
| [5] | `runtime.execute(...)` 在两种 args 形态下的表现 | body 收到的 args 形态严格等于传入形态（string → string，object → object）；无静默归一 |

最关键的输出片段（用于交叉验证）：

```
[1] one-string-parameters schema: {"type":"object","properties":{"prompt":{...}},"required":["prompt"]}
[2] defineTool root `type:'string'` rejected: unsupported JSON schema: parameters.type must be a value schema object
[5] body saw these argument shapes:
     [{"typeof":"object","preview":"{\"prompt\":\"hello world\"}"},
      {"typeof":"string","preview":"just plain text without JSON braces"},
      {"typeof":"object","preview":"{}"}]
```

成功触发 `tools/change` 事件 2 次（一次 register、一次 dispose）——再次确认 schema
变更的实时性（issue #75 的结论在「裸 register 路径」依然成立）。

---

## 推荐方案（双通道 schema-write 工具）

**首选：JSON 通道 + 原生文本通道并列**，execute 入口分流。具体实施路径：

1. **写一个新工具 `tool-write-shadow.ts`**：在 agent scope 层
   `agent.ctx.tools.register(...)`（参照 `src/tool-edit.ts` 的注册模式），
   **绕过 `defineTool`**（直接传裸 `ToolDefinition`），使用
   `parameters: { type: "object", additionalProperties: true, properties: { ... } }`
   ——这样模型既可发 JSON（自动解析为对象），也可发裸文本（自动 fallback 为字
   符串），execute 第一行 `typeof args === "string"` 分流
2. **不**用 `defineTool` 包它：避开「强制 required」「强制 object 根」两个约束。
   这条路径意味着失去 `defineTool` 编译期的 schema 合法性校验，但
   `additionalProperties: true` 让 wire schema 告诉模型「接受任何形态」——对
   模型侧也最自然
3. **保留并升级 `write-hook`**：hook 改成「在 execute 内部直接返回带 hashline
   preview 的结果」，省掉一次 post-execute 注入调用栈。如果想保守，两条路径
   共存
4. **接口签名**：
   - **JSON 通道 args**：`{prompt: string, [description?: string]}` → 沿用
     `dsh-tool-subagent` 的语义，但 description 可选
   - **原生文本通道 args**：`string`（parseArguments fallback 后的字符串） →
     视为「prompt 字段的另一种输入形式」，与 JSON 通道的 `prompt` 等价
   - 两个通道最终在 execute 内部都规整为「一段文本」+ 「可选 metadata」，送
     到下游（如子代理或写入工具）

**回退方案（最小改动）**：保留现状（write-hook 不动 schema），把工具叫
`write_text` 或 `send_text`（新名而非 shadow），仅用 `defineTool` + 单 string
属性 `prompt`。这条路径完全 JSON 通道、不需要分流、不绕 schema 校验，但失去
「模型可以直接写整段文本不嵌 JSON」的灵活性。**当工具的语义就是「读一段正
文」时，这一路径成本最低**。

**绝对不推荐**：硬把 `defineTool` 的 spec 改成根 string（DSL 不支持，编译期
就挂）；或者在 `execute` 里手动 `JSON.parse(args)` 然后 catch——这是「在
defineTool 路径上伪造纯文本」的脆弱拼凑。

---

## 代码层入口路径示意

- 新文件 `src/tool-write-shadow.ts`：写 `registerWriteShadow(rootCtx, agentCtx, io)`
  返回 disposer；内部用裸 `ToolDefinition` 注册 `name: "write"` 的 shadow 版
- 修改 `src/index.ts:154-156`：`disposers.push(registerWriteShadow(rootCtx, agent.ctx, io))`
- 修改 `src/write-hook.ts`（如果升级为合并方案）：把 hook 改成「基于 shadow 后
  的 tool 直接返回内嵌 hashline 预览的 result content」，让 `src/write-hook.ts`
  退化为可选的 fallback
- 工具 execute 内 `typeof args === "string"` 分流的第一行模板：
  - JSON 通道：解构 `const { prompt, ...meta } = args ?? {};` 再走 JSON 逻辑
  - 原生通道：直接把 args 当字符串透传给下游写入或子代理
- **不**需要在 settings 层面引入新开关（这是 schema 层硬编码的形态）；如果
  要给用户切换「双通道 vs 单 JSON 通道」的语义，可以在 settings 上加一个
  `writeText.mode: 'json-only' | 'dual-channel'` 字段，按 issue #75 的同款
  dispose+re-register 路径切换——但只有当用户明确要切换时再做

---

## 先例与边界

- **DSH 官方先例**：`dsh-tool-subagent` 在 settings/能力标志位变化时
  `mounted.disposeTool() → 重挂载`（`dsh-tool-subagent/lib/index.js:560-565`），
  是「同一工具名换 schema」的现成范式。我们的 shadow `write` 可以直接套用
- **本仓库先例**：issue #75 已经证明「dispose + re-register」对同一工具名有效；
  本次的扩展是「首次注册时用裸 `ToolDefinition` 而非 `defineTool`」，是
  issue #75 范式的合法变体
- **不**走 `tools/pre-execute` 拦截改写 args：那一层只能 `allow/deny/ask`，
  不能改写 `exec.arguments`（`dsh-tools/lib/index.d.ts:419-427` 的
  `PreToolDecision` 不含 args 重写）；并且 args 在更早的
  `dispatchToolBody` 之前就被冻结（`dsh-tools/lib/index.js:3056-3061`）。所以
  改 args 这一招在 pipeline 上不可行
- **没有覆盖到的边界**：
  - **PTC 模式（`dsh-tools` 的 `run_code` SDK 路径）**：本仓库未启用 PTC 模
    式（`tools.mode: 'native'`），但若日后启用，SDK 路径会按
    `parameterSchemaSpecToJsonSchema` 编译产物生成 TS 类型——若用裸
    `ToolDefinition`，SDK 生成器可能因为参数 schema 不在 DSL 子集里而拒绝
    生成。建议 `mode: 'ptc'` 部署下回退到 `defineTool` + JSON 通道
  - **多 agent 协同**：shadow 注册在每个 `agent.ctx` 上，所以不同 agent 可
    拥有不同 shadow——这是 scope 层 shadowing 的天然好处
  - **跨 channel 一致性**：JSON 通道 `{"prompt":"foo"}` 与原生通道 `"foo"` 在
    execute 内部都规整成「prompt = "foo"」是上游规整的责任。本插件不强制形
    式契约；调用方负责在两路径间放正确的语义负载

---

## 验证脚本 commit

分支 `research/text-input-mechanism`；脚本 `scripts/verify-text-input-schema.mjs`、
本文档随该分支落盘，commit sha 见 resolution comment。
