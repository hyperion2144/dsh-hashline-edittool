/**
 * The suppression LEDGER (#429, ADR-0039) — the stateful half of the
 * regression signal.
 *
 * Per (session key, absolute path) the ledger remembers the identities of the
 * LAST DELIVERED push, so the next write can split its push into NEW
 * diagnostics (report them) and UNCHANGED ones (one summary line). The rules
 * the spec fixes:
 *
 * - **Forget on absence**: an identity the latest push no longer carries is
 *   forgotten — if it comes back later it is new again (story 4: a fixed and
 *   re-introduced problem must resurface).
 * - **Line-number blind**: identities carry no line, so a context edit that
 *   shifts lines does not re-report (story 5).
 * - **Delivery-time bookkeeping**: the ledger is written only when a report
 *   was actually delivered (inline section attached, async injection
 *   accepted) — a delivery that failed never silently swallows diagnostics.
 * - **In-process only**: no persistence; after a restart the first report is
 *   full-volume, which is the honest "state re-trusted" (story 20).
 * - **Bounded**: at most {@link MAX_FILES} buckets, each at most
 *   {@link MAX_PER_FILE} identities, both evicted LRU. An evicted file's next
 *   write re-baselines (its push reports full-volume once) — the honest cost
 *   of the bound (story 19).
 *
 * The ledger answers "was this identity delivered before?" and NOTHING else:
 * the manual `lsp diagnostics` query never touches it (story 9), and an
 * externally-introduced problem is reported like any other new one (story 18)
 * because the ledger only knows what THIS pipeline delivered.
 *
 * @module dsh-hashline-edittool/lsp/diagnostics/ledger
 */
import { diagnosticIdentity, type RawDiagnostic } from "./identity.js";

/** Buckets the ledger keeps at most — the file dimension of the bound. */
export const MAX_FILES = 200;
/** Identities per bucket at most — the identity dimension of the bound. */
export const MAX_PER_FILE = 200;

interface Bucket {
	/** Identity → multiplicity in the last delivered push (insertion order = age). */
	identities: Map<string, number>;
	/** Last touch, for the file-level LRU. */
	touch: number;
}

const buckets = new Map<string, Bucket>();

/** The ledger key for one file in one session. */
export function suppressionBucketKey(sessionKey: string, absolutePath: string): string {
	return `${sessionKey}\u0000${absolutePath}`;
}

/**
 * Split a push against the ledger — a PURE view, no writes.
 *
 * `fresh` is everything the ledger has never delivered for this key; `unchanged`
 * counts (as a multiset) the entries the ledger DID deliver. A caller reports
 * `fresh` and summarizes `unchanged`; neither half ever touches the ledger —
 * bookkeeping happens only at delivery time.
 */
export function partitionPush<T extends RawDiagnostic>(
	key: string,
	diagnostics: readonly T[],
): { fresh: T[]; unchanged: T[] } {
	const seen = buckets.get(key)?.identities;
	const fresh: T[] = [];
	const unchanged: T[] = [];
	// #429 review: the multiset counts are CONSUMED — a copy that decrements on
	// every hit. The identity deliberately carries no line number, so one
	// server CAN emit the identical sentence on several lines; "seen at least
	// once" would swallow the Nth copy forever. Hit N-1 times = unchanged,
	// hit N times (count exhausted) = fresh.
	// A CONSUMABLE copy of the seen counts: each hit decrements, so the Nth
	// identical entry (count exhausted) is fresh, not another unchanged.
	const consumable = new Map<string, number>();
	for (const d of diagnostics) {
		const identity = diagnosticIdentity(d);
		const left = consumable.get(identity) ?? seen?.get(identity) ?? 0;
		if (left > 0) {
			consumable.set(identity, left - 1);
			unchanged.push(d);
		} else {
			fresh.push(d);
		}
	}
	return { fresh, unchanged };
}

/**
 * Delivery-time bookkeeping: the ledger now holds EXACTLY this push's
 * identities (already computed by the caller as `diagnosticIdentity` over
 * every reported entry, repetitions kept — the multiset IS the fact).
 * Identities absent from this call are forgotten — their return later is new
 * again. Evicts past both bounds (file-level LRU by last touch; identity-level
 * by insertion order within the bucket).
 */
export function recordDelivered(key: string, identities: readonly string[]): void {
	// Multiset counts (the repetition itself is a fact); insertion order = age.
	const counts = new Map<string, number>();
	for (const identity of identities) {
		counts.set(identity, (counts.get(identity) ?? 0) + 1);
		// The per-file bound trims the OLDEST-INSERTED identities first.
		if (counts.size > MAX_PER_FILE) {
			const oldest = counts.keys().next().value;
			if (oldest !== undefined) counts.delete(oldest);
		}
	}
	const previous = buckets.get(key);
	if (previous !== undefined) buckets.delete(key);
	buckets.set(key, { identities: counts, touch: Date.now() });
	// The file-level bound trims the LEAST-RECENTLY-TOUCHED buckets first.
	if (buckets.size > MAX_FILES) {
		let oldestKey: string | undefined;
		let oldestTouch = Number.POSITIVE_INFINITY;
		for (const [candidate, bucket] of buckets) {
			if (bucket.touch < oldestTouch) {
				oldestTouch = bucket.touch;
				oldestKey = candidate;
			}
		}
		if (oldestKey !== undefined && oldestKey !== key) buckets.delete(oldestKey);
	}
}

/** Clear one file's bucket — the file was deleted or renamed (story: no stale ledger). */
export function clearSuppression(key: string): void {
	buckets.delete(key);
}

/** Test seam: an empty ledger (no persistence exists to clear). */
export function resetSuppressionLedger(): void {
	buckets.clear();
}
