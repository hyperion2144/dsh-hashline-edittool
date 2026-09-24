/**
 * Hashline barrel — thin re-export via deep seams.
 * Deep seams: hash-assign (allocation), anchor-pipeline (ordering), hash (persistence).
 * @module dsh-hashline-edittool/hashline
 */
export {
	 HASH_SEP,
	 HASH_LEN,
	 HASH_CLASS,
	 ALPH_RE,
	 LINE_HASH_SEP,
	 LINE_HASH_RE,
	 hashSep,
	 contextLinesCfg,
	 hashClassSource,
	 hashRe,
	 lineAnchorRe,
	 hlRowAnchorRe,
	 hashlineHeader,
	 applyHashlineShape,
	 getHashlineShape,
	 type HashlineShape,
	 STALE_CONTEXT_LINES,
	 CANON_VERSION,
	 canon,
	 lineHashesPure,
	 hashOf,
	 contentChecksum,
} from "./hash-assign.js";

export { assignAnchors, allocateAnchor, probeStep, MIN_ANCHOR_DEPTH, PROBE_LIMIT } from "./alloc.js";
export { anchorsFor, anchorsPure, allocateForLines, updateAnchorsAfterEdit } from "./session-anchors.js";

export { lineHashes } from "./hash.js";

export { parseHashRef, parseText } from "./anchor-pipeline.js";
export type { Anchor } from "./anchor-pipeline.js";

export { resEdit } from "./anchor-pipeline.js";
export type { HEdit, HTEdit, NEdit, BDup, AutoFix } from "./anchor-pipeline.js";

export {
 applyEdit,
 fmtRegion,
 changedRange,
 buildIdx,
 ServedRejectionError,
 AnchorMismatchError,
 isServedRejection,
 isAnchorMismatch,
 verifyServedRange,
 buildRangeEcho,
 fmtServedRows,
} from "./anchor-pipeline.js";
export type {
 ServedRow,
 ResolvedRange,
 ServedCode,
} from "./anchor-pipeline.js";

//
// NOTHING above this line may leave the hashline layer.
//
// This barrel used to re-export `grepFileContent` (and three grep types) from
// `../tool-grep.js`, so that ONE line made every hashline consumer — including
// `edit-diff`, a pure diff renderer — instantiate the whole tool layer. The
// grep tool imports this barrel back, so the re-export was also half of a
// 14-module import cycle: `edit-diff → hashline/index → tool-grep →
// presentation-helpers → edit-diff`.
//
// `grepFileContent` was a tool-layer implementation detail wearing a hashline
// address: its only production caller is `tool-grep` itself. It is exported
// from there, and the one test that reached it through this barrel imports it
// from its own module now.
