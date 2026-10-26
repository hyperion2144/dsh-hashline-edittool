# DSH 删除接缝与沙箱一致性

> 取证笔记（2026-10-25）。范围只回答三件事：`ctx.fs` 有没有删除能力；绕过它走
> `node:fs` 时怎样才与 dsh 的沙箱语义一致；`delete` 工具该怎样探测能力、拒绝什么、
> 测什么。不设计工具文案与 UI。
>
> 取证手段：本机装机包
> `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`（运行中 **0.2.1-rc.3**）
> 内的 `@deepseek-ai/dsh-fs*` / `dsh-sandbox*` / `dsh-tool-fs` 等；仓内
> `node_modules/@deepseek-ai/*`（devDependencies **0.2.0-rc.2**）；官方
> `deepseek-ai/deepseek-harness` 的 `docs/` 与包 README（master，2026-10-25 抓取）；
> Node / POSIX / Windows 一手文档。**app.asar 未解包到仓库**，只按需取出单个文件到
> `/tmp` 阅读（读完清理）。**未做任何删除行为的真机复现**，平台错误码来自 OS/Node 文档。
>
> 版本差异：装机包 0.2.1-rc.3、仓内 devDependencies 0.2.0-rc.2。删除相关结论两版一致；
> 逐条标注证据取自哪一版。`app.asar` 内的行号是 asar 条目原始内容的行号。

## 结论（先给，3–6 条）

1. **`ctx.fs` 没有任何删除能力——类型面、事件面、实现面都缺，没有可汇报的方法名与签名。**
   `FileSystem` 只有 15 个方法和 1 个 getter（`watch`/`sandboxMode`/`resolve`/
   `processPath`/`processPathFromHostPath`/`fileUrl`/`contains`/`stat`/`lstat`/`readText`/
   `streamText`/`readBytes`/`readByteRange`/`listDir`/`writeText`/`editText`），没有
   `remove`/`unlink`/`delete`；`fs/*` 事件只有 `fs/write-intent`、`fs/edit-intent`、
   `fs/observed`；`FsErrorCode` 闭集没有删除错误码；官方 README 的 Known Limitations 直接写
   "No delete, rename, or copy"。最接近的只有只读的 `lstat`/`stat`。
2. **DSH 里唯一的删除通道是 shell（subprocess 例外）。** 模型面向工具集没有 delete
   （`dsh-tool-fs` 只有 `read`/`read_image`/`write`/`edit`），而 `bash`/`pwsh` 的工具描述
   自己教模型"删除或移动前先核对解析后的绝对路径"。删除由子进程做，边界交给
   `ctx.sandbox` 的内核级 runner，不是 `ctx.fs`。
3. **本地后端能把删除目标还原成宿主真实路径，但这不是契约保证。**
   `fs-local` 的 `resolve` 用 realpath 建身份（缺失时 realpath 最近存在祖先 + 拼回后缀），
   `processPath` 就是 `targetKey`（realpath），`processPathFromHostPath` 对绝对路径做纯词法
   `resolve`（无 I/O），`contains` 用两侧 `processPath` 的 `relative` 判定，`lstat` 是不跟随
   末段的路径探针。`fs-sandbox` 不覆盖这四者，只给 `writeText`/`editText` 套模式围栏；
   远程后端（`dsh-fs-ssh`）的 `processPath` 是**远端命名空间**、`processPathFromHostPath`
   返回 `undefined`——这是能力探测的关键判据。
4. **沙箱语义可逐字复用，围栏必须自己重建。** `sandboxPolicy.resolve()` 的优先级是
   "已批准显式 mode > session override > 部署 default（默认 `read-only`）"；`workspaceRoot`
   取 session 不可变 cwd；`workspace-write` 的可写根是 `writableRoots(policy)` =
   `workspaceRoot` + `/tmp` + `os.tmpdir()`（全部 realpath 去重）。`fs-sandbox` 只在 write/edit
   里调 `checkedTarget`，所以 `node:fs.unlink` **完全绕过**它；delete 必须自己用同一组
   `writableRoots`/`canonicalPath` 语义做围栏。
5. **approval/escalation 机制与操作种类无关，可以复用；但它只解决"批准"，不解决"执行"。**
   `approveEscalation` 只看 mode 阶梯（更宽才要审批）与审批结果，subject 词就是
   "operation"；`dsh-tools` 的 `tools/pre-execute` 也能对任意工具返回 `ask`（没有审批通道时
   fail-closed）。delete 需要自己把批准后的 mode 施加到 unlink 前的检查上。
6. **删除后的状态回收接口只完成了一半。** `HashStore` 已有 `deleteUndo(path)`、
   `deleteServed(sessionKey, path)`、`deleteServedByPath(path)`，但"单路径四表级联"
   （undo + served + anchor_meta + anchor_lines）只存在于 sweep 内部和全库 `pruneMissing()`，
   没有公开 API；`fs-observation-policy` 的 observed 状态按 `(session, targetKey)` 存在
   WeakMap 里，只能用一次 `fs/observed` absent 覆盖本会话。

## 证据（逐条：结论 + 证据来源路径/URL + 行号或片段说明）

### 问题 1：`ctx.fs` 是否提供删除/移除文件的能力或事件

#### E1. 类型面：没有删除方法

**结论**：`FileSystem` 抽象类的方法清单里不存在任何删除/移除原语。

**证据**：`node_modules/@deepseek-ai/dsh-fs/lib/types/index.d.ts`（0.2.0-rc.2；装机包
0.2.1-rc.3 的 `lib` 只有 JS，但 README 与实现同一套接口）。

| 成员 | 行 | 成员 | 行 |
| --- | --- | --- | --- |
| `watch` | 71 | `stat` | 138 |
| `get sandboxMode` | 84 | `lstat` | 153 |
| `resolve` | 94 | `readText` / `streamText` | 162 / 172 |
| `processPath` | 106 | `readBytes` / `readByteRange` | 183 / 197 |
| `processPathFromHostPath` | 115 | `listDir` | 208 |
| `fileUrl` | 123 | `writeText` | 221 |
| `contains` | 131 | `editText` | 235 |

该文件 61–238 行是完整类体，没有第 17 个成员。`FsErrorCode` 是闭集，同样没有删除语义
（`lib/types/types.d.ts:162`：`FS_NOT_FOUND | FS_NOT_DIRECTORY | FS_NOT_TEXT |
FS_NOT_REGULAR_FILE | FS_TOO_LARGE | FS_PERMISSION_DENIED | FS_SANDBOX_DENIED | FS_IO_ERROR |
FS_STALE_VERSION | FS_NOT_OBSERVED | FS_AMBIGUOUS_EDIT | FS_EDIT_NOT_FOUND | FS_ABORTED`）。

#### E2. 事件面：没有 `fs/delete-intent`、`fs/remove`

**结论**：文件系统策略只认写与编辑两种决策，以及一次观察记录；删除没有决策事件。

**证据**：
- `lib/types/index.d.ts:28,36,52`：仅 `'fs/write-intent'`、`'fs/edit-intent'`、`'fs/observed'`。
- `lib/invariant.js`（0.2.0-rc.2）对 `internal/dispatch` 的检查只放行这三个事件名。
- 对装机包整体做字节级 grep：`fs/delete-intent`、`fs/remove`、`fs/delete`、`fs/unlink`、
  `FS_DELETE`、`delete-intent` 命中次数均为 **0**（`app.asar`，2026-10-25）。
- 官方文档 `docs/subsystems/filesystem.md:278` 列举 provider 原语时同样止于
  `writeText`/`editText`（master；
  <https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/filesystem.md>）。

#### E3. 实现面：本地后端的 `rm` 只清自己的 staging 目录

**结论**：`fs-local` 里唯一的删除调用是原子写实现清理自己创建的临时目录，不是用户文件删除。

**证据**：装机包 `@deepseek-ai/dsh-fs-local/lib/index.js`（0.2.1-rc.3）：
- `524`：`removeStagingDir = internals.removeStagingDir ?? ((path) => rm(path, {recursive:true, force:true}))`；
- 该函数只在 `writeFileAtomic`（`512` 起）发布/失败路径上清理 `.<name>.<pid>.<uuid>.tmpdir`；
- `writeText`（`864`）/`editText`（`883`）都没有 unlink 分支。
- 装机包 README：`packages/fs/fs/README.md:115`（master 同文同号）——
  "**No delete, rename, or copy**"。

#### E4. 文档面：文件接缝被明确声明为"无删除"，模型工具集也没有 delete

**结论**：官方把"无删除"写进能力边界；模型只能通过 shell 删除。

**证据**：
- `docs/subsystems/filesystem.md:278`（同上）。
- `packages/fs/tool-fs/README.md:44-51`：The tools 表只有 `read` / `read_image` / `write` / `edit`
  （<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/fs/tool-fs/README.md>）。
- `docs/tool-catalog.md:699`（bash）与 `:787`（pwsh）的工具描述：
  "Before any delete or move, verify that the resolved absolute target path is the intended one"
  （<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/tool-catalog.md>）。
- 同一 catalog 的 `## ` 包清单里没有任何 `dsh-tool-delete` / `dsh-tool-rm`；装机包
  `node_modules/@deepseek-ai/` 的 308 个包里也只有 `dsh-tool-fs`（read/write/edit）与
  `dsh-tool-str-replace-editor`（其 `lib/index.js` 无 delete/unlink 字样）。

**类型面与实现面各缺什么**（直接回答"如果没有"）：
- 类型面：与 `writeText`/`editText` 同级的 `delete` 方法签名（`expected` 版本守卫、
  `sandboxPolicy` 参数、outcome 类型）；`fs/delete-intent` 事件与决策形状；`FsErrorCode` 里
  的删除错误码（`FS_NOT_EMPTY`/`FS_DELETE_*` 类）；`FsWriteIntent` 之外的删除守卫词汇。
- 实现面：`fs-local` 的 realpath 身份删除；`fs-sandbox` 的 `checkedTarget` 删除围栏；
  `fs-observation-policy` 的删除守卫与 absent 记录；`dsh-tool-fs` 的模型工具与 schema；
  `dsh-fs`/`fs-local`/`fs-sandbox`/`tool-fs` 的文档与错误映射；本仓 `delete` 的 store 回收。

#### E5. `ctx.fs` 之外只有两条删除路径，且都不受 `ctx.fs` 围栏约束

**结论**：(a) 走 `ctx.shell` 的 `rm`/`Remove-Item`，由 `ctx.sandbox` 的内核级 runner 兜底；
(b) 宿主插件直接 `node:fs/promises.unlink`，本身完全没有围栏。DSH 自己的插件用过 (b)
（`dsh-attachment-local`、`dsh-spill-local`），但删的都是 DSH_HOME/临时目录，不是工作区文件。

**证据**：
- `dsh-bash-sandbox/README.md:39`：`workspace-write` 的写效果是
  "workspace root plus `/tmp`"；`:125` 说明它通过 `sandbox_permissions` 升级。
- `dsh-sandbox-local/README.md:79`：Seatbelt 用 `(deny file-write*)` + `writableRoots` 的
  allow-list；这是内核边界，而 `fs-sandbox` 的围栏是进程内策略检查（见 E12）。
- 装机包 `dsh-attachment-local/lib/index.js:547,567` 与 `dsh-spill-local/lib/index.js:247-305`
  直接 `unlink`/`rm`；两者都不拿 `SandboxExecutionPolicy`。
- `@deepseek-ai/dsh-shell` README:12/28：`ctx.shell.execute(spec)` 是命令seam，模型工具
  `bash`/`pwsh` 自己拥有沙箱指引——文件接缝与命令接缝是两套边界。

### 问题 2：绕到 `node:fs/promises.unlink` 时，怎样才与 dsh 沙箱语义一致

#### E6. `resolve()`：realpath 身份 + 缺失路径的祖先回填

**结论**：`resolve` 对已存在路径取 realpath 作 `targetKey`；对缺失路径 realpath **最近的
存在祖先**再拼回缺失后缀；空/空白路径直接 `FS_NOT_FOUND`。`displayPath` 是绝对拼写
（不一定是 canonical），`targetKey` 是 canonical，且契约要求消费者不得解析它。

**证据**：装机包 `dsh-fs-local/lib/index.js`：`169` 起 `resolveLocalTarget`，`175`
`FsTargetKey(await realpath$1(displayPath))`，`186` 祖先 realpath、`193-196`
`join(realAncestor, ...missing)`；`154-160` `localDisplayPath` 负责 cwd/相对路径/`..` 的拼写；
`780-788` `resolve()` 只做这两步。仓内 0.2.0-rc.2 的 `lib/types/index.d.ts:86-97` 是同一契约
（"May perform I/O … a remote/sandboxed backend may need a round-trip"）。
`dsh-fs-local/README.md:73`：`targetKey` 是 `realpath`，"writes land on the link target
while preserving the link"。

#### E7. `processPath()`：本地后端返回宿主真实路径；远程后端返回远端命名空间

**结论**：`processPath` 的契约是"subprocess 能打开的 canonical 绝对路径"，不承诺是宿主路径。
本地实现就是 `String(target.targetKey)`，即 realpath；SSH 后端则明确是远端命名空间，
且 `processPathFromHostPath` 返回 `undefined`。

**证据**：
- 装机包 `dsh-fs-local/lib/index.js:789-790`：`processPath(target) { return String(target.targetKey); }`。
- 公开文档 `packages/ssh/fs-ssh/README.md:30`：
  "`processPath()` and `fileUrl()` name files in that same remote namespace; they do not grant
  host-side access. … `processPathFromHostPath()` returns `undefined`"
  （<https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/ssh/fs-ssh/README.md>）。
- `docs/subsystems/ssh.md:9`：文件身份、cwd、sandbox 根、file URL 都指向 SSH 主机。
- `lib/types/index.d.ts:98-115`（0.2.0-rc.2）：`processPath` 与 `processPathFromHostPath`
  的契约原文；基类默认 `processPathFromHostPath` 返回 `undefined`（`lib/index.js:95`）。

#### E8. `processPathFromHostPath()`：本地是纯词法映射，不是身份证明

**结论**：`fs-local` 的实现是同步的 `isAbsolute(hostPath) ? resolve(hostPath) : undefined`，
没有 I/O、没有存在性检查、没有 dev/ino 校验。因此它只能回答"这个后端的世界是否包含该宿主
路径（按拼写）"，不能证明两个路径是同一个文件。用它做删除前的能力探测时必须配合
`processPath` 相等性（或更强的身份比较）。

**证据**：装机包 `dsh-fs-local/lib/index.js:792-794`；契约 `lib/types/index.d.ts:107-115`
（"Map an absolute path from the harness host into this filesystem's execution world when both
paths identify the same file… The base provider exposes no mapping"）。注意契约说"same file"，
本地实现因为整个世界就是宿主，故退化为词法映射。

#### E9. `contains()`：两侧 `processPath` 的路径包含判定

**结论**：`contains(parent, child)` 用 `relative(processPath(parent), processPath(child))` 判定：
相等或后代为 true；跨盘符（Windows 上 `relative` 返回绝对路径）为 false。两侧 target 必须
来自同一 provider。因为 `processPath` 是 realpath，symlink 祖先已经被解析成同一身份。

**证据**：装机包 `dsh-fs-local/lib/index.js:798-801`；契约 `lib/types/index.d.ts:124-131`。
`fs-sandbox` **没有**覆盖 `contains`（`dsh-fs-sandbox/lib/index.js` 全文只有
`writeText`/`editText`/`checkedTarget` 三个方法 + 模块级 `isPathUnder`），所以沙箱后端也按
宿主真实路径判定包含关系。

#### E10. `lstat()`：路径形状、不跟随末段、能报 `symlink`

**结论**：`lstat(path, {cwd})` 先按 `localDisplayPath` 得到绝对拼写，再对**该拼写**做
no-follow 探测；类型是 `file | directory | symlink | other`，缺失返回 `undefined`。它和
`resolve` 是两套形状：`resolve` 跟随链接产出身份，`lstat` 让消费者在跟随之前拒绝路径本身。
`fs-sandbox` 不限制读/元数据，所以对工作区外的 `lstat` 也能成功。

**证据**：装机包 `dsh-fs-local/lib/index.js:813-827`（`probeNoFollow(localDisplayPath(...))`）、
`253-262`（`probeNoFollow`，`pathLinkType` 报 `symlink`）；契约
`lib/types/index.d.ts:139-155` 与 `lib/types/types.d.ts:76-88`（`FsPathInfo.type` 含
`symlink`，注释明说这是给"trust-boundary rules"用的）。`dsh-fs-sandbox/README.md:50`：
"Reads, listings, metadata, and read-only watches work exactly as with `fs-local`; the mutation
fence does not restrict observation."

#### E11. 符号链接陷阱：同一个 `processPath` 对活链接与悬空链接指向不同东西

**结论**：这是 delete 必须显式处理的坑。**活链接**：`resolve` 的 realpath 成功 ⇒
`processPath` 是**链接目标**的路径，`unlink` 会删目标、留下悬空链接。**悬空链接**：
realpath `ENOENT` ⇒ 祖先 realpath + 链接名 ⇒ `processPath` 是**链接本身**的路径，`unlink`
会删链接。两情形下"删 processPath"的语义不一致，而写出/编辑的语义是"跟随链接、保留链接"。

**证据**：装机包 `dsh-fs-local/lib/index.js:169-207`（realpath 成功 vs 失败回填两条分支）；
`dsh-fs-local/README.md:73`（realpath 身份、写落到链接目标）；POSIX `unlink(2)` 与 Windows
`DeleteFileW` 都规定"参数是链接时删链接"（见 E16/E17）——所以差别完全来自我们传的是不是
已被 realpath 的路径。

#### E12. `ctx.sandboxPolicy.resolve()` 的三种模式与 `workspaceRoot` 边界

**结论**：`resolve({session?, mode?})` 返回 `{mode, workspaceRoot, sessionId?}`，优先级
"显式已批准 mode > session override > 部署 default"；部署 default 的 fail-safe 是
`read-only`。`workspaceRoot` 取 session 的不可变 `cwd`，否则部署 fallback；它只校验"必须是
绝对执行世界路径"，**保留拼写不 realpath**——realpath 由执行侧（`writableRoots` →
`canonicalPath`，或 `fs-sandbox` 的 `isPathUnder`）完成。session override 存在 session log
的一条 `sandbox/mode` 事件里。

**证据**：
- 装机包 `dsh-sandbox-policy/lib/index.js:141-148`（`mode = request.mode ?? overrideOf(session)
  ?? defaultMode`；`workspaceRoot = resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot)`；
  `sessionId` 随行）；`:67-70`（`resolveWorkspaceRoot`：非绝对即 throw，原样返回）；
  `:154-156`（`overrideOf` 读 `sandboxMode` projection）。
- 仓内 0.2.0-rc.2 `lib/types/index.d.ts:50-55`（`SandboxPolicyRequest`：session 的不可变
  cwd 就是边界，显式已批准 mode 覆盖会话策略）、`:88`（`resolve` 签名）、`:33-38`（默认
  `read-only` 的 fail-safe 说明）。
- `dsh-sandbox/lib/types/index.d.ts:19`（`SandboxMode` 三值）、`:27-40`
  （`SandboxExecutionPolicy`）、`:55-58`（`SandboxPolicy` 只允许 confined 两值）。

#### E13. `writableRoots()`：`workspace-write` 的真实可写集合，`fs-sandbox` 正是这么围的

**结论**：`workspace-write` 的可写根 = `workspaceRoot`、`/tmp`、`os.tmpdir()`，经
`canonicalPath`（realpath，失败保留原拼写）去重；`read-only` 返回空；
`danger-full-access` 不参与。`fs-sandbox` 的 `checkedTarget` 正是：`danger-full-access` 原样
放行、`read-only` 直接 `FS_SANDBOX_DENIED`、`workspace-write` 先**重新 resolve** 再对
`fresh.targetKey` 逐个 `isPathUnder(root)`，并用重新解析出来的 target 去写（check-here-write-there
的 TOCTOU 收窄）。注意它判定的是 `targetKey`（真实路径），不是 `contains()`。

**证据**：
- 装机包 `dsh-sandbox/lib/index.js:150-155`（`canonicalPath`）、`:166-173`（`writableRoots`）。
- 装机包 `dsh-fs-sandbox/lib/index.js:153-166`（`checkedTarget`），`:53-65`（`isPathUnder`：
  词法快路径 + 逐级祖先 inode 同一性回退，用于 Windows 8.3/大小写别名）。
- `dsh-fs-sandbox/README.md:46`（三模式语义）、`:75`（re-canonicalize + `writableRoots`）、
  `:79`/`:123`（残留 TOCTOU 是**已知且接受**的，围栏不是内核边界）。
- `dsh-sandbox/lib/types/roots.d.ts` 的 `writableRoots` 文档：`/tmp`、`os.tmpdir()`、
  以及 `/tmp` 在 darwin 上就是 `/private/tmp`，所以必须 realpath。

#### E14. `fs-sandbox` 只围栏 `writeText`/`editText`——删除完全绕过

**结论**：`SandboxedFileSystem` 继承 `LocalFileSystem`，只覆盖两个 mutation；`processPath`、
`contains`、`lstat` 全部继承。因此 `node:fs.unlink(processPath(target))` 在
`workspace-write`/`read-only` 下都不经过任何 dsh 策略检查。delete 工具必须自己重建
E13 的围栏。

**证据**：装机包 `dsh-fs-sandbox/lib/index.js:103`（`class SandboxedFileSystem extends
LocalFileSystem`）、`:104`（`static inject = ["sandboxPolicy"]`）、`:125-141`（只有
`writeText`/`editText` 调 `checkedTarget`）；`dsh-fs-sandbox/README.md:12`（"preserving the
local filesystem's read behavior"）。`fs-local` 的 `processPath`/`contains`/`lstat` 见
E7/E9/E10。

#### E15. approval/escalation 与操作种类无关，但与"执行面"绑定

**结论**：`approveEscalation` 只判断"重复当前 mode 免审批 / 严格更宽才要审批 / 缺审批通道
或 agent 直接 throw / 四种 outcome 映射"；subject 是自由文案（fs 家族传 `"operation"`）。
`dsh-tools` 的 `tools/pre-execute` 也支持对任意工具返回 `{kind:'ask'}`，没有审批服务/agent
时 fail-closed。**可复用**的是这套词汇、mode 阶梯和审批编排；**不可复用**的是 enforcement：
`fs-sandbox` 没有删除入口，批准后的更宽 mode 必须由 delete 工具自己施加到 unlink 前的围栏。

**证据**：
- 仓内 0.2.0-rc.2 `dsh-sandbox/lib/types/escalation.d.ts:25`（`WIDER_MODES`）、`:34`
  （`ESCALATION_TARGETS`）、`:43`（`validateEscalationArgs`）、`:52`/`:62`（denial marker /
  hint）、`:84-101`（`EscalationApprover`）、`:142`（`approveEscalation`）。
- 装机包 `dsh-sandbox/lib/index.js:30-33`（阶梯：`read-only → workspace-write|danger-full-access`；
  `workspace-write → danger-full-access`）、`:99-130`（`mode === effectiveMode` 直接返回；
  否则要求严格更宽 + approver + agent，`allowed-once` 才放行）。
- 仓内 `dsh-tools/lib/types/index.d.ts:40-48`（`tools/pre-execute` 文档：`ask` 在无审批支持时
  变成拒绝）、`:445-455`（`PreToolDecision` 含 `ask`）；实现
  `dsh-tools/lib/index.js:3439-3470`（无 `approval` 或 `agent` 时返回 deny）。
- `docs/subsystems/approval.md:5`：调用方"fail closed unless it is `allowed-once`"。
- 本仓已有的复用先例：`src/infra/sandbox.ts:50-64`（`FsSandboxController` 用
  `ctx.fs.sandboxMode` 决定是否广告升级字段）、`:106-149`（`resolvePolicy` 调
  `approveEscalation`，subject `"operation"`）、`:150-163`（`FS_SANDBOX_DENIED` →
  `[sandbox: …]` marker + hint）。

#### E16. 删除后的状态回收：仓内 hash-store 已有三块，缺一块级联

**结论**：`HashStore` 的公开面有 `deleteUndo(path)`、`deleteServed(sessionKey, path)`、
`deleteServedByPath(path)`；"一次清掉一个 path 的四张表"只以私有 `deletePathCascade`
（sweep 内）和全库 `pruneMissing()` 的形式存在，没有公开的单路径 API。观察策略的
observed 状态按 `(session, targetKey)` 存 WeakMap，只有 `fs/observed` 能覆盖本会话；
没有"按 path 清所有会话"的接口。

**证据**：
- 仓内 `src/domain/session/hash-store.ts:220`（`allKnownPaths` 注释：undo ∪ served ∪
  anchor_meta）、`:238`（`deleteUndo`）、`:261-262`（`deleteServed`/`deleteServedByPath`）、
  `:283`（`pruneMissing`）、`:1067-1072`（sweep 的私有四表级联：`undoDelete`、
  `servedDeletePath`、`anchorMetaDelete`、`anchorLinesDeletePath`）、`:1327-1339`
  （`pruneMissing` 对全库 `allKnownPaths` 做同样四步）。
- `src/domain/edit/undo-edit.ts:130-137`：`clearUndo(path)` 的语义就是"外部写清空 undo 链"。
- 装机包 `dsh-fs-observation-policy/lib/index.js:22`（`WeakMap<owner, Map<targetKey,
  observation>>`）、`:29-30`（owner = `actor?.agent?.session`）、`:51-75`（write/edit intent 与
  `observe`）、`:90-94`（三个事件监听）。
- 仓内 `src/infra/fs-bridge.ts:276-281`（`ctxFsIO.resolve` 返回 `fs.processPath(target)`——
  store 的 path 键就是 processPath）、`:330`/`:351`（`emitObserved`/`emitAbsent` 已有实现）。
- `README.md:385` 起（Store 段）：anchor/served/undo 同一 SQLite、按 workspace 分库；
  `README.md:338` 起（错误码表）。

### 问题 3：平台失败语义

#### E17. POSIX `unlink(2)`

**结论**：参数是符号链接时删链接本身；目录给 `EISDIR`（Linux）；父目录无写权限 `EACCES`；
只读文件系统 `EROFS`；不可变/append-only 文件、sticky 目录等给 `EPERM`；`EBUSY` 用于挂载点
等。删除成功后，仍打开该文件的进程继续持有 inode，直到最后一个 fd 关闭。

**证据**：<https://man7.org/linux/man-pages/man2/unlink.2.html>（NAME/DESCRIPTION/ERRORS；
2026-10-25 抓取）。引文："If the name referred to a symbolic link, the link is removed."；
"EISDIR path refers to a directory."；"EACCES Write access to the directory containing path is
not allowed…"；"EROFS path refers to a file on a read-only filesystem."

#### E18. Windows `DeleteFileW`

**结论**：只读属性 → `ERROR_ACCESS_DENIED`（须先去掉只读属性）；有其他句柄打开（未用
`FILE_SHARE_DELETE`）→ 失败；路径是符号链接 → 删链接、不删目标；文件"标记删除"，最后一个
句柄关闭才真正消失。

**证据**：<https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-deletefilew>
（Remarks；2026-10-25 抓取）。引文："If the file is a read-only file, the function fails with
**ERROR_ACCESS_DENIED**."；"The **DeleteFile** function fails if an application attempts to
delete a file that has other handles open for normal I/O or as a memory-mapped file
(**FILE\_SHARE\_DELETE** must have been specified…)"；"If the path points to a symbolic link, the
symbolic link is deleted, not the target."

#### E19. Node 的两层封装：`fs.unlink` 与 `fs.rm`

**结论**：`fs.unlink` 只删文件/符号链接，**不能删目录**；`fs.rm` 可删文件与目录（`recursive`），
`force` 只忽略"不存在"，`maxRetries`（针对 `EBUSY`/`EMFILE`/`ENFILE`/`ENOTEMPTY`/`EPERM`）
**只在 `recursive: true` 时生效**。因此单文件删除走 `unlink`，不要用 `rm` 伪装成"更强"。

**证据**：Node 文档（2026-10-25 抓取，master `doc/api/fs.md`）：
- <https://nodejs.org/api/fs.html#fspromisesunlinkpath>："Asynchronously removes a file or
  symbolic link."（raw L2260 起）；
- <https://nodejs.org/api/fs.html#fsunlinkpath-callback>："`fs.unlink()` will not work on a
  directory, empty or otherwise."（raw L5328-5369）；
- <https://nodejs.org/api/fs.html#fspromisesrmpath-options>："Removes files and directories
  (modeled on the standard POSIX `rm` utility)."；`maxRetries` 段："This option is ignored if the
  `recursive` option is not `true`."（raw L2149-2166）。

## 对 `delete` 工具的设计含义（推荐方案 + 拒绝条件 + 错误类型）

### 推荐方案（短中期：宿主侧 unlink + 自建围栏；长期：给 `ctx.fs` 补缝）

长期正确解是上游给 `dsh-fs` 加 `delete(target, signal?, sandboxPolicy?)` + `fs/delete-intent`
+ 沙箱后端实现——但那要动契约、两个后端、策略与文档。在它落地前，delete 工具只能在宿主侧
`unlink`，并且必须**逐项复刻** E6–E15 的语义。推荐流程：

1. **入口先 `lstat`（路径形状，不跟随末段）**：`info = await fs.lstat(path, {cwd})`。
   - `undefined` → `[E_NOT_FOUND]`（不 purge，或只做无害的 stale purge）；
   - `directory` → `[E_IS_DIRECTORY]`，**不做 recursive**；
   - `other` → `[E_NOT_REGULAR_FILE]`；
   - `symlink` → `[E_SYMLINK]`（默认拒绝，理由见 E11；若要支持"删链接"，必须用未 realpath
     的绝对拼写调用 unlink，并把它当成独立模式，不要和"删目标"混用）。
2. **解析身份**：`target = await fs.resolve(path, {cwd})`；`proc = fs.processPath(target)`。
3. **能力探测（关键）**：`mapped = fs.processPathFromHostPath(proc)`；
   要求 `mapped !== undefined && mapped === proc`，否则 `[E_DELETE_UNSUPPORTED]`。
   理由：本地/沙箱后端满足（E8），SSH 后端 `processPathFromHostPath` 返回 `undefined`（E7）。
   **不要**用 `fs.sandboxMode !== undefined` 当"本地"判据——`fs-local` 的 `sandboxMode` 是
   `undefined`（不围栏），远程后端同样可能 `undefined`；它只能回答"是否围栏"。
4. **策略 + 升级**：`fs.sandboxMode === undefined` 时无策略；否则
   `policy = ctx.sandboxPolicy.resolve({session})`；带 `sandbox_permissions`/`justification`
   时复用 `approveEscalation`（subject `"operation"`），得到"仅本次调用"的更宽 mode
   （E15）。参数配对用 `validateEscalationArgs`。
5. **围栏（必须自己做）**：
   - `read-only` → throw `new FsError(sandboxDenialMarker(mode) + "\n" + escalationHintMarker("operation"),
     "FS_SANDBOX_DENIED")`；
   - `workspace-write` → `roots = writableRoots(policy).map(canonicalPath)`，
     `rootTargets = await Promise.all(roots.map((r) => fs.resolve(r)))`，要求
     `rootTargets.some((rt) => fs.contains(rt, target))`。
     `contains` 用的是 `processPath`（realpath）而 root 已 realpath，`/tmp` → `/private/tmp`
     才能匹配（E9/E13）。注意 `/tmp`/`os.tmpdir()` 在可写集合里是**设计如此**——删除临时文件
     与写临时文件同权；
   - `danger-full-access` → 不围栏。
   不要把检查写成"先 `dsh-fs` 再 `node:fs`"的两段：`fs-sandbox` 的 `checkedTarget` 语义是
   "把检查过的 target 直接用于变更"；这里相应的收窄是**在 unlink 前立即重解析**（见下一步）。
6. **TOCTOU 收窄**：unlink 前重新 `lstat` 并比较 `version`（不透明 token，仅比较相等即可，
   `types.d.ts:23-28` 只禁止"解释"）；不等 → `[E_DELETE_STALE]`。unlink 后再 `lstat`，
   若又出现 → 删除已发生但路径被并发重建，报告成功 + 警告，不能报失败。
   这是与 `fs-sandbox` "接受残余 TOCTOU"（README:79/123）同一档的诚实边界。
7. **前置观察（建议的默认门）**：若本会话没有该 path 的 served/read 记录，返回
   `[E_NOT_OBSERVED]`。理由：`write`/`edit` 已有 read-before-mutate（`tool-fs` README:50-51；
   本仓 `README.md:370` 的 `[E_NOT_OBSERVED]`），删除是更不可逆的 mutation，值得同一门；
   `grep` 命中即 serve（`README.md:276`），所以"看过"就够。是否默认开启是产品决策，建议
   默认开启、可由配置放宽。
8. **观察事件**：成功后只发 `fs/observed` + `{kind:'absent'}`（复用 `fs-bridge.ts:351` 的
   `emitAbsent`），**不要**发 `fs/write-intent`——那会让观察策略给出写守卫，语义错位
   （E14/`hash-store` 与 policy 的耦合见 E16）。
9. **状态回收**：以第 2 步的 `proc` 为键（与读路径同键，`fs-bridge.ts:276-281`）：
   `store.deleteUndo(proc)`、`store.deleteServedByPath(proc)`，再补一个新的
   `store.deletePath(proc)`（把 E16 的私有四步级联提升为公开 API：`undoDelete`、
   `servedDeletePath`、`anchorMetaDelete`、`anchorLinesDeletePath`）。
   顺序必须是"先落盘、后回收"；回收失败**不能**把已完成的删除报成失败——返回成功 + 一条
   `[E_SERVED_RECORD]` 风格的警告（对齐 `README.md:373` 的诊断语义）。
10. **LSP/缓存**：删除后 LSP 若仍持有该文档，需要在实现时补一条 `didClose` 通知
    （`src/lsp/session.ts:484` 有 `didClose`，但 `src/lsp/sync.ts` 对外只有
    `notifyDocumentWritten`/`syncDocumentContent`/`setPreWriteSyncHook` 等写入钩子，没有 close 出口）；
    否则下一次 `format`/`lsp` 可能对已删除路径报错。

不建议的两条路：
- **走 `ctx.shell` 执行 `rm`/`Remove-Item`**：能白拿内核级沙箱（E5），但要处理平台分支、
  引号、shell 存在性，且拿不到结构化 `errno`/`FsError`；`ctx.shell` 是命令 seam，不是文件原语。
  可作为"删除目录树"的远期逃生门，不作为单文件 delete 的实现。
- **先 `fs.writeText` 清空再删**：留下空文件的中间态，且对只读/二进制文件语义更差；没有理由。

### 拒绝条件（逐项）

| # | 条件 | 拒绝码 | 依据 |
| --- | --- | --- | --- |
| 1 | 路径不存在（`lstat` undefined） | `[E_NOT_FOUND]` | E10 |
| 2 | target 是目录 | `[E_IS_DIRECTORY]`（新） | E10；`fs.unlink` 不删目录（E19） |
| 3 | target 是 `other`（socket/fifo/device） | `[E_NOT_REGULAR_FILE]` | E10 |
| 4 | target 是符号链接（默认） | `[E_SYMLINK]`（新） | E11 |
| 5 | `processPathFromHostPath` 不返回同一路径 | `[E_DELETE_UNSUPPORTED]`（新） | E7/E8 |
| 6 | `read-only` | `FS_SANDBOX_DENIED` + `[sandbox: …]` + hint | E12/E13/E15 |
| 7 | `workspace-write` 且不在 `writableRoots` | 同上 | E13 |
| 8 | 本会话未读过（默认门） | `[E_NOT_OBSERVED]` | E16/README |
| 9 | `lstat` version 在两次探测间变化 | `[E_DELETE_STALE]`（新） | E6/E10 |
| 10 | Windows 只读属性 / 被占用 | `[E_ACCESS]`（保留原始 errno 文案） | E18 |
| 11 | POSIX `EACCES`/`EROFS`/`EPERM`/`EBUSY` | `[E_ACCESS]` | E17 |
| 12 | 调用方 abort | `FS_ABORTED`（沿用接缝词汇） | E1 |

补充：
- **不要**为了"删成功"自动 `chmod` 去只读位、不要 `rm -f` 式吞错。Windows 的只读是用户的
  状态，报告补救方法（对齐 `README.md` 的 `[E_WIN_REPLACE]` 风格）。
- `danger-full-access` 下是否额外要审批是**部署策略**：能力上可以（`tools/pre-execute` 的
  `ask`，E15），但不要由 delete 工具硬编码。

### 错误类型

- 复用接缝词汇：`FS_NOT_FOUND`、`FS_PERMISSION_DENIED`、`FS_SANDBOX_DENIED`、`FS_ABORTED`
  直接来自 `FsErrorCode`（E1）；**不要**往 `FsErrorCode` 里加新值（闭集，属于上游）。
- 新增的本仓模型面向码（与 `README.md:338` 的表同风格）：`[E_IS_DIRECTORY]`、`[E_SYMLINK]`、
  `[E_DELETE_UNSUPPORTED]`、`[E_DELETE_STALE]`；`[E_NOT_OBSERVED]` 沿用。
- 主机 errno 必须自己翻译：`fs-local` 的 `writeText` 对 `EACCES` 是**裸抛**（`writeText`
  无 try/catch，`writeFileAtomic` 直接抛），本仓 `mapFsError` 只识别 `FS_*` 与 Windows
  `ReplaceFileW` 文案（`src/infra/fs-bridge.ts:132-200`），所以 delete 要显式把
  `EACCES/EPERM/EROFS/EBUSY/EISDIR` 映射到上表，否则模型看到裸 errno。
- 保留 `code` 字段（`error-result.ts` 的 `ErrorMeta` 模式），并在返回里带 `displayPath`。

### 最小测试建议（都在 `test/core/`，vitest，沿用现有 fake ctx 风格）

1. **能力探测**：fake fs 的 `processPathFromHostPath` 返回 `undefined` → 拒绝
   `[E_DELETE_UNSUPPORTED]`，并断言没有调用 `node:fs`（`vi.mock`）。
2. **词法映射不等于身份**：fake 返回与 `processPath` 不同的路径 → 拒绝；相同才放行。
3. **正常删除 + 回收**：临时目录建文件，先 `read`（serve），delete 成功；断言文件消失、
   `fs/observed` 收到 `{kind:'absent'}`（且**没有** `fs/write-intent`）、`lstat` 返回
   undefined；store 的 `undo`/`served`/`anchor_meta`/`anchor_lines` 四类行都没了
   （参考 `test/core/hash-store-row-count.test.ts:211`、`served-store.test.ts:374-430`）。
4. **符号链接**：活链接与悬空链接各一例 → `[E_SYMLINK]`，链接与目标都还在（E11 的两个分支）。
5. **目录**：普通目录与空目录都拒绝，文件系统不变。
6. **只读/工作区边界**：`makeCtx` 注入 `sandboxMode` + fake `sandboxPolicy`（照
   `test/core/sandbox.test.ts:24-45`）：`read-only` → marker + hint；`workspace-write` 内放行、
   外拒绝；`/tmp` 内放行（E13 的临时区）。
7. **升级**：`sandbox_permissions: "danger-full-access"` + fake approval `allowed-once` → 放行；
   `rejected`/`unavailable` → 拒绝且文件还在（E15）。
8. **TOCTOU**：注入 hook 在两次 `lstat` 之间改 version → `[E_DELETE_STALE]` 且未 unlink。
9. **重复删除 / 外部已删**：第二次 `[E_NOT_FOUND]`；回收幂等，不抛。
10. **回收边界**：两个文件只删一个；另一 path 的四类行不受影响；同一 path 两个 session 的
    served 行都被 `deleteServedByPath` 清掉（明确这是期望行为）。
11. **Windows 专用**（CI 矩阵已有 Windows Node 22）：`chmod 0o444` 后删除失败（`[E_ACCESS]`），
    `chmod 0o666` 后成功。**被占用**的场景不要写成必过断言——Node 自己打开的文件通常带
    `FILE_SHARE_DELETE`，能否稳定复现占用要先在真机确认（见下）。
12. **abort**：`signal` 在 unlink 前已 abort → `FS_ABORTED`，无删除、无回收。

## 未解风险 / 需要真机验证的点

1. **Windows 的真实错误码**：`DeleteFileW` 文档只给 `ERROR_ACCESS_DENIED`；libuv 映射到
   `EACCES`/`EPERM`/`EBUSY` 的哪一种，以及"文件被其它进程打开"能否在测试里稳定复现
   （Node 自己的 `open` 带 `FILE_SHARE_DELETE`），必须在 Windows 真机/CI 上跑一次才能定错误表。
2. **能力探测不是身份证明**：`processPathFromHostPath` 在本地是纯词法（E8）。若未来出现
   "部分共享宿主目录"的远程/容器后端且实现了映射，`mapped === proc` 可能误放行。更强的判据
   需要后端提供映射保证，或比较（dev, ino）——但 `ctx.fs` 不暴露这些。**本机没有远程 fs
   后端可验**（装机包只有 `dsh-fs-local`/`dsh-fs-sandbox`；SSH fs 只在 repo 文档里）。
3. **自建围栏的 TOCTOU**：`fs-sandbox` 明确接受 resolve→syscall 的残留窗口（README:79/123）。
   delete 的 `lstat`→`unlink` 同构，且 `unlink` 没有原子"按版本删"的原语。是否接受、要不要
   用 `O_PATH`/`openat2` 类方案，需要安全评审。
4. **符号链接语义是产品决策**：跟随（与 write/edit 的身份一致，但删目标、留悬空链接）vs
   删链接（与 unlink 的系统语义一致，但与 `targetKey = realpath` 的身份模型冲突）。默认
   拒绝最安全；一旦要支持，需要定义"删除链接"的路径拼写、围栏判据（链接路径 vs 目标路径）
   和 UI 文案。
5. **审批链路没有端到端验证**：`approveEscalation` 需要 `ctx.approval` + agent + 打开的 turn；
   本会话 approval prompts 被禁用（自动拒绝），无法验证真实 UI。headless/无审批通道时
   `ask`/escalation 都会 fail-closed（E15），delete 的错误文案要能让模型区分"用户拒绝"与
   "没有审批通道"。
6. **store 级联的新 API**：把 E16 的私有四步提为公开方法后，要验证 `anchor_lines`/`anchor_meta`
   的 path-count 触发器不漂移（`hash-store.ts:680-700` 一带的触发器设计），以及 `pruneMissing`
   与新方法幂等共存。需要真实大 store（不是单测临时库）验证一次 sweep 计数。
7. **跨会话 served 回收**：`deleteServedByPath` 清所有 session 的行。若产品意图是"只回收本
   会话"，就得改成按 session 循环删除；这会影响多会话/子代理共享同一工作区时的锚点寿命。
8. **目录与递归删除**：首版应不支持（`rmdir` 不在接缝里，`fs.rm(recursive)` 的语义与
   `writableRoots` 的边界组合风险更高）。若未来支持，需要重新论证"删整棵子树"的围栏与
   部分失败（`ENOTEMPTY`、中途 EACCES）的报告方式。
9. **LSP/format/read-window 的残留状态**：`didClose` 没有对外的钩子（E-design 10）；
   `format` 的磁盘快照缓存、read 的 `resume` token、`alignmentNotices` 都可能指向已删除的
   path。需要逐一确认"删除后下一次调用"的行为（预期：干净的 `E_NOT_FOUND`，而不是陈旧
   状态误导）。
10. **删除与 watch/`fs/observed` 的竞态**：本仓的 `watch` 是 chokidar（`fs-local` `728` 起），
    删除会触发 watcher 回调；如果 delete 自己也在 watcher 上做回收，需避免双触发。当前
    delete 不依赖 watcher，但这是未来做"外部删除也回收"时的接入点。

11. **上游的可写根清单还在长**：master 的 `docs/subsystems/sandbox.md:11` 已写
    "workspace root, explicit extra directories, and the backend's promised temp area"，`:62`
    已出现 `additionalWritableRoots`，而运行中的 0.2.1-rc.3 `writableRoots()`（E13）还没有这个
    字段。delete 若自己拼 `workspaceRoot + /tmp + os.tmpdir()`，未来会漏掉额外可写根；实现必须
    调用导出的 `writableRoots(policy)`（`dsh-sandbox/lib/types/index.d.ts:12`），不要复刻列表。
