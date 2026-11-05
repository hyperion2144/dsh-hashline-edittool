/**
 * dsh-hashline-edittool — hash-anchored read/edit/undo_last_edit/grep for
 * DeepSeek Harness — a dsh port of the hashline editor.
 *
 * Cordis host-plane plugin (mounted by the bundle's cordis.patch.yml). The
 * tools sit on TWO layers: the agent's own scope layer and the plugin's.
 *
 * - The tools that shadow a same-named built-in (`read`, `write`, `edit`,
 *   `grep`) go on the AGENT's own scope layer — the agent's nearer layer
 *   wins over the preset's (nearest layer wins in dsh's tool registry),
 *   and it is the only layer that can shadow a built-in at all. They
 *   unwind automatically when the agent is disposed.
 * - `lsp` and `apply_patch` join them on the agent's layer UNCONDITIONALLY
 *   (#418): the probe-decided placement (#398 / ADR-0032) relied on a
 *   per-process ownership check that cannot survive a restart, and the
 *   restart-resume path put both tools on the agent layer anyway — a
 *   layer whose fresh names do not reach the first turn's schema in a
 *   deployment whose preset declares no same-named built-in. The agent's
 *   own layer is the layer this install fills synchronously, so it is
 *   the layer these two live on, shadowing or not.
 * - The tools that shadow NOTHING (`ast_grep`, `ast_edit`, `undo_last_edit`,
 *   `format`, `delete`, `rename`) are registered ONCE on the plugin's own
 *   layer at plugin load, the way every other dsh plugin registers its
 *   tools. Every agent inherits them: they do not wait for an agent to
 *   exist, and they do not vanish when one ends (#398).
 *
 * The `agent/created` listener (dsh ≥ 0.1.6; the pre-rename name
 * `agent/session-start` is still registered for older harnesses) returns only
 * after the agent-scoped half is installed: the host holds a resumed
 * session's queued input until every listener has returned, so an early
 * return hands the model a half-installed tool surface on the first turn.
 *
 * The six `tool:*` guidance sections resolve per agent preset from override
 * files in the shared home (see `src/guidance.ts`); deployments without the
 * `agentPresets` service keep the compiled defaults unchanged.
 * @module dsh-hashline-edittool
 */

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { FileSystem } from "@deepseek-ai/dsh-fs";
import { ctxFsIO } from "./infra/fs-bridge.js";
import { FsSandboxController } from "./infra/sandbox.js";
import { registerReadTool } from "./tools/tool-read.js";
import { registerEditTool } from "./tools/tool-edit.js";
import { registerApplyPatchTool } from "./tools/tool-apply-patch.js";
import {
	HashlineSettingsSchema,
	installHashlineSettings,
	isApplyPatchEnabled,
	lspConfiguredServers,
	lspIdleTimeoutMs,
} from "./config.js";
import { registerUndoTool } from "./tools/tool-undo.js";
import { registerGrepTool } from "./tools/tool-grep.js";
import { registerAstGrepTool } from "./tools/tool-ast-grep.js";
import { registerLspTool } from "./tools/tool-lsp.js";
import { registerAstEditTool } from "./tools/tool-ast-edit.js";
import { registerWriteShadow } from "./tools/tool-write-shadow.js";
import { registerFormatTool } from "./tools/tool-format.js";
import { registerDeleteTool } from "./tools/tool-delete.js";
import { registerRenameTool } from "./tools/tool-rename.js";
import { onEditSurfaceRebuild } from "./domain/edit/edit-rebuild.js";
import { LspManager, setLspManager } from "./lsp/manager.js";
import { subprocessTransport } from "./lsp/transport.js";
import { registerLspProvider } from "./lsp/provider.js";
import { serverArgv } from "./lsp/discovery.js";
import { registerGrammarRoutes } from "./ast/install-route.js";
import { registerLspRoutes } from "./lsp/status-route.js";

/** How long to wait for a web server before giving up on the routes. */
const ROUTE_WAIT_MS = 15_000;

import {
	composeSections,
	ensurePresetGuidance,
	GUIDANCE_SECTIONS,
	type SectionOverride,
} from "./guidance.js";
import { configDir } from "./infra/paths.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "dsh-hashline-edittool";

/**
 * Services the plugin's per-agent install touches: `tools` and `systemPrompt`
 * for the shadow registrations, `fs` for the IO bridge. Cordis refuses
 * property access to an undeclared service ("cannot get property X without
 * inject"), so these MUST be listed or every agent install fails at
 * session-start.
 */
// No `settings` inject anymore: dsh 0.1.7 hands settings to `apply` as the
// plugin's own Config (every field volatile), and the document-updated
// signal rides the string-keyed event bus — no service property access left.
export const inject = ["tools", "systemPrompt", "fs"];

/** The plugin's configuration schema — the 0.1.7 settings entry surface. */
export const Config = HashlineSettingsSchema;

/** One per-agent registration bundle, disposed with the agent. */
interface AgentTools {
	dispose(): void;
}

/**
 * Minimal shape of the optional `agentPresets` service (dsh-agent-presets).
 * Read via `ctx.get` — never injected — so a deployment composed without the
 * service keeps the compiled defaults and never touches the filesystem here.
 */
interface AgentPresetsService {
	composedPreset(agentCtx: Context): string | undefined;
}

/** The four sections as compiled, byte-identical to the pre-guidance install. */
function compiledDefaultSections(): SectionOverride[] {
	return GUIDANCE_SECTIONS.map((section) => ({
		name: section.name,
		order: section.defaultOrder,
		text: section.renderDefault(),
	}));
}

/**
 * Resolve the agent scope's `systemPrompt` service (dsh ≥ 0.1.6 moved it from
 * a Context property to a scoped service — #134's follow-on). A missing
 * service degrades to a warn-and-no-op stub so losing prompt sections can
 * never fail the tool install: the tools are the contract, the sections are
 * guidance.
 */
function resolveAgentSystemPrompt(rootCtx: Context, agent: Agent): {
	section(section: SectionOverride): () => void;
} {
	const service = agent.ctx.get("systemPrompt") as
		| { section(section: SectionOverride): () => void }
		| undefined;
	if (service) return service;
	rootCtx.logger.warn(
		`dsh-hashline-edittool: systemPrompt service unavailable on agent ${agent.id}; prompt sections skipped`,
	);
	return {
		section: () => () => undefined,
	};
}

/**
 * Resolve the four guidance sections for one agent. Without the `agentPresets`
 * service the fast path returns the compiled defaults untouched. With it, the
 * agent's preset id drives `composeSections` against the shared home; any
 * resolution failure degrades to compiled defaults so a bad override file can
 * never fail the install.
 */
async function resolveAgentSections(
	rootCtx: Context,
	agent: Agent,
): Promise<SectionOverride[]> {
	const agentPresets = rootCtx.get("agentPresets") as
		| AgentPresetsService
		| undefined;
	if (!agentPresets) return compiledDefaultSections();
	try {
		const presetId = agentPresets.composedPreset(agent.ctx);
		const sections = await composeSections(presetId, configDir());
		// Warn once per agent install (this runs once per agent, under the
		// WeakSet guard) about any malformed override we had to ignore.
		for (const section of sections) {
			if (section.malformed) {
				rootCtx.logger.warn(
					`dsh-hashline-edittool: ignoring malformed guidance override ${section.malformed.file}: ${section.malformed.reason}; using compiled default`,
				);
			}
		}
		return sections;
	} catch (error) {
		rootCtx.logger.warn(
			`dsh-hashline-edittool: guidance resolution failed for agent ${agent.id}, using compiled defaults: ${error instanceof Error ? error.message : String(error)}`,
		);
		return compiledDefaultSections();
	}
}

/**
 * Install the tools that must SHADOW the preset's built-ins on the agent's
 * own scope layer, and resolve once they are all in place.
 *
 * The host holds a resumed session's queued input until every `agent/created`
 * listener has returned (`packages/core/agent/README.md:207`), so this
 * promise is what keeps the first turn of a resumed session from seeing a
 * half-installed tool surface (#398).
 */
function installAgentTools(rootCtx: Context, agent: Agent): Promise<void> {
	let markDone!: () => void;
	let markFailed!: (error: unknown) => void;
	const ready = new Promise<void>((resolve, reject) => {
		markDone = () => resolve();
		markFailed = (error: unknown) => reject(error);
	});
	try {
		agent.ctx.effect(async () => {
			try {
				return await installAgentScopedTools(rootCtx, agent);
			} catch (error) {
				// The listener must learn the failure: the host releases a
				// resumed session's queued input the moment this listener
				// returns, so a half-installed surface would otherwise reach
				// the model unannounced.
				markFailed(error);
				return () => undefined;
			} finally {
				markDone();
			}
		});
	} catch (error) {
		// `ctx.effect` throws when the agent's scope is already gone. The
		// listener still has to RETURN — one that never settles holds the
		// host's queued input forever.
		markFailed(error);
	}
	return ready;
}

/**
 * The agent-scoped half: every tool that lives on the agent's own layer —
 * the four shadowing tools, plus `lsp` / `apply_patch` (#418) — plus the
 * per-preset guidance sections.
 *
 * The tool registrations happen BEFORE the first await (the guidance
 * override read), so the tool surface is complete the moment the agent
 * exists; only the guidance text lands a tick later.
 */
async function installAgentScopedTools(rootCtx: Context, agent: Agent): Promise<() => void> {
	// `fs` is host-plane: use the plugin's own context (covered by
	// inject) rather than the agent's scoped one, whose fiber chain does
	// not declare it. The session's LIVE working directory reaches the bridge
	// per call, asked of the host (see domain/session/live-cwd.ts).
	const io = ctxFsIO(rootCtx.fs as FileSystem, rootCtx);
	const sandbox = new FsSandboxController(rootCtx);

	// The edit surface (tool schema + its guidance section) depends on
	// `hashline.require_line_content`: when the flag flips, dispose and
	// re-register so the model's NEXT step sees the new parameter set
	// (tools are re-assembled per step — not session-snapshotted).
	let editDispose: (() => void) | undefined;
	let editSectionDispose: (() => void) | undefined;
	let reinstall: Promise<void> = Promise.resolve();
	const systemPrompt = resolveAgentSystemPrompt(rootCtx, agent);
	const installEditTool = (): void => {
		editDispose = registerEditTool(rootCtx, agent.ctx, io, sandbox);
	};
	const installEditSection = async (): Promise<void> => {
		// Re-resolve per install so a rebuilt surface picks up fresh
		// flag-aware default text (user overrides stay authoritative).
		const sections = await resolveAgentSections(rootCtx, agent);
		for (const section of sections) {
			if (section.name !== "tool:edit") continue;
			editSectionDispose = systemPrompt.section(section);
		}
	};

	// The patch surface follows `apply_patch.enabled` and nothing else: off
	// removes BOTH the tool and its guidance section, and a hot flip
	// reinstalls them without restarting the session (map #401).
	let applyPatchDispose: (() => void) | undefined;
	let applyPatchSectionDispose: (() => void) | undefined;
	const installApplyPatch = (): void => {
		applyPatchDispose?.();
		applyPatchDispose = undefined;
		// The agent's own layer, unconditionally (#418): the probe-decided
		// placement fell back to the plugin layer exactly when no preset
		// built-in existed — and the restart-resume path then placed the tool
		// on the agent layer anyway, whose fresh names miss a first turn that
		// no preset declaration occupies. The agent's own layer is the layer
		// THIS install fills synchronously before the host releases the
		// queued input, so it is the only placement this plugin controls
		// end to end. Off means OFF for this agent: no tool, no guidance
		// section. The cross-agent plugin-layer disposer bookkeeping is gone
		// with the probe.
		if (!isApplyPatchEnabled()) return;
		applyPatchDispose = registerApplyPatchTool(rootCtx, agent.ctx, io, sandbox).dispose;
	};
	const installApplyPatchSection = async (): Promise<void> => {
		applyPatchSectionDispose?.();
		applyPatchSectionDispose = undefined;
		if (!isApplyPatchEnabled()) return;
		const sections = await resolveAgentSections(rootCtx, agent);
		for (const section of sections) {
			if (section.name !== "tool:apply_patch") continue;
			applyPatchSectionDispose = systemPrompt.section(section);
		}
	};

	const disposers: Array<() => void> = [];
	// The READ surface is registered ONCE and never rebuilt.
	//
	// It used to be gated like the edit surface, because its parameter set
	// followed `ast.enabled`: the AST sentences and the AST parameters appeared
	// together, so the model never read about a parameter it could not pass.
	// The parameters are gone — structure moved to `ast_grep` / `lsp`, whose
	// surfaces do not vary — so there is nothing left for a rebuild to react
	// to, and machinery for a change that cannot happen is its own kind of lie.
	installEditTool();
	installApplyPatch();
	disposers.push(registerReadTool(rootCtx, agent.ctx, io));
	disposers.push(registerGrepTool(rootCtx, agent.ctx, io));
	// The semantic half. omp's rule, and now ours: symbol-aware work goes to a
	// language server whenever one can be had, because it follows shadowing and
	// cross-file usage that a syntax tree cannot.
	// `lsp` registers on the agent's own layer UNCONDITIONALLY (#418): the
	// probe's plugin-layer fallback was reached exactly when no preset
	// built-in existed, and the restart-resume path overrode it to the agent
	// layer anyway — leaving the tool out of that first turn. The agent's
	// layer is what this install fills synchronously, so it is where the
	// name lives from the first turn, shadowing a built-in or not.
	disposers.push(registerLspTool(rootCtx, agent.ctx, io).dispose);
	// #53: the write tool is fully shadowed — it owns the auto-read preview
	// (formerly a post-execute hook) AND the write card's structured rows.
	disposers.push(registerWriteShadow(rootCtx, agent.ctx, io, sandbox));

	const offRebuild = onEditSurfaceRebuild(() => {
		// Serialize rebuilds; a failure must not unwind the agent install.
		reinstall = reinstall.then(async () => {
			try {
				editDispose?.();
				editSectionDispose?.();
				installEditTool();
				await installEditSection();
				// The patch surface follows its own switch, so a rebuild for the
				// edit flag must leave it alone — but a flip of EITHER flag must
				// reach both, and the registry has one rebuild path.
				installApplyPatch();
				await installApplyPatchSection();
			} catch (error) {
				rootCtx.logger.warn(
					`dsh-hashline-edittool: edit surface rebuild failed for agent ${agent.id}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		});
	});
	disposers.push(offRebuild);

	// Shadow the preset's built-in tool guidance with the hashline
	// contract. Same section names on the agent's own layer win over the
	// preset's; text and order come from the per-preset resolution.
	const sections = await resolveAgentSections(rootCtx, agent);
	for (const section of sections) {
		if (section.name === "tool:edit") {
			editSectionDispose = systemPrompt.section(section);
			continue;
		}
		if (section.name === "tool:apply_patch") continue; // installed with its switch
	}
	// The patch section follows `apply_patch.enabled`, so it is installed by the
	// same routine a hot flip runs — never by the loop above.
	await installApplyPatchSection();

	return () => {
		applyPatchDispose?.();
		applyPatchSectionDispose?.();
		editDispose?.();
		editSectionDispose?.();
		for (const dispose of disposers) dispose();
	};
}

/**
 * The tools that shadow NOTHING are registered ONCE, on the plugin's own
 * context — the way every other dsh plugin registers its tools (`tool-goal`,
 * `dsh-mnemon`, ...). They need no agent context: their file access and
 * sandbox policy are host-plane products, and the session's live working
 * directory is asked of the host per call (#398).
 */
function installPluginTools(rootCtx: Context): void {
	const io = ctxFsIO(rootCtx.fs as FileSystem, rootCtx);
	const sandbox = new FsSandboxController(rootCtx);
	// Each register function takes the context whose tool layer receives the
	// registration — the plugin's own context puts them on the plugin layer,
	// which every agent inherits.
	registerAstGrepTool(rootCtx, rootCtx, io);
	registerAstEditTool(rootCtx, rootCtx, io, sandbox);
	registerUndoTool(rootCtx, rootCtx, io, sandbox);
	registerFormatTool(rootCtx, rootCtx, io, sandbox);
	registerDeleteTool(rootCtx, rootCtx, io, sandbox);
	registerRenameTool(rootCtx, rootCtx, io, sandbox);
}

/**
 * Mount the bundle: initialize the store, then install tools per agent.
 *
 * `config` is the loader-resolved Config (0.1.7): every field arrives as a
 * volatile live reference, unwrapped at use time by `resolveSettings`.
 */
export function apply(rootCtx: Context, config?: unknown): void {
	// Hashline settings (separator / output_format / context_lines /
	// require_line_content / ast / lsp): applied once here and re-applied on
	// every `settings/document-updated` — the refs are read live each time.
	installHashlineSettings(rootCtx, config);

	// The tools that shadow nothing are registered once, here — on the
	// plugin layer, which every agent inherits. Registering them per agent
	// made a resumed session's first turn miss them entirely (#398).
	installPluginTools(rootCtx);

	installGrammarRoutes(rootCtx);

	// The language-server client. `subprocess` and `lsp` are both consumed
	// OPTIONALLY — neither is declared in `inject`, because declaring them
	// would stop this plugin loading at all in a deployment that has neither
	// (which is the default: the official LSP packages are not installed).
	installLspIntegration(rootCtx);

	// The per-workspace stores are opened lazily on the first tool call in
	// each workspace (there is no shared store to prune at boot anymore);
	// hashing is synchronous and dependency-free, so no warm-up is needed.

	// Seed each shipped preset's guidance directory once, so users have
	// editable per-preset overrides (idempotent: never rewrites existing
	// files). A failure must never fail the boot.
	ensurePresetGuidance(configDir()).catch((error) => {
		rootCtx.logger.warn(
			`dsh-hashline-edittool: guidance materialization failed: ${error instanceof Error ? error.message : String(error)}`,
		);
	});

	// dsh 0.1.6 renamed the agent-start event `agent/session-start` →
	// `agent/created` (#134). Register BOTH names: whichever the running
	// harness emits wins, the other is a silent no-op (unknown events are
	// accepted and never fired). The WeakSet makes double arrival idempotent.
	const registered = new WeakSet<Agent>();
	const onAgentStart = async ({ agent }: { agent: Agent }): Promise<void> => {
		if (registered.has(agent)) return;
		registered.add(agent);
		try {
			await installAgentTools(rootCtx, agent);
		} catch (error) {
			rootCtx.logger.warn(
				`dsh-hashline-edittool: failed to install tools for agent ${agent.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};
	const onAgentLifecycle = rootCtx.on.bind(rootCtx) as (
		event: string,
		handler: (payload: { agent: Agent }) => void | Promise<void>,
	) => unknown;
	onAgentLifecycle("agent/created", onAgentStart);
	onAgentLifecycle("agent/session-start", onAgentStart);
}

/**
 * Wire the language-server client into the platform's optional services.
 *
 * Everything here is guarded: no `subprocess` means no sessions can be spawned
 * (the heuristic backend still works), and no `lsp` means there is nothing to
 * register a provider on. Neither absence is an error — they are the default
 * deployment (ADR-0008 D2/D3).
 */
/**
 * Register the grammar routes once a web server exists.
 *
 * NOT a single `get("webServer")` at apply time: `apply()` runs before the web
 * server is mounted, so that lookup found nothing and the routes never appeared.
 * The symptom was a 404 from the router for `/api/hashline/grammars` — which
 * proved the request REACHED the API layer and simply found no such route, i.e.
 * registration never happened rather than being blocked.
 *
 * Retried rather than declared in `inject`, for the same reason `subprocess` and
 * `lsp` are not: a headless deployment has no web server at all, and declaring
 * one would stop this plugin loading entirely in those profiles.
 *
 * @param rootCtx - the plugin's root context.
 */
/**
 * Register every plugin-owned route once a web server exists.
 *
 * Both route sets share this one retry: they wait for the same service, and two
 * waiters would be two opportunities to disagree about when it arrived.
 *
 * @param rootCtx - the plugin's root context.
 */
function installGrammarRoutes(rootCtx: Context): void {
	const get = (name: string): unknown => (rootCtx as unknown as { get(key: string): unknown }).get(name);
	const registerAll = (): number => {
		const webServer = get("webServer");
		// The install ACTION needs a process to run, so the LSP routes get the same
		// seam the servers themselves are spawned through. Absent in a deployment
		// without one, and the install route then declines rather than throwing —
		// reading status must not depend on being able to change the machine.
		const subprocess = get("subprocess") as { spawn?: unknown } | undefined;
		const spawn =
			typeof subprocess?.spawn === "function"
				? (subprocess.spawn.bind(subprocess) as Parameters<typeof registerLspRoutes>[1])
				: undefined;
		return registerGrammarRoutes(webServer).length + registerLspRoutes(webServer, spawn).length;
	};
	const startedAt = Date.now();
	if (registerAll() > 0) return;
	const attempt = (): void => {
		if (registerAll() > 0) return;
		if (Date.now() - startedAt > ROUTE_WAIT_MS) {
			// Headless is the expected case, so this is a note rather than a
			// warning: there is simply no HTTP carrier to register against.
			rootCtx.logger.warn(
				`dsh-hashline-edittool: no web server appeared within ${ROUTE_WAIT_MS}ms — plugin routes not registered (expected in a headless profile).`,
			);
			return;
		}
		setTimeout(attempt, 100);
	};
	setTimeout(attempt, 100);
}

function installLspIntegration(rootCtx: Context): void {
	const get = (name: string): unknown => (rootCtx as unknown as { get(key: string): unknown }).get(name);

	const manager = new LspManager({
		spawn: (server, cwd) => {
			const subprocess = get("subprocess") as
				| {
						spawn(spec: {
							argv: readonly string[];
							cwd: string;
							stdio: { stdin: "pipe"; stdout: "pipe"; stderr: "pipe" };
							graceMs: number;
						}): unknown;
					}
				| undefined;
			if (subprocess === undefined || typeof subprocess.spawn !== "function") {
				throw new Error("The subprocess seam is not available, so no language server can be started.");
			}
			// Raw pipes: the seam's own documentation names LSP as a consumer of
			// exactly this shape, and it owns the process-tree teardown.
			const handle = subprocess.spawn({
				argv: serverArgv(server),
				cwd,
				stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
				graceMs: 2_000,
			});
			return { transport: subprocessTransport(handle as never) };
		},
		projectRoot: process.cwd(),
		//
		// Servers the user NAMED, as discovery's `configured` origin. Grouped by
		// command because that is the shape discovery wants: two languages served
		// by the same binary are one entry with two languages, not two entries
		// that would each spawn their own process.
		//
		// Read at CALL time rather than captured here, so a setting changed while
		// the plugin is loaded takes effect on the next discovery instead of
		// needing a restart. A named command is NOT checked for existence: that is
		// a fact the status surface reports, and refusing it here would make a typo
		// invisible at exactly the place that could show it.
		configured: configuredServers(),
		// Read at CALL time, like `configured`: the window comes from a setting
		// the user can change while the plugin is loaded, and the change must take
		// effect without a restart.
		idleTimeoutMs: () => lspIdleTimeoutMs(),
		onFailure: (languageId, message) => {
			rootCtx.logger.warn(`dsh-hashline-edittool: language server for ${languageId} did not start: ${message}`);
		},
	});
	setLspManager(manager);

	// Registering makes US the implementation the official `lsp` tool uses, so
	// the same server process serves both (ADR-0008 D2).
	const dispose = registerLspProvider(get("lsp"), (languageId) => manager.readySessionFor(languageId));

	try {
		rootCtx.effect(() => () => {
			void manager.dispose();
			dispose?.();
		});
	} catch {
		// No effect scope (older host): the sessions still shut down at exit.
	}
}

export type { AgentTools };

/**
 * The user's named servers, in the shape discovery wants.
 *
 * Grouped by command: two languages served by one binary become ONE entry with
 * two languages, because two entries would spawn two processes for one server.
 *
 * @returns configured entries, or an empty array when none are named.
 */
function configuredServers(): Array<{ command: string; languages: string[] }> {
	const byCommand = new Map<string, string[]>();
	for (const [language, command] of lspConfiguredServers()) {
		const bucket = byCommand.get(command);
		if (bucket === undefined) byCommand.set(command, [language]);
		else bucket.push(language);
	}
	return [...byCommand].map(([command, languages]) => ({ command, languages }));
}
