/**
 * Undo persistence for the hashline tools: before an edit is applied, the
 * pre-edit state (content, BOM, original line ending, hash anchors, and the
 * result content that the undo must verify against) is written to the hash
 * store. `undo_last_edit` reverts only when the file still matches the stored
 * result — a later external write clears the history instead of being
 * overwritten. Undo survives restarts (the store is on disk).
 * @module dsh-hashline-edittool/undo-edit
 */

import { restoreEndings, type LineEnding } from '../../render/edit-diff.js'
import { contentChecksum } from '../../hashline/hash-assign.js'
import { loadHashStore, type UndoRecord } from '../session/hash-store.js'

export interface UndoEntry {
	content: string
	bom: string
	originalEnding: LineEnding
	hashes: string[]
	resultContent: string
	/**
	 * Checksum of `bom + restoreEndings(resultContent, originalEnding)` (#176).
	 * Present on rows an older build did not write; undefined means "verify by
	 * text", which is how legacy entries keep working.
	 */
	resultChecksum?: string
}

/**
 * Persist an undo entry for one path before mutating it.
 * @param path - canonical absolute path.
 * @param entry - the pre-edit state plus the result content the undo will verify.
 * @returns whether persistence succeeded, plus a restore that puts the previous
 *   undo entry back (used when the mutation itself fails).
 */
export async function saveUndo(
	path: string,
	entry: UndoEntry,
): Promise<{ persisted: boolean; restore: () => Promise<void> }> {
	try {
		const store = await loadHashStore()
		store.pushUndo(path, {
			content: entry.content,
			bom: entry.bom,
			ending: entry.originalEnding,
			hashes: entry.hashes,
			// The undo stale check compares the CURRENT file against what this edit
			// produced. Keeping that second body in full was the largest text payload
			// in the store (#176), so store its checksum instead — taken over the
			// exact raw form the comparison builds (`bom + restoreEndings(result,
			// ending)`), and leave `resultContent` empty. The column stays for rows an
			// older build wrote, which the compare still handles by text.
			resultContent: '',
			resultChecksum: contentChecksum(entry.bom + restoreEndings(entry.resultContent, entry.originalEnding)),
		})
	} catch (error) {
		console.error('Failed to persist undo entry:', error)
		return { persisted: false, restore: async () => undefined }
	}
	return {
		persisted: true,
		// Cancelling the push pops it: whatever was newest before is newest again,
		// because the write this entry belonged to never happened.
		restore: async () => {
			try {
				const store = await loadHashStore()
				store.popUndo(path)
			} catch (error) {
				console.error('Failed to restore previous undo entry:', error)
			}
		},
	}
}

/**
 * Consume the newest entry — call this AFTER a successful revert. The entry
 * below it becomes the next undo, which is what makes the history a stack
 * rather than a single slot (#151/P5).
 */
export async function popUndo(path: string): Promise<void> {
	try {
		const store = await loadHashStore()
		store.popUndo(path)
	} catch (error) {
		console.error('Failed to consume undo entry:', error)
	}
}

/** How many successive edits on this path can still be undone. */
export async function undoDepth(path: string): Promise<number> {
	try {
		const store = await loadHashStore()
		return store.undoDepth(path)
	} catch (error) {
		console.error('Failed to read undo depth:', error)
		return 0
	}
}

/** Load the last undo entry for a path, if any. */
export async function getUndo(path: string): Promise<UndoEntry | undefined> {
	try {
		const store = await loadHashStore()
		const record = store.getUndo(path)
		if (!record) return undefined
		const originalEnding = record.ending
		if (
			originalEnding !== '\r\n' &&
			originalEnding !== '\n' &&
			originalEnding !== '\r'
		) {
			store.deleteUndo(path)
			return undefined
		}
		return {
			content: record.content,
			bom: record.bom,
			originalEnding,
			hashes: record.hashes,
			resultContent: record.resultContent,
			resultChecksum: record.resultChecksum,
		}
	} catch (error) {
		console.error('Failed to load undo entry:', error)
		return undefined
	}
}

/** Drop the whole undo history for a path (an external write clears the chain). */
export async function clearUndo(path: string): Promise<void> {
	try {
		const store = await loadHashStore()
		store.deleteUndo(path)
	} catch (error) {
		console.error('Failed to clear undo entry:', error)
	}
}
