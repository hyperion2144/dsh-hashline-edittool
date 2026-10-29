# `ctx.locale` 与客户端 locale seat 取证（#369）

> 调研笔记（2026-10-28）。范围只回答 #369 的五个问题：`ctx.locale` 服务契约、客户端 locale
> seat 的 `t` 解析链、插件自有词表机制、非中英语言回落英文的位置、host 侧能否读到当前语言。
> 不含实现决策——取舍留给票面。
>
> 取证手段：本机 shipped 运行时 `/Applications/DSH Desktop Plus.app/Contents/Resources/app.asar`
> （DSH Desktop 0.2.1-rc.3，内含 dsh 0.2.1-rc.3）。asar 用 `npx @electron/asar extract` 解到
> `/tmp/dsh-asar`（**未解进仓库目录**），下文引用写作
> `app.asar:dsh/node_modules/@deepseek-ai/<包>/<文件>:<行号>`。辅以宿主 profile
> `~/.dsh/profiles/desktop/cordis.patch.yml`、npm registry、本仓 `client/` 源码。
> **未做真机复现**（本会话无浏览器）。

## TL;DR

1. **host 侧没有 `ctx.locale` 这个服务。** 全量检索整个 asar，`provide("locale", …)` 只有一处，
   且在**浏览器半侧**：`app.asar:dsh/node_modules/@deepseek-ai/dsh-client-locale/lib/client.js:1526`。
   host 半侧（`…/dsh-client-locale/lib/index.js:22-26`）只注册 `locale` **设置命名空间**，
   不提供任何服务。`dsh-cordis-host-runner/lib/` 全文检索不到 "locale"。
2. **`locale` 是 client cordis 服务**，服务名就叫 `locale`，契约清单在
   `app.asar:dsh/node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js:1169-1263`：
   `getLocale` / `getSnapshot` / `subscribe` / `setLocale` / `addLanguage` / `register`（类型化 +
   单语言两种）/ `bind`（类型化 + 非类型化两种）。当前语言从 `getLocale()` 读，语言只经
   `setLocale(id)` 切换（唯一的偏好写入口）。
3. **locale seat 的机制**：slot 注册项上的 `locale: "<namespace>"` 是一个**命名空间**声明；
   渲染时 renderer 用 `ctx.slots.installLocale(face)` 装上的 face 生成 `t` 并注入组件 props
   （`app.asar:dsh/node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js:742-746`）。
   `t(key, params)` 的解析链是 **entry namespace → `common` → key 本身**
   （`…/dsh-client-locale/lib/client.js:1423-1427`）。
4. **插件自有词表**：`ctx.effect(() => ctx.locale.register(NS, { zh, en }), "…: dictionaries")`
   + slot 注册写 `locale: NS`。先例：`…/dsh-client-ui-skill/lib/client.js:355-364`、
   `…/dsh-client-ui-user-questions/lib/client.js:1900-1903`；完整模板：
   `…/dsh-client-ui-workspace/README.md:112-168`。
5. **非中英回落英文**在 `fallbackChain()`：`app.asar:dsh/node_modules/@deepseek-ai/dsh-client-locale/lib/client.js:1382`
   ——链里没有 `en` 就补一个 `en`。浏览器名不出已注册语言时也回落 `en`（同文件 `:1462`）。
6. **host 侧读不到"当前语言"**。最多能读到 settings document 里 `locale` 命名空间的
   `preference`（存储偏好），而生效语言可能是浏览器推导的临时值，host 无从得知。
   ⇒ 本插件 `lossyNote` 这类 **host 文案无法在 host 侧本地化**。
7. **顺带查出一个现存缺陷**：本插件复用的 `conversation` 命名空间里**没有**
   `diff.files.one` / `diff.files.other` / `lsp.title` / `lsp.diagnostics.summary` 这四个 key，
   而 `t()` 找不到 key 时**显示 key 本身**（同文件 `:1425` 的 `?? key`）——所以 diff 卡页脚现在
   显示字面量 `diff.files.one`，LSP 卡页脚显示字面量 `lsp.diagnostics.summary`。

## 1. host 侧 `ctx.locale`：不存在

### 1.1 证据

| 检索 | 结果 |
| --- | --- |
| 全 asar 检索 `provide("locale"` | 唯一命中 `app.asar:dsh/node_modules/@deepseek-ai/dsh-client-locale/lib/client.js:1526`，在 `apply(ctx)`（浏览器半侧）里 |
| `app.asar:dsh/node_modules/@deepseek-ai/dsh-cordis-host-runner/lib/` 检索 `locale` | 无匹配 |
| 客户端服务清单里的 `locale` 条目 | `app.asar:dsh/node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js:1169-1172`（**只有 client runner 有**） |

host 半侧只做一件事（`app.asar:dsh/node_modules/@deepseek-ai/dsh-client-locale/lib/index.js:22-26`）：

```js
function apply(ctx) {
	ctx.inject(["settings"], (child) => {
		child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
	});
}
```

同文件 `:5-7` 定义了两个常量：设置命名空间 `locale`、字段 `preference`。

⇒ **host 侧 `ctx.locale` 是 `undefined`。** 任何在 host 半侧写 `ctx.locale.getLocale()` 的插件
都会拿到 `undefined`（或 `ctx.get("locale")` 返回 `undefined`）。

### 1.2 那 host 侧"语言"到底存在哪

存在 **settings document**（`$DSH_HOME/cordis.patch.yml`）里，命名空间 `locale`、字段 `preference`。
本机 profile 里它已被显式写成 `zh`：

- `~/.dsh/profiles/desktop/cordis.patch.yml:250-253`
  ```yaml
  - id: locale
    name: "@deepseek-ai/dsh-client-locale"
    config:
      preference: zh
  ```

客户端读它的路径是 `ctx.configForms.get("locale")`（settings scope）
（`app.asar:dsh/node_modules/@deepseek-ai/dsh-client-locale/lib/client.js:1517`）。

## 2. 客户端 `locale` 服务契约

权威文本是客户端 runner 的服务清单
（`app.asar:dsh/node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js:1169-1263`）：

| 方法 | 签名 | 行号 |
| --- | --- | --- |
| 读当前快照 | `getLocale(): LocaleSnapshot` | `:1175` |
| LocaleFace 读 | `getSnapshot(): LocaleSnapshot` | `:1181` |
| LocaleFace 订阅 | `subscribe(fn: () => void): () => void` | `:1187` |
| 切换语言（唯一写入口） | `setLocale(id: string): void` | `:1196` |
| 注册语言包定义 | `addLanguage(input: LanguageRegistration): () => void` | `:1204` |
| 注册词表（类型化） | `register<N extends keyof LocaleNamespaceMap>(ns: N, dicts: Record<BuiltInLocaleId, LocaleDictOf<N>>): () => void` | `:1214` |
| 注册词表（单语言，语言包用） | `register(ns: string, locale: string, dict: LocaleDict): () => void` | `:1226` |
| 绑定翻译函数（类型化） | `bind<N extends keyof LocaleNamespaceMap>(ns: N): TranslateNS<N>` | `:1246` |
| 绑定翻译函数（非类型化） | `bind(ns: string): Translate` | `:1255` |

服务清单的 description 把查找链写死了（同文件 `:1172`）：

> Lookup walks the active language's declared fallback chain in the entry namespace, then repeats
> it in the shared common namespace before showing the key itself.

其它相关类型（同一份清单）：

- `LocaleSnapshot = { active: LocaleId; locales: readonly LocaleDefinition[]; revision: number }`（`:1986`）
- `LocaleNamespaceMap` 是**空 interface**，靠声明合并扩展（`:1982`）
- `LocaleDictOf<N> = Record<LocaleNamespaceMap[N] & string, string>`（`:1970`）
- `LocaleKeysOf<N> = (LocaleNamespaceMap[N] & string) | CommonKeyOf`（`:1978`）
- `PropsLocale<N> = { t: TranslateNS<N> }`（`:2058`）
- `StoredEntry.locale?: string | undefined`（`:2282`）——注册项上 `locale` 是**顶层命名空间字符串**

**注意**：`resolveText(text)` 在实现里有（`…/dsh-client-locale/lib/client.js:1241-1243`）、
README 也推荐用它解析包标题/描述（`…/dsh-client-locale/README.md:42`），但**它不在上面这份服务
契约清单里**——服务清单只列了 9 个方法。⇒ 依赖 `resolveText` 时按"实现存在、契约未列"看待。

### 2.1 当前语言从哪读

`ctx.locale.getLocale()` / `getSnapshot()` 返回不可变快照，`active` 就是生效语言
（`…/dsh-client-locale/lib/client.js:1232-1233`、`:1250-1251`）。

`active` 的解析顺序（`…/dsh-client-locale/lib/client.js:1343-1346`）：

```js
resolveActive() {
	if (this.preference === void 0) return this.provisional;
	return this.catalog.get(localeKey(this.preference))?.id ?? this.provisional;
}
```

即 **显式偏好优先**；偏好的语言包还没注册 ⇒ 退回 `provisional`（浏览器推导值）。

### 2.2 语言如何切换

唯一写入口 `setLocale(id)`（`…/dsh-client-locale/lib/client.js:1278-1284`）：

1. 未知 id 直接 throw；
2. 写 `this.preference`；
3. 若 active 变了 ⇒ `publish(id, true)`；
4. **总是**写持久化：`this.host?.set(LOCALE_PREFERENCE_FIELD, match.id)`（settings scope 的 `locale.preference`）。

UI 入口是「设置 → 常规 → 语言」行，注册在 `settings.general.item` 槽
（`…/dsh-client-locale/lib/client.js:1553-1560`，`id: "language"`, `order: 0`）。

生效语言变化时发 `locale/change` 事件（同文件 `:1449`）；**词表注册不发这个事件**，只推进
`revision`（`:1436-1442` 的注释说明：避免启动期大量注册把事件监听器打爆）。

### 2.3 原生壳的额外通道

Electron 壳可以提供 `globalThis.__DSH_LOCALE__`（`read()` + `onChange(locale)`），
客户端在 `apply` 里读它作为 bootstrap（`…/dsh-client-locale/lib/client.js:1504-1516`），
并在切换时回调 `onChange`（`:1527-1531`）。DSH Desktop Plus 的实现见
`app.asar:lib/main.js:16720-16726`（`localeBootstrap` IPC）与 `:12920-12927`
（`readLocalePreference` ⇒ 走 host 的 `settings.describe`）。

## 3. 客户端 locale seat：`locale:"conversation"` 到底做了什么

### 3.1 声明 → 注入

slot 注册项上的 `locale` 是一个**命名空间字符串**（`StoredEntry.locale?: string`，
`app.asar:dsh/node_modules/@deepseek-ai/dsh-cordis-client-runner/lib/client.js:2282`）。
渲染时（`app.asar:dsh/node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js:742-746`）：

```js
if (entry.locale !== void 0) {
	const face = host.locale;
	if (face === void 0) throw new SlotAssemblyError(`entry declares locale namespace '${entry.locale}' but no locale face is installed (locale plugin missing from the composition?)`);
	kit["t"] = localeSeat(face, entry.locale);
}
```

- 没有装 face 就**抛错**（不是降级）；
- Factory 变体同理（`:949-953`）。

`localeSeat(face, ns)`（同文件 `:541-557`）按 `(face, ns, revision)` 缓存，命中缓存直接返回旧
引用；否则 `face.bind(ns)` 再包一层 `(key, params) => bound(key, params)`。**revision 进缓存键是
刻意的**：切语言会为每个命名空间铸造**新的函数引用**，于是吃 `t` 的 `React.memo` 组件靠浅比较
自然重渲（注释 `:534-540`）。

face 从哪来：`ctx.slots.installLocale(locale)`（`…/dsh-client-locale/lib/client.js:1533`），
renderer 侧的实现见 `…/dsh-client-ui-renderer/lib/client.js:1450-1457`（**boot-once**：
装第二次直接 throw），并通过 `host.locale` getter 暴露（`:1674-1676`）。

组件重渲由 `useLocaleRevision(host.locale)` 驱动（`…/dsh-client-ui-renderer/lib/client.js:587-590`，
`useSyncExternalStore` 订阅 face 的 revision）；`SlotOutlet` 与 `RootOutlet` 都调它
（`:1120`、`:1236`）。

### 3.2 `t(key, params)` 的解析链

`t` 最终落到 `LocaleRuntime.translate(ns, key, params)`
（`app.asar:dsh/node_modules/@deepseek-ai/dsh-client-locale/lib/client.js:1423-1427`）：

```js
translate(ns, key, params) {
	const chain = this.fallbackChain(this.snapshot.active);
	const template = this.lookup(ns, key, chain) ?? (ns !== "common" ? this.lookup("common", key, chain) : void 0) ?? key;
	if (!params) return template;
	return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
}
```

即：

1. **entry namespace**（= 注册项里 `locale:` 写的那个）按语言链查；
2. 落空 ⇒ **`common`** 命名空间按同一条链查；
3. 再落空 ⇒ **显示 key 本身**；
4. `{name}` 占位符由 `params` 替换（缺失的占位符原样留下）。

`lookup(ns, key, chain)` 遍历链、逐个语言取 `dicts.get(ns).get(locale)?.[key]`
（同文件 `:1429-1434`）。

**这条链只有两级：entry namespace → common。** 没有"→ 别的 namespace"的回落。

### 3.3 两个命名空间的归属

| 命名空间 | 拥有者 | 注册处 |
| --- | --- | --- |
| `common` | `dsh-client-locale` 自己 | `…/dsh-client-locale/lib/client.js:1137`（`COMMON_NS`）、`:1518-1521`（注册 zh/en） |
| `conversation` | `dsh-client-ui-conversation` | `…/dsh-client-ui-conversation/lib/client.js:16073`（`NS = "conversation"`）、`:19716-19719`（注册 zh/en） |

`common` 里有的 key（`app.asar:dsh/node_modules/@deepseek-ai/dsh-client-locale/lib/client.js`
的 `:933-934`、`:957-959` zh；`:979-980`、`:1003-1005` en）：
`ok` `cancel` `close` `copy` `copied` `codeBlock.*` `edit` `save` `search` `more` `collapse` `expand` `back`。

`conversation` 里与本插件相关的 key：

| key | zh | en | 出处（zh / en） |
| --- | --- | --- | --- |
| `read.window` | 显示 {shown} / {total} 行 | Showing {shown} of {total} lines | `:16408` / `:16786` |
| `read.collapseAria` | 收起内容 | Collapse content | `:16409` / `:16787` |
| `read.expandAria` | 展开其余 {count} 行 | Expand {count} more lines | `:16410` / `:16788` |
| `read.expandRest` | … 其余 {count} 行 | … {count} more lines | `:16411` / `:16789` |
| `diff.collapseAria` | 收起差异 | Collapse diff | `:16405` / `:16783` |
| `diff.expandAria` | 展开其余 {count} 行差异 | Expand {count} more diff lines | `:16406` / `:16784` |
| `diff.expandRest` | … 其余 {count} 行 | … {count} more lines | `:16407` / `:16785` |
| `search.matches` | {shown} 处匹配 · {files} 个文件 | {shown} matches · {files} files | `:16414` / `:16792` |
| `search.matches.truncated` | 显示 {shown} / 共 {total} 处匹配 · {files} 个文件 | Showing {shown} of {total} matches · {files} files | `:16415` / `:16793` |
| `search.noResults` | 无结果 | No results | `:16416` / `:16794` |
| `search.collapseAria` / `expandAria` / `expandRest` | — | — | `:16417-16419` / `:16795-16797` |
| `row.running` / `row.failed` / `row.stopped` | 运行中 / 失败 / 已停止 | Running / Failed / Stopped | `:16375-16378` / `:16753-16756` |
| `tool.title.read` | 读取 | Read | `:16386` / `:16764` |
| `tool.title.grep` | 搜索文件内容 | Grep | `:16398` / `:16776` |

（行号均指 `app.asar:dsh/node_modules/@deepseek-ai/dsh-client-ui-conversation/lib/client.js`。）

### 3.4 由此暴露的本插件现存缺陷


本插件当前把**十个 toolview key**（read / edit / write / grep / undo_last_edit / delete /
ast_grep / ast_edit / lsp / format）外加一张设置卡，全部注册在 `locale: "conversation"` 上
（`client/src/client/index.ts:41` 的 `CONVERSATION_NS = "conversation"`；注册处 `:77`、`:91`、
`:114`、`:128`、`:142`、`:156`、`:192`（ast/format 四键在同一个 for 循环里）、`:237`），
因此 `t` 解析到的是 `conversation` 命名空间。

但本插件用到的四个 key **在 shipped DSH 里根本不存在**（全量检索
`app.asar:dsh/node_modules/@deepseek-ai/` 无匹配）：

| 本插件调用 | 出处 | 实际显示 |
| --- | --- | --- |
| `t("diff.files.one")` / `t("diff.files.other")` | `client/src/client/labels.ts:80` | 字面量 `diff.files.one` / `diff.files.other` |
| `t("lsp.title")` | `client/src/client/labels.ts:98` | 字面量 `lsp.title` |
| `t("lsp.diagnostics.summary")` | `client/src/client/labels.ts:106` | 字面量 `lsp.diagnostics.summary` |

前两个落在**可见文本**上：

- diff 卡页脚：`client/src/client/diff-block.tsx:560`
  `` `└ +${added} -${removed} · ${labels.files(fileGroups.length)}` ``
- LSP 卡页脚：`client/src/client/lsp-block.tsx:233`
  `jsx_("div", { className: css.footer, children: labels.summary(rows.length, messageCount) })`

⇒ 这是「插件注册自有词表」最直接的动机：**不是锦上添花，是补洞**。

## 4. 插件如何注册自己的词表

### 4.1 两个先例（shipped 代码）

**`dsh-client-ui-skill`**（`app.asar:dsh/node_modules/@deepseek-ai/dsh-client-ui-skill/lib/client.js`）：

```js
const inject = [
	"inputTriggers", "sessions", "slots", "locale", "remote",
	"remote.skills", "sidebarRight", "uiConversation"
];                                          // :339-349

function apply(ctx) {
	ctx.effect(() => ctx.locale.register(NS, {
		zh,
		en
	}), "ui-skill: dictionaries");            // :355-358
	…
	ctx.slots.inject("tool.call.toolview", () => ctx.slots.register({
		name: "tool.call.toolview",
		key: "skill",
		locale: NS                              // :360-364
	}, SkillRow));
}
```

**`dsh-client-ui-user-questions`**：`NS = "question"`（`:1633`），
`ctx.effect(() => ctx.locale.register(NS, { zh, en }), "ui-user-questions: dictionaries")`（`:1900-1903`）。
它的 README 把这条规矩写成文（`…/dsh-client-ui-user-questions/README.md:82`）：

> the plugin registers zh/en dictionaries under the `question` namespace of `dsh-client-locale`
> and hands the entry its bound translator plus the locale snapshot source through the inject face

### 4.2 官方给插件作者的完整模板

`app.asar:dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace/README.md:112-168`（原文照录）：

```tsx
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {
  InjectFace, LocaleDictOf, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'

const NS = 'acme.sessionActions'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'acme.sessionActions': 'export'
  }
}

const en: LocaleDictOf<typeof NS> = { export: 'Export {title}' }
const zh: LocaleDictOf<typeof NS> = { export: '导出 {title}' }

type ExportRowProps =
  PropsRuntime<'sidebar.workspaces.session.menu.item'>
  & PropsLocale<typeof NS>
  & InjectFace<ExportRowInjected>

export const inject = ['slots', 'locale']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'acme-session-actions: dictionaries')

  ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.menu.item',
    id: 'acme.export-session',
    order: 500,
    locale: NS,
    inject: (): ExportRowInjected => ({ exportSession }),
  }, ExportRow))
}
```

要点：

1. **类型入口是 `@deepseek-ai/dsh-client-ui-slots`**（`LocaleNamespaceMap` / `LocaleDictOf` /
   `PropsLocale` 都在那儿）。该包**已发布到 npm**（`npm view @deepseek-ai/dsh-client-ui-slots` →
   `latest 0.0.1-rc.1`，`next 0.2.1-rc.4`），但在 asar 里**没有独立运行时包**——它是类型包，
   运行时服务由 `dsh-client-locale`（提供 `locale`）与 `dsh-client-ui-renderer`（提供 slots）承担。
   `dsh-client-locale` 自己也把它列为 devDependency（`…/dsh-client-locale/package.json:53`）。
2. **声明合并**：`declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { … } }`。
   `LocaleNamespaceMap` 本身是空 interface（`dsh-cordis-client-runner/lib/client.js:1982`）。
3. **类型化 `register(ns, {zh, en})` 要求两个内置语言齐全**，且 key 集合要与声明的并集严格相等
   （契约描述 `…/dsh-cordis-client-runner/lib/client.js:1215`）；`(ns, locale)` 重复注册会 throw
   （「一个命名空间的文本只有一个主人」，同文件 `:1215`；实现见
   `…/dsh-client-locale/lib/client.js:1395`）。
4. **必须 `inject: ['locale']`**，否则 cordis 会因为服务不存在而 park 住整个插件。
5. 本仓 `client/package.json:55-63` 目前只有 `@deepseek-ai/cordis` 与
   `@deepseek-ai/dsh-client-ui-primitives` 两个 devDependency；`client/src/client/types.ts:1-8`
   明确说明「dsh client 类型面（`@deepseek-ai/dsh-client-ui-slots` 的 SlotMap 增强等）住在
   shell-only 包里，所以浏览器半侧改成编译这些结构镜像」。⇒ 本插件若要用
   `LocaleDictOf`/`PropsLocale` 这类真类型，需要**新增 devDependency**
   `@deepseek-ai/dsh-client-ui-slots`（类型包，不进运行时依赖，符合 AGENTS.md 第 5 条）。

### 4.3 本插件注册自有词表后必须注意的一条硬约束

`translate` 的回落只有 `entry namespace → common → key`
（`…/dsh-client-locale/lib/client.js:1425`），**没有 `→ conversation` 这一跳**。而
`conversation` 命名空间已被 `dsh-client-ui-conversation` 独占注册（`:19716-19719`），
插件**不能**再往里注册（`(ns, locale)` 重复即 throw）。

⇒ **一旦把 slot 的 `locale` 从 `"conversation"` 改成插件自有命名空间，本插件现在借用的
`read.*` / `diff.*` / `search.*` / `row.*` / `tool.title.*` 这些 key 全部会失配、显示 key 本身。**
所以自有词表必须**把这些用到的 key 一并复制进插件自己的 zh/en 字典**（这正是「插件自有词表」
的完整含义），或者保持 `locale: "conversation"` 不动、另开一条只承载新文案的注册。

## 5. 非中文、非英文语言下回落英文的确切实现

全部在 `app.asar:dsh/node_modules/@deepseek-ai/dsh-client-locale/lib/client.js`：

| 行为 | 代码 | 行号 |
| --- | --- | --- |
| **查找链末尾补 `en`** | `if (!seen.has(localeKey("en"))) chain.push("en");` | `:1382` |
| 链的构造（active → fallback → fallback…） | `fallbackChain(start)` | `:1368-1385` |
| 语言包必须能回落到 `en`（注册时校验） | `assertFallbackChain`：`if (key === localeKey("en")) return;` + 「chain does not reach "en"」 | `:1352-1366` |
| 浏览器名不出已注册语言 ⇒ `en` | `return detectBrowserLocale(locales, languages) ?? "en";` | `:1461-1462` |
| `en` 是常量（兼「非浏览器运行的兜底」） | `const FALLBACK_LOCALE = "en";`（含设计注释） | `:1126-1135` |
| 语言包定义 | `addLanguage({ id, label, fallback })`：fallback 必须已注册、链必须终止于 `en`、重复 id / 环都 throw | `:1297-1319` |
| 语言包的单语言词表注册 | `register(ns, locale, dict)`（契约 `:1226`；实现 `:1387-1396`） | |

注册语言包的官方写法（`…/dsh-client-locale/README.md:44-66`）：

```js
export const inject = ['locale']
export function apply(ctx) {
  ctx.effect(() => ctx.locale.addLanguage({ id: 'ja', label: '日本語', fallback: 'en' }), 'my-locale: language')
  ctx.effect(() => ctx.locale.register('common', 'ja', { cancel: 'キャンセル', close: '閉じる' }), 'my-locale: common dictionary')
}
```

README 同处（`:66`）写明了查找次序：

> Lookup walks the fallback chain in the requested namespace, repeats it in `common`, then displays
> the key.

**Electron 壳另有一套只认 zh/en 的回落**（壳自己的 UI 文案，与 client 词表是两套）：
`app.asar:lib/main.js:11539-11546`（`resolveDesktopLocale`）、`:11554-11558`
（`resolveDesktopStartupLocale`）、`:11609-11610`（`platformWireLocale` → `zh_CN` / `en_US`）。

## 6. host 侧能否读到当前语言（用于拼装 host 文案）

**不能可靠地读到。** 分三层说：

1. **没有 `ctx.locale`**（§1.1）。host 插件拿不到 locale 服务，也拿不到"生效语言"。
2. **只能读到存储的偏好**。Electron 壳的先例（`app.asar:lib/main.js:12920-12927`）是走 host 的
   `settings.describe`，再从返回的 namespaces 里找 `ns === "locale"` 取 `value.preference`
   （解析函数 `localePreference`，`:12858-12861`）。settings 服务的 `describe()` 在
   `app.asar:dsh/node_modules/@deepseek-ai/dsh-settings/lib/index.js:413-463`，返回项形如
   `{ ns, schema, revision, applies, value, base, user }`（`:441-450`）。
   注意这是 **Host 设置文档里的持久值**，取值可能是 `undefined`。
3. **而生效语言未必等于存储偏好**。生效值是 `resolveActive()`（`…/dsh-client-locale/lib/client.js:1343-1346`）：
   偏好为空 ⇒ 用 `provisional`；偏好的语言包没注册 ⇒ 也用 `provisional`。
   `provisional` 来自浏览器 `navigator.languages`（`:1214`、`:1476-1489`），**host 完全看不到**。
   ⇒ host 侧拼出来的文案，可能和用户眼前的语言不一致。

**对本插件的直接后果**：`read` 卡的 `lossyNote` 是 host 写的常量
（`src/read-and-serve.ts:24-25` 的 `LOSSY_BYTES_NOTE`，在 `src/tools/tool-read.ts:655-659`
被塞进 presentation meta）。它现在是**硬编码英文**，且：
- host 无法按用户语言产出它；
- 客户端也不该解析 host 文案（`client/src/client/read-meta.ts:38-40` 是把 host 的字符串**原样**
  渲染进页脚）。

⇒ **要么 host 侧保持英文（现状），要么把这条文案改成"客户端按 key 查"的结构**——即 host 只写
一个稳定的 key/标记，客户端用 `t()` 查自有词表。这条路需要改 wire 形状，属于票面 #369 之外的
设计决策，本笔记只给证据。

## 7. 未证实 / 待做

- **未做真机复现**：没有在浏览器里验证"切到 ja 后 `t` 的回落链确实是 `ja → en`"，也没验证
  `diff.files.one` 这类缺失 key 在真实页面上确实显示为字面量。结论来自源码静态取证。
- **未证实 `dsh-client-ui-slots` 的运行时角色**：该包在 asar 里没有独立产物；推断它是类型包
  （`dsh-client-locale`、`dsh-client-ui-shortcuts` 等把它列为 devDependency），运行时由
  `dsh-client-locale` + `dsh-client-ui-renderer` + `dsh-cordis-client-runner` 承担。**未在运行时
  验证过这个推断**。
- **未证实官方（非 Plus）版 DSH 的宿主是否有同样的 `locale` 半侧**：本笔记只针对本机
  DSH Desktop Plus 0.2.1-rc.3 内含的 dsh 0.2.1-rc.3。
- **未证实 `resolveText` 是否属于公开契约**：实现里有（`…/dsh-client-locale/lib/client.js:1241`）、
  README 推荐用（`README.md:42`），但客户端服务清单没有列它。
- **待做**：本插件要落自有词表，需要先定下"命名空间名 + key 集合 + 是否整体搬走
  `conversation` 的那些 key"；以及 `lossyNote` 是否改成 key 化的 wire 形状。
