/**
 * The session's LIVE working directory — the one directory a tool call
 * resolves its paths against.
 *
 * #394: the session HEADER's cwd is a creation-time snapshot, and by design it
 * never moves — the host keeps it so a resumed session can find its project
 * again. But a session's WORKING DIRECTORY moves: DSH's `create_worktree` and
 * `working_directory` tools commit a `working-directory/change` event and the
 * live directory follows it. The host's own fs tools ask the host's
 * `workingDirectory` service for that live directory on every call; this
 * plugin used the header instead, so after a worktree switch every relative
 * path still resolved into the ORIGINAL checkout — and every write landed
 * there, while the model believed it was working in the worktree.
 *
 * This seam is the plugin's ONE answer to "where is this session working?":
 * it asks the host, per call, and falls back to the header only on a host
 * that has no such service (an older harness — which cannot move a session's
 * directory either, so it has nothing to follow). It never probes the disk for
 * worktree directories: several checkouts can exist at once, and only the host
 * knows which one this session is in.
 *
 * @module dsh-hashline-edittool/live-cwd
 */

import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { withWorkspace } from "../../infra/workspace.js";

/**
 * The `workingDirectory` service shape this seam speaks.
 *
 * dsh ≥ 0.2 ships it as `@deepseek-ai/dsh-working-directory`. The plugin does
 * NOT depend on that package: the service is optional (a host without it keeps
 * the header behaviour), so the shape is declared here and read through
 * `ctx.get` — the same way the sandbox policy is read.
 */
export interface WorkingDirectoryLike {
	/**
	 * The session's committed directory, validated against the filesystem; a
	 * directory that vanished is restored to the session's original project.
	 */
	ensure(agent: Agent, signal?: AbortSignal): Promise<string>;
}

/** The context shape the service is read through. */
interface ServiceReader {
	get(name: string): unknown;
}

/**
 * The host's working-directory service, or `undefined` when this host has
 * none (an older harness, or a test double).
 *
 * It is read from the CALLING AGENT's scope, because that is where the plugin
 * registers its tools: `ctx.get` reads the host's service store — the same
 * store the app-level service is provided into — without the plugin having to
 * declare the service as a dependency (a host without it must still load the
 * plugin).
 */
function workingDirectoryOf(agent: Agent): WorkingDirectoryLike | undefined {
	const reader = agent.ctx as unknown as Partial<ServiceReader> | undefined;
	if (reader === undefined || typeof reader.get !== "function") return undefined;
	const service = reader.get("workingDirectory") as WorkingDirectoryLike | undefined;
	if (service === undefined || typeof service.ensure !== "function") return undefined;
	return service;
}

/**
 * The session's live working directory.
 *
 * The host's answer is AUTHORITATIVE: it validates the directory (and restores
 * the original project when it vanished), exactly as the host's own fs tools
 * ask for it. Its failure PROPAGATES — the built-in fs tools treat it the same
 * way, and resolving against a stale header is the very bug this seam exists
 * to remove.
 *
 * @param exec - the tool execution; its agent owns the session.
 * @returns the session's live working directory, or the header's cwd on a host
 *   that has no working-directory service.
 */
export async function liveCwd(exec: ToolExecution): Promise<string> {
	const agent = exec.agent;
	if (agent === undefined) return process.cwd();
	const service = workingDirectoryOf(agent);
	if (service === undefined) return agent.session.header.cwd ?? process.cwd();
	return service.ensure(agent, exec.signal);
}

/**
 * Run `fn` inside the workspace scope of the session's LIVE working directory.
 *
 * The scope and the resolved directory are ONE thing: the body is handed the
 * same value the scope carries, so the ambient workspace, the store it opens
 * and the path the body resolves can never disagree about where the session is
 * working.
 *
 * @param exec - the tool execution; its agent owns the session.
 * @param fn - the body, handed the session's live working directory.
 * @returns whatever `fn` resolves to.
 */
export async function withLiveWorkspace<T>(
	exec: ToolExecution,
	fn: (cwd: string) => Promise<T>,
): Promise<T> {
	const cwd = await liveCwd(exec);
	return withWorkspace(cwd, () => fn(cwd));
}
