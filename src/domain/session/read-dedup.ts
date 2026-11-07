/**
 * Read deduplication (#421 ④) — "the content is already in your context".
 *
 * A repeated full-file `read` normally re-emits every line. When the plugin
 * can PROVE the model's context still holds that content, it answers with one
 * line instead: the file is unchanged and the anchors it already holds remain
 * directly editable.
 *
 * The proof is TWO persisted facts about the LAST full-file serve, and
 * neither is sufficient alone:
 *
 * 1. **The file content is byte-identical to what was served**
 *    (`contentChecksum(normalized)` recorded at serve time). This ties the
 *    claim to the actual bytes, and it self-invalidates: any write/edit that
 *    changes even one line changes the checksum, so a later dedup attempt
 *    fails without any explicit invalidation step.
 * 2. **The context replacement generation has not moved since that serve**
 *    (`SessionSurface.contentGeneration`, reached through the runtime-
 *    augmented `Agent.session`). Context compaction rewrites the model-
 *    visible history; if the generation differs, the model's context was
 *    rewritten and the served bytes — however identical the file is NOW —
 *    may no longer BE in it. The read is answered normally.
 *
 * The evidence is captured at serve time (before this read can mint or serve
 * anything), which keeps it unpolluted: a read that first serves new bindings
 * and then "verifies" them would always succeed against itself.
 *
 * Failure direction is asymmetric and deliberately conservative: missing a
 * dedup costs tokens; a WRONG dedup hands the model "unchanged" while its
 * context no longer holds the file. Every unprovable case (no session, no
 * generation signal, partial window, resume, lossy view) answers normally.
 *
 * Both scalars live in the hash-store's `meta` table keyed by session+path —
 * no schema migration.
 *
 * @module dsh-hashline-edittool/domain/session/read-dedup
 */
import type { ToolExecution } from "@deepseek-ai/dsh-tools";
import { loadHashStore } from "./hash-store.js";
import { withWorkspace } from "../../infra/workspace.js";

/** The persisted per-(session,path) serve evidence. */
function evidenceKey(sessionKey: string, path: string): string {
	return `readgen:${sessionKey}:${path}`;
}

/**
 * The harness's context-replacement counter, when the execution can reach it.
 *
 * `Agent` exposes `session` only through the runtime augmentation (the public
 * type is `{ id }`), so this probes structurally instead of importing types
 * the plugin's dependency set does not publish. Anything other than a finite
 * number — a test double, an older harness, a headless caller — answers
 * `undefined`, and every dedup decision downstream answers "no".
 */
export function surfaceGenerationOf(exec: ToolExecution | undefined): number | undefined {
	const generation = (
		exec as
		| {
			agent?: {
				session?: {
					surface?: { contentGeneration?: unknown };
				};
			};
		}
		| undefined
	)?.agent?.session?.surface?.contentGeneration;
	return typeof generation === "number" && Number.isFinite(generation) ? generation : undefined;
}

export interface ServeEvidence {
	/** The context generation (`SessionSurface.contentGeneration`) at serve time. */
	readonly generation: number;
	/** `contentChecksum(normalized)` of the bytes that were served. */
	readonly checksum: string;
}

/**
 * Persist the serve evidence (context generation + file checksum) observed at
 * serve time. Only a FULL-file serve may record — a partial window's evidence
 * cannot vouch for the whole file. A missing generation records nothing (no
 * signal → the dedup gate can never open).
 */
export async function recordServeEvidence(
	sessionKey: string,
	path: string,
	evidence: ServeEvidence | undefined,
	cwd: string,
): Promise<void> {
	if (evidence === undefined) return;
	const store = await loadHashStore();
	await withWorkspace(cwd, async () => {
		store.metaSet(evidenceKey(sessionKey, path), JSON.stringify(evidence));
	});
}

async function readServeEvidence(
	sessionKey: string,
	path: string,
	cwd: string,
): Promise<ServeEvidence | undefined> {
	const store = await loadHashStore();
	let raw: string | undefined;
	await withWorkspace(cwd, async () => {
		raw = store.metaGet(evidenceKey(sessionKey, path));
	});
	if (raw === undefined) return undefined;
	try {
		const parsed = JSON.parse(raw) as { generation?: unknown; checksum?: unknown };
		if (
			typeof parsed.generation === "number" &&
			Number.isFinite(parsed.generation) &&
			typeof parsed.checksum === "string"
		) {
			return { generation: parsed.generation, checksum: parsed.checksum };
		}
		return undefined;
	} catch {
		return undefined;
	}
}

export interface ReadDedupInput {
	readonly sessionKey: string;
	/** The absolute path of the file being read. */
	readonly absolutePath: string;
	readonly cwd: string;
	/** Total lines of the file (the full-file side of the window check). */
	readonly totalLines: number;
	/** The rows the view served — for a full-file read this IS every line. */
	readonly servedRows: ReadonlyArray<{ readonly anchor: string }>;
	/** `contentChecksum(normalized)` of the bytes THIS read sees. */
	readonly currentChecksum: string;
	/** The context generation observed on THIS read's execution. */
	readonly currentGeneration: number | undefined;
}

export type ReadDedupVerdict =
	| { readonly dedup: false }
	| { readonly dedup: true; readonly message: string };

/**
 * Decide whether this read may answer "unchanged". Exported for tests; the
 * read seam calls it after the view is built.
 */
export async function evaluateReadDedup(input: ReadDedupInput): Promise<ReadDedupVerdict> {
	const { sessionKey, absolutePath, cwd, totalLines, servedRows, currentChecksum, currentGeneration } = input;
	// No generation signal (no live session, older harness, test double): the
	// second condition is unprovable, so the dedup never fires.
	if (currentGeneration === undefined) return { dedup: false };
	// The window must BE the file: a partial window's lines do not vouch for
	// the whole file, and an empty window proves nothing.
	if (servedRows.length === 0 || servedRows.length !== totalLines) return { dedup: false };
	const evidence = await readServeEvidence(sessionKey, absolutePath, cwd);
	if (evidence === undefined) return { dedup: false };
	if (evidence.generation !== currentGeneration) return { dedup: false };
	if (evidence.checksum !== currentChecksum) return { dedup: false };
	return {
		dedup: true,
		message: `[Unchanged] ${totalLines} lines — the file and its anchors are exactly as last served. Edit directly with the same anchors; call read again only if your context no longer holds this file.`,
	};
}
