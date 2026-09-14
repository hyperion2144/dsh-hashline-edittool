/**
 * The language-server status surface the settings card reads.
 *
 * The attribution for "why did references fall back to the heuristic scan?"
 * already existed in `LspManager.unavailability`; nothing consumed it, so the
 * answer was unreachable from the screen. This exposes it.
 *
 * Two things this deliberately does NOT do:
 *
 * 1. **It never starts anything.** Reporting status must not warm a server,
 *    because the cost of a language server is a process per language and a
 *    settings card being opened is not a request for one.
 * 2. **It never fails.** An absent manager is a state to report, not an error —
 *    a deployment can run without the LSP packages installed at all, which is
 *    the default.
 *
 * @module dsh-hashline-edittool/lsp/status-route
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { LANGUAGES } from "../ast/language.js";
import { getLspManager, type LspLanguageStatus } from "./manager.js";
import { canInstallServer, installLspServer, serverEntryFor, type SpawnLike } from "./install-server.js";
import { readJsonBody } from "../ast/install-route.js";

/** The `ctx.webServer` surface, structurally (the service is optional). */
interface WebServerLike {
	register(route: {
		readonly kind: "exact" | "prefix";
		readonly path: string;
		readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
	}): () => void;
}

/** The route path, under the same plugin-owned prefix as the grammar routes. */
export const LSP_STATUS_ROUTE = "/api/hashline/lsp";

/** Write a JSON response. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}

/**
 * Install the language server for one language, when npm can provide it.
 *
 * The body is `{ languageId }`. A refusal is a 200 with `ok: false` rather than an
 * HTTP error, for the same reason the status route never fails: "this server comes
 * from `go install`" is an ANSWER, and dressing it as a transport failure would
 * make the card render a fact as a crash.
 *
 * @param req - the POST whose body names the language.
 * @param res - the response to write.
 * @param spawn - the subprocess seam, absent in a deployment without one.
 */
export async function handleLspInstall(
	req: IncomingMessage,
	res: ServerResponse,
	spawn: SpawnLike | undefined,
): Promise<void> {
	if (spawn === undefined) {
		sendJson(res, 200, { ok: false, message: "这个部署没有 subprocess seam，所以无法运行 npm。" });
		return;
	}
	let body: Record<string, unknown>;
	try {
		body = await readJsonBody(req);
	} catch (error) {
		sendJson(res, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
		return;
	}
	const languageId = typeof body.languageId === "string" ? body.languageId : undefined;
	if (languageId === undefined) {
		sendJson(res, 400, { ok: false, message: "languageId is required." });
		return;
	}
	try {
		const outcome = await installLspServer(languageId, spawn);
		if (outcome.ok) {
			// THE HALF THAT MADE THE FIRST VERSION LOOK BROKEN.
			//
			// `installLspServer` succeeds and the card re-reads this route — but the
			// manager had memoised discovery for its own lifetime, so it answered from
			// a search taken before the install existed and the row still said 未找到.
			// The install was real; nothing could see it.
			//
			// The failed slots go with it, because `warm` refuses a language that
			// already has one — re-discovering alone would find the new server and
			// still never start it.
			getLspManager()?.rescan();
		}
		sendJson(res, 200, outcome);
	} catch (error) {
		// A throw here is OUR bug, not the user's: `installLspServer` reports every
		// expected failure as an outcome. Surfacing it as a 500 keeps that
		// distinction visible instead of disguising it as a failed install.
		sendJson(res, 500, { ok: false, message: error instanceof Error ? error.message : String(error) });
	}
}

/**
 * Report every language's server state.
 *
 * @param _req - unused; the report has no parameters.
 * @param res - the response to write.
 */
export async function handleLspStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
	const manager = getLspManager();
	if (manager === undefined) {
		// Not an error: with no manager there is no client, which is a state the
		// card should be able to state plainly rather than render as a failure.
		sendJson(res, 200, {
			available: false,
			message: "语言服务器客户端未启用，所以 `symbols` / `code_actions` / `diagnostics` 没有可用的服务器。已装的服务器仍然会被探测到。",
			languages: [] satisfies readonly LspLanguageStatus[],
		});
		return;
	}
	// Every language we have a descriptor for, in registry order, so the card's
	// list and the language manager's list are the same list.
	const languages = await manager.status(LANGUAGES.map((language) => language.id));
	sendJson(res, 200, { available: true, languages });
}

/**
 * Register the LSP routes on `ctx.webServer`, when that service exists.
 *
 * TWO routes: the status READ, and the install ACTION. They are separate in the
 * same way the grammar routes are — a read has no side effects and must never be
 * able to start one, so anything that changes the machine is its own path.
 *
 * Each registers independently: a collision on one must not take the other down
 * with it, because reporting status is what a user opens the card FOR.
 *
 * @param webServer - whatever `ctx.get("webServer")` returned.
 * @param spawn - the subprocess seam; without it the install route declines.
 * @returns the disposers, or an empty array when there is no web server.
 */
export function registerLspRoutes(webServer: unknown, spawn?: SpawnLike): Array<() => void> {
	const service = webServer as WebServerLike | undefined;
	if (service === undefined || typeof service.register !== "function") return [];
	const routes: Array<{ path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> }> = [
		{ path: LSP_STATUS_ROUTE, handler: (req, res) => handleLspStatus(req, res) },
		{ path: `${LSP_STATUS_ROUTE}/install`, handler: (req, res) => handleLspInstall(req, res, spawn) },
	];
	const disposers: Array<() => void> = [];
	for (const route of routes) {
		try {
			disposers.push(service.register({ kind: "exact", path: route.path, handler: route.handler }));
		} catch (error) {
			console.error(
				`dsh-hashline-edittool: LSP route ${route.path} was not registered: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return disposers;
}
