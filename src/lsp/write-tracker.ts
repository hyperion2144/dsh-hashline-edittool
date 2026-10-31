/**
 * The newest write per document — the "which version is current" ledger the
 * diagnostics delivery never had.
 *
 * #388: a late diagnostic must never describe a file version the model has
 * already moved past. The delivery knows the text of the write it serves, but
 * nothing told it that a LATER write to the same file had landed meanwhile —
 * so the background wait kept verifying its own (now old) snapshot and handed
 * the model a report for content that is no longer on disk, with anchors that
 * no longer exist in the file.
 *
 * This module is the one place that answers "what is the current content of
 * this document?" for the LSP layer. It is FED by the write path
 * (`notifyDocumentWritten`, the single funnel every write tool goes through)
 * and READ by the delivery (`src/lsp/auto-diag.ts`).
 *
 * The ledger is deliberately small: one entry per document, holding the
 * content and a generation counter. It is a freshness record, not a store —
 * the content itself lives on disk, and the plugin reads the file when it
 * needs the bytes. It is bounded in BOTH documents and bytes, because the
 * content it holds is whole files.
 *
 * @module dsh-hashline-edittool/lsp/write-tracker
 */

/** One write to one document: its content and the generation it created. */
export interface TrackedWrite {
	/**
	 * A counter that never repeats across the plugin's lifetime. Every write
	 * takes the next number, so "is my write still the newest?" is a single
	 * comparison and can never be fooled by a recycled number.
	 */
	readonly generation: number;
	/**
	 * Which write to THIS document it is (1 = the first write the plugin saw).
	 * The generation is the guard's identity; this is the number a reader can
	 * read out loud — "this report describes write #2 of a.ts".
	 */
	readonly writeNumber: number;
	/** The content the write landed. */
	readonly text: string;
	/**
	 * An async injection for this document happened, and no later inline report
	 * has told the model about it yet.
	 *
	 * #388: `agent.inject` queues without waking, so a report enqueued for an
	 * earlier write can still be delivered after a newer one — and the plugin
	 * cannot withdraw it. The next inline report says which of the two wins.
	 */
	hadAsyncInjection: boolean;
}

/**
 * How many documents the ledger remembers. A long session can touch many
 * files; the ledger only needs the recent ones — a delivery that outlives its
 * document's entry finds "no newer write" and stops, which is the safe side.
 */
const MAX_TRACKED = 256;

/**
 * How much file content the ledger may hold at once. The ledger stores whole
 * files, so the document cap alone could hold a gigabyte of big files; the
 * byte cap is what keeps it a ledger.
 */
const MAX_BYTES = 16 * 1024 * 1024;

/** The generation the next write takes. Global, so numbers never repeat. */
let nextGeneration = 0;

/** The newest write per document, in write order (oldest first). */
const writes = new Map<string, TrackedWrite>();

/** How many bytes of content the ledger holds right now. */
let heldBytes = 0;

/**
 * Record a write to `uri` and return the write it created.
 *
 * @param uri - the document's URI, as the LSP layer spells it.
 * @param text - the content the write landed.
 */
export function noteDocumentWrite(uri: string, text: string): TrackedWrite {
	nextGeneration += 1;
	const previous = writes.get(uri);
	const write: TrackedWrite = {
		generation: nextGeneration,
		writeNumber: (previous?.writeNumber ?? 0) + 1,
		text,
		// The warning travels with the document: a new write inherits it, and
		// the inline report that carries it clears it again.
		hadAsyncInjection: previous?.hadAsyncInjection === true,
	};
	// Re-insert so the map keeps write order: the oldest entry is the first.
	if (previous !== undefined) heldBytes -= previous.text.length;
	writes.delete(uri);
	writes.set(uri, write);
	heldBytes += text.length;
	// Oldest first: the ledger keeps the documents the session is working on.
	while (writes.size > MAX_TRACKED || heldBytes > MAX_BYTES) {
		const oldest = writes.keys().next();
		if (oldest.done === true) break;
		const dropped = writes.get(oldest.value);
		if (dropped !== undefined) heldBytes -= dropped.text.length;
		writes.delete(oldest.value);
	}
	return write;
}

/** The newest write the plugin saw for `uri`, if it saw one. */
export function latestWriteFor(uri: string): TrackedWrite | undefined {
	return writes.get(uri);
}

/**
 * Record that an async delivery enqueued a report for `uri`.
 *
 * #388: the platform's `agent.inject` queues without waking the model, so a
 * report enqueued for one write can be delivered after a LATER write. The
 * plugin cannot withdraw it; the next inline report says which one wins
 * instead, and the enqueued report carries its own generation stamp.
 *
 * @param uri - the document's URI.
 * @param generation - the generation of the write the report describes. A
 * mismatch means a newer write already owns the document, so nothing is
 * marked.
 */
export function markAsyncInjection(uri: string, generation: number): void {
	const current = writes.get(uri);
	if (current === undefined || current.generation !== generation) return;
	current.hadAsyncInjection = true;
}

/**
 * Forget the document — it is gone, so no write owns it and a late delivery
 * for it has nothing to say.
 */
export function forgetDocumentWrite(uri: string): void {
	const dropped = writes.get(uri);
	if (dropped !== undefined) heldBytes -= dropped.text.length;
	writes.delete(uri);
}
