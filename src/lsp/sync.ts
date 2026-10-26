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

/** How a deleted document reaches the LSP layer. */
export type DocumentCloseHook = (absolutePath: string) => void;

let closeHook: DocumentCloseHook | undefined;

/** Replace the close hook (tests, or a deployment with its own wiring). */
export function setDocumentClosedHook(next: DocumentCloseHook | undefined): void {
	closeHook = next;
}

/**
 * Tell the language server a file is gone.
 *
 * Same never-throws, never-warms contract as the write sync: only a server
 * that is ALREADY running hears about it, and a misbehaving one cannot turn a
 * successful delete into a failed one.
 *
 * @param absolutePath - the file that was just deleted.
 */
export function notifyDocumentClosed(absolutePath: string): void {
	try {
		if (closeHook !== undefined) {
			closeHook(absolutePath);
			return;
		}
		defaultClose(absolutePath);
	} catch (error) {
		console.error(
			`dsh-hashline-edittool: document close failed for ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/** The default close wiring: use the process-wide manager, if one is installed. */
function defaultClose(absolutePath: string): void {
	const manager = getLspManager();
	if (manager === undefined) return;
	const language = languageForPath(absolutePath);
	if (language === undefined) return;
	if (!manager.readyLanguages.includes(language.id)) return;
	manager.closeDocumentFor(language.id, pathToFileURL(absolutePath).href);
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

/**
 * Tell the language server a file is ABOUT to take this content.
 *
 * The PRE-write sibling of {@linkcode notifyDocumentWritten}: the automatic
 * format path (map #275, G2) formats in memory and writes ONCE, so the
 * server must learn the final content BEFORE the write lands — not from the
 * write notification afterwards. Semantics differ (a format sync is a
 * promise about a write that has not happened yet; the write sync is a
 * report about one that has), so the hook seams stay separate and a test
 * can intercept one without the other.
 *
 * Same never-throws, never-warms contract as the write sync: only a server
 * that is ALREADY running hears about the change, and a misbehaving one
 * cannot break the format pipeline here.
 *
 * @param absolutePath - the file that is about to be written.
 * @param text - the content it will carry (post-format).
 */
export function syncDocumentContent(absolutePath: string, text: string): void {
	try {
		if (preWriteHook !== undefined) {
			preWriteHook(absolutePath, text);
			return;
		}
		defaultSync(absolutePath, text);
	} catch (error) {
		// Same swallow as the write sync: a sync failure must not turn a
		// successful format-and-write into a failed edit.
		console.error(
			`dsh-hashline-edittool: pre-write document sync failed for ${absolutePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

let preWriteHook: DocumentSyncHook | undefined;

/** Replace the PRE-write sync hook (tests, or a deployment with its own wiring). */
export function setPreWriteSyncHook(next: DocumentSyncHook | undefined): void {
	preWriteHook = next;
}
