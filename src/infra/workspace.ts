/**
 * The ambient workspace, and nothing else.
 *
 * `withWorkspace` / `workspaceCwd` used to live beside the served state in
 * `session-view`, which made them unreachable from any module BELOW that seam:
 * `hash-store` needed the cwd to choose which database to open, and the only
 * way to ask was through `workspace.ts`, a 5-line `export *` shim. That is the
 * edge that made `hash-store → workspace → session-view → hash-store` a cycle
 * the source could not show.
 *
 * The value is one `AsyncLocalStorage` and two accessors, so it belongs at the
 * bottom of the tree where every layer may read it and none may change its
 * meaning. `session-view` re-exports both for its own callers.
 *
 * @module dsh-hashline-edittool/infra/workspace
 */
import { AsyncLocalStorage } from "node:async_hooks";

const current = new AsyncLocalStorage<string>();

/**
 * Run `fn` with `cwd` as the active workspace for this async execution.
 *
 * Every entry point that touches per-workspace state must cross this seam, so
 * that `workspaceCwd()` cannot answer with a stale or absent cwd partway
 * through a call.
 *
 * @param cwd - the workspace root for this execution.
 * @param fn - the body to run inside the scope.
 * @returns whatever `fn` resolves to.
 */
export function withWorkspace<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
	return current.run(cwd, fn);
}

/** The active workspace root, or `undefined` outside every `withWorkspace` scope. */
export function workspaceCwd(): string | undefined {
	return current.getStore();
}
