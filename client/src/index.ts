/**
 * dsh-hashline-edittool-client — host-plane marker plugin.
 *
 * The browser half of this package (lib/client.js) is what renders the
 * hashline-branded read/edit cards; the host half exists only so the dsh
 * Loader mounts the package: dsh's client module system scans Loader entries
 * for `dsh.client` declarations and serves the browser bundle into the web
 * boot graph (`window.__DSH_BOOT__`). Disposing this row (plugin disabled or
 * uninstalled) removes the client bundle from the graph — no web residue.
 * @module dsh-hashline-edittool-client
 */

import type { Context } from "@deepseek-ai/cordis";

/** Cordis plugin name used by loader diagnostics. */
export const name = "dsh-hashline-edittool-client";

/** No services are touched: the host half is a pure mount marker. */
export const inject: string[] = [];

/**
 * Mount the marker plugin. Logs once so deployments can confirm the client
 * half shipped; the actual card registration happens browser-side.
 * @param ctx - host plugin context.
 */
export function apply(ctx: Context): void {
	ctx.logger.info("hashline client ui bundle mounted (web cards for read/edit)");
}
