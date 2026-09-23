# 0.1.7-alpha.1 运行时内置 Agent Preset id 全集与种子列表差集

> 调研对象：`com.arcreel.dsh-desktop-tauriapp/runtimes/0.1.7-alpha.1`
> 对比基准：`src/guidance/materialize.ts` 的 `DEFAULT_PRESETS`
> 调研方法：只读本机文件。运行时 `node_modules/@deepseek-ai/` 下，`dsh-agent-preset` 与 `dsh-agent-preset-registry` 两包是声明/注册两个协作面；所有 bundle 包通过 `package.json` 的 `dsh.bundle.patch` 列表加载 `cordis.patch.yml`，preset 身份由其中 `@deepseek-ai/dsh-agent-preset` 行的 `config.id` 决定。

---

## 结论先行（TL;DR）

| 维度 | 结论 |
| --- | --- |
| **内置 preset id 全集** | `standard`、`ptc`、`minimal`、`cordis`（4 个，按 `order` 字段排序：1 / 2 / 3 / 4） |
| **默认 preset** | `standard`（`dsh-web-app/cordis.patch.yml` 第 543–544 行 `agent-preset-registry` 配置 `default: standard`） |
| **声明包** | 4 个 preset 全部由 bundle `@deepseek-ai/dsh-web-app`（v0.1.7-alpha.1）的 `presets/*.patch.yml` 装载 |
| **可选安装** | 无——`experimental-*` / `speech-to-text` / `voice-input-bundle` 等没有声明任何 `agent-preset` 行；`dsh-base` 提到的 `presets` 是 sandbox 权限（`read-only` / `workspace-write` / `danger-full-access`），不是 agent preset |
| **`DEFAULT_PRESETS` 差集** | **需增补 `ptc`**；`code` 不存在（应改为改名/移除） |
| **建议** | **改**。把 `DEFAULT_PRESETS` 调整为 `["standard", "ptc", "minimal", "cordis"]`；如保留 `code` 作为老 id 别名，则需另作迁移说明 |

---

## 1. 注册面 vs 声明面

`dsh-agent-preset` 与 `dsh-agent-preset-registry` 两个包在 0.1.7 里分别承担「声明」与「注册」：

### 1.1 `@deepseek-ai/dsh-agent-preset`（声明面）

源码证据：`node_modules/@deepseek-ai/dsh-agent-preset/lib/index.js:6-27`

```
/** A declarative preset row in an ordinary Cordis composition. */
var AgentPreset = class {
  ...
  static inject = ["agentPresets"];
  static [EntryGroup.key] = true;
  static Config = z.object({
    id: z.string().required(),
    name: z.string(),
    description: z.string(),
    order: z.number(),
    plugins: z.array(z.any()).required()
  });
  constructor(ctx, config) { this.ctx = ctx; this.config = config; }
  async *[Service.init]() {
    yield await this.ctx.agentPresets.register(this.config);
  }
};
```

——一行 `id: <name>` 就是一个 preset；该 row 的 `config.plugins` 是 agent 真正看到的子插件列表。

### 1.2 `@deepseek-ai/dsh-agent-preset-registry`（注册面）

源码证据：`node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/index.js:411-513`

```
class AgentPresetRegistry extends TypertRemoteService {
  static inject = ["loader", "sessionProjections"];
  static Config = z.object({
    default: z.string().required(),
    selectedDefault: z.string().volatile(),
    modeSelectionEnabled: z.boolean().default(true).volatile()
  });
  definitions = new Map();
  ...
  async register(definition) {
    if (!definition.id.trim()) throw new Error("Preset id must not be empty");
    if (this.definitions.has(definition.id)) throw new Error(`Duplicate agent preset: ${definition.id}`);
    ...
  }
  ...
}
```

——register 端只关心 `definition.id`，所以「内置」等价于「哪个 plugin 在 Loader 里被注入了一行 `dsh-agent-preset`」。

---

## 2. 内置 preset id 全集与证据

`dsh.bundle.patch` 列表是真正装载 preset 的地方。全 runtime 内有且仅有 `dsh-web-app` 同时声明了 `dsh-agent-preset-registry` 与 4 个 `dsh-agent-preset` 行：

| preset id | order | 来源 patch | 关键证据行 |
| --- | --- | --- | --- |
| `standard` | 1 | `node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml` | 第 5 行 `- id: preset-standard` + 第 8 行 `id: standard` |
| `ptc`     | 2 | `node_modules/@deepseek-ai/dsh-web-app/presets/ptc.patch.yml`     | 第 5 行 `- id: preset-ptc` + 第 8 行 `id: ptc` |
| `minimal` | 3 | `node_modules/@deepseek-ai/dsh-web-app/presets/minimal.patch.yml` | 第 5 行 `- id: preset-minimal` + 第 8 行 `id: minimal` |
| `cordis`  | 4 | `node_modules/@deepseek-ai/dsh-web-app/presets/cordis.patch.yml`  | 第 5 行 `- id: preset-cordis` + 第 8 行 `id: cordis` |

装载顺序由 `node_modules/@deepseek-ai/dsh-web-app/package.json` 第 41–50 行 `dsh.bundle.patch` 决定：

```jsonc
"dsh": {
  "bundle": {
    "patch": [
      "./cordis.patch.yml",
      "./presets/standard.patch.yml",
      "./presets/ptc.patch.yml",
      "./presets/minimal.patch.yml",
      "./presets/cordis.patch.yml"
    ]
  }
}
```

`./cordis.patch.yml` 的最后一段（`node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml:541-544`）插入了注册行并指明默认 preset：

```yaml
- id: agent-preset-registry
  name: '@deepseek-ai/dsh-agent-preset-registry'
  config:
    default: standard
```

→ 4 个内置预设声明、默认 preset = `standard`，双重独立来源（package.json 的 bundle.patch 清单 + 4 个独立 patch 文件中的 `id:` 字段）。

---

## 3. 与 `DEFAULT_PRESETS` 的差集

种子列表（`src/guidance/materialize.ts:14-19`）：

```ts
export const DEFAULT_PRESETS: readonly string[] = [
    "standard",
    "code",
    "minimal",
    "cordis",
];
```

差集（按 0.1.7-alpha.1 实际声明）：

| 操作 | id | 说明 |
| --- | --- | --- |
| 新增 | `ptc` | 0.1.7 才出现（`dsh-agent-tool-presentation` + `mode: ptc`），未在种子列表里 |
| 删除 / 改名 | `code` | 0.1.7 内置清单里**没有** `code` 这个 id。可能是从老版本目录残留或历史别名迁过来的——若保留它，插件会写入无意义目录 |
| 保留 | `standard` / `minimal` / `cordis` | 与运行时完全一致 |

---

## 4. 可选安装类（实验包 / 单一来源）

调研方法要求把「只在单个实验性包里出现」的预设单列。下面是逐包核验结果：

| 包 | 是否声明 agent preset | 备注 |
| --- | --- | --- |
| `dsh-experimental-agent-team-profile/cordis.patch.yml` | ❌ | 改写 `tool-subagent-*` 行为并新增 `dsh-experimental-tool-agent-team` / `dsh-experimental-client-ui-agent-team`；**没有** `dsh-agent-preset` 行 |
| `dsh-experimental-voice-input-bundle/cordis.patch.yml` | ❌ | 仅放 `voice-input`，无 preset |
| `dsh-experimental-speech-to-text-*` 系列 | ❌ | 仅转写服务，无 preset |
| `dsh-experimental-agent-team` / `dsh-experimental-tool-agent-team` | ❌ | 同上 |
| `dsh-base/cordis.patch.yml:252` 提到的 `presets:` | ❌（不是 agent preset） | 这是 `dsh-permission-presets` 的 sandbox 权限预设：`read-only` / `workspace-write` / `danger-full-access`，与 agent preset 是不同概念（不同 Service：`permissions` vs `agentPresets`） |
| `dsh-headless/cordis.patch.yml` / `dsh-sdk-app/cordis.patch.yml` / `dsh-sdk-minimal/cordis.patch.yml` / `dsh-acp-app/cordis.patch.yml` | ❌ | 没有 preset 行；headless/sdk/acp 直接走 TUI 或 ACP 客户端，agent 进程内 composition |
| `dsh-web-app/presets/cordis.patch.yml` | ✅ | 属于 4 个内置之一（`cordis`），不是「可选安装」 |

→ **结论**：0.1.7-alpha.1 里没有任何「可选安装」的 agent preset；可选安装概念暂时只在运行时通过 `dsh-client-ui-plugin-manager` 让用户手动安装 profile bundle 后由其 patch 文件注入。

---

## 5. 对 `DEFAULT_PRESETS` 的改动建议

### 5.1 推荐改动

将 `src/guidance/materialize.ts:14-19`：

```ts
export const DEFAULT_PRESETS: readonly string[] = [
    "standard",
    "code",
    "minimal",
    "cordis",
];
```

改为：

```ts
export const DEFAULT_PRESETS: readonly string[] = [
    "standard",
    "ptc",
    "minimal",
    "cordis",
];
```

理由：
- 运行时实际只有 4 个：`standard` / `ptc` / `minimal` / `cordis`（`order` 1/2/3/4 也是这个顺序）。
- `code` 在 0.1.7 没有任何声明，会让引导脚本凭空在 `<homeDir>/code/` 下创建空白目录，触发「空白目录 + 没有 README」的混淆状态。
- `ptc` 是 0.1.7 的新预设（基于 `dsh-agent-tool-presentation` + `mode: ptc`），是用户在新版本中最可能选择的目标。
- 用户在引导前已经手动编辑过的 `code/` 自定义目录不会被自动删除（`materialize.ts:170-188` 只对目录中存在的文件做「修复空白」），所以迁移是安全的——只是新机器/新工作区不再自动产生空目录。

### 5.2 不改的代价

若保留 `["standard", "code", "minimal", "cordis"]`：
- 会在新机器上生成 4 个目录，其中 `code/` 永远没有运行时对应的 preset；用户的 `dsh-hashline-edittool guidance` 配置在「code preset」下是死路——模型不可能以 `code` 为预设启动（设置页下拉里也没有 `code`）。
- README 中 `GUIDANCE_HOME_README` / `GUIDANCE_HOME_README_ZH`（`materialize.ts:25-98`）列出的 4 个 preset 与实际可用清单不一致，会误导用户。

### 5.3 不在范围内的次级事项

- README 文案（`materialize.ts:25-63` / `65-98`）中同样列出了 `standard / code / minimal / cordis` 字面量；如改动 `DEFAULT_PRESETS`，这两段 README 也要同步替换为 `standard / ptc / minimal / cordis`。
- 任何下游 `iteration(entry.name)` 之类的别名兼容逻辑本仓库没有，可保持简单。

---

## 6. 调研路径完整索引（便于复现）

| 步骤 | 路径 / 文件 | 关注点 |
| --- | --- | --- |
| 1. 找注册入口 | `node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/index.js:411-513` | `AgentPresetRegistry` 类，`definitions: Map`，`register(definition)` 拒绝重名 |
| 2. 找声明面 schema | `node_modules/@deepseek-ai/dsh-agent-preset/lib/index.js:6-27` | `AgentPreset` 类，`Config = { id, name, description, order, plugins }` |
| 3. 找 bundle patch 装载清单 | `node_modules/@deepseek-ai/dsh-web-app/package.json:41-50` | `dsh.bundle.patch` 列了 5 个 yml：1 个 surface patch + 4 个 preset patch |
| 4. 找 4 个 preset 实际身份 | `node_modules/@deepseek-ai/dsh-web-app/presets/{standard,ptc,minimal,cordis}.patch.yml` 第 8 行 | 每个文件里都是 `id: <preset>` |
| 5. 找注册行 + 默认 preset | `node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml:540-544` | `agent-preset-registry` 行的 `default: standard` |
| 6. 排除非 agent preset 干扰 | `node_modules/@deepseek-ai/dsh-base/cordis.patch.yml:249-261` | 这里 `presets:` 键是 `dsh-permission-presets` 的 sandbox 权限预设（`read-only/workspace-write/danger-full-access`），与 agent preset 是不同 Service |
| 7. 排除实验包干扰 | `node_modules/@deepseek-ai/dsh-experimental-agent-team-profile/cordis.patch.yml`、`dsh-experimental-voice-input-bundle/cordis.patch.yml` 等 | grep 验证：均无 `agent-preset` 行 |
| 8. 排除 headless/sdk/acp/base 干扰 | `node_modules/@deepseek-ai/dsh-{headless,sdk-app,sdk-minimal,acp-app,base}/cordis.patch.yml` | grep 验证：均无 `agent-preset` 行；base 有 `permission-presets` 但不是 agent preset |