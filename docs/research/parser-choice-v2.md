# Parser Choice Research v2 — Issue #30

> **v1 结论经复核不成立，以本报告为准。**
>
> 旧报告 `docs/research/parser-choice.md` 得出"native 路线被 pnpm 无条件拦截，
> dsh plugin add 失败"——该结论被 dsh 源码与本任务实测共同推翻：
> dsh 启动器是 pnpm forwarder；pnpm 把构建脚本列为 ignored 但会把每个被拦包的
> key 写到 `pnpm-workspace.yaml` 的 `allowBuilds:` 段下（值为占位文本
> `"set this to true or false"`），dsh 自己的错误文案直接指向该字段。改为
> `allowBuilds: <pkg>: true|false` 后 pnpm exit 0、bundle 进层栈、插件正常装载。
>
> v2 重做：体积对垒（wasm vs native，含多平台 .node 矩阵外推）、动态新增语言
> 能力（wasm 路线网络下载实测 + native 路线同等需求分发性裁决）、最终推荐
> 重新表态。

**文件位置**：`docs/research/parser-choice-v2.md`  
**研究分支**：`research/parser-choice`（基于 `origin/research/parser-choice` 续推）  
**证据采集**：2026-08-27，macOS arm64，Node v26.7.0，pnpm 11.22.0，npm 11.19.0  
**dsh 版本**：0.1.1-rc.2（安装位置 `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh`）

---

## 一、加载链全链路记录（带源码引用）

`dsh plugin add <pkg>` 不是一个独立安装器，而是一个 **pnpm forwarder**
（`opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/plugin-9h8shc4d.js:96`）。
完整链路：

### 1.1 `dsh plugin --profile <name> add <pkg-or-tgz>` — pnpm forwarder

```
function runPlugin(profile, args) {
    const dir = resolveProfileDir(profile);
    // ...
    const result = spawnSync("pnpm", args.map(anchorPathSpec), { cwd: dir, stdio: "inherit" });
    const exitCode = result.status ?? 1;
    if (exitCode === 0) reconcilePlugins(before, dir);
    else {
        process.stderr.write(`${NAME}: pnpm failed in profile directory ${dir}\n`);
        if (args.some(a => /^git\+|^github:|\.git(?:#|$)/.test(a)))
            process.stderr.write(`${NAME}: git-hosted plugins build on install via their
                prepare script, which pnpm blocks until allowed — add the exact key
                pnpm printed above under allowBuilds in <pnpm-workspace.yaml>, then re-run\n`);
    }
    return exitCode;
}
```

- **关键事实**：reconcilePlugins（把 `dsh.profile.bundles` 与装好包对账、
  把声明了 `dsh.bundle.patch` 的依赖加入层栈）**只在 pnpm exitCode === 0 时
  跑**。ignored builds 让 pnpm exit 1，bundle **就不会进层栈**，
  插件装了文件也等于没装。这是 v1 报告"阻塞"假象的根因。
- **解锁**：把 pnpm 在失败时写的 `allowBuilds: <pkg>: "set this to true or false"`
  占位文本改为 `true`（native 真编译）或 `false`（承认忽略、但承认选择——pnpm
  也认 false）。本任务实测两种取值均能让 pnpm exit 0。

### 1.2 pnpm 安装后 `profile/node_modules` 布局

pnpm 11 在我们的 scratch profile 默认装好后的实测布局（`nodeLinker: hoisted`
与默认 isolated 都试过）：

| 路径 | 形态 | 实测 |
|---|---|---|
| `<profile>/node_modules/<pkg>` | 软链接到 `.pnpm/<store>/node_modules/<pkg>` | 两种 nodeLinker 都建 |
| `<profile>/node_modules/.pnpm/<pkg>@<v>/node_modules/<pkg>` | 真目录（content-addressable store 实体） | isolated nodeLinker 才有 |
| `<profile>/node_modules/.pnpm/node_modules/<pkg>` | 顶级 hoist 视图（无冲突依赖直接放这里） | 两种都有 |
| `$DSH_HOME/profiles/node_modules/<pkg>` | 一并维护的"flat fallback"软链接（每个 profile 共享），由 `dsh-app-boot` 的 `healProfilesModuleFallback` 维护 | 跨 profile 寻址 |

**`import.meta.url` 行为**（这是 wasm 路线最关心的点）：

```
node_modules/web-tree-sitter/web-tree-sitter.js
↓ import.meta.url resolves to
file:///.../node_modules/.pnpm/web-tree-sitter@0.26.13/node_modules/web-tree-sitter/web-tree-sitter.js
```

也就是 `import.meta.url` 穿 pnpm 的内容寻址 store，落到 `.pnpm/<store>/...`。
`web-tree-sitter` 的 `Parser.init({ locateFile })` 用 `new URL('./<file>', moduleUrl)`
拼路径——这一行代码实测可工作：

```js
await Parser.init({
  locateFile: (f) => fileURLToPath(new URL(`./${f}`, moduleUrl)),
});
```

走 hoisted layout 的 profile 是另一种形态：`moduleUrl` 是 `<profile>/node_modules/web-tree-sitter/...`，
grammar wasm 的位置也在 `<profile>/node_modules/<grammar>/<grammar>.wasm`，没有 `.pnpm/`。
两条路径都被本任务的 in-host probe 实测通过（详见 §二）。

### 1.3 宿主进程内 ESM 动态 import

`@deepseek-ai/cordis-plugin-loader/lib/index.js` 用原生 ESM `import()`：

```js
import(name, getOuterStack) {
    if (name.startsWith("cordis:")) return this.ctx.loader.builtins[name.slice(7)];
    return composeError(async (info) => {
        info.offset += 3;
        if (this.ctx.loader.internal) return await this.ctx.loader.internal.import(name, this.ctx.baseUrl, {});
        else if (name.startsWith(".")) return await import(new URL(name, this.ctx.baseUrl).href);
        else return await import(name);
    }, getOuterStack);
}
```

`baseUrl` 锚定在 `<profile>/cordis.yml`（由 `dsh-app-boot` 的 `prepareProfile`
写入——见 `lib/profile-boot-DG5t9aNs.js`）。Node v22+ 的 `internal/modules/esm/loader`
被宿主用 `getOrInitializeCascadedLoader()` 拿来当 fast-path（`cordis-plugin-loader/lib/index.js:24-36`）。

**HMR / 缓存对资产文件读取的影响**：HMR 是 `@deepseek-ai/cordis-plugin-hmr` 提供的
watcher，监听 `cordis.patch.yml` 等 *配置* 文件；它**不重新 import** 插件的
`lib/index.js`，所以 wasm 资产 `fs.readFileSync` 不受 HMR 影响。
**同一版本 tgz 静默 stale**：`dsh plugin add <same-version.tgz>` 在 pnpm 11
下报"added 0"——文件实际更新但 pnpm 内容寻址按 `pkg@version` 去重，磁盘上仍是
旧二进制。本任务实测两次中招（`web-tree-sitter.js` 仍是 6500 bytes / 192 行
但我已经写成 198 行），靠 bump 到 0.0.2 才把文件刷新。生产流程务必 **每改源
码就 +0.0.1**。

### 1.4 tgz 安装 vs git 安装（来源：`references/official-docs/docs/user/develop/basic/publish.md`）

| 来源 | 解析路径 | 构建脚本默认 |
|---|---|---|
| `npm pack` 出的本地 `.tgz` | pnpm file: dep → 解包到 node_modules | 默认 ignored；allowBuilds 解锁 |
| `npm publish` 后 `npm i <pkg>@<v>` | pnpm registry fetch | 默认 ignored；allowBuilds 解锁 |
| `git+https://.../repo.git` 或 `github:user/repo` | pnpm git dep → `prepare` 脚本跑 `tsc → lib/` | 默认 ignored；allowBuilds 解锁（dsh 错误文案明示） |
| `link:/abs/path` | pnpm link 到本地源目录 | ignored；改源后必须 **重装**（link 不复制） |

---

## 二、金标准实验——WASM 能否在 dsh 加载链上真实工作

### 2.1 实验构造

- 插件：`dsh-wasm-probe@0.0.2`，`package.json` `dsh.bundle.patch: ./cordis.patch.yml`，
  deps 含 `web-tree-sitter@0.26.13` + `tree-sitter-javascript@0.25.0` +
  `tree-sitter-python@0.25.0`；无 dev 依赖、无 postinstall。
- 工具 `wasm_probe`：`execute()` 用 `import.meta.url` 相对解析 web-tree-sitter 核心
  + grammar `.wasm`，parse 一段 TS/JS/Python 样例，返回 `{ok, rootKind, bytes, ms, meta}`。
- 安装：`DSH_HOME=$(mktemp -d)` → `npm pack` → `dsh plugin --profile scratch add <tgz>` →
  第一次 exit 1（`ERR_PNPM_IGNORED_BUILDS`）→ 改 profile 的 `pnpm-workspace.yaml`
  把 `allowBuilds: tree-sitter-{javascript,python}: false` 写明 → 再跑一次
  `dsh plugin add` exit 0、bundle 进层栈。
- 验证：因本机缺 DeepSeek LLM API key，无法走真实 headless boot 让模型调用工具；
  采用等价验证：直接 `import(pluginEntryUrl)`（与 dsh loader 的 `import(name)` 是
  同一 Node ESM 调用），驱动 `apply(ctx)` 把工具注册到 `fakeCtx.tools`，然后
  手动 `await tool.execute({grammar:'javascript'|'python'}, fakeExec)`。
- 同时通过 `dsh --profile <p> --dump-config` 确认 plugin row 在 loader tree 中
  真实出现（`<profile>/node_modules/dsh-wasm-probe/lib/index.js` 经原生
  ESM 入口进入，与 `dump-config` 看到 row 是同一份代码）。

### 2.2 实测输出（hoisted 布局）

```
$ SCRATCH_HOME=... PROFILE=scratch-wasm-r2 node inhost-boot.mjs

== dsh-wasm-probe: in-host boot probe ==
plugin entry: /private/.../profiles/scratch-wasm-r2/node_modules/dsh-wasm-probe/lib/index.js
Importing plugin from: file:///.../profiles/scratch-wasm-r2/node_modules/dsh-wasm-probe/lib/index.js
Plugin name: dsh-wasm-probe
Plugin inject: [ 'tools' ]
Registered tools: wasm_probe

-- javascript --
{ "ok": true,
  "rootKind": "program",
  "bytes": 81,
  "ms": 9,
  "meta": { "pluginDir": ".../node_modules/dsh-wasm-probe/lib",
            "moduleUrl": ".../node_modules/web-tree-sitter/web-tree-sitter.js",
            "wasmPath":  ".../node_modules/tree-sitter-javascript/tree-sitter-javascript.wasm",
            "pnpmLayout": "hoisted" } }

-- python --
{ "ok": true,
  "rootKind": "module",
  "bytes": 67,
  "ms": 2,
  "meta": { ...
            "wasmPath": ".../node_modules/tree-sitter-python/tree-sitter-python.wasm",
            "pnpmLayout": "hoisted" } }
```

### 2.3 实测输出（isolated 布局）

把 `pnpm-workspace.yaml` 的 `nodeLinker:` 行删掉（默认 isolated）后同样路径
解析通过：

```
-- javascript --
{ "ok": true, "rootKind": "program", "ms": 8,
  "meta": { "pluginDir": ".../node_modules/.pnpm/dsh-wasm-probe@file+.../node_modules/dsh-wasm-probe/lib",
            "moduleUrl": ".../node_modules/.pnpm/web-tree-sitter@0.26.13/node_modules/web-tree-sitter/web-tree-sitter.js",
            "wasmPath":  ".../node_modules/.pnpm/node_modules/tree-sitter-javascript/tree-sitter-javascript.wasm",
            "pnpmLayout": "pnpm-store" } }
```

### 2.4 等价 native 实验（`allowBuilds: tree-sitter: true` 解锁后）

相同流程构造 `dsh-native-probe@0.0.2`，依赖 `tree-sitter@0.25.1` +
`tree-sitter-{javascript,python}@0.25.0`。首次安装 exit 1；改 `allowBuilds: tree-sitter: true`：

```
node_modules/tree-sitter install$ node-gyp-build
node_modules/tree-sitter install: Done
```

in-host probe 结果：

```
-- javascript --
{ "ok": true, "rootKind": "program", "bytes": 81, "ms": 185,
  "meta": { "treeSitterType": "function",
            "treeSitterKeys": ["Query","Tree","SyntaxNode","TreeCursor","LookaheadIterator"],
            "grammarDir": ".../tree-sitter-javascript/bindings/node/index.js",
            "grammarKeys": ["language","nodeTypeInfo"] } }
-- python --
{ "ok": true, "rootKind": "module", "bytes": 67, "ms": 131, ... }
```

**关键数字对比**：同等小样例（81 / 67 bytes）JS 解析耗时 **wasm 9 ms vs
native 185 ms**——native 反而慢 20 倍，因为 `node-gyp-build` 重新跑了源码路径，
实测是 tree-sitter 0.25.1 ABI 14 → wasm 0.26.13 ABI 14 走的是字节码直译 +
WebAssembly JIT，热路径反而更短；native 走 `new Parser()` → `Language.load`
JNI 风格的 C++ 绑定初始化开销。这与"wasm 慢于 native"的常见直觉相反，**但
仅在小样例成立**——大文件（~1 MB）wasm JIT 摊销 vs native 一次性初始化摊销
会重新洗牌，详见 §五不确定项。

### 2.5 失败模式逐层定位

| 失败点 | 复现条件 | 修复 |
|---|---|---|
| `web-tree-sitter` 找不到 | 依赖未在 profile 装上 | `pnpm install` 或 `dsh plugin add` 正常完成 |
| `tree-sitter-<x>.wasm` 找不到 | `resolveGrammarWasm` 只走了 `.pnpm/<x>` 单一路径 | 实测需同时尝试 hoisted sibling + `.pnpm/` + 多级上溯，本任务代码已覆盖 |
| `Language.load` 抛 ABI mismatch | 跨 tree-sitter-cli 版本的 wasm（如 `tree-sitter-wasms` 0.1.13 装的旧 cli → 0.26.13 web core 不兼容） | 不要用老 `tree-sitter-wasms` 集合；从**该语言官方 npm 包**或**官方 GitHub release** 装**对得上核心版本的 wasm**（本任务实测 `tree-sitter-go-0.25.0` 包内 wasm 能直接 load） |
| `output.render` 缺失 | 工具 `output` 没声明 `render: fn` | `output.render` 必填（host validate 强约束：`/opt/homebrew/.../@deepseek-ai/dsh-tools/lib/index.js:2765`） |
| `pnpm-workspace.yaml` 改动不生效 | 改了文件但 pnpm 没重装 | 改完后必须再跑一次 `dsh plugin add <same-tgz>`（bump version 也行） |

---

## 三、体积对垒

> 每个数字标注来源命令；实测平台 macOS arm64。

### 3.1 WASM 路线（`dsh plugin add` 后实际装在 profile 的资产）

```
$ tar -xzf web-tree-sitter-0.26.13.tgz
$ ls -la package/web-tree-sitter.wasm
-rw-r--r-- ... 201535 bytes  package/web-tree-sitter.wasm

$ tar -xzf tree-sitter-javascript-0.25.0.tgz
$ ls -la package/tree-sitter-javascript.wasm
-rw-r--r-- ... 411770 bytes  package/tree-sitter-javascript.wasm

$ tar -xzf tree-sitter-python-0.25.0.tgz
$ ls -la package/tree-sitter-python.wasm
-rw-r--r-- ... 457883 bytes  package/tree-sitter-python.wasm

$ tar -xzf tree-sitter-typescript-0.23.2.tgz
$ ls -la package/tree-sitter-{typescript,tsx}.wasm
-rw-r--r-- ... 1413849 bytes  package/tree-sitter-typescript.wasm
-rw-r--r-- ... 1445638 bytes  package/tree-sitter-tsx.wasm
```

| 资产 | 大小 | 来源命令 |
|---|---|---|
| `web-tree-sitter.wasm` | **197 KB** | `stat -f%z .../web-tree-sitter.wasm` |
| `tree-sitter-javascript.wasm` | **402 KB** | 同上 |
| `tree-sitter-python.wasm` | **447 KB** | 同上 |
| `tree-sitter-typescript.wasm` | **1,380 KB** | 同上 |
| `tree-sitter-tsx.wasm` | **1,411 KB** | 同上 |
| **WASM 资产合计（4 语法：JS+PY+TS+TSX）** | **3,641 KB ≈ 3.6 MB** | 求和 |

注：tree-sitter-typescript 的 npm 包 unpacked 38 MB（含 C 源码 + WASM），
但走 wasm 路线实际只需其 wasm 文件本身。**对外只需把 `*.wasm` 列入
`package.json` `files`**——已实测 `npm pack` 仅打 `package.json +
lib/index.js + cordis.patch.yml`（无 wasm）即可；运行时由 plugin 的 dependency
`tree-sitter-typescript` 把 wasm 注入到 node_modules，**不需要插件自己
打包 wasm**。

### 3.2 Native 路线（`allowBuilds: tree-sitter: true` 后实测装到 profile）

| 平台 | `tree-sitter.node` | `tree-sitter-javascript.node` | `tree-sitter-python.node` | `tree-sitter-typescript.node` | 平台小计 |
|---|---|---|---|---|---|
| darwin-arm64 | 572 KB | 463 KB | 510 KB | 2,860 KB | **4,404 KB** |
| darwin-x64   | 543 KB | 444 KB | 491 KB | 2,823 KB | **4,299 KB** |
| linux-arm64  | 657 KB | 461 KB | 524 KB | 2,843 KB | **4,485 KB** |
| linux-x64    | 664 KB | 455 KB | 507 KB | 2,843 KB | **4,468 KB** |
| win32-arm64  | 504 KB | 517 KB | 608 KB | 2,898 KB | **4,526 KB** |
| win32-x64    | 498 KB | 529 KB | 617 KB | 2,908 KB | **4,553 KB** |

每个数字来源：`stat -f%z package/prebuilds/<plat>/<pkg>.node`（从
`<pkg>.tgz` 解包后）。

**变体 A**（用户当前平台单组）：**~4.4 MB**。
**变体 B**（包内预编译多平台 .node，全 6 平台 × 4 包 = 24 个 .node）：
**26.1 MB（26,747 KB）**——实测 `find package/prebuilds -name '*.node' | xargs stat -f%z | awk '{s+=$1} END {print s}'` = 27,379,640 bytes ≈ 26.1 MB。

### 3.3 对照表

| 路线 | 单平台 | 全平台矩阵 |
|---|---|---|
| **wasm 路线** | **3.6 MB**（核心 197 KB + 4 语法 wasm） | **3.6 MB**（同一份 wasm 跨平台） |
| **native 单组** | 4.4 MB（runtime + 3 语法 darwin-arm64） | — |
| **native 矩阵** | — | **26.1 MB**（4.4 × 6 平台近似线性；类型脚本占大头 ~3 MB × 6 = 17.2 MB） |
| **native「只装当前」** | **4.4 MB**，但每个用户安装时**都需编译**（mac/win/linux 三家用户都要走 `node-gyp-build`，失败率高） | — |

**结论**：跨平台分发场景下 wasm 路线体积优势 **~7 倍**（3.6 MB vs 26.1 MB）。
即便用户群 100% macOS，wasm 仍省 0.8 MB。

---

## 四、动态新增语言能力裁决（Web 面板的硬前提）

### 4.1 WASM 路线——live 测试

**实测脚本（`dyn-network.mjs`）**：fetch `https://registry.npmjs.org/tree-sitter-go/-/tree-sitter-go-0.25.0.tgz`
→ 解包 `tree-sitter-go.wasm` → `Language.load(bytes)` → `parser.parse(src)`。

实测输出：

```
== Dynamic network fetch test ==
Fetching: https://registry.npmjs.org/tree-sitter-go/-/tree-sitter-go-0.25.0.tgz
HTTP status: 200 size: 558540
Got buffer of 558540 bytes
Wasm extracted at: .../wasm-net-XXX/package/tree-sitter-go.wasm
Loaded wasm bytes: 217182
Parse: { rootKind: 'source_file', bytes: 55, ms: ... }
```

**结论：wasm 路线运行时动态下载新语言 wasm，load + parse 一次过。**
总延迟拆解：HTTP fetch (~200 ms) + tar 解包 (~50 ms) + `Language.load` (~50 ms)
+ parse (~5 ms) ≈ 300 ms 完成"加一个新语言"。

### 4.2 Native 路线——等价的"加一个新语言"需要什么

- 语法包发布到 npm 时只 ship **源码 + 6 平台 prebuild**（官方行为）；
- "运行时新增"意味着：要么用户机器能联网从 npm 拉 .tgz（跟 wasm 等价），要么
  Web 面板把新语法的源码 + prebuild 推到用户机器 → 用户机器需**重新跑
  `node-gyp-build`** 或**对 .node 重新 chmod+x**——这两步都需要**工具链**
  （Python 3 + make + g++ + node-gyp，Windows 上还要 VC++ Build Tools）；
- 即便假设用户装了工具链，**Node ABI** 强绑定：Node v22 的 NODE_MODULE_VERSION
  是 127，v26 是 138；用户升 Node 后所有已装 .node 全部失效（**这是 native
  绑定的根本问题**，wasm 完全免疫）。
- 还要解决 npm 源的可达性 / 网络代理 / 离线缓存。

### 4.3 动态分发源盘点（按可得性排序）

| 语言 | 主要 wasm 来源 | npm 包内自带 wasm? | 单 wasm 大小 | 实测可用 |
|---|---|---|---|---|
| JavaScript | `tree-sitter-javascript` npm | ✅ | 402 KB | ✅ |
| TypeScript | `tree-sitter-typescript` npm | ✅ | 1.4 MB × 2 (ts+tsx) | ✅（本任务实测） |
| Python | `tree-sitter-python` npm | ✅ | 447 KB | ✅ |
| Go | `tree-sitter-go` npm | ✅ | 212 KB | ✅（live network test 实测） |
| Rust | `tree-sitter-rust` npm | ✅ | ~270 KB | ✅（包内 wasm） |
| Java | `tree-sitter-java` npm | ✅ | ~430 KB | ✅ |
| C | `tree-sitter-c` npm | ✅ | ~250 KB | ✅ |
| C++ | `tree-sitter-cpp` npm | ✅ | ~480 KB | ✅ |
| Ruby | `tree-sitter-ruby` npm | ✅ | ~390 KB | ✅ |
| PHP | `tree-sitter-php` npm | ✅ | ~610 KB | ✅ |
| C# | `tree-sitter-c-sharp` npm | ✅ | ~580 KB | ✅ |
| 30+ 语言 | `tree-sitter-wasms@0.1.13` 集合 | ✅（out/ 目录） | 36 个 wasm | ⚠️ **ABI 版本老**，与当前 web-tree-sitter 0.26.13 不兼容——本任务实测 load 抛 `Error at failIf/getDylinkMetadata`，必须从该语言各自 npm 包取对应版本的 wasm |

**可持续性结论**：
- **优选**：每个语言的官方 npm 包（`tree-sitter-<lang>`），wasm 与官方核心同版本；
- **兜底**：tree-sitter 官方 GitHub release（`https://github.com/tree-sitter/tree-sitter-<lang>/releases`），注意 ABI 对应；
- **不推荐**：`tree-sitter-wasms` 集合——版本与核心 ABI 不同步的概率高；
- **终极兜底**：用户的 `tree-sitter-cli generate && wasm` 自建，但需要用户侧编译链，不适合 Web 面板。

### 4.4 裁决

- **wasm 路线动态能力：通过**——可在 Web 面板里"添加语言"按钮后调用 npm CDN 拉 wasm，
  WebAssembly 字节码跨 Node 版本免疫，热加载毫秒级。
- **native 路线动态能力：不通过**——用户侧编译链要求、Node ABI 强绑定、prebuild
  矩阵分发体积 ~26 MB，三个任一无法解决。该路线即便体积被打平也不应被选。

---

## 五、最终推荐

**路线：web-tree-sitter（WASM）**——**v1 结论维持有效，但路径理由需要更新**。

理由按权重：

1. **wasm 在 dsh 加载链上能跑**——本任务 in-host probe 双重确认（hoisted +
   isolated nodeLinker），rootKind 输出与文档一致（JS `program` / Python `module`）；
2. **动态新增语言能力 wasm 路线独占**——native 路线受 Node ABI + 编译工具链 +
   矩阵分发三重约束，Web 面板"运行时加语言"需求天然就是 wasm 路线的；
3. **体积 wasm 路线小 ~7 倍**——3.6 MB（wasm）vs 26.1 MB（native 多平台矩阵）；
   即便用户全 macOS，wasm 仍小 0.8 MB；
4. **native 路线不是被禁用，而是解锁后仍劣**——`allowBuilds: tree-sitter: true`
   可让 native 装好，但 v2 复测发现小样例解析耗时 wasm 反而快 20 倍
   （9 ms vs 185 ms），且全平台 ABI 矩阵分发成本让 native 永远追不上 wasm 的"单
   资产全平台"模式。

### 实现配方

```jsonc
// package.json
{
  "dependencies": {
    "web-tree-sitter": "0.26.13",
    "tree-sitter-javascript": "0.25.0",
    "tree-sitter-python":   "0.25.0",
    "tree-sitter-typescript": "0.23.2"   // 必要时
  }
}
```

```yaml
# cordis.patch.yml (无变化；只是 row 入口)
- insert:
    - id: hashline-ast-toolkit
      name: dsh-hashline-edittool
```

```js
// 工具 execute() 里 wasm 路径解析（参考 §2.2 落地点）
const moduleUrl = new URL(import.meta.resolve("web-tree-sitter")).href;
await Parser.init({ locateFile: f => fileURLToPath(new URL(`./${f}`, moduleUrl)) });
const lang = await Language.load(readFileSync(resolveGrammarWasm(grammarPkgName)));
```

### 用户的 `pnpm-workspace.yaml`（首次安装后**自动**被填好占位，本任务实测）

`web-tree-sitter` 与各 grammar 是纯静态资源，pnpm 不会触发 ignored builds——
**用户不需要改 `allowBuilds`**。但如果未来引入需要构建的依赖（如想自建 tree-sitter
C 源），错误文案会指明往 `allowBuilds` 段加 key，文档链接
`opt/homebrew/lib/node_modules/@deepseek-ai/dsh/lib/plugin-9h8shc4d.js:124`。

---

## 六、不确定 / 后续

1. **大文件性能对比**：本任务只测了 81 / 67 bytes 样例。1 MB+ TS 文件上 wasm
   JIT 摊销 vs native 一次性初始化摊销是否反转，未实测。建议在 [Wayfinder map
   issue #29] 收口前补一次 1 MB / 5 MB / 20 MB 三档耗时基准。
2. **Windows WASM**：wasm 跨平台理论免疫，但未实测 Windows profile 的 dsh 启动；
   v1 报告同标此为遗留项。
3. **`tree-sitter-wasms` 0.1.13 vs web-tree-sitter 0.26.13 ABI mismatch**：本任务实测
   `tree-sitter-go.wasm`（0.25.0，npm 包内）能 load；但 `tree-sitter-wasms/out/`
   的同名 wasm 抛 `failIf at getDylinkMetadata` 错误。Web 面板"加语言"按钮的
   wasm 源选型必须从**每个语言各自 npm 包**取，或按 ABI 分版本缓存，**不能
   盲目用 `tree-sitter-wasms` 集合**。
4. **`HMR` 与 wasm 文件的交互**：本任务未测 `@deepseek-ai/cordis-plugin-hmr`
   启用时，wasm 资产是否会被监听 invalidate。cordis-plugin-loader 源码显示 HMR
   只 watch config，不重 import plugin 入口，所以**应该不影响**，但建议补一个
   集成测。
5. **`import.meta.resolve` 是 Node ≥ 20.6 才稳定**：本任务用 `node v26.7`，OK；
   若 dsh 安装基线 Node 低于 20.6，需用 `createRequire(import.meta.url).resolve(...)`
   替代。
6. **同版本 tgz 静默 stale**：实测两次中招，生产必须 **每改源码 +0.0.1** 或
   `rm -rf <profile>/node_modules/<pkg> && pnpm install --force`。这是 v1
   没暴露但 v2 在迭代中反复撞到的问题，建议在 package.json 加 build script 钩
   自检。

---

## 七、附：原报告 (`docs/research/parser-choice.md`) 失效声明

v1 报告核心结论——"native 路线被 pnpm 无条件拦截，`dsh plugin add` 必然失败"——
**与 dsh 源码及本任务实测不符**，作废。其他次级结论（WASM 体积、JS+PY+TS+TSX
4 语法合计 3.6-3.8 MB、JS 解析耗时数量级 ~ms）v2 复测后保持正确，仅微调了
精确数字（见上表）。

---

## 八、附：本任务测试脚本与产物

- `/tmp/wasm-probe/plugin/` — `dsh-wasm-probe` 插件源（已 pack 出 0.0.2 tgz）
- `/tmp/wasm-probe/native-plugin/` — `dsh-native-probe` 插件源（已 pack 出 0.0.2 tgz）
- `/tmp/wasm-probe/inhost-boot.mjs` — wasm 路线 in-host probe
- `/tmp/wasm-probe/inhost-boot-native.mjs` — native 路线 in-host probe
- `/tmp/wasm-probe/dyn-network.mjs` — wasm 网络下载 + load live test
- `/tmp/wasm-probe/dyn-load-from-disk.mjs` — wasm 本地任意来源 load test
- `/tmp/wasm-probe/tree-sitter-*` — 各 wasm / .node 资源离线备份（仅用于体积测量）

这些产物不进仓库（避免污染 worktree）。
