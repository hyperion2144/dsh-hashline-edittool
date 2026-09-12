/**
 * Keeping a language server's view of a file in step with ours after an edit.
 *
 * This is small and easy to overlook, but it is the link everything downstream
 * needs: a server that was never told about a write keeps answering from the
 * old text, and the answers get *worse* the more the file is edited. Ticket
 * #104's diagnostics attach to exactly this call.
 *
 * Two decisions worth stating:
 *
 * 1. **A write only notifies a server that is ALREADY running.** An edit must
 *    not spawn a language server: most edits happen in sessions that never ask
 *    a semantic question, and a TypeScript server indexing a large repository
 *    can cost gigabytes. If nothing is running, there is nothing to keep in
 *    step — and the next semantic call will `didOpen` the current text anyway.
 * 2. **Open-or-change, not change-only.** A document the server has never seen
 *    must be opened before it can be changed; sending a change for an unknown
 *    URI is a protocol error some servers ignore and others reject, and both
 *    lose the edit.
 *
 * @module dsh-hashline-edittool/lsp/sync
 */
import { pathToFileURL } from "node:url";
import { languageForPath } from "../ast/language.js";
import { getLspManager } from "./manager.js";

/** How a written document reaches the LSP layer. */
export type DocumentSyncHook = (absolutePath: string, text: string) => void;

let hook: DocumentSyncHook | undefined;

/** Replace the sync hook (tests, or a deployment with its own wiring). */
export function setDocumentSyncHook(next: DocumentSyncHook | undefined): void {
	hook = next;
}

/**
 * Tell the language server that a file's content changed.
 *
 * Never throws and never blocks: a write has already succeeded, and a sync
 * failure must not turn a good edit into a failed one.
 *
 * @param absolutePath - the file that was just written.
 * @param text - its new content.
 */
export function notifyDocumentWritten(absolutePath: string, text: string): void {
	try {
		if (hook !== undefined) {
			hook(absolutePath, text);
			return;
		}
		defaultSync(absolutePath, text);
	} catch (error) {
		// A sync failure is not an edit failure. Logged rather than raised so a
		// misbehaving server cannot break the write path.
		console.error(
			`dsh-hashline-edittool: document sync failed for ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** The default wiring: use the process-wide manager, if one is installed. */
function defaultSync(absolutePath: string, text: string): void {
	const manager = getLspManager();
	if (manager === undefined) return;
	const language = languageForPath(absolutePath);
	if (language === undefined) return;
	// `readyLanguages` is checked first so a write never triggers a warm: the
	// manager's `decide` would start a server, which is exactly what an edit
	// must not do.
	if (!manager.readyLanguages.includes(language.id)) return;
	const uri = pathToFileURL(absolutePath).href;
	const open = manager.openDocumentFor(language.id, uri);
	if (open === undefined) return;
	open(text);
}
