/**
 * The cards' own vocabulary (issue #372).
 *
 * Every interface word the hashline cards draw comes from ONE namespace —
 * `hashline.card` — registered with the host's locale service, so a card in a
 * Chinese session says 复制 and a card in an English session says Copy. Any
 * other language falls back to English: the host walks the active language's
 * declared fallback chain, and English terminates it.
 *
 * The namespace is OURS, not the shipped `conversation` seat's. That seat
 * carried the keys the built-in cards use, and four keys the hashline cards
 * ask for — `diff.files.one`, `diff.files.other`, `lsp.title`,
 * `lsp.diagnostics.summary` — were not among them, so they rendered on screen
 * as their own key names. The lookup chain has no `→ conversation` hop: a
 * namespace that is not the shipped one must carry EVERY key it uses, which
 * is why the whole vocabulary is copied here rather than borrowed.
 *
 * The module owns its types: `@deepseek-ai/dsh-client-ui-slots` is a
 * shell-only package (it cannot be installed in this repository), so the
 * namespace's key union and dictionary type live HERE instead of in the
 * host's type surface. The English dictionary IS the key contract; the
 * Chinese one is checked against exactly that key set, so the two languages
 * can never drift apart.
 *
 * @module dsh-hashline-edittool-client/locale
 */

/**
 * The namespace the cards' vocabulary is registered under.
 *
 * The host binds a slot's `t` seat to the namespace its registration
 * declares, so this one constant is what every card registration points at.
 */
export const CARD_NS = "hashline.card";

/**
 * The English card vocabulary — the KEY CONTRACT.
 *
 * Its keys are the union every card may ask the host for; the Chinese
 * dictionary below is checked against exactly this set. The wording follows
 * the shipped cards' chrome (the built-in read/diff/search cards say the same
 * things), so a hashline card reads like the card it takes over.
 */
export const EN_CARD_DICTIONARY = {
	// The chrome every card shares.
	copy: "Copy",
	copied: "Copied",
	collapse: "Collapse",
	more: "More",
	// The read card.
	"read.window": "Showing {shown} of {total} lines",
	"read.collapseAria": "Collapse content",
	"read.expandAria": "Expand {count} more lines",
	// The read card's lossy footnote (#375): the host sends the KEY, the
	// client renders it — the host cannot read the reader's language (#369).
	"read.lossy":
		"[Undecodable bytes shown as U+FFFD; this view is not editable — edit refuses files whose bytes are not valid UTF-8.]",
	"read.expandRest": "… {count} more lines",
	// The diff card (edit / write / undo / ast_edit / format).
	"diff.collapseAria": "Collapse diff",
	"diff.expandAria": "Expand {count} more diff lines",
	"diff.expandRest": "… {count} more lines",
	"diff.files.one": "{count} file",
	"diff.files.other": "{count} files",
	// The search card (grep / ast_grep).
	"search.collapseAria": "Collapse results",
	"search.expandAria": "Expand {count} more results",
	"search.expandRest": "… {count} more lines",
	"search.noResults": "No results",
	"search.matches": "{shown} matches · {files} files",
	"search.matches.truncated": "Showing {shown} of {total} matches · {files} files",
	"search.outline": "outline · {count} lines",
	// The diagnostics card.
	"lsp.title": "Diagnostics",
	"lsp.diagnostics.summary": "{lines} lines · {messages} diagnostics",
	// The language-server ROUTE's texts (#377): the HOST names the wording and
	// hands over the facts, because it cannot read the reader's language. The
	// facts — a command, a display name, a platform, an exit code, a stderr tail —
	// read the same in every language, so they stay verbatim in the template.
	"lsp.status.noSubprocessSeam": "This deployment has no subprocess seam, so npm cannot run.",
	"lsp.status.noClient":
		"The language-server client is not enabled, so `symbols` / `code_actions` / `diagnostics` have no server. Installed servers are still probed.",
	"lsp.row.canInstall": "One-click install available",
	"lsp.status.serverNotStarted": "No server has been started for this language yet.",
	"lsp.status.serverStarting": "The server is still starting.",
	"lsp.row.noBuiltinCommand":
		"The plugin has no built-in command for it — set one under \"Named servers\" below",
	"lsp.row.selfInstall": "Install {command} yourself (no built-in install command on this machine)",
	"lsp.install.noCommand":
		"{displayName} has no install command to run directly (it comes from a system package manager or a release package). Once it is installed, this list finds it automatically; you can also write the command directly under \"Named servers\" below.",
	"lsp.install.noCommandForPlatform":
		"{displayName} has no built-in install command on this system ({platform}). Once it is installed, this list finds it automatically; you can also write the command directly under \"Named servers\" below.",
	"lsp.install.exitCode": "The install command exited with {code}: {tail}",
	"lsp.install.npmOkButMissing":
		"npm reported success, but {command} is not in the plugin's directory. The package's executable may have a different name.",
	"lsp.install.doneBuiltinDir":
		"{displayName} is installed in the plugin's own directory, and is now found ahead of PATH.",
	"lsp.install.doneOwnToolchain":
		"The install command for {displayName} completed successfully. It went into its own toolchain's directory — the list below shows it once it is re-read.",
	// The titles a row announces itself with (#375: the HOST names the
	// wording — these keys travel over the wire as `rowTitle.key`).
	"row.title.read": "Read",
	"row.title.grep": "Grep",
	"row.title.edit": "Edit",
	"row.title.write": "Write",
	"row.title.ast_grep": "AST grep",
	"row.title.ast_edit": "AST edit",
	"row.title.undo": "Undo",
	"row.title.format": "Format",
	"row.title.generic": "Tool call",
	// The READ row's trailing suffix (#374): what the call served — the window
	// it cut, the file's length, or the resume hint a budget-cut window carries.
	"row.title.read.window": "L{start}–{end} · {total} lines total",
	"row.title.read.window.truncated":
		"L{start}–{end} · {total} lines total — truncated by the budget; resume to continue",
	"row.title.read.total": "{total} lines total",
	// The row's own state words.
	"row.running": "Running",
	"row.failed": "Failed",
	"row.stopped": "Stopped",
	"row.input": "Input",
	"row.output": "Output",
	"row.inspect": "Inspect",
	// The delete card's own words (hardcoded English until now).
	"delete.title": "Delete",
	"delete.failedTitle": "Delete failed",
	"delete.status.failed": "failed",
	"delete.status.deleted": "deleted",
	"delete.status.absent": "already absent",
	// The delete card's summary and per-path details (#375): the model
	// layer owns the COUNTS, the client renders the words.
	"delete.count": "{count} paths",
	"delete.stat.deleted": "{count} deleted",
	"delete.stat.absent": "{count} already absent",
	"delete.stat.failed": "{count} failed",
	"delete.stat.freed": "{bytes} freed",
	"delete.detail.anchors": "{count} anchors",
	"delete.detail.undo": "{count} undo layers",
	"delete.detail.served": "{count} served rows",
	// The rename card's own words (issue 375): the chrome it draws around the
	// model's facts, and the wording of its summary and per-pair details.
	"rename.title": "Rename",
	"rename.failedTitle": "Rename failed",
	"rename.status.renamed": "renamed",
	"rename.status.failed": "failed",
	// The model layer owns the COUNTS, the client renders the words.
	"rename.count": "{count} paths",
	"rename.stat.renamed": "{count} renamed",
	"rename.stat.failed": "{count} failed",
	"rename.stat.reclaimed": "{bytes} reclaimed",
	"rename.detail.anchors": "{count} anchors",
	"rename.detail.undo": "{count} undo layers",
	"rename.detail.served": "{count} served rows",
	// The wrap switch's one word (#373): the button that folds a long line
	// inside the card instead of scrolling the card sideways.
	"wrap.toggle": "Toggle line wrap",
	// The error card's hint label.
	"error.hintLabel": "Hint:",
	// The error card's folded context echo: how many lines the fold hides.
	"error.moreLines": "… +{count} more lines",
	// The settings card's own words (#375). The labels were hardcoded
	// Chinese in the component; they live here now, so the page follows the
	// interface language like every other card.
	"settings.tab.core": "Behaviour",
	"settings.tab.ast": "AST management",
	"settings.tab.lsp": "Language servers",
	"settings.tab.store": "Storage",
	"settings.section.rows": "Row format",
	"settings.section.output": "Output",
	"settings.section.edit": "Editing",
	"settings.section.format": "Formatting",
	"settings.section.store": "Anchor store budget",
	"settings.label.separator": "Separator",
	"settings.label.outputFormat": "JSON output",
	"settings.label.lineNumbers": "Show line numbers",
	"settings.label.contextLines": "Context lines",
	"settings.label.requireLineContent": "Re-state the changed lines",
	"settings.label.astMaster": "Master switch",
	"settings.label.lspAutoDiag": "Auto diagnostics",
	"settings.label.lspIdle": "Idle reclaim",
	"settings.label.formatAuto": "Auto-format (after write / edit / ast_edit)",
	"settings.label.formatFallback": "Fall back to the whole file",
	"settings.label.formatEditorconfig": "Read .editorconfig",
	"settings.label.lspServers": "Named servers",
	"settings.label.storeBytes": "Whole-store byte budget",
	"settings.label.storePaths": "Path count limit",
	"settings.label.storeLines": "anchor_lines line limit",
	"settings.label.restoreDefaults": "Restore defaults",
	"settings.label.writePreview": "Write echo",
	"settings.writePreview.full": "Full file",
	"settings.writePreview.diff": "Unified diff",
	"settings.writePreview.confirmation": "Confirmation only",
	"settings.hint.writePreview": "Confirmation only: replies a single \"Wrote …\" line — no content echo, no anchors minted; read again to keep editing. Full: re-reads the whole file with its anchors (today's behavior).",
	"settings.hint.separator":
		"Between the anchor and the content. Between the line number and the anchor it is always `:` — not configurable.",
	"settings.hint.lineNumbers":
		"When on, every row is marked `<anchor>:<line>` (the anchor first); when off, only the anchor is given and the line number never reaches the model. The web card is unaffected.",
	"settings.hint.contextLines":
		"How many lines to keep above and below in the diff and in error echoes (0–20). Out of range or not a number restores the default.",
	"settings.hint.requireLineContent":
		"When on, every anchor must be declared together with the line's content ({tuple}), and a declaration that does not match the disk is refused — it guards against changing a new file with numbers from an old read.",
	"settings.hint.astMaster":
		"When off, ast_grep / ast_edit refuse to run (read / edit are unaffected).",
	"settings.hint.astInherit": "Inherit the preset",
	"settings.hint.lspAutoDiag":
		"After edit / write / undo lands on disk, the language server's diagnostics are sent back to the model automatically (on by default).",
	"settings.hint.lspIdle":
		"Milliseconds, 0–3600000; default 300000. A server idle for longer than this is reclaimed and started again on the next use; 0 means never reclaim.",
	"settings.hint.formatAuto":
		"Off = no formatting; whole file = the whole file; range = only the changed lines (off by default).",
	"settings.hint.formatFallback":
		"On = when partial formatting is unavailable, use the whole file instead; off = the automatic path skips silently and the format tool errors explicitly (off by default).",
	"settings.hint.formatEditorconfig":
		"Indentation style and width come from .editorconfig first; without one, the file's own heuristics apply (on by default).",
	"settings.hint.lspServers": "Name a command per language; leave it empty to use the detected one.",
	"settings.hint.lspServersNone": "No server named — every language uses the detected one.",
	"settings.hint.storeIntro":
		"The three limits stop different runaway shapes: bytes stop big files, the path count stops whole-tree scans, the row count stops a few big files being read again and again.",
	"settings.hint.storeDefaults":
		"Unset means the constant default in the code; lowering it really evicts on the next scan (the anchors the model holds may stop working).",
	"settings.summary": "What read / edit / grep do, and the language support.",
	"settings.hint.storeBytes": "MiB, 8–2048; default 64.",
	"settings.hint.storePaths": "paths, 100–100000; default 5000.",
	"settings.hint.storeLines": "lines, 10000–10000000; default 300000.",
	"settings.notReady": "The settings are not ready yet.",
	"settings.placeholder.default": "{value} (default)",
	// The settings card's remaining words (#375): the catalog rows, the
	// language-server list, the buttons and the failure sentences.
	"settings.action.remove": "Remove",
	"settings.action.add": "Add",
	"settings.action.unavailable": "Not installable yet",
	"settings.action.cancelInstall": "Cancel the install",
	"settings.action.install": "Install",
	"settings.action.retry": "Retry",
	"settings.action.assign": "Assign",
	"settings.status.overridden": "Overridden",
	"settings.status.notFound": "Not found",
	"settings.status.installing": "Installing, please wait",
	"settings.fact.builtin": "Built-in · {version}",
	"settings.fact.installed": "Installed · {version}",
	"settings.fact.available": "{version} · {size}",
	"settings.title.overridden":
		"This language has an explicit value in the configuration (the other languages follow the master switch)",
	"settings.title.notInstallable":
		"This language's semantic descriptor is not written yet, so installing it cannot enumerate symbols",
	"settings.origin.project": "In the project",
	"settings.origin.path": "On PATH",
	"settings.origin.configured": "Explicitly configured",
	"settings.origin.installed": "Installed by the card",
	"settings.formatMode.off": "Off",
	"settings.formatMode.full": "Whole file",
	"settings.formatMode.range": "Changed lines",
	"settings.section.usable": "Usable · {count}",
	"settings.section.addable": "Addable · {count}",
	"settings.hint.noMatches": "No matching entries",
	"settings.hint.grammarUpdates": "{count} grammars have a new version ({list}) — updating the plugin gets them.",
	"settings.hint.lspUnavailable":
		"The language-server client is not enabled, so semantic operations have no server available.",
	"settings.placeholder.catalogSearch": "Search a language or an extension ({count} entries)",
	"settings.placeholder.serverLang": "Language, e.g. typescript",
	"settings.placeholder.serverCommand": "Command, e.g. /usr/local/bin/tsserver",
	"settings.list.separator": ", ",
	"settings.error.catalog": "Cannot read the language catalog: {message}",
	"settings.error.catalogHttp": "{route} returned HTTP {status}",
	"settings.error.catalogShape": "The response from {route} carries no languages field",
	"settings.error.catalogFailed": "The request to {route} failed: {message}",
	"settings.error.lsp": "Cannot read the language-server status: {message}",
	"settings.error.lspHttp": "{route} returned HTTP {status}",
	"settings.error.installFailed": "Failed: {message}",
	"settings.error.installIncomplete": "The install did not complete.",
	"settings.error.writeRejected":
		"The write was refused: the configuration was changed elsewhere (revision conflict) or the validation failed. Try again.",
	"settings.notice.installing": "Installing the server for {languageId}; this may take a while.",
	"settings.notice.installed": "✓ The server for {languageId} is installed.",
	// The settings card's validation sentences (#375): the model layer owns
	// the range and NAMES the wording; the card renders it. The unit is a key of
	// its own — its word differs by language ("paths" in English, "个" in Chinese).
	"settings.error.budgetInteger": "Enter a whole number between {min} and {max} {unit}",
	"settings.error.budgetRange": "Out of the allowed range {min}–{max} {unit}",
	"settings.error.idleInteger": "Enter a whole number between {min} and {max}",
	"settings.error.idleRange": "Out of the allowed range {min}–{max}",
	"settings.unit.mib": "MiB",
	"settings.unit.paths": "paths",
	"settings.unit.lines": "lines",
} satisfies Record<string, string>;

/** Every key a card may ask the host for. */
export type CardLocaleKey = keyof typeof EN_CARD_DICTIONARY;

/** One language's card vocabulary: every key, exactly. */
export type CardDictionary = Record<CardLocaleKey, string>;

/**
 * The keys the HOST may put on the wire (ADR-0024): the wire's slice of this
 * vocabulary.
 *
 * The list IS the contract: the client's `WireTextKey` derives from it and the
 * meta validator refuses every key outside it, so the keys that travel the wire
 * and the keys the client accepts can never drift apart.
 */
export const WIRE_TEXT_KEYS = {
	"read.lossy": true,
	"row.title.read": true,
	"row.title.read.window": true,
	"row.title.read.window.truncated": true,
	"row.title.read.total": true,
	"row.title.grep": true,
	"row.title.edit": true,
	"row.title.write": true,
	// #377: the language-server routes' texts. The host names the wording; the
	// card resolves it in the reader's language.
	"lsp.status.noSubprocessSeam": true,
	"lsp.status.noClient": true,
	"lsp.status.serverNotStarted": true,
	"lsp.status.serverStarting": true,
	"lsp.row.canInstall": true,
	"lsp.row.noBuiltinCommand": true,
	"lsp.row.selfInstall": true,
	"lsp.install.noCommand": true,
	"lsp.install.noCommandForPlatform": true,
	"lsp.install.exitCode": true,
	"lsp.install.npmOkButMissing": true,
	"lsp.install.doneBuiltinDir": true,
	"lsp.install.doneOwnToolchain": true,
} as const satisfies Partial<Record<CardLocaleKey, boolean>>;

/**
 * The Chinese card vocabulary — checked against the English key set.
 *
 * `satisfies` is the lock: a key the English dictionary has and this one
 * does not (a missing translation) and a key this one has and the English
 * does not (a stray translation) are both compile errors.
 */
export const ZH_CARD_DICTIONARY = {
	copy: "复制",
	copied: "已复制",
	collapse: "折叠",
	more: "更多",
	"read.window": "显示 {shown} / {total} 行",
	// #375: the read card's lossy footnote — the host sends the key.
	"read.lossy": "[无法解码的字节显示为 U+FFFD；此视图不可编辑——edit 会拒绝字节不是合法 UTF-8 的文件。]",
	"read.collapseAria": "收起内容",
	"read.expandAria": "展开其余 {count} 行",
	"read.expandRest": "… 其余 {count} 行",
	"diff.collapseAria": "收起差异",
	"diff.expandAria": "展开其余 {count} 行差异",
	"diff.expandRest": "… 其余 {count} 行",
	"diff.files.one": "{count} 个文件",
	"diff.files.other": "{count} 个文件",
	"search.collapseAria": "收起结果",
	"search.expandAria": "展开其余 {count} 行结果",
	"search.expandRest": "… 其余 {count} 行",
	"search.noResults": "无结果",
	"search.matches": "{shown} 处匹配 · {files} 个文件",
	"search.matches.truncated": "显示 {shown} / 共 {total} 处匹配 · {files} 个文件",
	"search.outline": "大纲 · {count} 行",
	"lsp.title": "诊断",
	// #377: the language-server route's texts — the host sends the KEY.
	"lsp.status.noSubprocessSeam": "这个部署没有 subprocess seam，所以无法运行 npm。",
	"lsp.status.noClient":
		"语言服务器客户端未启用，所以 `symbols` / `code_actions` / `diagnostics` 没有可用的服务器。已装的服务器仍然会被探测到。",
	"lsp.row.canInstall": "可一键安装",
	"lsp.status.serverNotStarted": "该语言还没有已启动的服务器。",
	"lsp.status.serverStarting": "服务器仍在启动中。",
	"lsp.row.noBuiltinCommand": "插件没有它的内置命令，可用下方「指定服务器」直接填",
	"lsp.row.selfInstall": "需自行安装 {command}（本机无内置安装命令）",
	"lsp.install.noCommand":
		"{displayName} 没有可直接运行的安装命令（它来自系统包管理器或发布包）。装上后这个列表会自动找到它；也可以在下方的「指定服务器」里直接写命令。",
	"lsp.install.noCommandForPlatform":
		"{displayName} 在这个系统（{platform}）上没有内置安装命令。装上后这个列表会自动找到它；也可以在下方的「指定服务器」里直接写命令。",
	"lsp.install.exitCode": "安装命令以 {code} 退出：{tail}",
	"lsp.install.npmOkButMissing":
		"npm 报成功，但 {command} 不在插件目录里。可能这个包的可执行文件叫别的名字。",
	"lsp.install.doneBuiltinDir": "{displayName} 已装进插件自己的目录，从现在起优先于 PATH 被找到。",
	"lsp.install.doneOwnToolchain":
		"{displayName} 的安装命令已成功完成。它装进了它自己工具链的目录——下面列表重读后就能看到它。",
	"lsp.diagnostics.summary": "{lines} 行 · {messages} 条诊断",
	// #375: the host names the row title's wording; these keys travel the wire.
	"row.title.read": "读取",
	"row.title.grep": "搜索文件内容",
	"row.title.edit": "编辑",
	"row.title.write": "写入",
	"row.title.generic": "工具调用",
	"row.title.ast_grep": "AST 搜索",
	"row.title.ast_edit": "AST 编辑",
	"row.title.undo": "撤销",
	"row.title.format": "格式化",
	// #374: the read row's trailing suffix — the window it served, the file's
	// length, and the resume hint a budget-cut window carries.
	"row.title.read.window": "L{start}–{end} · 共 {total} 行",
	"row.title.read.window.truncated": "L{start}–{end} · 共 {total} 行 · 已按预算截断，resume 可续读",
	"row.title.read.total": "共 {total} 行",
	"row.running": "运行中",
	"row.failed": "失败",
	"row.stopped": "已停止",
	"row.input": "输入",
	"row.output": "输出",
	"row.inspect": "查看",
	"delete.title": "删除",
	"delete.failedTitle": "删除失败",
	"delete.status.failed": "失败",
	"delete.status.deleted": "已删除",
	"delete.status.absent": "已不存在",
	// #375: the delete card's summary and per-path details.
	"delete.count": "{count} 个路径",
	"delete.stat.deleted": "{count} 已删除",
	"delete.stat.absent": "{count} 已不存在",
	"delete.stat.failed": "{count} 失败",
	"delete.stat.freed": "{bytes} 已释放",
	"delete.detail.anchors": "{count} 个锚点",
	"delete.detail.undo": "{count} 层撤销",
	"delete.detail.served": "{count} 行已服务",
	// issue 375: the rename card's own words, its summary and its per-pair details.
	"rename.title": "重命名",
	"rename.failedTitle": "重命名失败",
	"rename.status.renamed": "已重命名",
	"rename.status.failed": "失败",
	"rename.count": "{count} 个路径",
	"rename.stat.renamed": "{count} 已重命名",
	"rename.stat.failed": "{count} 失败",
	"rename.stat.reclaimed": "{bytes} 已回收",
	"rename.detail.anchors": "{count} 个锚点",
	"rename.detail.undo": "{count} 层撤销",
	"rename.detail.served": "{count} 行已服务",
	"error.hintLabel": "提示：",
	// The error card's folded context echo: how many lines the fold hides.
	"error.moreLines": "… 其余 {count} 行",
	// #373: the wrap switch's one word.
	"wrap.toggle": "切换自动换行",
	// #375: the settings card's own words.
	"settings.tab.core": "行为",
	"settings.tab.ast": "AST 管理",
	"settings.tab.lsp": "语言服务器",
	"settings.tab.store": "存储",
	"settings.section.rows": "行格式",
	"settings.section.output": "输出",
	"settings.section.edit": "编辑",
	"settings.section.format": "格式化",
	"settings.section.store": "锚点存储预算",
	"settings.label.separator": "分隔符",
	"settings.label.outputFormat": "JSON 输出",
	"settings.label.lineNumbers": "显示行号",
	"settings.label.contextLines": "上下文行数",
	"settings.label.requireLineContent": "重述被改的行",
	"settings.label.astMaster": "总开关",
	"settings.label.lspAutoDiag": "自动诊断回送",
	"settings.label.lspIdle": "空闲回收",
	"settings.label.formatAuto": "自动格式化（write / edit / ast_edit 后）",
	"settings.label.formatFallback": "范围不可用时回退全文",
	"settings.label.formatEditorconfig": "读取 .editorconfig",
	"settings.label.lspServers": "指定服务器",
	"settings.label.storeBytes": "整库字节预算",
	"settings.label.storePaths": "路径数上限",
	"settings.label.storeLines": "anchor_lines 行数上限",
	"settings.label.restoreDefaults": "恢复默认",
	"settings.label.writePreview": "write 后回显",
	"settings.writePreview.full": "全文",
	"settings.writePreview.diff": "统一 diff",
	"settings.writePreview.confirmation": "仅确认",
	"settings.hint.writePreview": "仅确认：只回一行「Wrote …」，不回显内容、不分配锚点——要接着改先 read。全文：回读整份文件与锚点（今天的行为）。",
	"settings.hint.separator": "锚点与内容之间。行号与锚点之间永远是 `:`，不可配置。",
	"settings.hint.lineNumbers":
		"开启后每行标记为 `<锚点>:<行号>`（锚点在前）；关闭时只给锚点，行号不发给模型。web 卡片不受影响。",
	"settings.hint.contextLines": "diff 与错误回显里上下各留几行（0–20）。域外或非数字则恢复默认。",
	"settings.hint.requireLineContent":
		"开启后每个锚点必须连同行内容一起声明（{tuple}），声明与磁盘不符就拒绝——防的是“拿着旧读的数去改新文件”。",
	"settings.hint.astMaster": "关闭时 ast_grep / ast_edit 拒绝运行（read / edit 不受影响）。",
	"settings.hint.astInherit": "继承预设",
	"settings.hint.lspAutoDiag": "edit / write / undo 落盘后自动把语言服务器诊断回送模型（默认开）。",
	"settings.hint.lspIdle":
		"毫秒，0–3600000；默认 300000。空闲超过这个时间语言服务器会被回收，下次用到再拉起；填 0 表示永不回收。",
	"settings.hint.formatAuto": "关 = 不格式化；全文 = 整文件；范围 = 只格式化被改的行（默认关）。",
	"settings.hint.formatFallback":
		"开 = 局部格式化不可用时用整文件代替；关 = 自动路径静默跳过、format 工具显式报错（默认关）。",
	"settings.hint.formatEditorconfig": "缩进风格与宽度优先取 .editorconfig，缺省用文件内启发式（默认开）。",
	"settings.hint.lspServers": "按语言指定命令；留空则用探测到的。",
	"settings.hint.lspServersNone": "没有指定任何服务器，全部使用探测结果。",
	"settings.hint.storeIntro":
		"三个上限分别挡不同的失控形状：字节挡大文件，路径数挡整树扫描，行数挡“几个大文件被多次读取”。",
	"settings.hint.storeDefaults":
		"未设置时使用代码内的常量默认；改小会在下一次扫描时真的淘汰（模型手里的锚点可能失效）。",
	"settings.summary": "read / edit / grep 的行为与语言支持。",
	"settings.hint.storeBytes": "MiB，8–2048；默认 64。",
	"settings.hint.storePaths": "个，100–100000；默认 5000。",
	"settings.hint.storeLines": "行，10000–10000000；默认 300000。",
	"settings.notReady": "设置尚未就绪。",
	"settings.placeholder.default": "{value}（默认）",
	"settings.action.remove": "移除",
	"settings.action.add": "添加",
	"settings.action.unavailable": "暂不可装",
	"settings.action.cancelInstall": "取消安装",
	"settings.action.install": "安装",
	"settings.action.retry": "重试",
	"settings.action.assign": "指定",
	"settings.status.overridden": "已覆盖",
	"settings.status.notFound": "未找到",
	"settings.status.installing": "安装中，请稍候",
	"settings.fact.builtin": "内置 · {version}",
	"settings.fact.installed": "已装 · {version}",
	"settings.fact.available": "{version} · {size}",
	"settings.title.overridden": "这门语言在配置里写了显式值（其余语言继承总开关）",
	"settings.title.notInstallable": "该语言的语义描述符尚未编写，装上也无法枚举符号",
	"settings.origin.project": "项目内",
	"settings.origin.path": "PATH 中",
	"settings.origin.configured": "显式配置",
	"settings.origin.installed": "卡片安装",
	"settings.formatMode.off": "关",
	"settings.formatMode.full": "全文",
	"settings.formatMode.range": "范围",
	"settings.section.usable": "已可用 · {count}",
	"settings.section.addable": "可添加 · {count}",
	"settings.hint.noMatches": "没有匹配的条目",
	"settings.hint.grammarUpdates": "{count} 门文法有新版本（{list}）——跟随插件更新获取。",
	"settings.hint.lspUnavailable": "语言服务器客户端未启用，所以语义操作没有可用的服务器。",
	"settings.placeholder.catalogSearch": "搜索语言或扩展名（{count} 个条目）",
	"settings.placeholder.serverLang": "语言，如 typescript",
	"settings.placeholder.serverCommand": "命令，如 /usr/local/bin/tsserver",
	"settings.list.separator": "、",
	"settings.error.catalog": "无法读取语言目录：{message}",
	"settings.error.catalogHttp": "{route} 返回 HTTP {status}",
	"settings.error.catalogShape": "{route} 的响应里没有 languages 字段",
	"settings.error.catalogFailed": "{route} 请求失败：{message}",
	"settings.error.lsp": "无法读取语言服务器状态：{message}",
	"settings.error.lspHttp": "{route} 返回 HTTP {status}",
	"settings.error.installFailed": "失败：{message}",
	"settings.error.installIncomplete": "安装未完成。",
	"settings.error.writeRejected": "写入被拒绝：配置已在他处修改（revision 冲突）或校验未通过，请重试。",
	"settings.notice.installing": "正在安装 {languageId} 的服务器，可能要一会儿。",
	"settings.notice.installed": "✓ {languageId} 的服务器已安装。",
	// #375: the settings card's validation sentences and their units.
	"settings.error.budgetInteger": "请输入 {min}–{max} {unit} 之间的整数",
	"settings.error.budgetRange": "超出允许范围 {min}–{max} {unit}",
	"settings.error.idleInteger": "请输入 {min}–{max} 之间的整数",
	"settings.error.idleRange": "超出允许范围 {min}–{max}",
	"settings.unit.mib": "MiB",
	"settings.unit.paths": "个",
	"settings.unit.lines": "行",
} satisfies CardDictionary;

/**
 * Both languages, as the host's `locale.register` takes them.
 *
 * The host requires the two baseline languages (`en` and `zh`); every other
 * language falls back to English through the declared fallback chain.
 */
export const CARD_DICTIONARIES: Record<string, CardDictionary> = {
	en: EN_CARD_DICTIONARY,
	zh: ZH_CARD_DICTIONARY,
};
