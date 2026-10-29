# DSH 改名接缝、观察状态与跨平台 rename 语义

> 取证笔记（2026-10-26）。范围只回答六件事：`ctx.fs` 有没有 rename/move 能力；
> 绕过它走 `node:fs.rename` 时 `fs/observed` 与 `fs/write-intent` 该怎么发；
> 围栏（`writableRoots` / `fs.contains`）怎么组合判定源与目标；LSP 侧「改名」
> 能不能表达；Node `fs.rename` 的 errno 面与「同一个文件」的识别；以及 dsh 有没有
> 任何可替换的改名事件/API。不设计工具文案与 UI。
>
> 取证手段：仓内 `node_modules/@deepseek-ai/{dsh-fs,dsh-sandbox,dsh-sandbox-policy}`
> （devDependencies **0.2.0-rc.2**）；本机装机包
> `/Applications/DeepSeek Harness.app/Contents/Resources/app.asar`（运行中
> **0.2.1-rc.3**）内的 `dsh-fs-local` / `dsh-fs-sandbox` /
> `dsh-fs-observation-policy` / `dsh-tool-fs`；POSIX `rename()` 规范、Microsoft
> `MoveFileExW`、libuv `src/win/error.c`；本机 macOS（APFS 大小写不敏感）/tmp +
> Node 26.5.0 的实测。
>
> 版本差异：装机包 0.2.1-rc.3、仓内 devDependencies 0.2.0-rc.2。**契约面（`dsh-fs`
> 的 .d.ts）只有 rc.2 可用**，实现面（`fs-local`/`fs-sandbox`/观察策略）只有 rc.3 的
> asar 可用；逐条标注证据取自哪一版。asar 未解包到仓库，只按需把单个文件取到 `/tmp`
> 阅读。`app.asar` 内的行号是 asar 条目原始内容的行号；该内容有一行以 `;` 开头的
> 构建残留（JSON 文件亦然），不影响行号。

## 结论（先给，6 条）

1. **`ctx.fs` 没有 rename/move——类型面、事件面、实现面都缺。**
   `FileSystem` 是 15 个方法 + 1 个 getter，没有 `rename`/`move`；`fs/*` 事件只有
   `fs/write-intent`、`fs/edit-intent`、`fs/observed`；`FsErrorCode` 是 13 值闭集，没有
   改名相关错误码；包 README 的 "No delete, rename, or copy" 在 0.2.0-rc.2 与
   0.2.1-rc.3 两版都还在。模型工具集（`read`/`write`/`edit`/`read_image`）也没有
   改名工具，所以 DSH 里唯一的改名通道是 `node:fs.rename` 或 shell 的 `mv`。
2. **DSH 自己就在用 `node:fs.rename`，只是不对外暴露。** `fs-local` 的原子写
   `writeFileAtomic` 以 `rename(tempPath, absolutePath)` 收尾（rc.3 源码实证），说明
   一次「同目录 rename」在 dsh 眼里是普通文件操作——真正的缺口是**接缝**与
   **状态迁移**，不是能力。
3. **一次 rename 要发两条 `fs/observed`：旧路径 `absent` + 新路径 `present`，且
   present 的 version 必须是 rename 之后重新 stat 出来的。** 观察策略只按
   `(session, targetKey)` 记 present/absent；而 `versionOf` 是
   `dev:ino:size:mtimeNs:ctimeNs`，**rename 会改 ctime**（本机实测：同 inode、mtime
   不变、ctime 变），所以迁移前记录的旧 version 在新路径上一定 stale，照抄会让下一次
   `edit` 撞 `FS_STALE_VERSION`。只发「旧 absent」而不发「新 present」则下一次 `edit`
   直接 `FS_NOT_OBSERVED`、下一次覆盖写退化成 `createIfAbsent` 而拒绝覆盖。
4. **rename 不该发 `fs/write-intent`。** 该 waterfall 的语义是「为紧接着的一次
   `ctx.fs.writeText` 派生 guard」，rename 不经过 `writeText`，没有 guard 可交；delete
   的先例已经把这条写死（"Only `fs/observed` absent — never a write intent"）。副作用
   要记：`dsh-workspace-changes` 的「改前整文件快照」也挂在 `fs/write-intent` /
   `fs/edit-intent` 上，因此改名不会被它的 file-capture 记录（只可能被 turn 级 git
   快照看到）。
5. **围栏只有 `fs-sandbox` 的两个方法，rename 必须自建，而且源与目标都要过。**
   `SandboxedFileSystem` 只覆盖 `writeText`/`editText`，`resolve`/`contains`/`processPath`
   全部继承；判据是 `writableRoots(policy)` + `fs.resolve()` + `fs.contains()`。
   源侧不判会导致「把受保护区的文件搬出来」，目标侧不判会导致「把任意内容写进受保护区」。
6. **平台面：POSIX 对「同一个文件」的 rename 返回成功且什么都不做**（大小写不敏感盘上
   `a.txt → A.TXT` 在 POSIX 语义里是 same-entry，实测 macOS/APFS 上它反而**改了盘上的
   大小写**），所以「目标 lstat 命中」必须先按 `dev`+`ino` 判同文件；`EXDEV` 只在跨
   文件系统出现；`ENOTEMPTY`/`EEXIST` 只在目录对目录出现；Windows 的
   `ERROR_ACCESS_DENIED` 经 libuv 映射成 **`EPERM`** 而不是 `EACCES`——错误映射表必须
   同时收 `EACCES` 和 `EPERM`。

## 证据（逐条：结论 + 证据来源路径/URL + 行号或片段说明）

### 问题 1：`ctx.fs` 是否已有 rename/move 接缝

#### E1. 类型面：没有改名方法

**结论**：`FileSystem` 抽象类的方法清单里不存在任何改名/移动原语，也没有「目标已存在
怎么办」这类语义位。

- 仓内 `node_modules/@deepseek-ai/dsh-fs/lib/types/index.d.ts`（0.2.0-rc.2），
  `abstract class FileSystem extends Service`（`:61`）的方法全集：
  `watch` `:71`、`get sandboxMode` `:84`、`resolve` `:94-97`、`processPath` `:106`、
  `processPathFromHostPath` `:115`、`fileUrl` `:123`、`contains` `:131`、`stat` `:138`、
  `lstat` `:153-155`、`readText` `:162`、`streamText` `:172`、`readBytes` `:183`、
  `readByteRange` `:197-200`、`listDir` `:208`、`writeText` `:221`、`editText` `:235`。
  总计 15 个方法 + 1 个 getter，无 `rename` / `move` / `mv`。
- 同一文件 `:56-59` 的类注释把契约边界写成 "Targets must preserve identity across
  aliases; reads expose regular UTF-8 text or typed errors, listings are stable and
  content-free, and mutations are atomic"——「mutation」只有两种，见 `:221`/`:235`
  各自的 `sandboxPolicy` 形参（写与编辑各一个围栏入口，改名词条不存在）。

#### E2. 事件面：只有三个 `fs/*` 事件，没有 rename intent / rename 决策

**结论**：文件系统策略只认写、编辑、观察三件事；改名没有决策事件可挂。

- 仓内 `dsh-fs/lib/types/index.d.ts:19-53` 的 `interface Events`：`'fs/write-intent'`
  `:28`（waterfall，`:21-27` 注释说明「为下一次 writeText 的单槽决策」）、
  `'fs/edit-intent'` `:36-42`、`'fs/observed'` `:52`（`:43-51` 注释：
  "Record an authoritative positive or negative observation"。`@mode emit`）。
- 无 `fs/rename-intent`、无 `fs/moved`、无 `fs/renamed`。

#### E3. 错误面：`FsErrorCode` 是 13 值闭集

**结论**：错误词汇里没有改名专属码，rename 失败只能复用现有码或走本插件自己的
`[E_*]` 词汇（delete 的选择）。

- 仓内 `dsh-fs/lib/types/types.d.ts:162`：
  `'FS_NOT_FOUND' | 'FS_NOT_DIRECTORY' | 'FS_NOT_TEXT' | 'FS_NOT_REGULAR_FILE' |
  'FS_TOO_LARGE' | 'FS_PERMISSION_DENIED' | 'FS_SANDBOX_DENIED' | 'FS_IO_ERROR' |
  'FS_STALE_VERSION' | 'FS_NOT_OBSERVED' | 'FS_AMBIGUOUS_EDIT' | 'FS_EDIT_NOT_FOUND' |
  'FS_ABORTED'`。
- 同一文件 `:106-110` 的 `FsWriteIntent` 只有 `createIfAbsent` / `replaceIfVersion`
  两臂；`:38-47` 的 `FsObservation` 只有 `present(version)` / `absent` 两臂。改名的
  「目标已存在要不要覆盖」在词汇里无处安放——这属于工具层参数，不属于接缝。

#### E4. 文档面：「No delete, rename, or copy」两个版本都仍成立

**结论**：这不是 0.2.0-rc.2 的旧说法，运行中的 0.2.1-rc.3 同样这么写。

- 仓内 `dsh-fs/README.md:115`（0.2.0-rc.2）：
  "**No delete, rename, or copy** — `listDir` lists a single level, with recursion,
  globbing, pagination, and search out of scope"。
- 装机包 `dsh-fs/README.md:116`（0.2.1-rc.3）：同一句，仅行号后移一位（前插了一行）。
- `dsh-fs/README.md:114`："**Text-only mutations by contract** …
  `readBytes` and `readByteRange` are the raw-byte primitives, and binary-safe
  mutations remain deferred."
- `dsh-fs/README.md:72`（The `fs/*` policy events）把事件数锁死在 "three events"。

#### E5. 实现面：`fs-local` 内部真的调用 `node:fs.rename`，但没有导出方法

**结论**：改名能力在 dsh 的实现里已经存在（原子写收尾），只是没有作为接缝方法暴露；
这也说明「一次同目录 rename」完全在 dsh 的既有假设内。

- 装机包 `dsh-fs-local/lib/index.js:11`：`import { chmod, link, lstat, mkdir, open,
  readFile, readdir, rename, rm, stat } from "node:fs/promises";`
- 同文件 `:513-562` `writeFileAtomic(...)`：临时文件写完后 `:560`
  `await rename(tempPath, absolutePath);`（create-if-absent 分支）与 `:562`
  `else await rename(tempPath, absolutePath);`（覆盖分支）。
- 同文件 `:790-791` `processPath(target) { return String(target.targetKey); }` →
  本地后端的 processPath 就是 **realpath**（见 E7）。
- 同文件 `:799-802` `contains(parent, child)` 用
  `relative(this.processPath(parent), this.processPath(child))` 判定，`""` 或非 `..`/
  非绝对路径为 true。
- 同文件 `:146-148` `versionOf(info)` =
  `` FsVersion(`${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`) ``。
- 同文件 `:170-213` `resolveLocalTarget(cwd, path)`：`path.trim()` 为空 → `FS_NOT_FOUND`
  （`:171`）；存在则 `targetKey: FsTargetKey(await realpath$1(displayPath))`（`:176`）；
  不存在则 realpath 最近存在祖先再拼回缺失后缀（`:186-213`）。
- 同文件 `:814-825` `lstat(path, opts, signal)`：对**该拼写**做 no-follow 探测
  （`:820-825` 返回 `version` / `type`，`type` 可为 `symlink`）。

#### E6. 模型工具集：没有 `rename`/`move` 工具

**结论**：改名只能由插件新注册一个工具，或者由模型自己用 shell。

- 装机包 `dsh-tool-fs/lib/index.js` 注册的工具只有四个：
  `name: "read"` `:252`、`name: "write"` `:550`、`name: "edit"` `:691`、
  `name: "read_image"` `:987`。

### 问题 2：`fs/observed` 语义与 rename 要发的观察

#### E7. 观察状态是 `(owner, targetKey)` 上的 WeakMap，owner = agent session

**结论**：观察是「本会话 + 本 targetKey」的记忆；同一个 inode 换了路径就是另一个
targetKey（targetKey 是路径 realpath，不是文件身份）。因此 rename 之后新路径是一个
**从未被观察过**的目标，直到我们显式记录它。

- 装机包 `dsh-fs-observation-policy/lib/index.js:16-77`（`ObservedStateGate`）：
  - `:23` `observed = /* @__PURE__ */ new WeakMap();`，`:18-22` 注释：keyed first by
    the owner object … then by `FsTarget.targetKey`，且 "its discriminant keeps
    confirmed absence distinct from an unseen target"。
  - `:30-32` `owner(actor) { return actor?.agent?.session; }`——**owner 是 agent 的
    session**；`:26-28` 注释：a direct tool call with no agent "read freely but cannot
    satisfy the write/edit prior-observation policy"。
  - `:52-59` `writeIntent`：`prior?.kind === "present"` → `replaceIfVersion(prior.version)`；
    否则 `createIfAbsent`。
  - `:65-71` `editIntent`：`!owner || prior === undefined` → **`FS_NOT_OBSERVED`**
    （`:68`，"edit requires reading … first"）；`prior.kind === "absent"` →
    **`FS_NOT_FOUND`**（`:69`）；否则 `{ version: prior.version }`。
  - `:73-76` `observe(target, observation, actor)` 只在 owner 存在时写入。
- 装机包 `dsh-tool-fs/lib/index.js` 的公开消费方式：
  - read 成功 → `:351-353` `ctx.emit("fs/observed", target, { kind: "present", version:
    info.version }, …)`；read 遇 not-found → `:196` `{ kind: "absent" }` 再抛
    `FS_NOT_FOUND`。
  - 写/编辑成功 → `:493-498` `mutationResult(...)` 用 **outcome.version** 发 present。
  - write 工具：`:607` `resolve` → `:608` `ctx.waterfall("fs/write-intent", …)` →
    `:611` `writeText` → `:615` `mutationResult`。
  - edit 工具：`:751` `resolve` → `:754` `waterfall("fs/edit-intent", …)` →
    `:755` `editText` → `:763` `mutationResult`。

#### E8. 本仓 bridge 的 `emitObserved` 取的是「现在再 stat 一次」的版本

**结论**：`emitObserved` 不是「把调用方手里的版本记下来」，而是 `resolve` + `stat` 之后
用**当下**的 `info.version`；这条实现正好适合 rename 之后重新取版本。`emitAbsent` 同构
（resolve + stat，缺失才发 absent）。

- `src/infra/fs-bridge.ts:101-109`：`emitObserved(absolutePath, exec?, signal?)` 的契约
  （"Emit `fs/observed` (present at the current version) for a successful read"）。
- 同文件 `:425-445` 实现：`fs.resolve(absolutePath, …)` → `fs.stat(target, signal)` →
  `info !== undefined` 时 `ctx.emit("fs/observed", target, { kind: "present", version:
  info.version }, exec)`；异常被吞掉（`:439-444`，"A failed observation must not fail
  the read that preceded it"）。
- 同文件 `:446-476` `emitAbsent`：`stat` 为 `undefined` 才发 `{ kind: "absent" }`；
  `:117-118` 注释 "returns true when an absent observation was actually recorded"。
- 同文件 `:256-262`（`writeWithIntent`）：写成功用 `outcome.version` 发 present。
  `:6-12` 的模块注释说明了为什么必须发："A hashline tool that silently skipped those
  events would leave the policy's observed state stale, and the next built-in `write` on
  the same file would fail with `FS_NOT_OBSERVED` / `FS_STALE_VERSION`."

#### E9. version 迁移前会失效：rename 改 ctime，本机实测

**结论**：`versionOf` 把 ctime 纳入版本，而 rename 会更新被改文件的 ctime——所以
「把旧路径观察到的 version 记到新路径上」是错的，必须 rename 之后重新 stat。

- 版本构成：装机包 `dsh-fs-local/lib/index.js:146-148`（见 E5）。
- 本机实测（macOS APFS，Node 26.5.0，`/tmp` 下临时文件）：
  - rename 前后 `dev`、`ino`、`size`、`mtimeNs` 全部相同；
  - `ctimeNs` 从 `1793018785948294431` 变为 `1793018785948565890`；
  - 按 `versionOf` 拼出来的版本字符串**不同**。
- 因此：`rename` 之后必须对**新路径**做一次 `stat`/`resolve`，用新 version 发 present；
  对**旧路径**用 absent 覆盖（旧 targetKey 上还挂着 present + 旧 version）。
- 只发 absents 不覆盖旧 targetKey 的后果：旧路径的 targetKey 在文件消失后依然可解析成
  同一字符串（`resolveLocalTarget` 的祖先回填，E5 `:186-213`），所以旧 observation 会
  命中，下一次 `write` 走 `replaceIfVersion` → `probe` 发现缺失 →
  `FS_STALE_VERSION`（`fs-local/lib/index.js:869-871`：`cannot write …: file no longer
  exists` / `file changed since it was read`）。

#### E10. delete 的先例：只发 observed，不发 write-intent

**结论**：同类「非 `ctx.fs` 迁移」已经定过基调，rename 沿用即可。

- `src/tools/tool-delete.ts:370-372`：
  "…present observation, a stale alignment notice, or an LSP document for it. Only
  `fs/observed` absent — never a write intent."
- 同文件 `:373-374`：`clearAlignmentNotice(outcome.path)` + `notifyDocumentClosed(outcome.path)`。

#### E11. `fs/write-intent` 的用途：给一次 `ctx.fs.writeText` 派生 guard

**结论**：rename 没有 `writeText` 要 guard，因此不应发；发了也没有消费方，而且会误导
把「改名前快照」挂在这个 waterfall 上的插件。

- 仓内 `dsh-fs/lib/types/index.d.ts:21-28`：单槽 decision，"Calling `next()` yields the
  bare provider's unconditional write; the first listener that returns an intent owns
  the decision"。
- 观察策略的 listener 就是 `fs-observation-policy/lib/index.js:91`
  `ctx.on("fs/write-intent", …)`，它只读 observed 状态派生 `createIfAbsent` /
  `replaceIfVersion`（E7）。
- 另一个真实消费者：装机包 `dsh-workspace-changes/README.md:47`、`:59`——"After a
  `write`, `edit`, or mutating `str_replace_editor` call resolves its target and obtains
  its mutation guard, the recorder copies that exact file before the mutation" /
  "the filesystem's `fs/write-intent` and `fs/edit-intent` waterfalls delegate the guard
  decision, then queue and await the capture of the resolved target before mutation"。
  这条路径**看不到 rename**，是「改名不进 turn 快照」的上游原因。

### 问题 3：围栏（`writableRoots` / `fs.contains`）与源/目标组合判定

#### E12. `fs-sandbox` 只围 `writeText`/`editText`，其余全部继承

**结论**：rename 在 `fs-sandbox` 下完全没有围栏；必须由工具自己按同一判据重建，否则
`workspace-write` 的承诺被绕过。

- 装机包 `dsh-fs-sandbox/lib/index.js:104-142`：`var SandboxedFileSystem = class extends
  LocalFileSystem`（`:104`），覆盖的方法只有 `writeText`（`:126-128`）与 `editText`
  （`:140-142`），两者都是 `super.xxx(await this.checkedTarget(target, sandboxPolicy), …)`。
- 同文件 `:69-95` 模块注释："It extends `LocalFileSystem` so all text-storage mechanics
  — resolve, stat, read/stream, list, the atomic write and the read-match-write edit
  critical section — are the local implementation's, verbatim; this package adds only
  the per-call POLICY fence on the two mutations."
- 同文件 `:78-86` 还点明了威胁模型："a policy check in TRUSTED code over a
  MODEL-CONTROLLED path, NOT a kernel boundary — the operations are the seam's own
  (open, rename) … This is containment, not a security boundary"。

#### E13. `checkedTarget` 的三种模式与「用刚 resolve 出来的 target 去写」

**结论**：围栏 = `danger-full-access` 放行 / `read-only` 直接拒 /
`workspace-write` 重新 resolve 后要求落在某个 writable root 之下，且**返回那个新
target** 以消除 check-here-write-there 的 TOCTOU。rename 要照抄这个结构，但要做两次
（源 + 目标）。

- 装机包 `dsh-fs-sandbox/lib/index.js:154-166`：
  - `:155` `const policy = sandboxPolicy ?? this.ctx.sandboxPolicy.resolve();`
  - `:157` `if (mode === "danger-full-access") return target;`
  - `:158` `read-only` → `throw new FsError(… "FS_SANDBOX_DENIED")`
  - `:159` `const fresh = await this.resolve(target.displayPath);`
  - `:161` `for (const root of writableRoots(policy)) if (await isPathUnder(fresh.targetKey, root)) …`
  - `:165` 不 contained → `FS_SANDBOX_DENIED`；`:166` `return fresh;`

#### E14. `isPathUnder` 的 dev+ino 保守回退——上游对「同一文件」的判法

**结论**：dsh 自己在围栏里就同时用「词法前缀」和「文件身份」两种判据；这直接回答了
「路径拼写不可信时怎么判包含/同一」——`dev` + `ino`。

- 装机包 `dsh-fs-sandbox/lib/index.js:54-65`：`isPathUnder(path, root, caseSensitive)`，
  先词法（`:55`，`:22-28` `isLexicallyUnder`），再对目标的**存在祖先**逐个 `stat` 与
  root 比身份（`:56-65`）。
- 同文件 `:39-41`：`function sameIdentity(left, right) { return left.dev === right.dev &&
  left.ino === right.ino; }`（`bigint: true` 的 stat，见 `:29-31`）。
- 同文件 `:14` `MISSING_CODES = new Set(["ENOENT", "ENOTDIR"])`，`:19-21` 大小写敏感
  时 `toLowerCase()` 比较——Windows 大小写不敏感盘的词法快路径。

#### E15. `writableRoots` 的契约：workspace root + `/tmp` + `os.tmpdir()`，canonical

**结论**：可写根是上游导出的一个函数，**不要复刻列表**；它已经 realpath 过
（`/tmp` 在 darwin 上是 `/private/tmp`）。给 rename 判定时，直接用它的返回值。

- 仓内 `node_modules/@deepseek-ai/dsh-sandbox/lib/types/roots.d.ts:28-36`：
  "`read-only` allows nothing; `workspace-write` allows the policy's workspace root, the
  host `/tmp`, and the per-user platform temp dir (`os.tmpdir()` …)"。
- 同文件 `:16-26` `canonicalPath(path)`：canonical（symlinks resolved），
  "`/tmp` IS `/private/tmp` on darwin"，解析失败保留原拼写。
- 同文件 `:2-11`：Seatbelt 与 `fs-sandbox` **共用**这一份推导，所以「write 工具写不了
  /tmp 但 bash 能」这类不对称不该出现——这也是 rename 必须走同一函数的理由。

#### E16. 围栏组合：源与目标各判一次，缺一不可

**结论**（由 E12–E15 推出，属**推断**，但结论明确）：`workspace-write` 下 rename 需要
① 源的真实路径落在某个 writable root 内；② 目标父路径的真实路径落在某个 writable
root 内（目标文件通常还不存在，`resolve` 的祖先回填正好给出可判定的 targetKey）。只判
源 = 允许把受保护内容搬到任意位置；只判目标 = 允许把受保护区外的文件搬进来。

- 判据的具体调用形状与 delete 先例一致：`fs.resolve(root)` → `fs.contains(rootTarget,
  target)`（`src/infra/fs-bridge.ts:542-556`，`:544` `for (const root of
  writableRoots(sandboxPolicy))`、`:547` `fs.contains(rootTarget, target)`）。
- `contains` 的两侧都走 `processPath`（E5 `:799-802`），而目标缺失时 targetKey 是
  「祖先 realpath + 后缀」（E5 `:186-213`），所以**目标不存在也能判**。

### 问题 4：LSP 侧的「文件改名」

#### E17. dsh 没有 LSP 服务，本仓是唯一实现

**结论**：不存在「dsh 的 lsp 服务是否支持 `workspace/didRenameFiles`」这个问题——dsh
根本没有 LSP 包。改名通知只能由本插件在自己的 LSP 会话上做。

- 装机包 asar 的 `dsh/node_modules/@deepseek-ai/` 共 **308** 个包，没有 `dsh-lsp*`；
  唯一相近的是 `dsh-util-code-language`（代码围栏语言标注，与 LSP 无关）。
- 本仓 `src/lsp/` 自带 `manager.ts` / `session.ts` / `transport.ts` / `sync.ts` /
  `discovery.ts` 等，是这套能力的唯一实现。

#### E18. 本仓没有 `workspace/didRenameFiles`，document 表是 per-session URI 键

**结论**：现有词汇能表达的只有「关掉旧 URI」。改名后新 URI 在下一次语义调用时按需
`didOpen`（open-or-change），所以 `close(old)` + 懒 open(new) 在行为上等价于一次改名
通知——代价是服务器会丢掉该文档的增量状态（rename 通知能保留）。

- `src/lsp/session.ts:141` `#open = new Map<string, OpenDocument>();`
- 同文件 `:484-488` `didClose(uri)`：`this.#open.delete(uri)` 成功后 `notify(
  "textDocument/didClose", { textDocument: { uri } })`；`:490-493`
  `get openDocuments()` 返回 `[...this.#open.keys()]`。
- 同文件 `:456-462` `didOpen`（`:457` 已开则跳过）、`:472-480` `didChange`（整文档同步）。
- `src/lsp/manager.ts:491-517` `openDocumentFor(languageId, uri)`：返回一个
  `(text) => void` 闭包，内部 `:507` `if (!session.openDocuments.includes(uri))` 就先
  `didOpen`，否则 `didChange`——即 **open-or-change**。
- 同文件 `:523-528` `closeDocumentFor(languageId, uri)`：非 ready 直接 false，否则
  `slot.session.didClose(uri)`。
- `src/lsp/sync.ts:81-93` `notifyDocumentClosed(absolutePath)`：never-throws；默认接线
  `:96-103` `defaultClose`（`languageForPath` → 只对 `readyLanguages` 里的语言 →
  `manager.closeDocumentFor(language.id, pathToFileURL(absolutePath).href)`）。
- 结论：改名要做的就是 `notifyDocumentClosed(oldAbsolutePath)`；**不要**顺手
  `notifyDocumentWritten(newAbsolutePath, text)`——那会把新 URI 立刻 open 出去，
  与「写才通知、不主动暖机」的既有约定相冲突（`sync.ts:11-15` 的两条决策）。

### 问题 5：平台面——Node `fs.rename` 的 errno 与「同一个文件」

#### E19. POSIX `rename()`：符号链接、same-file、errno 面

**结论**：三条决定性规范——(a) 末段是符号链接时**操作链接本身**、不解析末段；
(b) old 与 new 指向同一个目录项、或同一文件的不用目录项时**返回成功且不做任何动作**；
(c) 对方是目录时才有 `EISDIR`/`ENOTEMPTY`/`EEXIST`，跨文件系统是 `EXDEV`。

- <https://pubs.opengroup.org/onlinepubs/9699919799/functions/rename.html>，DESCRIPTION：
  - "If either the _old_ or _new_ argument names a symbolic link, `rename()` shall operate
    on the symbolic link itself, and shall not resolve the last component of the argument.
    If the _old_ argument and the _new_ argument resolve to either the same existing
    directory entry or different directory entries for the same existing file, `rename()`
    shall return successfully and perform no other action."
  - "If the _old_ argument points to the pathname of a file that is not a directory, the
    _new_ argument shall not point to the pathname of a directory. If the link named by
    the _new_ argument exists, it shall be removed and _old_ renamed to _new_."
  - "Upon successful completion, `rename()` shall mark for update the last data
    modification and last file status change timestamps of the parent directory of each
    file."
- 同页 ERRORS（节选原文）：`EACCES`（路径前缀无搜索权限、或 old/new 所在目录无写权限）、
  `EBUSY`（old 或 new 命名的**目录**正被使用）、`EEXIST` or `ENOTEMPTY`
  ("The link named by _new_ is a directory that is not an empty directory")、
  `EISDIR` ("The _new_ argument points to a directory and the _old_ argument points to a
  file that is not a directory")、`ENOENT`（old 不存在、new 的前缀不存在、或任一方空串）、
  `ENOTDIR`、`EPERM` or `EACCES`（sticky bit 目录）、`EROFS`、
  `EXDEV` ("The links named by _new_ and _old_ are on different file systems and the
  implementation does not support links between file systems")。

#### E20. Windows：`MoveFileExW` + libuv 的 errno 映射（`ERROR_ACCESS_DENIED` → `EPERM`）

**结论**：Windows 上 Node 的 rename 落在 `MoveFileExW`；跨盘没有 `MOVEFILE_COPY_ALLOWED`
就失败（libuv 把它映射成 `EXDEV`）；**权限拒绝经 libuv 变成 `EPERM`，不是 `EACCES`**；
文件被别的进程打开 → `ERROR_SHARING_VIOLATION` → `EBUSY`。

- <https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw>：
  - "When moving a file, the destination can be on a different file system or volume.
    If the destination is on another drive, you must set the **MOVEFILE_COPY_ALLOWED**
    flag in _dwFlags_."
  - `MOVEFILE_REPLACE_EXISTING`："If a file named `lpNewFileName` exists, the function
    replaces its contents … If `lpNewFileName` names an existing directory, an error is
    reported."
  - "To delete or rename a file, you must have either delete permission on the file or
    delete child permission in the parent directory."
- <https://raw.githubusercontent.com/libuv/libuv/v1.x/src/win/error.c>（`uv_translate_sys_error`
  的 switch，原文逐条）：
  - `ERROR_ACCESS_DENIED: return UV_EPERM;`
  - `ERROR_CANT_ACCESS_FILE: return UV_EACCES;`、`ERROR_ELEVATION_REQUIRED: return UV_EACCES;`
  - `ERROR_SHARING_VIOLATION: return UV_EBUSY;`、`ERROR_LOCK_VIOLATION: return UV_EBUSY;`
  - `ERROR_NOT_SAME_DEVICE: return UV_EXDEV;`
  - `ERROR_DIR_NOT_EMPTY: return UV_ENOTEMPTY;`
  - `ERROR_FILE_NOT_FOUND / ERROR_PATH_NOT_FOUND / ERROR_INVALID_DRIVE: return UV_ENOENT;`
  - `ERROR_INVALID_FUNCTION: return UV_EISDIR;`
  - `ERROR_WRITE_PROTECT: return UV_EROFS;`
  - `ERROR_ALREADY_EXISTS / ERROR_FILE_EXISTS: return UV_EEXIST;`

#### E21. 本机实测（macOS / APFS 大小写不敏感 / Node 26.5.0，`/tmp` 临时文件）

**结论**：macOS 上的 errno 形状与 POSIX 一致；大小写不敏感盘上「只改大小写」的 rename
**成功且真的改了盘上的名字**（不是 no-op），所以「目标 lstat 命中」既可能是同文件也
可能是真改名，必须用 `dev`+`ino` 才能分辨；符号链接被当链接改名、目标不受影响。

- 身份：rename 前后 `dev`/`ino` 不变（同一 inode），`mtimeNs` 不变，`ctimeNs` 变。
- `rename("case.txt" → "CASE.txt")`：成功；`readdir` 之后目录里只剩 `CASE.txt`（大小写
  真的改了）；`ino` 保持。
- `rename(file → 已存在目录)`：**`EISDIR`**（不是 `ENOTEMPTY`）。
- `rename(目录 → 非空目录)`：**`ENOTEMPTY`**。
- `rename(不存在的源)`：**`ENOENT`**；`rename(→ 父目录不存在)`：**`ENOENT`**
  （不是 `ENOTDIR`）。
- 父目录 0555（无写权限）：**`EACCES`**。
- `rename(符号链接 → 新名)`：新名仍是符号链接（`lstat().isSymbolicLink() === true`），
  链接目标文件仍在原处。

#### E22. 「目标 lstat 命中但就是同一个文件」怎么识别

**结论**：**先 `lstat` 两侧拼写，再用 `stat({ bigint: true })` 比 `dev` + `ino`**。
大小写不敏感盘上两次 `lstat` 会都成功且指向同一 inode；大小写敏感盘上则可能一个是
`undefined`。`dev`+`ino` 是上游围栏用的同一判据（E14），也是唯一跨平台稳定的身份。

- 依据：E14 `sameIdentity`；E19 的 same-file 条款（POSIX 把它定义为「成功且无动作」，
  所以不能靠"是否抛错"来判断）；E21 的实测（`dev`/`ino` 跨 rename 保持）。
- `fs.stat(target)` 的 `version` 含 `ino`（E5 `:146-148`），所以**两个拼写若解析到同一
  inode，version 的 ino 段相同**——可作第二重旁证，但不要单独拿 version 判身份
  （ctime/size 会变）。

### 问题 6：dsh 有没有可替换的「改名」事件/API

#### E23. 没有。三个候选都不是改名 API

**结论**：没有任何现成的改名事件或 API 供本插件未来「换传输层」；要换只能等上游加
`fs.rename` + 一个 intent/observed 组合。

- `ctx.fs` 事件只有三个（E2），实现面没有方法（E1/E5），工具集没有工具（E6）。
- `workspace/changes` 是**log-only 的 Session 事件**，主体是「本 turn 改了哪些文件」的
  摘要，不是可执行 API：装机包 `dsh-workspace-changes/README.md:13`（"The Session log
  receives one `workspace/changes` event naming the turn"）、`:49`
  （`ctx.workspaceChanges.summary(sessionId, seq)` / `.diff(...)`）、`:77`
  （"the recorder appends a log-only `workspace/changes` event that only clients read"）。
- `@deepseek-ai/dsh-api-workspace-files` 是**只读**远端文件 API：
  `remote.workspaceFiles.read / stat / readBytes / list / changes`
  （装机包 `dsh-api-workspace-files/README.md:29`），没有 rename/move 方法。
- 结论与 delete 一致：**上游不给接缝，就只能宿主侧 `node:fs` + 自己维持策略状态**；
  未来接缝的形状应当是 `fs.rename(old, new, sandboxPolicy)`（两侧围栏 + 两条 observed），
  而不是新造一个事件。

## 对 `rename` 工具的实现影响（推荐方案 + 拒绝条件 + 错误类型）

### 传输与围栏（宿主侧 `node:fs.rename`，结构照抄 `deleteFile`）

- 位置：`src/infra/fs-bridge.ts` 的 `FileIO` 增加 `moveFile(requestedFrom, requestedTo,
  cwd, expectedFrom, expectedTo, signal, sandboxPolicy)`，与 `:506-580` 的 `deleteFile`
  同构（`localIO()` 侧也要一份 `:661-…`）。
- 能力探测：`fs.processPathFromHostPath(proc)` 必须回映射到同一路径（`:532-538` 的
  `E_DELETE_UNSUPPORTED` 同款），否则拒绝——宿主 `node:fs.rename` 只对本地后端成立。
- 类型拒绝：源按 `probe`（`:507-516`）拒绝 `symlink`/`directory`/`other`。rename 比
  delete 更需要这条，因为 `processPath` 是 **realpath**（E5 `:790-791`）：对活链接
  `processPath` 给的是**目标**的路径，`rename` 会移动目标、留下悬空链接（E19 说
  `rename` 本身不解析末段，差别全在「我们传的是不是已被 realpath 的路径」，与 delete
  E11 的结论完全相同）。
- 围栏：`sandboxPolicy` 存在时，`read-only` → 拒；`workspace-write` → **源**与**目标父
  目录**各做一次 `writableRoots(policy)` + `fs.contains`（`:540-557` 的同款循环，跑两遍）。
- 目标策略：默认**不覆盖**（先 `lstat` 目标：存在则除「dev+ino 同文件」外一律拒绝）。
  覆盖语义一旦放开，就要面对 POSIX "removed and renamed" 与 Windows
  `MOVEFILE_REPLACE_EXISTING` 的差异，以及「覆盖后 undo 的旧内容归属」（本仓 undo 按
  path+depth 存，覆盖会在同一 path 上叠一层，语义不清）。

### 观察与状态（顺序不能错）

1. `rename` 成功。
2. 对**旧路径** `emitAbsent`（`fs-bridge.ts:446-476`），覆盖掉这个 targetKey 上的
   present（E9：否则下一次 `write` 撞 `FS_STALE_VERSION`）。
3. 对**新路径** `emitObserved`（`:425-445`，内部 `resolve` + `stat`，天然拿到 rename
   之后的版本；**不要**复用迁移前的 version）。
4. **不发** `fs/write-intent` / `fs/edit-intent`（E10/E11）。
5. `notifyDocumentClosed(oldAbsolutePath)`（E18）。
6. store 四族迁移（见下）。

顺序理由：先旧后新没有硬约束，但「旧 absent」必须发生在任何可能失败的 store 迁移之前
或之后**在同一事务语义里**——否则会出现「盘上已改名、观察还是旧的」的中间态。建议：磁盘
成功 → observed 两条 → store 迁移（失败只降级为 warning，与 delete 的 `reclaimed?`
处理一致：`tool-delete.ts:64-67`）。

### store：四族行要「搬」不是「删」，且不能走 UPDATE

- 四张表与键：`anchor_meta(path PK)`（`hash-store.ts:566-571`）、
  `anchor_lines(path, line)`（`:574-581`，索引 `(path, anchor)` `:583-585`）、
  `undo(path, depth)`（`:424-429`）、`served(session_id, path)`（`:692-700`）。
- 维护计数只挂在 **INSERT / DELETE** 上：`store-counts.ts:87-94`
  （`anchorLinesRowCountTriggerSql(event: "insert" | "delete")`）与 `:112-133`
  （`anchorPathCountTriggerSql(table, event: "insert" | "delete")`，触发体是
  `AFTER ${event.toUpperCase()} ON ${table}`）。**没有 UPDATE 触发器**。
- 因此迁移必须写成 `INSERT … SELECT`（新 path）+ `DELETE … WHERE path = 旧`，让触发器
  自己把 `anchor_paths_count` / `anchor_lines_rows_count` 搬到正确值；直接
  `UPDATE … SET path = ?` 会让两个计数一起漂移（**推断**：由 DDL 推出，未实测）。
- 已有可复用的原子级联：`hash-store.ts:1122` `const deletePathCascade = (path) =>
  purgePathRows(path)`（`:295-297` 的公开注释描述「一次清掉一个 path 的四张表」）。
  新 API 建议命名为 `migratePath(from, to, opts?)`，返回与 `PurgeReport`
  （`:136-148`）同形的「搬了多少行」。
- `served` 的 `hashes` 是 JSON 列（`:693-700`），搬行时不解析；`anchor_lines.content_key`
  同理（`:574-581`）。
- 冲突处理：目标 path 已有行（例如模型先 write 了新路径再 rename）→ 要么拒绝，要么
  以源为准覆盖；**推荐拒绝并要求先决定保留哪一份**，否则两组互不相容的锚点会混在一个
  path 下，直接破坏「锚点唯一 per file」的契约。

### LSP

- 只关旧：`notifyDocumentClosed`。不要为新 URI 预开（E18）。
- 若要更精确：未来上游若支持 `workspace/didRenameFiles`，在 `LspSession` 上加一个
  `didRenameFiles` 并把 `#open` 的 key 搬过去——但 dsh 与本仓目前都没有这条路径，
  属于未来项。

### 拒绝条件（逐项）

| # | 条件 | 拒绝码 | 依据 |
| --- | --- | --- | --- |
| 1 | 源是符号链接 | `[E_SYMLINK]` | E5 `:790-791` 的 realpath + E19 末段不解析 → 会改名目标 |
| 2 | 源不是普通文件 | `[E_NOT_FILE]` | E5 `:814-825`；delete 同款 |
| 3 | 后端不支持宿主路径映射 | `[E_RENAME_UNSUPPORTED]` | E1/E6 无接缝；delete `:537-538` 同款 |
| 4 | `read-only` 模式 | `[E_SANDBOX]` / `FS_SANDBOX_DENIED` | E13 `:158` |
| 5 | 源或目标不在 writable root 内 | `[E_SANDBOX]` | E15/E16 |
| 6 | 源 version 与探测时不同 | `[E_RENAME_STALE]` | E7/E9；delete `:523-524` 同款 |
| 7 | 目标已存在（非同文件） | `[E_TARGET_EXISTS]` | 覆盖语义未定 |
| 8 | 目标与源同一文件（dev+ino 相等，且拼写不同） | `[E_SAME_FILE]` | E19 same-file 成功条款 + E22 |
| 9 | 源与目标拼写完全相等 | `[E_SAME_FILE]`（或直接 no-op 成功） | 产品选择 |
| 10 | 目标父目录不存在 | `[E_NOT_FOUND]`（`ENOENT`） | E19/E21 |
| 11 | 跨文件系统（`EXDEV`） | `[E_CROSS_DEVICE]` | E19/E20；不做 copy+delete 回退（非原子、且 copy 会绕过围栏） |

### 错误类型（errno → 工具错误）

- 复用接缝词汇：`FS_NOT_FOUND`、`FS_PERMISSION_DENIED`、`FS_SANDBOX_DENIED`、
  `FS_ABORTED` 直接来自 `FsErrorCode`（E3）；**不要**往 `FsErrorCode` 里加新值（闭集，
  属于上游）。
- `node:fs.rename` 的 `code` 映射（两平台都要收）：
  - `ENOENT`（源缺失 / 目标父目录缺失）→ `[E_NOT_FOUND]`（E19/E21）
  - `EACCES` **或** `EPERM` → `[E_ACCESS]`（Windows 的 `ERROR_ACCESS_DENIED` 经 libuv
    是 `EPERM`，E20；macOS 只读父目录是 `EACCES`，E21）
  - `EBUSY`（Windows 被占用；目录在使用中）→ `[E_ACCESS]` 且文案点明「关闭占用程序」
  - `EISDIR` / `ENOTEMPTY` / `EEXIST`（目标形状不对）→ `[E_TARGET_EXISTS]` /
    `[E_NOT_FILE]`（本工具不该支持目录，出现在这里说明探测后被并发换掉了）
  - `EXDEV` → `[E_CROSS_DEVICE]`
  - `EROFS` → `[E_ACCESS]`
  - `ENAMETOOLONG` / `ENOTDIR` / `EINVAL` → `[E_RENAME_FAILED]`（原始 message 带上）
- 保留 `code` 字段（`error-result.ts` 的 `ErrorMeta` 模式），并在返回里带两个
  `displayPath`（源 + 目标），让卡片能并排显示。

### 结果形状（对齐 delete）

- 成功：`{ from: {path, canonicalPath}, to: {path, canonicalPath, version}, migrated?:
  MigrateReport, warning?: string }`——`version` 是 **rename 之后** 的版本，同时是
  发出去的那条 observation 的版本，两者必须同源。
- 部分失败（磁盘成功、store 迁移失败）：保持 `status: "renamed"` + `warning`，不要
  把成功的改名报成失败（delete 的 `reclaimed?` / `warning?` 就是为这个留的，
  `tool-delete.ts:64-67`）。

## 未解风险 / 需要真机验证的点

1. **Node 官方文档原文没取到**：`nodejs.org/api/fs.html` 与 `fs.md` 的 fetch 都被压缩成
   目录骨架，`fsPromises.rename` 段落没读到。本笔记的 rename 行为取自 POSIX 规范
   （E19）、`MoveFileExW`（E20）、libuv 映射（E20）与本机实测（E21），**没有**引用
   Node 文档的措辞。若实现里要写「Node 文档说会覆盖」这类话，必须先去官方页确认。
2. **Windows 的真实 errno 未复现**：`ERROR_SHARING_VIOLATION → EBUSY` 是 libuv 源码
   实证，但「文件被别的进程打开时 Node 报 EBUSY 还是 EPERM」需要真机跑一次；同理
   `MOVEFILE_REPLACE_EXISTING` 覆盖同名文件的行为、只读属性文件的行为。
3. **`EXDEV` 未复现**：本机只有一个卷（`/System/Volumes/Data`），没有第二个文件系统
   可试。跨卷行为来自 POSIX + libuv 文档。
4. **rc.2 与 rc.3 的实现差异未验证**：`fs-local` / `fs-sandbox` / 观察策略的证据全部
   来自装机包 0.2.1-rc.3 的 asar（仓内没有这三个包）。契约（`dsh-fs` 的 .d.ts）是
   rc.2。若 rc.2 的 `writeFileAtomic` 不是用 `rename` 收尾、或 `versionOf` 不同，E5/E9
   的推论要重新核对。
5. **store 计数漂移是推断**：由 `store-counts.ts` 的触发器只覆盖 INSERT/DELETE 推出
   「UPDATE 会漂移」，没有拿真实 store 跑一次 `UPDATE … SET path` 再读
   `anchor_paths_count` 验证。
6. **跨会话 observed**：`owner` 是 `actor?.agent?.session`（E7 `:30-32`）。子代理/多会话
   共享同一工作区时，rename 只在**调用它的那个 session** 里把新路径记为 present；别的
   会话下一次 `edit` 仍会 `FS_NOT_OBSERVED`。这与 delete 笔记里的同一条限制一致，
   产品上是否要接受「改名后必须重读」需明确。
7. **大小写不敏感盘上的「只改大小写」**：实测成功且名字真的变了（E21），但这是 APFS 的
   行为；POSIX 规范说「同一目录项则成功且无动作」（E19）。两者不矛盾（实现可以选择
   真的改），但**不能**据此假设「大小写不变的名字请求一定是 no-op」——判同文件仍须
   `dev`+`ino`。
8. **`fs/observed` 的 actor 形状**：`emitObserved` 传的是 `exec`（`fs-bridge.ts:425-445`）。
   在没有 agent 的执行里（测试、headless）观察不会落库（E7 `:26-28`），rename 后
   紧接着的 `edit` 可能因此 `FS_NOT_OBSERVED`——测试断言要按这个事实写，不要断言
   「一定观察到」。
9. **硬链接**：`dev`+`ino` 相等但路径是不同目录项时，POSIX 说「不同目录项但同一文件」
   也是成功且无动作（E19）。若模型想「给同一内容挂第二个名字」，rename 做不了（返回
   成功但没建新名字），需要 `link`——工具要么明确拒绝，要么在文档里说清。
10. **watch / chokidar**：`fs-local` 从 `chokidar` 引入 `watch`（`:4`），`LocalFileSystem.watch`
    在 `:727` 起；rename 会触发 watcher 回调。本仓的 rename 不应该依赖 watcher，但「外部改名后
    「外部改名后回收」将来会在这里接入（与 delete 笔记第 10 条同一个接入点）。
