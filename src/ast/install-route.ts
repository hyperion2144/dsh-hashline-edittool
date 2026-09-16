/**
 * The install/uninstall HTTP surface the settings card calls.
 *
 * Grammar *intent* travels through `settingsScope` like every other setting;
 * installing assets is an **action**, not a configuration value, so it goes
 * through a route instead (spec §7.5). Keeping them apart is what lets the
 * settings layer stay a pure value store.
 *
 * Three things this module refuses to assume:
 *
 * 1. **`ctx.webServer` may not exist.** A headless profile has no HTTP
 *    carrier. The route then simply is not registered, and nothing else
 *    changes — declaring `webServer` in `inject` would stop the plugin loading
 *    at all in those profiles.
 * 2. **A request body is untrusted input.** It is size-capped and parsed
 *    defensively, and the language id is checked against the curated catalog
 *    before it reaches anything that touches the filesystem.
 * 3. **Only the configured method is accepted.** A `GET` on an install route
 *    is a caller mistake, and answering it with a side effect would be worse
 *    than a 405.
 *
 * @module dsh-hashline-edittool/ast/install-route
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
	CATALOG,
	installGrammar,
	installedGrammars,
	isInstallable,
	uninstallGrammar,
	type InstallOutcome,
} from "./registry.js";
import { fetchGrammarBytes, type FetchLike } from "./fetch-grammar.js";
import { checkGrammarUpdates } from "./check-updates.js";
import { isAstLanguageEnabled } from "../infra/settings.js";

/** The `ctx.webServer` surface, structurally (the service is optional). */
export interface WebServerLike {
	register(route: {
		readonly kind: "exact" | "prefix";
		readonly path: string;
		readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
	}): () => void;
}

/** The route prefix, owned entirely by this plugin. */
export const ROUTE_BASE = "/api/hashline/grammars";

/** Largest request body accepted, in bytes. */
const MAX_BODY_BYTES = 8 * 1024;

// Exported so the LSP install route reads a body the SAME way. Two readers would
// be two ideas of what "too large" means, and only one of them would be the one
// an attacker found.
export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
		total += buffer.byteLength;
		if (total > MAX_BODY_BYTES) throw new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes.`);
		chunks.push(buffer);
	}
	if (total === 0) return {};
	const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Request body must be a JSON object.");
	}
	return parsed as Record<string, unknown>;
}

/** Write a JSON response. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
	const payload = JSON.stringify(body);
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(payload);
}

/** The catalog as the card shows it, joined with what is installed. */
async function statusPayload(): Promise<unknown> {
	const installed = await installedGrammars();
	return {
		languages: CATALOG.map((entry) => {
			const facts = installed.get(entry.id);
			return {
				id: entry.id,
				displayName: entry.displayName,
				extensions: entry.extensions,
				version: entry.version,
				size: entry.size,
				// The card must be able to tell a packaged language from an added
				// one WITHOUT guessing: it decides whether to offer a Remove button
				// and whether an entry is even installable.
				builtin: entry.builtin,
				installable: isInstallable(entry),
				installed: facts !== undefined,
				installedVersion: facts?.version,
				installedAt: facts?.installedAt,
				enabled: isAstLanguageEnabled(entry.id),
			};
		}),
	};
}

/** Turn an install outcome into a response. */
function outcomeResponse(res: ServerResponse, outcome: InstallOutcome): void {
	if (outcome.ok) {
		sendJson(res, 200, {
			ok: true,
			id: outcome.installed.id,
			version: outcome.installed.version,
			sha256: outcome.installed.sha256,
			bytes: outcome.installed.bytes,
		});
		return;
	}
	// The code travels verbatim: the card shows the refusal reason, and a hash
	// mismatch and an unknown id need different words.
	sendJson(res, 400, { ok: false, code: outcome.code, message: outcome.message });
}

/** How the route reaches the network; injected so tests need no fetch. */
export type RouteDeps = {
	readonly fetchImpl?: FetchLike;
};

/**
 * The handlers, exported so they can be driven directly in tests.
 */
export async function handleStatus(_req: IncomingMessage, res: ServerResponse): Promise<void> {
	sendJson(res, 200, await statusPayload());
}

/**
 * Newer versions of the installed grammars, when the registry answers.
 *
 * Read-only and best-effort. It reaches the network, so it is a SEPARATE route
 * rather than a field on the status payload: the card's main list must render
 * without waiting on a registry, and a slow or unreachable one must not delay
 * it. An empty list is the honest answer for "nothing newer" and for "could not
 * ask" alike, because neither is actionable and the two are not worth
 * distinguishing on screen.
 *
 * @param _req - unused; the question has no parameters.
 * @param res - the response to write.
 */
export async function handleUpdates(_req: IncomingMessage, res: ServerResponse): Promise<void> {
	sendJson(res, 200, { updates: await checkGrammarUpdates() });
}

/** Whether the caller asked for a progress stream. */
function wantsStream(req: IncomingMessage): boolean {
	const accept = req.headers.accept ?? "";
	return accept.includes("application/x-ndjson");
}

/**
 * Install while streaming each stage as a JSON line.
 *
 * One line per event, flushed as it happens. A refusal still arrives as a final
 * `done` line rather than an HTTP status, because by then the response has
 * already begun — and a stream that reports its own failure is more useful to a
 * watcher than a truncated one.
 */
async function streamInstall(res: ServerResponse, id: string, deps: RouteDeps): Promise<void> {
	res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
	const line = (event: unknown): void => {
		res.write(`${JSON.stringify(event)}\n`);
	};
	try {
		const bytes = await fetchGrammarBytes(id, deps.fetchImpl, (progress) => {
			line({ type: "progress", stage: progress.stage, received: progress.received, total: progress.total });
		});
		// The third stage. It comes from here rather than from the download layer
		// because by now the bytes are in hand and only the verify-and-write is
		// left — and omitting it left the stream ending at "verify", which the
		// card would have shown as a download that never finishes installing.
		line({ type: "progress", stage: "install" });
		const outcome = await installGrammar(id, bytes, "catalog");
		if (outcome.ok) {
			line({ type: "done", ok: true, id: outcome.installed.id, version: outcome.installed.version, sha256: outcome.installed.sha256, bytes: outcome.installed.bytes });
		} else {
			line({ type: "done", ok: false, code: outcome.code, message: outcome.message });
		}
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		line({ type: "done", ok: false, code: typeof code === "string" ? code : "E_INTERNAL", message: error instanceof Error ? error.message : String(error) });
	}
	res.end();
}

export async function handleInstall(req: IncomingMessage, res: ServerResponse, deps: RouteDeps = {}): Promise<void> {
	if (req.method !== "POST") {
		sendJson(res, 405, { ok: false, code: "E_METHOD", message: "Use POST to install a grammar." });
		return;
	}
	let id: string;
	try {
		const body = await readJsonBody(req);
		if (typeof body.id !== "string" || body.id.length === 0) {
			sendJson(res, 400, { ok: false, code: "E_BAD_SHAPE", message: 'The body needs a non-empty "id".' });
			return;
		}
		id = body.id;
	} catch (error) {
		sendJson(res, 400, { ok: false, code: "E_BAD_SHAPE", message: error instanceof Error ? error.message : String(error) });
		return;
	}
	// The catalog is the allowlist: an id outside it never reaches the
	// filesystem, and no arbitrary URL is ever fetched.
	if (!CATALOG.some((entry) => entry.id === id)) {
		sendJson(res, 400, {
			ok: false,
			code: "[E_GRAMMAR_UNKNOWN]",
			message: `${id} is not in the curated catalog.`,
		});
		return;
	}
	// A caller that asks for NDJSON gets the download's stages as they happen,
	// which is the only way the card can show 下载中 -> 校验中 -> 安装中 honestly.
	// Everyone else keeps the single-JSON-response contract.
	if (wantsStream(req)) {
		await streamInstall(res, id, deps);
		return;
	}
	try {
		const bytes = await fetchGrammarBytes(id, deps.fetchImpl);
		outcomeResponse(res, await installGrammar(id, bytes, "catalog"));
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		sendJson(res, 502, {
			ok: false,
			code: typeof code === "string" ? code : "E_INTERNAL",
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

export async function handleUninstall(req: IncomingMessage, res: ServerResponse): Promise<void> {
	if (req.method !== "POST") {
		sendJson(res, 405, { ok: false, code: "E_METHOD", message: "Use POST to uninstall a grammar." });
		return;
	}
	let id: string;
	try {
		const body = await readJsonBody(req);
		if (typeof body.id !== "string" || body.id.length === 0) {
			sendJson(res, 400, { ok: false, code: "E_BAD_SHAPE", message: 'The body needs a non-empty "id".' });
			return;
		}
		id = body.id;
	} catch (error) {
		sendJson(res, 400, { ok: false, code: "E_BAD_SHAPE", message: error instanceof Error ? error.message : String(error) });
		return;
	}
	const outcome = await uninstallGrammar(id);
	if (!outcome.ok) {
		// A refused uninstall is the caller's mistake, not a server fault.
		sendJson(res, 400, { ok: false, code: outcome.code, message: outcome.message });
		return;
	}
	sendJson(res, 200, { ok: true, id, removed: outcome.removed });
}

/**
 * Register the routes on `ctx.webServer`, when that service exists.
 *
 * @param webServer - whatever `ctx.get("webServer")` returned.
 * @param deps - injected fetch for tests.
 * @returns the disposers, or an empty array when there is no web server.
 */
export function registerGrammarRoutes(webServer: unknown, deps: RouteDeps = {}): Array<() => void> {
	const service = webServer as WebServerLike | undefined;
	if (service === undefined || typeof service.register !== "function") return [];
	const disposers: Array<() => void> = [];
	// A duplicate (kind, path) throws by contract; registering nothing is the
	// right answer for a collision, because the other owner is already serving
	// the same route.
	const routes: Array<{ path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }> = [
		{ path: ROUTE_BASE, handler: (req, res) => handleStatus(req, res) },
		{ path: `${ROUTE_BASE}/install`, handler: (req, res) => handleInstall(req, res, deps) },
		{ path: `${ROUTE_BASE}/uninstall`, handler: (req, res) => handleUninstall(req, res) },
		{ path: `${ROUTE_BASE}/updates`, handler: (req, res) => handleUpdates(req, res) },
	];
	for (const route of routes) {
		try {
			disposers.push(service.register({ kind: "exact", path: route.path, handler: route.handler }));
		} catch (error) {
			console.error(
				`dsh-hashline-edittool: grammar route ${route.path} was not registered: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return disposers;
}
