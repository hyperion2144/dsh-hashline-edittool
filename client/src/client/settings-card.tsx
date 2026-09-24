/**
 * The hashline tool's configuration card — the whole of it, not one capability's.
 *
 * It began as the language manager (#114's shape: A's search, B's two columns) and
 * is deliberately NAMED for the tool rather than for that feature, because the
 * settings that used to live only in settings.yaml — `separator`, `output_format`,
 * `context_lines`, `require_line_content` — now have controls of their own. (A
 * `hash_length` was named here too and never existed: it was a plan rather than a
 * setting, and a comment promising a control nobody can find is worse than one
 * that says nothing.) A card called 语言管理器 would have had to be renamed the
 * moment the first of them arrived.
 *
 * Its sections switch rather than stack, so each reads on its own: 行为 is the row
 * format every output depends on, AST 管理 the grammars, 语言服务器 the semantic
 * half. Each answers a question the others cannot.
 *
 * The card renders in the two views the plugin manager asks of every
 * configuration entry (`PluginConfigViewProps`): `summary` — the one-liner
 * under the bundle page's title — and `page` — the form itself. The page
 * draws the title, the icon and the crumb, so the form wears NO card chrome
 * of its own: an earlier revision wrapped it in a shipped-style collapsible
 * `<li>` with a header of its own, stacking a second “Hashline 工具配置”
 * heading under the page's package title. The tabs inside still follow the
 * settings page's own tab language (plain label, underline on the active
 * one), and the manager CSS remains the shipped rules with the design
 * tokens intact, minus the card chrome this card no longer draws.
 *
 * Three kinds of catalog entry stay visibly distinct:
 *   builtin   内置 · version, and NO install/remove control at all
 *   已可用     builtins plus what was installed; removable only if installed
 *   可添加     pinned version and download SIZE
 *
 * @module dsh-hashline-edittool-client/settings-card
 */
import { useCallback, useEffect, useMemo, useReducer, useState, useSyncExternalStore, type ReactElement } from "react";
import { Button, Pill, StateDot } from "@deepseek-ai/dsh-client-ui-primitives";
import * as primitives from "@deepseek-ai/dsh-client-ui-primitives";
import type { ConfigFormSnapshot } from "./types.js";
import { buildFieldOp, controllerSnapshot, requestedView, settingsSummaryText, type SettingsCardView, type SettingsControllerFace } from "./settings-model.js";
/** Props the slot hands the card: OUR controller plus the view it asks for. */
export interface SettingsCardProps {
	/**
	 * The settings controller injected by the slot registration (#171).
	 *
	 * The bundle page hands `{ view }` and no form, so the card brings its
	 * own — built from the `configForms` service in the registration — and
	 * subscribes to it here because no page owner re-renders us.
	 */
	readonly controller?: SettingsControllerFace;
	/** Absent means the page view — the full form is the safe default. */
	readonly view?: SettingsCardView;
}

/** Where the manager's facts live. */
const MANAGER_ROUTE = "/api/hashline/grammars";

/** Where the language-SERVER facts live. */
const LSP_ROUTE = "/api/hashline/lsp";

/** One installed grammar with a newer version published. */
interface UpdateRow {
	readonly id: string;
	readonly installed: string;
	readonly latest: string;
}

/**
 * Newer grammars, asked for SEPARATELY and never awaited by the main list.
 *
 * It reaches the network, so it is the one thing on this card that can be slow.
 * The language list must render without it, and a registry that cannot be
 * reached must look exactly like one with nothing to say — both are
 * non-actionable, and a spinner or an error here would cost more than the
 * feature is worth.
 */
function useUpdates(): readonly UpdateRow[] {
	const [rows, setRows] = useState<readonly UpdateRow[]>([]);
	useEffect(() => {
		let live = true;
		void (async () => {
			try {
				const response = await fetch(`${MANAGER_ROUTE}/updates`, { headers: { accept: "application/json" } });
				if (!response.ok) return;
				const body = (await response.json()) as { updates?: readonly UpdateRow[] };
				if (live && Array.isArray(body.updates)) setRows(body.updates);
			} catch {
				// Silent by contract: see above.
			}
		})();
		return () => {
			live = false;
		};
	}, []);
	return rows;
}

/** One language's server state, as `/api/hashline/lsp` reports it. */
interface LspRow {
	readonly languageId: string;
	readonly server?: {
		readonly displayName: string;
		readonly command: string;
		readonly executable: string;
		readonly origin: string;
	};
	readonly ready: boolean;
	readonly reason?: string;
	readonly message?: string;
	/** Whether the plugin can install this one itself (npm-form servers only). */
	readonly canInstall?: boolean;
}

/** How each discovery origin reads to a person. */
const ORIGIN_TEXT: Record<string, string> = {
	project: "项目内",
	path: "PATH 中",
	configured: "显式配置",
	// Chosen by someone rather than found lying around, and the distinction
	// matters to the reader: `configured` is their own settings entry, while
	// `installed` is the plugin's own prefix — the one this card installs into.
	installed: "卡片安装",
};


/** One catalog row, as the route reports it. */
interface LanguageRow {
	readonly id: string;
	readonly displayName: string;
	readonly extensions: readonly string[];
	readonly version: string;
	readonly size?: number;
	readonly builtin: boolean;
	readonly installable: boolean;
	readonly installed: boolean;
	readonly installedVersion?: string;
}

/**
 * Copied from the shipped `PluginCard.module.css`, minus the card chrome the
 * manager page draws for us now: the selectors that remain are renamed so they
 * cannot collide, and every value — the `.5px` hairline, the 15px/600 label
 * over its 13px tertiary hint — is theirs, because matching by eye is how a
 * card ends up almost-but-not-quite aligned with its neighbours.
 */
const CSS_TEXT = [
	// the active one, so these read as tabs rather than as buttons.
	".dshl-mgr-tabs{display:flex;gap:18px;margin:12px 0 4px;border-bottom:.5px solid var(--dsw-alias-border-l2)}",
	".dshl-mgr-tab{appearance:none;background:0 0;border:0;border-bottom:2px solid transparent;padding:6px 0 8px;font:inherit;font-size:13px;color:var(--dsw-alias-label-tertiary);cursor:pointer}",
	".dshl-mgr-tab--active{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-label-primary)}",

	// The manager's own controls, on top of that chrome.
	".dshl-mgr-master{align-items:center;gap:10px;padding:12px 0;display:flex}",
	".dshl-mgr-label{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary)}",
	".dshl-mgr-hint{font-size:12px;color:var(--dsw-alias-label-tertiary)}",
	".dshl-mgr-grow{flex:1}",
	".dshl-mgr-search{width:100%;box-sizing:border-box;margin:0 0 12px;padding:7px 11px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:0 0;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}",
	// `auto-fit` + a minimum, rather than a fixed 1fr 1fr: two columns that
	// refuse to shrink will overflow the card the moment the window is narrow, and
	// this collapses to ONE column instead of squeezing both into rubble. A viewport
	// media query would be the wrong instrument — this card lives inside a modal, so
	// what matters is the space it was given, not the window's width.
	".dshl-mgr-columns{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;align-items:start}",
	// Grid and flex children default to `min-width:auto`, i.e. "never narrower than
	// my content" — which is exactly what pushed the version pill and the install
	// button out of the card. Zero lets the ellipsis below actually engage.
	".dshl-mgr-columns>section{min-width:0}",
	".dshl-mgr-section{margin:0 0 6px;font-size:12px;font-weight:500;color:var(--dsw-alias-label-tertiary)}",
	".dshl-mgr-list{list-style:none;margin:0;padding:0;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;overflow:hidden}",
	// `flex-wrap` is the part I got wrong TWICE. Without it a row is a single
	// unbreakable line, so "wrap the text" cannot happen no matter what the text's
	// own rules say — and `overflow-wrap:anywhere` on a shrunken item then broke
	// «可一键安装» character by character into a vertical column, because CJK has no
	// spaces and can break between any two of them.
	// The row MAY wrap, and exactly one thing asks it to: the error.
	//
	// Two earlier versions got this wrong in opposite directions. With no
	// wrapping at all, every child being `flex:none`, a long status simply left
	// the box. Then with `flex:1 0 100%` on everything long, which is not "wrap
	// the text" but "give every long string a line of its own": 可一键安装 went
	// below the name and pushed the 安装 button down with it. A short status
	// belongs INLINE; the button never moves; an error gets a line because an
	// error is worth reading and there is no room to read it in 30 characters.
	".dshl-mgr-row{align-items:center;gap:8px;padding:8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2);font-size:13px;display:flex;flex-wrap:wrap;min-width:0}",
	".dshl-mgr-row:last-child{border-bottom:none}",
	".dshl-mgr-ext{font-family:var(--ds-font-family-code);font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	// The NAME is what yields when space runs out: the extensions, the pill and the
	// control are all more informative than a truncated name would be, and the pill
	// must never wrap (it did, splitting "内置 · 0.23.2" across two lines).
	".dshl-mgr-display-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
	// The NAME yields before the pill does, and the pill must never wrap (it did once,
	// splitting «内置 · 0.23.2» across two lines).
	".dshl-mgr-row>*{flex:none}",
	// Everything that can be long takes a FULL LINE OF ITS OWN, by `flex: 1 0 100%`:
	// A status may be long, so it takes the slack and wraps WITHIN it, capped at
	// 60% so the name keeps its room. It is NOT given a line of its own: 可一键安装
	// is three words and reads fine beside the name.
	".dshl-mgr-row .dshl-mgr-hint{flex:1 1 auto;min-width:8ch;max-width:60%;white-space:normal;overflow-wrap:break-word;text-align:right}",
	// An ERROR takes a full line, and it is placed AFTER the button in the DOM so
	// the wrap happens below the control rather than shoving it aside. Full width
	// because a failed install explains itself at length — a truncated reason is
	// not a reason.
	".dshl-mgr-row .dshl-mgr-error{flex:1 0 100%;min-width:0;white-space:normal;overflow-wrap:break-word;text-align:left;font-size:12px;line-height:1.5}",
	".dshl-mgr-error{margin:10px 0 0;font-size:12px;color:var(--dsw-alias-label-error)}",
	".dshl-mgr-cancel{margin:0 0 10px;padding:5px 11px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12.5px;cursor:pointer}",
].join("");

const CSS_TAG_ID = "dsh-hashline-edittool-client/language-manager.css";

/** Install the manager sheet once (same tagged style-tag contract as ToolRow). */
function ensureManagerStyles(): void {
	if (typeof document === "undefined") return;
	if (document.querySelector(`style[data-plugin-css="${CSS_TAG_ID}"]`) !== null) return;
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-hashline-edittool-client";
	tag.dataset.pluginCss = CSS_TAG_ID;
	tag.textContent = CSS_TEXT;
	document.head.appendChild(tag);
}

/** `Switch` is runtime-only in our pinned type copy. */
interface SwitchLike {
	(props: {
		readonly checked: boolean;
		readonly label: string;
		readonly disabled?: boolean;
		readonly onChange: (checked: boolean) => void;
	}): ReactElement | null;
}
const Switch = (primitives as unknown as { Switch?: SwitchLike }).Switch;

/** Human-readable byte size; the figure a user judges a download by. */
function bytesText(size: number | undefined): string {
	if (size === undefined) return "";
	if (size < 1024) return `${size} B`;
	if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
	return `${(size / 1048576).toFixed(1)} MB`;
}

/** Read the AST subtree out of a snapshot without trusting its shape. */
function readAst(snapshot: ConfigFormSnapshot): {
	enabled: boolean;
	languages: Record<string, { enabled?: boolean } | undefined>;
} {
	const ast = snapshot.value?.ast;
	if (typeof ast !== "object" || ast === null) return { enabled: false, languages: {} };
	const record = ast as { enabled?: unknown; languages?: unknown };
	const languages =
		typeof record.languages === "object" && record.languages !== null
			? (record.languages as Record<string, { enabled?: boolean } | undefined>)
			: {};
	return { enabled: record.enabled === true, languages };
}

/**
 * The four settings that shape the ROWS themselves, read out of the snapshot.
 *
 * They were reachable only by editing `settings.yaml`, which meant the card showed
 * two capability sections while the behaviour every row depends on — the separator
 * between anchor and content, how many context lines a diff shows — had no control
 * anywhere. A card that governs a tool's output but not its shape is half a card.
 *
 * Defaults come from `DEFAULT_CONFIG` through the same shape, so the card shows
 * what the tools will actually do rather than an empty box.
 */
function readCore(snapshot: ConfigFormSnapshot): {
	separator: string;
	outputFormat: "text" | "json";
	contextLines: number;
	requireLineContent: boolean;
} {
	const value = snapshot.value ?? {};
	return {
		separator: typeof value.separator === "string" && value.separator !== "" ? value.separator : ":",
		outputFormat: value.output_format === "json" ? "json" : "text",
		contextLines: typeof value.context_lines === "number" ? value.context_lines : 3,
		requireLineContent: value.require_line_content === true,
	};
}

/**
 * Read the named-servers subtree, keyed by language.
 *
 * Names only. Whether a command exists, and whether anything is running, are
 * facts the STATUS route reports — this side must not guess at them, or a typo
 * would look like a working server.
 */
function readLspServers(snapshot: ConfigFormSnapshot): Record<string, string> {
	const lsp = snapshot.value?.lsp;
	if (typeof lsp !== "object" || lsp === null) return {};
	const servers = (lsp as { servers?: unknown }).servers;
	if (typeof servers !== "object" || servers === null) return {};
	const out: Record<string, string> = {};
	for (const [id, command] of Object.entries(servers as Record<string, unknown>)) {
		if (typeof command === "string" && command !== "") out[id] = command;
	}
	return out;
}


/**
 * The auto-diagnostics switch (#131). ABSENT means on: the feature is
 * opt-out, so only an explicit `false` in the settings turns it off — the
 * same absence-means-default rule the AST master switch follows.
 */
function readAutoDiagnostics(snapshot: ConfigFormSnapshot): boolean {
	const lsp = snapshot.value?.lsp;
	if (typeof lsp !== "object" || lsp === null) return true;
	return (lsp as { auto_diagnostics?: unknown }).auto_diagnostics !== false;
}

/** Whether the user layer has an explicit `ast.enabled` (presence, not value). */
function hasExplicitMaster(snapshot: ConfigFormSnapshot): boolean {
	const user = snapshot.user;
	if (typeof user !== "object" || user === null) return false;
	const ast = (user as { ast?: unknown }).ast;
	return typeof ast === "object" && ast !== null && (ast as { enabled?: unknown }).enabled !== undefined;
}


/** What the catalog fetch produced — including WHY, when it produced nothing. */
interface CatalogState {
	readonly rows: readonly LanguageRow[];
	readonly failure?: string;
}

/**
 * The catalog, fetched once.
 *
 * A failure is REPORTED rather than swallowed. An earlier version returned an
 * empty list on any error, so the card said "0 门可用" whether the route was
 * missing, refused, or simply empty — three very different problems wearing one
 * symptom, and none of them diagnosable from the screen.
 */
function useCatalog(): { state: CatalogState; reload: () => void } {
	const [state, setState] = useState<CatalogState>({ rows: [] });
	const [nonce, setNonce] = useState(0);
	useEffect(() => {
		let live = true;
		void (async () => {
			try {
				const response = await fetch(MANAGER_ROUTE, { headers: { accept: "application/json" } });
				if (!response.ok) {
					if (live) setState({ rows: [], failure: `${MANAGER_ROUTE} 返回 HTTP ${response.status}` });
					return;
				}
				const body = (await response.json()) as { languages?: readonly LanguageRow[] };
				if (!live) return;
				if (Array.isArray(body.languages)) setState({ rows: body.languages });
				else setState({ rows: [], failure: `${MANAGER_ROUTE} 的响应里没有 languages 字段` });
			} catch (cause) {
				if (live) {
					setState({ rows: [], failure: `${MANAGER_ROUTE} 请求失败：${cause instanceof Error ? cause.message : String(cause)}` });
				}
			}
		})();
		return () => {
			live = false;
		};
	}, [nonce]);
	return { state, reload: () => setNonce((n) => n + 1) };
}

/**
 * The language-server report.
 *
 * `available: false` is a STATE, not a failure: the LSP packages are not
 * installed by default, so a deployment legitimately has no client. Rendering
 * that as an error would be wrong twice — wrong about the cause, and wrong about
 * whether anything can be done about it here.
 */
function useLspStatus(): { rows: readonly LspRow[]; available: boolean; message?: string; failure?: string; reload: () => void } {
	const [nonce, setNonce] = useState(0);
	const [state, setState] = useState<{ rows: readonly LspRow[]; available: boolean; message?: string; failure?: string }>({
		rows: [],
		available: false,
	});
	useEffect(() => {
		let live = true;
		void (async () => {
			try {
				const response = await fetch(LSP_ROUTE, { headers: { accept: "application/json" } });
				if (!response.ok) {
					if (live) setState({ rows: [], available: false, failure: `${LSP_ROUTE} 返回 HTTP ${response.status}` });
					return;
				}
				const body = (await response.json()) as { available?: boolean; message?: string; languages?: readonly LspRow[] };
				if (!live) return;
				setState({
					rows: Array.isArray(body.languages) ? body.languages : [],
					available: body.available === true,
					...(typeof body.message === "string" ? { message: body.message } : {}),
				});
			} catch (cause) {
				if (live) setState({ rows: [], available: false, failure: cause instanceof Error ? cause.message : String(cause) });
			}
		})();
		return () => {
			live = false;
		};
		// `nonce` IS the dependency: bumping it re-runs the effect and re-reads the
		// list. An install changes what discovery FINDS, so the reload is not a
		// nicety — a card still saying "未找到" after a successful install would be
		// reporting a stale fact as a current one.
	}, [nonce]);
	return { ...state, reload: () => setNonce((n) => n + 1) };
}

/** Render the runtime switch, or the native fallback. */
function renderSwitch(
	checked: boolean,
	disabled: boolean,
	key: string,
	onChange: (checked: boolean) => void,
): ReactElement {
	if (Switch !== undefined) {
		return <Switch key={key} checked={checked} label="" disabled={disabled} onChange={onChange} />;
	}
	return (
		<input key={key} type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
	);
}

/** One row: install FACT in the middle, enable INTENT on the right. */
function LanguageRowItem(props: {
	readonly row: LanguageRow;
	readonly astEnabled: boolean;
	/** Only consulted when this row renders a switch — i.e. when it is usable. */
	readonly disabled?: boolean | undefined;
	/**
	 * Whether settings.yaml names this language EXPLICITLY.
	 *
	 * The distinction the card was hiding: an absent entry means "inherit the
	 * master switch", and only an explicit `false` is ever written — so a user
	 * who installs five languages and enables them all still sees
	 * `languages: {}`. That is correct, and it read as though nothing had been
	 * saved. Marking the OVERRIDDEN rows makes the rule visible without putting a
	 * badge on every row that is merely inheriting — which, by default, is all.
	 */
	readonly overridden?: boolean | undefined;
	readonly writable: boolean;
	readonly busy: string | undefined;
	readonly onToggle: () => void;
	readonly onInstall?: (() => void) | undefined;
	readonly onRemove?: (() => void) | undefined;
}): ReactElement {
	const { row } = props;
	const present = row.builtin || row.installed;
	const fact = row.builtin
		? `内置 · ${row.version}`
		: row.installed
			? `已装 · ${row.installedVersion ?? row.version}`
			: `${row.version} · ${bytesText(row.size)}`;
	const dotState = present ? "done" : row.installable ? "warning" : "error";
	return (
		<li className="dshl-mgr-row">
			<StateDot state={dotState} size={8} />
			<span className="dshl-mgr-display-name">{row.displayName}</span>
			{props.overridden === true ? (
				<span className="dshl-mgr-hint" title="settings.yaml 里为这门语言写了显式值（其余语言继承总开关）">
					已覆盖
				</span>
			) : null}
			<span className="dshl-mgr-ext">{row.extensions.join(" ")}</span>
			<span className="dshl-mgr-grow" />
			<Pill>{fact}</Pill>
			{props.busy?.endsWith(`:${row.id}`) === true ? <StateDot state="ongoing" size={8} /> : null}
			{/* FACT: whether the grammar is on disk, and the one control that changes it. */}
			{row.builtin ? null : row.installed ? (
				<Button size="sm" disabled={!props.writable} onClick={props.onRemove}>
					移除
				</Button>
			) : row.installable ? (
				<Button size="sm" variant="primary" disabled={!props.writable} onClick={props.onInstall}>
					添加
				</Button>
			) : (
				<span className="dshl-mgr-hint" title="该语言的语义描述符尚未编写，装上也无法枚举符号">
					暂不可装
				</span>
			)}
			{/*
			 * INTENT, but only where intent can MEAN anything: a language has a switch
			 * once its grammar is usable — packaged, or installed from the catalog.
			 *
			 * An earlier revision put one on every row, reasoning that intent precedes
			 * installation. That was wrong: a language whose grammar is not on disk
			 * cannot be used at all, so a switch there advertises a state it cannot
			 * reach. The row already offers the one action that changes that — 添加.
			 * (The bug that prompted the over-correction was real and is still fixed:
			 * an INSTALLED extension used to have no switch, so turning it off meant
			 * removing its grammar and installing it again.)
			 */}
			{present ? renderSwitch(props.disabled !== true, !props.writable || !props.astEnabled, row.id, props.onToggle) : null}
		</li>
	);
}

/**
 * The card the slot hands over: dispatch on the view the manager page asks
 * for. No hooks live here on purpose — the summary must stay a one-liner
 * without dragging the form's catalog fetches into the page's first paint.
 *
 * @param props - our injected controller and the requested view.
 */
export function HashlineSettingsCard(props: SettingsCardProps): ReactElement {
	if (requestedView(props.view) === "summary") {
		return <>{settingsSummaryText()}</>;
	}
	return <HashlineSettingsPageView controller={props.controller} />;
}

/**
 * Subscribe to the controller's snapshot.
 *
 * The page used to re-render us when the form moved; at bundle level nobody
 * does, so the card follows the controller itself. `getSnapshot` returns a
 * stable reference until the next change (the shipped controller documents
 * that), which is what `useSyncExternalStore` requires.
 *
 * @param controller - the injected face, when the slot handed one.
 * @returns the live snapshot, or the not-ready shape.
 */
function useControllerSnapshot(controller: SettingsControllerFace | undefined): ConfigFormSnapshot {
	const subscribe = useCallback(
		(listener: () => void) => controller?.subscribe(listener) ?? (() => undefined),
		[controller],
	);
	const getSnapshot = useCallback(() => controllerSnapshot(controller), [controller]);
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * The page view: the whole form, no card chrome of its own — the bundle page
 * draws the title, the icon and the crumb.
 *
 * @param props - the injected controller.
 */
function HashlineSettingsPageView({ controller }: { readonly controller?: SettingsControllerFace }): ReactElement {
	ensureManagerStyles();
	// Our own controller (#171): subscribed above, written through below.
	// A deployment that injected none degrades through the not-ready gate.
	const snapshot = useControllerSnapshot(controller);
	const ast = readAst(snapshot);
	const core = readCore(snapshot);
	const overridden = hasExplicitMaster(snapshot);
	const { state: catalog, reload } = useCatalog();
	const lsp = useLspStatus();
	const namedServers = readLspServers(snapshot);
	const autoDiag = readAutoDiagnostics(snapshot);
	const updates = useUpdates();
	const [serverLang, setServerLang] = useState("");
	const [serverCommand, setServerCommand] = useState("");
	/**
	 * The separator is a DRAFT, committed on blur.
	 *
	 * Writing on every keystroke would re-register the tool surfaces per character —
	 * the separator is part of the row format, so a live edit redraws every row in
	 * the conversation. Blur is the moment the user means "this is it".
	 */
	const [separatorDraft, setSeparatorDraft] = useState(core.separator);
	/** Same draft-on-blur treatment for the numeric field. */
	const [contextDraft, setContextDraft] = useState(String(core.contextLines));
	/** Which of the card's two sections is showing. */
	const [tab, setTab] = useState<"core" | "ast" | "lsp">("core");
	const [query, setQuery] = useState("");
	const [busy, setBusy] = useState<string | undefined>(undefined);
	const [error, setError] = useState<string | undefined>(undefined);
	const [inFlight, setInFlight] = useState<AbortController | undefined>(undefined);
	/** The language whose server is being installed right now, if any. */
	const [installing, setInstalling] = useState<string | undefined>(undefined);
	/**
	 * What the last install did, kept until the next one.
	 *
	 * A successful install used to leave NOTHING on screen: the row changed, or
	 * with the discovery cache it did not, and either way the reader was left to
	 * guess whether the click had done anything. An action that installs software
	 * has to say so.
	 */
	const [notice, setNotice] = useState<string | undefined>(undefined);
	/**
	 * The last FAILED install, kept per language so its own row can say why.
	 *
	 * A single global `error` put the message at the bottom of the card, below a
	 * nineteen-row list — which is the same as not showing it. The row the user
	 * clicked is the only place it gets read.
	 */
	const [failedInstall, setFailedInstall] = useState<{ languageId: string; message: string } | undefined>(undefined);

	/**
	 * Install one language's server, then re-read the list.
	 *
	 * The re-read is the point rather than a nicety: the plugin's install prefix
	 * is searched ahead of PATH, so a successful install changes what discovery
	 * FINDS — and a card still showing "未找到" after a successful install would
	 * be reporting a stale fact as a current one.
	 */
	const installServer = useCallback(
		async (languageId: string) => {
			setInstalling(languageId);
			setFailedInstall(undefined);
			// `go install` builds a toolchain and `npm install` resolves a tree; the
			// message does not name either one, because the catalog decides which runs
			// and naming the wrong one is a small lie the user then reasons from.
			setNotice(`正在安装 ${languageId} 的服务器，可能要一会儿。`);
			setError(undefined);
			try {
				const response = await fetch(`${LSP_ROUTE}/install`, {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: JSON.stringify({ languageId }),
				});
				const body = (await response.json()) as { ok?: boolean; message?: string };
				if (body.ok !== true) throw new Error(body.message ?? "install did not complete");
				setNotice(`✓ ${languageId} 的服务器已安装。`);
				lsp.reload();
			} catch (cause) {
				setNotice(undefined);
				// ON THE ROW, not at the bottom of the card. This is the failure the user
				// reported as "变回安装，全程没有任何错误提示": the message existed, it was
				// rendered below a nineteen-row list, and nobody scrolls there.
				setFailedInstall({ languageId, message: cause instanceof Error ? cause.message : String(cause) });
			} finally {
				setInstalling(undefined);
			}
		},
		[lsp],
	);

	const write = useCallback(async (key: string, action: () => Promise<void>) => {
		setBusy(key);
		setError(undefined);
		try {
			await action();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(undefined);
		}
	}, []);

	/**
	 * Queue one field edit through the controller's mutate: a VALUE sets the
	 * field, no value CLEARS it (the field re-inherits the composition
	 * base) — the same "empty means revert" the card's drafts already use.
	 */
	const writeField = async (field: string, ...value: readonly unknown[]): Promise<void> => {
		if (controller === undefined) return;
		// mutate resolves `false` on refusal (revision conflict, rejected
		// validation) rather than throwing — surface it so the control shows
		// WHY nothing wrote instead of silently looking dead.
		const accepted = await controller.mutate([buildFieldOp(field, value[0])]);
		if (accepted !== true) {
			throw new Error("写入被拒绝：配置已在他处修改（revision 冲突）或校验未通过，请重试。");
		}
	};

	const callRoute = useCallback(
		async (action: "install" | "uninstall", id: string, signal?: AbortSignal) => {
			await write(`${action}:${id}`, async () => {
				const response = await fetch(`${MANAGER_ROUTE}/${action}`, {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/x-ndjson" },
					body: JSON.stringify({ id }),
					...(signal === undefined ? {} : { signal }),
				});
				if (response.headers.get("content-type")?.includes("x-ndjson") === true && response.body !== null) {
					const reader = response.body.getReader();
					const decoder = new TextDecoder();
					let buffer = "";
					let outcome: { ok?: boolean; message?: string } | undefined;
					for (;;) {
						const { done, value } = await reader.read();
						if (done) break;
						buffer += decoder.decode(value, { stream: true });
						const lines = buffer.split("\n");
						buffer = lines.pop() ?? "";
						for (const line of lines) {
							if (line === "") continue;
							const event = JSON.parse(line) as { type?: string; ok?: boolean; message?: string };
							if (event.type === "done") outcome = event;
						}
					}
					if (outcome?.ok !== true) throw new Error(outcome?.message ?? "install did not complete");
				} else {
					const body = (await response.json()) as { ok?: boolean; message?: string };
					if (body.ok !== true) throw new Error(body.message ?? `HTTP ${response.status}`);
				}
				reload();
			});
		},
		[write, reload],
	);

	const writable = snapshot.writable && busy === undefined;

	/** A's search: match the name, the id, or any extension. */
	const matches = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (needle === "") return catalog.rows;
		return catalog.rows.filter(
			(row) =>
				row.displayName.toLowerCase().includes(needle) ||
				row.id.includes(needle) ||
				row.extensions.some((extension) => extension.includes(needle)),
		);
	}, [catalog.rows, query]);

	const builtin = matches.filter((row) => row.builtin);
	const installed = matches.filter((row) => !row.builtin && row.installed);
	const available = matches.filter((row) => !row.builtin && !row.installed);
	const usable = [...builtin, ...installed];

	// Not ready means the Host has not served this namespace yet; offering
	// controls that cannot write would be worse than saying nothing.
	if (snapshot.status !== "ready") {
		return <p className="dshl-mgr-hint">设置尚未就绪。</p>;
	}

	return (
		<>
			{/*
			 * Two sections, one card. Cards are dispatched by settings NAMESPACE
			 * and both live under `hashline`, so two cards would need two
			 * namespaces — and a namespace with nothing in it is a slot reserved
			 * for nothing. A switch keeps one namespace and still separates the two
			 * layers, which is the part that matters to a reader.
			 */}
			<div className="dshl-mgr-tabs" role="tablist">
				<button
					type="button"
					role="tab"
					aria-selected={tab === "core"}
					className={`dshl-mgr-tab${tab === "core" ? " dshl-mgr-tab--active" : ""}`}
					onClick={() => setTab("core")}
				>
					行为
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={tab === "ast"}
					className={`dshl-mgr-tab${tab === "ast" ? " dshl-mgr-tab--active" : ""}`}
					onClick={() => setTab("ast")}
				>
					AST 管理
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={tab === "lsp"}
					className={`dshl-mgr-tab${tab === "lsp" ? " dshl-mgr-tab--active" : ""}`}
					onClick={() => setTab("lsp")}
				>
					语言服务器
				</button>
			</div>
			{/*
			 * ABOVE the tab content, not below it.
			 *
			 * This is where the result of an action is announced, and it used to sit after
			 * every tab — under a list nineteen rows long. Clicking 安装 and getting an
			 * error scrolled off the bottom is indistinguishable from getting nothing,
			 * which is exactly how it was reported: the button went back to 安装 and no
			 * reason appeared.
			 */}
			{notice === undefined ? null : (
				<p className="dshl-mgr-hint" role="status">
					{notice}
				</p>
			)}
			{error === undefined ? null : (
				<p className="dshl-mgr-error" role="status">
					{error}
				</p>
			)}
			{tab === "core" ? (
				<>
					{/*
					 * The settings that shape every ROW, which had no control anywhere.
					 * They were reachable only by editing settings.yaml, so the card showed
					 * the two capability sections while the behaviour every one of their rows
					 * depends on — the character between anchor and content, whether an edit
					 * must re-state the line it touches — was invisible.
					 */}
					<h4 className="dshl-mgr-section">行格式</h4>
					<div className="dshl-mgr-master">
						<span className="dshl-mgr-label">分隔符</span>
						<input
							className="dshl-mgr-search"
							style={{ maxWidth: "8ch" }}
							value={separatorDraft}
							disabled={!writable}
							onChange={(event) => setSeparatorDraft(event.target.value)}
							onBlur={() =>
								void write("separator", () =>
									separatorDraft === ""
										? writeField("separator")
										: writeField("separator", separatorDraft),
								)
							}
						/>
						<span className="dshl-mgr-grow" />
						<span className="dshl-mgr-hint">
							锚点与内容之间。行号与锚点之间永远是 `:`，不可配置。
						</span>
					</div>

					<h4 className="dshl-mgr-section">输出</h4>
					<div className="dshl-mgr-master">
						<span className="dshl-mgr-label">JSON 输出</span>
						<span className="dshl-mgr-grow" />
						{/*
						 * A switch rather than a free-text field: `output_format` is a two-value
						 * enum in the schema, and offering a text box for it would let the card
						 * write a value the reader will not accept.
						 */}
						{renderSwitch(core.outputFormat === "json", !writable, "output", (checked) =>
							void write("output", () =>
								checked ? writeField("output_format", "json") : writeField("output_format"),
							),
						)}
					</div>
					<div className="dshl-mgr-master">
						<span className="dshl-mgr-label">上下文行数</span>
						<input
							className="dshl-mgr-search"
							style={{ maxWidth: "8ch" }}
							type="number"
							min={0}
							max={20}
							value={contextDraft}
							disabled={!writable}
							onChange={(event) => setContextDraft(event.target.value)}
							onBlur={() => {
								const parsed = Number.parseInt(contextDraft, 10);
								void write("context", () =>
									Number.isInteger(parsed) && parsed >= 0 && parsed <= 20
										? writeField("context_lines", parsed)
										: writeField("context_lines"),
								);
							}}
						/>
						<span className="dshl-mgr-grow" />
						<span className="dshl-mgr-hint">diff 与错误回显里上下各留几行（0–20）。域外或非数字则恢复默认。</span>
					</div>

					<h4 className="dshl-mgr-section">编辑</h4>
					<div className="dshl-mgr-master">
						<span className="dshl-mgr-label">重述被改的行</span>
						<span className="dshl-mgr-grow" />
						{renderSwitch(core.requireLineContent, !writable, "require", (checked) =>
							void write("require", () =>
								checked ? writeField("require_line_content", true) : writeField("require_line_content"),
							),
						)}
					</div>
					<p className="dshl-mgr-hint">
						开启后每个锚点必须连同行内容一起声明（`{'{'}`anchor, line{'}'}`），声明与磁盘不符就拒绝——防的是“拿着旧读的数去改新文件”。
					</p>
				</>
			) : tab === "ast" ? (
				<>
			<div className="dshl-mgr-master">
				<span className="dshl-mgr-label">总开关</span>
				<span className="dshl-mgr-hint">关闭时 ast_grep / ast_edit 拒绝运行（read / edit 不受影响）</span>
				<span className="dshl-mgr-grow" />
				{overridden ? (
					<Button size="sm" disabled={!writable} onClick={() => void write("reset", () => writeField("ast"))}>
						恢复默认
					</Button>
				) : (
					<span className="dshl-mgr-hint">继承预设</span>
				)}
				{/* 
				 * `checked` is the CURRENT state, not its negation. It was inverted here,
				 * which produced two symptoms from one bug: the switch read OFF while
				 * settings.yaml said true, and clicking it sent the value it already had —
				 * so nothing changed and the control looked dead.
				 */}
				{renderSwitch(ast.enabled, !writable, "master", (checked) =>
					void write("master", () => writeField("ast", { ...ast, enabled: checked })),
				)}
			</div>

			<input
				className="dshl-mgr-search"
				placeholder={`搜索语言或扩展名（${catalog.rows.length} 个条目）`}
				value={query}
				onChange={(event) => setQuery(event.target.value)}
			/>

			{inFlight === undefined ? null : (
				<button type="button" className="dshl-mgr-cancel" onClick={() => inFlight.abort()}>
					取消安装
				</button>
			)}

			{catalog.failure === undefined ? null : (
				<p className="dshl-mgr-error" role="status">
					无法读取语言目录：{catalog.failure}
				</p>
			)}

			<div className="dshl-mgr-columns">
				<section>
					<h4 className="dshl-mgr-section">已可用 · {usable.length}</h4>
					<ul className="dshl-mgr-list">
						{usable.map((row) => (
							<LanguageRowItem
								key={row.id}
								row={row}
								astEnabled={ast.enabled}
								disabled={ast.languages[row.id]?.enabled === false}
								// Presence, not value: only an explicit entry is an override.
								writable={writable}
								overridden={ast.languages[row.id] !== undefined}
								busy={busy}
								onToggle={() => {
									const languages = { ...ast.languages };
									// Absent = inherit the master switch; only an explicit
									// `false` is stored, and clearing is DELETION.
									if (languages[row.id]?.enabled === false) delete languages[row.id];
									else languages[row.id] = { enabled: false };
									void write(`lang:${row.id}`, () => writeField("ast", { ...ast, languages }));
								}}
								onRemove={() => void callRoute("uninstall", row.id)}
							/>
						))}
					</ul>
				</section>
				<section>
					<h4 className="dshl-mgr-section">可添加 · {available.length}</h4>
					<ul className="dshl-mgr-list">
						{available.map((row) => (
							<LanguageRowItem
								key={row.id}
								row={row}
								astEnabled={ast.enabled}
								// No switch here: this row's grammar is not on disk, so it cannot be
								// used yet whatever the enable list says. 添加 is the only action that
								// changes that, and the row offers exactly it.
								writable={writable}
								// Reported even here: a language can be named explicitly in settings
								// before its grammar is ever installed.
								overridden={ast.languages[row.id] !== undefined}
								busy={busy}
								onToggle={() => undefined}
								onInstall={() => {
									const controller = new AbortController();
									setInFlight(controller);
									void callRoute("install", row.id, controller.signal).finally(() => setInFlight(undefined));
								}}
							/>
						))}
						{available.length === 0 ? <li className="dshl-mgr-hint">没有匹配的条目</li> : null}
					</ul>
				</section>
			</div>
				{updates.length === 0 ? null : (
					// A NOTICE, never an action. The newer grammar's hash was published by
					// the registry and nothing here has measured it against a catalog, so
					// the honest thing is to say one exists rather than to offer it — and
					// to say WHERE it comes from, because "update" with no object reads as
					// a button that is missing rather than a decision already made.
					<p className="dshl-mgr-hint">
						{updates.length} 门文法有新版本（
						{updates.map((row) => `${row.id} ${row.installed}→${row.latest}`).join("、")}）——跟随插件更新获取。
					</p>
				)}
				</>
			) : null}
			{tab === "lsp" ? (
				<>


			{/*
			 * The SERVER half, in the same card as the grammar half because the two
			 * answer the same question from different layers: a tree-sitter grammar
			 * gives structure, a language server gives cross-file reference
			 * precision. References fall back to heuristic scanning without one, and
			 * the reason is the part that was previously unreachable from the screen.
			 */}
			<h4 className="dshl-mgr-section">语言服务器</h4>
			{lsp.failure !== undefined ? (
				<p className="dshl-mgr-error" role="status">
					无法读取语言服务器状态：{lsp.failure}
				</p>
			) : !lsp.available ? (
				// A state, not a failure: the LSP packages are not installed by default.
				<p className="dshl-mgr-hint">{lsp.message ?? "语言服务器客户端未启用，所以语义操作没有可用的服务器。"}</p>
			) : (
				<ul className="dshl-mgr-list">
					{lsp.rows.map((entry) => (
						<li key={entry.languageId} className="dshl-mgr-row">
							<StateDot state={entry.ready ? "done" : entry.server === undefined ? "error" : "warning"} size={8} />
							<span className="dshl-mgr-display-name">{entry.languageId}</span>
							<span className="dshl-mgr-ext">
								{entry.server === undefined
									? "未找到"
									: `${entry.server.displayName} · ${ORIGIN_TEXT[entry.server.origin] ?? entry.server.origin}`}
							</span>
							{/*
							 * TWO SLOTS, not one. The status is where a message goes; the
							 * button is where the action lives, and the action does not
							 * disappear because an attempt failed.
							 *
							 * It did exactly that before: a failure replaced the button,
							 * so a failed install could not be retried without reloading
							 * the page — the one moment you most want to try again.
							 */}
							{/*
							 * TWO SLOTS, and the error is the one that wraps.
							 *
							 * A short status reads fine beside the name; a failed install does
							 * not, and squeezing it into the same slot truncated the one thing
							 * the reader needs. So the status stays inline and the error —
							 * rendered AFTER the button — takes a line of its own below.
							 */}
							{installing === entry.languageId ? (
								<span className="dshl-mgr-hint">安装中，请稍候</span>
							) : failedInstall?.languageId === entry.languageId ? null : entry.ready ? null : (
								<span className="dshl-mgr-hint">{entry.message ?? entry.reason}</span>
							)}
							<span className="dshl-mgr-grow" />
							{!entry.ready && entry.server === undefined && entry.canInstall === true ? (
								// The host's own Button. The label says 重试 once this language has
								// failed once — the action is available either way, and saying so
								// is the difference between "it broke" and "it is broken".
								<Button size="sm" disabled={installing !== undefined} onClick={() => void installServer(entry.languageId)}>
									{failedInstall?.languageId === entry.languageId ? "重试" : "安装"}
								</Button>
							) : null}
							{/* LAST in DOM order, so its `flex:1 0 100%` wraps BELOW the button
							 * instead of shoving the button onto a second line. */}
							{failedInstall?.languageId === entry.languageId ? (
								<span className="dshl-mgr-error">失败：{failedInstall.message}</span>
							) : null}
						</li>
					))}
				</ul>
			)}
			{/* #131: the delivery switch, beside the servers it governs. The card
			 * shows the effective state; only an explicit `false` turns it off, and
			 * switching it back on writes that value explicitly so the file says
			 * what the card shows. */}
			<div className="dshl-mgr-master">
				<span className="dshl-mgr-label">自动诊断回送</span>
				<span className="dshl-mgr-hint">edit / write / undo 落盘后自动把语言服务器诊断回送模型（默认开）</span>
				<span className="dshl-mgr-grow" />
				{renderSwitch(
					autoDiag,
					!writable,
					"autoDiag",
					(checked) =>
						void write("autoDiag", () =>
							writeField("lsp", { servers: { ...namedServers }, auto_diagnostics: checked }),
						),
				)}
			</div>
			{/*
			 * Naming a server is INTENT and lives here; whether that command exists
			 * is a fact the status list above reports. Keeping them apart is what
			 * lets a typo be VISIBLE — it shows as 未找到 with the command beside it
			 * — instead of being silently refused at the point of entry.
			 */}
			<div className="dshl-mgr-master">
				<span className="dshl-mgr-label">指定服务器</span>
				<span className="dshl-mgr-hint">按语言指定命令；留空则用探测到的</span>
				<span className="dshl-mgr-grow" />
			</div>
			{Object.keys(namedServers).length === 0 ? (
				<p className="dshl-mgr-hint">没有指定任何服务器，全部使用探测结果。</p>
			) : (
				<ul className="dshl-mgr-list">
					{Object.entries(namedServers).map(([id, command]) => (
						<li key={id} className="dshl-mgr-row">
							<span className="dshl-mgr-display-name">{id}</span>
							<span className="dshl-mgr-ext" title={command}>{command}</span>
							<span className="dshl-mgr-grow" />
							<Button
								size="sm"
								disabled={!writable}
								onClick={() => {
									const servers = { ...namedServers };
									delete servers[id];
									void write(`lsp:${id}`, () => writeField("lsp", { servers, auto_diagnostics: autoDiag }));
								}}
							>
								移除
							</Button>
						</li>
					))}
				</ul>
			)}
			<div className="dshl-mgr-master">
				<input
					className="dshl-mgr-search"
					placeholder="语言，如 typescript"
					value={serverLang}
					onChange={(event) => setServerLang(event.target.value)}
				/>
				<input
					className="dshl-mgr-search"
					placeholder="命令，如 /usr/local/bin/tsserver"
					value={serverCommand}
					onChange={(event) => setServerCommand(event.target.value)}
				/>
				<Button
					size="sm"
					variant="primary"
					disabled={!writable || serverLang.trim() === "" || serverCommand.trim() === ""}
					onClick={() => {
						const servers = { ...namedServers, [serverLang.trim()]: serverCommand.trim() };
						setServerLang("");
						setServerCommand("");
						void write(`lsp:${serverLang.trim()}`, () => writeField("lsp", { servers, auto_diagnostics: autoDiag }));
					}}
				>
					指定
				</Button>
			</div>
				</>
			) : null}
		</>
	);
}
