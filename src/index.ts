/**
 * dsh-hashline-edittool — hash-anchored read/edit/undo_last_edit/grep for
 * DeepSeek Harness — a dsh port of the hashline editor.
 *
 * Cordis host-plane plugin (mounted by the bundle's cordis.patch.yml). On
 * `agent/session-start` it registers the hashline tools and prompt sections on
 * the AGENT's own scope layer, so they shadow the preset's built-in `read` /
 * `edit` for that agent (nearest layer wins in dsh's tool registry) and unwind
 * automatically when the agent is disposed. The built-in `write` stays in
 * place; a scoped `tools/post-execute` listener appends the fresh hashline
 * preview to write results.
 *
 * The four `tool:*` guidance sections resolve per agent preset from override
 * files in the shared home (see `src/guidance.ts`); deployments without the
 * `agentPresets` service keep the compiled defaults unchanged.
 * @module dsh-hashline-edittool
 */

import type { Context } from "@deepseek-ai/cordis";
import type { Agent } from "@deepseek-ai/dsh-agent";
import type { FileSystem } from "@deepseek-ai/dsh-fs";
import { ctxFsIO } from "./fs-bridge.js";
import { FsSandboxController } from "./sandbox.js";
import { registerReadTool } from "./tool-read.js";
import { registerEditTool } from "./tool-edit.js";
import { installHashlineSettings, lspConfiguredServers } from "./config.js";
import { registerUndoTool } from "./tool-undo.js";
import { registerGrepTool } from "./tool-grep.js";
import { registerAstGrepTool } from "./tool-ast-grep.js";
import { registerLspTool } from "./tool-lsp.js";
import { registerAstEditTool } from "./tool-ast-edit.js";
import { registerWriteShadow } from "./tool-write-shadow.js";
import { onEditSurfaceRebuild } from "./edit-rebuild.js";
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
import { configDir } from "./paths.js";

/** Cordis plugin name used by loader diagnostics. */
export const name = "dsh-hashline-edittool";

/**
 * Services the plugin's per-agent install touches: `tools` and `systemPrompt`
 * for the shadow registrations, `fs` for the IO bridge. Cordis refuses
 * property access to an undeclared service ("cannot get property X without
 * inject"), so these MUST be listed or every agent install fails at
 * session-start.
 */
// `settings` is core dsh and declared here so cordis STARTS it before this
// plugin's apply runs — that is what retired the boot-order retry. The other
// three are the per-agent registration and IO seams.
export const inject = ["tools", "systemPrompt", "fs", "settings"];

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

function installAgentTools(rootCtx: Context, agent: Agent): void {
	agent.ctx.effect(async () => {
		// `fs` is host-plane: use the plugin's own context (covered by
		// inject) rather than the agent's scoped one, whose fiber chain does
		// not declare it. Session cwd still reaches the bridge per call via
		// exec.agent.session.header.cwd.
		const io = ctxFsIO(rootCtx.fs as FileSystem, rootCtx);
		const sandbox = new FsSandboxController(rootCtx);

		// The edit surface (tool schema + its guidance section) depends on
		// `hashline.require_line_content`: when the flag flips, dispose and
		// re-register so the model's NEXT step sees the new parameter set
		// (tools are re-assembled per step — not session-snapshotted).
		let editDispose: (() => void) | undefined;
		let editSectionDispose: (() => void) | undefined;
		let reinstall: Promise<void> = Promise.resolve();
		const installEditSurface = async (): Promise<void> => {
			editDispose = registerEditTool(rootCtx, agent.ctx, io, sandbox);
			// Re-resolve per install so a rebuilt surface picks up fresh
			// flag-aware default text (user overrides stay authoritative).
			const sections = await resolveAgentSections(rootCtx, agent);
			for (const section of sections) {
				if (section.name !== "tool:edit") continue;
				editSectionDispose = agent.ctx.systemPrompt.section(section);
			}
		};
		await installEditSurface();
		const offRebuild = onEditSurfaceRebuild(() => {
			// Serialize rebuilds; a failure must not unwind the agent install.
			reinstall = reinstall.then(async () => {
				try {
					editDispose?.();
					editSectionDispose?.();
					await installEditSurface();
				} catch (error) {
					rootCtx.logger.warn(
						`dsh-hashline-edittool: edit surface rebuild failed for agent ${agent.id}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			});
		});


		const disposers: Array<() => void> = [offRebuild];
		// The READ surface is registered ONCE and never rebuilt.
		//
		// It used to be gated like the edit surface, because its parameter set
		// followed `ast.enabled`: the AST sentences and the AST parameters appeared
		// together, so the model never read about a parameter it could not pass.
		// The parameters are gone — structure moved to `ast_grep` / `lsp`, whose
		// surfaces do not vary — so there is nothing left for a rebuild to react
		// to, and machinery for a change that cannot happen is its own kind of lie.
		disposers.push(registerReadTool(rootCtx, agent.ctx, io));
		disposers.push(registerGrepTool(rootCtx, agent.ctx, io));
		// Structural search is its OWN tool rather than a mode of `read`: it answers
		// "where does the syntax match", while `read` answers "what are these lines",
		// and folding one into the other meant a global switch plus parameters that
		// existed only while it was on.
		disposers.push(registerAstGrepTool(rootCtx, agent.ctx, io));
		// The semantic half. omp's rule, and now ours: symbol-aware work goes to a
		// language server whenever one can be had, because it follows shadowing and
		// cross-file usage that a syntax tree cannot.
		disposers.push(registerLspTool(rootCtx, agent.ctx, io));
		// The write half. It finds the places by shape and hands the change to the
		// SAME engine `edit` uses — it owns no file I/O and no anchor logic, so the
		// served-state check, the syntax gate, the diff and the undo entry all
		// apply exactly as they do to a hand-written edit.
		disposers.push(registerAstEditTool(rootCtx, agent.ctx, io, sandbox));
		disposers.push(registerUndoTool(rootCtx, agent.ctx, io, sandbox));
		// #53: the write tool is fully shadowed — it owns the auto-read preview
		// (formerly a post-execute hook) AND the write card's structured rows.
		disposers.push(registerWriteShadow(rootCtx, agent.ctx, io, sandbox));

		// Shadow the preset's built-in tool guidance with the hashline
		// contract. Same section names on the agent's own layer win over the
		// preset's; text and order come from the per-preset resolution.
		// tool:edit is managed by the rebuild path above.
		const sections = await resolveAgentSections(rootCtx, agent);
		for (const section of sections) {
			if (section.name === "tool:edit") continue;
			disposers.push(agent.ctx.systemPrompt.section(section));
		}

		return () => {
			editDispose?.();
			editSectionDispose?.();
			for (const dispose of disposers) dispose();
		};
	});
}

/** Mount the bundle: initialize the store, then install tools per agent. */
export function apply(rootCtx: Context): void {
	// Hashline settings namespace (separator / output_format / context_lines /
	// require_line_content / ast / lsp): registers on the settings service and
	// re-applies the effective config on every commit. The `settings` service is
	// core dsh — every deployment mounts one — so it is declared in `inject`
	// above and cordis guarantees it is STARTED before this apply runs. That is
	// what retired the old retry-and-fallback machinery: there is no race left
	// to retry.
	installHashlineSettings(rootCtx);

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

	const registered = new WeakSet<Agent>();
	rootCtx.on("agent/session-start", ({ agent }) => {
		if (registered.has(agent)) return;
		registered.add(agent);
		try {
			installAgentTools(rootCtx, agent);
		} catch (error) {
			rootCtx.logger.warn(
				`dsh-hashline-edittool: failed to install tools for agent ${agent.id}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	});
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
