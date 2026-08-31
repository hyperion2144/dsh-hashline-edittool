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
export { anchorsFor, anchorsPure, updateAnchorsAfterEdit } from "./session-anchors.js";

export { lineHashes } from "./hash.js";

export { parseHashRef, parseText } from "./parse.js";
export type { Anchor } from "./parse.js";

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

export { grepFileContent } from "../tool-grep.js";
export type { GrepFileSection, GrepToolOptions, GrepSectionRow } from "../tool-grep.js";
