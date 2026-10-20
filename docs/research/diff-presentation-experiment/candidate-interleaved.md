# 模型可见 diff —— 候选新格式（arm: new）

> 由 `docs/research/diff-presentation-experiment/render.mjs` 渲染，用的是仓库自己的 `genDiff`。

> 同一份素材的另一臂（新格式）渲染出来后再比。**这份文件里没有答案**——答案在 `fixtures.mjs`。


## F1-myers-tiebreak — myersRange：回溯时相等元素的取舍从「严格小于」改成「小于等于」

文件：`src/render/line-diff.ts`（改动前 464 行 → 改动后 464 行）

### 候选新形态（行业惯例 unified diff + 干净主体 + 删除行单列）

```text
Diff rows: <+|-><anchor>:<content> — the body is the new code (unchanged lines keep their anchor, `+` lines are new); the removed lines are listed under each hunk, and `~` marks their stale pre-edit anchor.
--- src/render/line-diff.ts
+++ src/render/line-diff.ts
@@ -157,81 +157,81 @@ myersRange()
 WJ:
 cd:/**
 FO: * Myers' greedy search over one range, with a bounded trace.
 PF: *
 FF: * The trace is one `V` snapshot per distance round, which is what makes the
 Ec: * script recoverable without the O(D²) "save every k on every round" table the
 5g: * textbook formulation uses.
 8O: *
 1h: * @param a - old-side hashes.
 cL: * @param b - new-side hashes.
 uY: * @param aLo - inclusive old-side start.
 ry: * @param aHi - exclusive old-side end.
 kG: * @param bLo - inclusive new-side start.
 6P: * @param bHi - exclusive new-side end.
 Ds: * @param maxD - distance cap.
 yk: * @returns the runs in forward order, or undefined when the cap was exceeded.
 3j: */
 4w:function myersRange(
 R2:	a: Int32Array,
 sN:	b: Int32Array,
 Un:	aLo: number,
 ex:	aHi: number,
 C5:	bLo: number,
 Dp:	bHi: number,
 4t:	maxD: number,
 VB:): Run[] | undefined {
 kd:	const n = aHi - aLo;
 Zv:	const m = bHi - bLo;
 uC:	// The trace is `O(maxD²)` and this is its only allocation site, so the clamp
 ll:	// is applied here rather than trusting the caller to have used `effectiveMaxD`
 pR:	// (#230).
 VV:	const cap = effectiveMaxD(maxD);
 Qz:	const mid = cap;
 lX:	const v = new Int32Array(2 * cap + 1);
 CB:	const trace: Int32Array[] = [];
 Za:	let reachedAt = -1;
 MQ:	for (let d = 0; d <= cap && reachedAt < 0; d++) {
 B1:		trace.push(v.slice());
 Yc:		for (let k = -d; k <= d; k += 2) {
 jt:			let x: number;
-~Tl:			if (k === -d || (k !== d && v[mid + k - 1]! < v[mid + k + 1]!)) x = v[mid + k + 1]!;
+bj:			if (k === -d || (k !== d && v[mid + k - 1]! <= v[mid + k + 1]!)) x = v[mid + k + 1]!;
 5X:			else x = v[mid + k - 1]! + 1;
 Tg:			let y = x - k;
 nm:			while (x < n && y < m && a[aLo + x] === b[bLo + y]) {
 hr:				x += 1;
 bp:				y += 1;
 Ng:			}
 7L:			v[mid + k] = x;
 EU:			if (x >= n && y >= m) {
 9Q:				reachedAt = d;
 sV:				break;
 d9:			}
 D2:		}
 2V:	}
 pK:	if (reachedAt < 0) return undefined;
 1d:	return backtrack(aLo, bLo, n, m, reachedAt, trace, mid);
 sO:}
 eE:
 mO:/**
 g1: * Reconstruct the script by walking backwards from (n, m).
 rX: *
 sZ: * At each round the step onto the current diagonal is taken first, then the
 t0: * snake of equal lines back to where that diagonal's path came from — which is
 cu: * the forward order reversed, so the runs are flipped at the end.
 L6: *
 OH: * @param aLo - old-side range start.
 8S: * @param bLo - new-side range start.
 Vn: * @param n - old-side length.
 ot: * @param m - new-side length.
 V9: * @param dEnd - the distance the search completed at.
 zV: * @param trace - `V` snapshots, one per round (index `d` is the state BEFORE round `d`).
 2b: * @param mid - the k offset those vectors use.
 HB: * @returns the runs, forward order, absolute indices.
 jk: */
 wz:
 xp:/**
 ua: * The distance a search may actually explore: floored at 0 and clamped to
 h1: * {@link DIFF_HARD_MAX_D}, so no caller can inflate the trace past the ceiling.
 4f: *
 L2: * @param maxD - the requested distance cap.
 ke: * @returns the cap this module will honour.
```


## F2-salvage-branch-merge — salvageAnchorRef：把「+」与「-」两个警告分支合并成一个

文件：`src/hashline/anchor-pipeline.ts`（改动前 1918 行 → 改动后 1917 行）

### 候选新形态（行业惯例 unified diff + 干净主体 + 删除行单列）

```text
Diff rows: <+|-><anchor>:<content> — the body is the new code (unchanged lines keep their anchor, `+` lines are new); the removed lines are listed under each hunk, and `~` marks their stale pre-edit anchor.
--- src/hashline/anchor-pipeline.ts
+++ src/hashline/anchor-pipeline.ts
@@ -513,84 +513,83 @@ salvageAnchorRef()
 8L: * pass through verbatim — the row regex would greedily eat `4:lA` as anchor
 cz: * "4" plus separator, so the fast path must run first.
 8O: *
 ed: * Shared by `buildPreparedItem` (tool layer — #261 normalize-once: the ins
 kw: * expansion must see the same salvaged ref the pipeline would forgive, or
 DC: * `resolveIns`'s strict parse early-returns and the anchor line is replaced
 hm: * instead of kept) and by `resEdit` (engine bounds — the last-line defense
 3R: * for callers that bypass the tool layer).
 Zq: * `fieldLabel` names the anchor field in warnings, so a pasted row is
 XC: * attributed to the field the caller actually handed over (`anchor_after`
 iK: * from the tool layer, `remove_from`/`remove_to` from `resEdit` bounds).
 jk: */
 iT:export function salvageAnchorRef(
 Zr:	ref: string,
 q7:	warnings: string[] | undefined,
 Za:	fieldLabel: string,
 Yk:): string {
 HX:	const trimmed = ref.trim();
 k3:	// Already a valid reference form (bare anchor or `<line>:<anchor>` hint) —
 Kz:	// keep it verbatim so the line hint survives to parseHashRef. The row
 Vh:	// regex below would greedily eat `4:lA` as anchor "4" + separator ":".
 zi:	if (hashRe().test(trimmed) || lineAnchorRe().test(trimmed)) return trimmed;
 kg:	const match = trimmed.match(hlRowAnchorRe());
 7v:	if (!match) return ref;
 HZ:	// The row regex accepts either marker order; re-emit in the CURRENT one so
 vj:	// the line hint survives to parseHashRef whatever the row used.
 L1:	const parts = rowMarkerParts(match);
 q4:	const anchor =
 yY:		parts.line === undefined ? parts.anchor : `${parts.anchor}:${parts.line}`;
 uo:	const rest = trimmed.slice(match[0].length);
 YS:	if (rest) {
 cu:		// issue #66/B2: any pasted row prefix (diff marker / line hint / anchor
 do:		// + separator + content) is stripped UNCONDITIONALLY, with a warning.
 9f:		// The v2.0-era isRealMarker check (line number in range AND that
 gA:		// line's current anchor equals the prefix anchor) almost never held
 VG:		// for rows pasted from a post-edit diff (fresh anchors) — such rows
 ST:		// landed verbatim in the file, polluting it with anchor junk.
 h4:		let message: string;
 MJ:		if (/\r\n?|\n/.test(rest)) {
 1X:			message = `[E_BAD_REF] ${fieldLabel} got a multi-line block; only the first row's anchor "${anchor}" was used, the rest was ignored.`;
-~ku:		} else if (match[1] === "+") {
-~OK:			message = `[E_BAD_REF] stripped diff-preview "+" marker and trailing content — using "${anchor}" (from "${clipLine(trimmed, 60)}").`;
-~pu:		} else if (match[1] === "-") {
-~Nx:			message = `[E_BAD_REF] stripped leading "-" marker and trailing content — using "${anchor}" (from "${clipLine(trimmed, 60)}").`;
+8M:		} else if (match[1] === "+" || match[1] === "-") {
+hr:			const which = match[1] === "+" ? `diff-preview "+"` : `leading "-"`;
+lm:			message = `[E_BAD_REF] stripped ${which} marker and trailing content — using "${anchor}" (from "${clipLine(trimmed, 60)}").`;
 Ne:		} else {
 8s:			message = `[E_BAD_REF] stripped trailing content — using "${anchor}" (from "${clipLine(trimmed, 60)}").`;
 zx:		}
 NA:		warnings?.push(message);
 pj:	}
 qB:	// Re-emitted in the CURRENT order (`<anchor>:<line>`) either way — the
 EF:	// bounds are re-parsed right below, so only the anchor and the hint matter.
 jn:	return anchor;
 f5:}
 Ky:
 L2:function warnUnicodeEsc(edit: HEdit, warnings: string[]): void {
 Ps:	if (edit.content_lines.some((line) => /\\uDDDD/i.test(line))) {
 Jt:		warnings.push(
 KB:			"Detected literal \\uDDDD in edit content; no autocorrection applied. Verify whether this should be a real Unicode escape or plain text.",
 L3:		);
 EY:	}
 4R:}
 2t:
 Id:/** @internal — private to anchor-pipeline seam; do not import directly, use anchor-pipeline.ts */
 wu:function stripBarePrefixes(
 RA:	edit: HEdit,
 VB:	fileAnchors: string[],
 CO:	warnings: string[],
 W7:): HEdit {
 4r:	// issue #66/B2: pasted anchor-prefix rows in the replacement content are
 3b:	// stripped (prefix = [line?]:anchor<sep>). The old isRealMarker check (line
 4D:	// number in range AND that line's CURRENT anchor equals the prefix anchor)
 Vk:	// almost never held for rows pasted from a post-edit diff (fresh anchors),
 Nb:	// so anchor junk landed verbatim in files. The strip condition is anchor
 lj:	// EXISTENCE: the prefix anchor must be an anchor currently allocated in
 Oh:	// this file — always true for rows pasted from this file's read/diff
 Ag:	// output, and astronomically unlikely for literal content like "sep:".
 BK:	// (Anchor-existence, not unconditional stripping, keeps the fidelity
 yF:	// constraint: the tool must not rewrite literal content it cannot verify.)
 5J:	const stripped: { lineIndex: number }[] = [];
 ZK:	const kept: string[] = [];
 dx:	const contentLines = edit.content_lines.map((line, lineIndex) => {
 Na:		const m = hlRowAnchorRe().exec(line);
 XT:		if (!m) return line;
 Y0:		if (m[1] !== '') return line; // diff-marked rows handled by stripDiffPrefixes
```


## F3-elide-drop-nested-order — dropNested：跨度排序的第二关键字从「endLine 降序」改成「升序」

文件：`src/ast/elide.ts`（改动前 170 行 → 改动后 170 行）

### 候选新形态（行业惯例 unified diff + 干净主体 + 删除行单列）

```text
Diff rows: <+|-><anchor>:<content> — the body is the new code (unchanged lines keep their anchor, `+` lines are new); the removed lines are listed under each hunk, and `~` marks their stale pre-edit anchor.
--- src/ast/elide.ts
+++ src/ast/elide.ts
@@ -112,58 +112,58 @@ dropNested()
 Uq:	for (const node of root.descendantsOfType(["comment"]) as unknown as Node[]) {
 0L:		if (node.startPosition.row === node.endPosition.row) continue;
 KF:		const span = interiorOf(node, "comment", limits.minCommentLines);
 mm:		if (span !== undefined) spans.push(span);
 2h:	}
 mT:
 Ky:	spans.push(...importRunSpans(root, languageId));
 EO:
 l6:	return dropNested(spans);
 sa:}
 eE:
 Gq:/**
 EP: * Fold the middle of a consecutive import run, keeping the first and last
 bn: * import visible. A run shorter than three imports has no middle worth
 fl: * folding, and its ends already anchor the group.
 1f: */
 Hu:function importRunSpans(root: Node, languageId: string): ElisionSpan[] {
 6a:	const types = IMPORT_NODE_TYPES[languageId] ?? [];
 QZ:	if (types.length === 0) return [];
 pY:	const isImport = (node: Node): boolean => types.includes(node.type);
 Su:	const out: ElisionSpan[] = [];
 Vj:	for (const child of root.namedChildren as unknown as Node[]) {
 nU:		if (!isImport(child)) continue;
 gg:		// Walk the whole run from its first member only.
 1a:		let last = child;
 Aq:		for (const sibling of (root.namedChildren as unknown as Node[])) {
 f9:			if (!isImport(sibling)) continue;
 Ds:			if (sibling.startPosition.row > last.endPosition.row) last = sibling;
 hW:		}
 ng:		const openerLine = child.startPosition.row + 1;
 Mb:		const closerLine = last.endPosition.row + 1;
 5c:		if (closerLine - openerLine - 1 < 1) return out;
 qY:		out.push({ startLine: openerLine + 1, endLine: closerLine - 1, openerLine, closerLine, kind: "imports" });
 FO:		return out;
 HP:	}
 FP:	return out;
 7I:}
 wz:
 EU:/** Remove spans fully contained in another; the outer fold already covers them. */
 P5:function dropNested(spans: readonly ElisionSpan[]): ElisionSpan[] {
-~Y0:	const sorted = [...spans].sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
+1X:	const sorted = [...spans].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
 Sv:	const out: ElisionSpan[] = [];
 R2:	let coveredTo = 0;
 u5:	for (const span of sorted) {
 fJ:		if (span.startLine <= coveredTo) continue;
 vh:		out.push(span);
 Sw:		coveredTo = span.endLine;
 xB:	}
 FQ:	return out;
 nn:}
 Ou:
 hP:/** Overlapping spans are not representable by the renderer; this is the check. */
 6b:export function spansAreDisjoint(spans: readonly ElisionSpan[]): boolean {
 Wb:	for (let i = 1; i < spans.length; i++) {
 Qr:		if (spans[i]!.startLine <= spans[i - 1]!.endLine) return false;
 Ng:	}
 bi:	return true;
 d9:}
```


## F4-symbol-rule-order — ruleMatches：把六个判定条件重排（先判便宜的）

文件：`src/ast/symbols.ts`（改动前 503 行 → 改动后 503 行）

### 候选新形态（行业惯例 unified diff + 干净主体 + 删除行单列）

```text
Diff rows: <+|-><anchor>:<content> — the body is the new code (unchanged lines keep their anchor, `+` lines are new); the removed lines are listed under each hunk, and `~` marks their stale pre-edit anchor.
--- src/ast/symbols.ts
+++ src/ast/symbols.ts
@@ -221,86 +221,86 @@ ruleMatches()
 Fi:	for (const child of node.children) {
 Pe:		if (texts.includes(child.text)) return true;
 Xu:	}
 tQ:	return false;
 nn:}
 WJ:
 A6:/** Whether a descendant within the bound has this type. */
 vQ:function hasChildOfType(node: Node, type: string): boolean {
 3u:	let level: Node[] = [...node.children];
 8q:	for (let depth = 0; depth < CHILD_SEARCH_DEPTH && level.length > 0; depth += 1) {
 By:		const next: Node[] = [];
 Ob:		for (const child of level) {
 by:			if (child.type === type) return true;
 kX:			next.push(...child.children);
 Ng:		}
 cV:		level = next;
 d9:	}
 tR:	return false;
 D2:}
 eE:
 0e:/** Whether an ancestor chain contains a node type. */
 HM:function hasAncestor(node: Node, type: string): boolean {
 7b:	for (let parent = node.parent; parent !== null; parent = parent.parent) {
 AO:		if (parent.type === type) return true;
 2V:	}
 tS:	return false;
 sO:}
 wz:
 wH:/** Classify one node, or `undefined` when it is not an addressable symbol. */
 eK:function classify(node: Node, rules: KindRules): SymbolKind | undefined {
 fV:	const candidates = rules[node.type];
 zh:	if (candidates === undefined) return undefined;
 Z5:	for (const rule of candidates) {
 uT:		if (!ruleMatches(rule, node)) continue;
 P1:		return rule.kind;
 SH:	}
 Bd:	return undefined;
 iA:}
 Ou:
 xC:function ruleMatches(rule: KindRule, node: Node): boolean {
+Qf:	if (rule.childAbsent !== undefined && hasChildOfType(node, rule.childAbsent)) return false;
 5L:	if (rule.parentType !== undefined && node.parent?.type !== rule.parentType) return false;
 sA:	if (rule.ancestorType !== undefined && !hasAncestor(node, rule.ancestorType)) return false;
 NZ:	if (rule.ancestorAbsent !== undefined && hasAncestor(node, rule.ancestorAbsent)) return false;
 8d:	if (rule.childType !== undefined && !hasChildOfType(node, rule.childType)) return false;
 Cz:	if (rule.childText !== undefined && !hasChildWithText(node, rule.childText)) return false;
-~Qf:	if (rule.childAbsent !== undefined && hasChildOfType(node, rule.childAbsent)) return false;
 bi:	return true;
 It:}
 6p:
 xp:/**
 YC: * Build the dotted qualified name from name-bearing ancestors only.
 ib: * @param node - the symbol node; its own name is appended last.
 h6: * @param rules - the language's own kind table.
 jk: */
 s6:function qualifiedNameOf(
 bL:	node: Node,
 rT:	rules: KindRules,
 JA:	nameFields: readonly string[],
 TJ:	nameChildTypes: readonly string[] | undefined,
 Ze:	nameChildExclude: readonly string[] | undefined,
 Yk:): string {
 zJ:	const segments: string[] = [];
 N6:	const own = ownSymbolName(node, rules, nameFields, nameChildTypes, nameChildExclude);
 Gk:	if (own !== undefined) segments.push(own);
 7c:	for (let parent = node.parent; parent !== null; parent = parent.parent) {
 xL:		// Only ancestors the language's own table knows carry an identifier
 Z7:		// count; the rest (`statement_block`, `class_body`, `program`, …) are
 iK:		// structure.
 6X:		if (rules[parent.type] === undefined) continue;
 jY:		// ownSymbolName, not bare ownName: an ancestor whose name lives in its
 ir:		// SUBTREE contributes nothing otherwise. Elixir exposed this — its
 2Q:		// `defmodule Geo` is a `call` with no name field, so `def add` came out as
 kF:		// bare `add` instead of `Geo.add` while every namespace around it was
 oR:		// correctly enumerated.
 rV:		const name = ownSymbolName(parent, rules, nameFields, nameChildTypes, nameChildExclude);
 Mu:		if (name !== undefined) segments.push(name);
 8m:	}
 MW:	// Collapse CONSECUTIVE duplicates. `typedef struct Point { int x; } Point;`
 zi:	// legitimately nests two nodes both named Point — the struct specifier and
 SD:	// the typedef — and the member's qualified name must read `Point.x`, not
 wI:	// `Point.Point.x`. Only adjacent repeats collapse, so a genuine
 oF:	// `namespace a { class a {} }` keeps both halves.
 qt:	const collapsed = segments.reverse().filter((segment, index, all) => segment !== all[index - 1]);
 gh:	return collapsed.join(".");
 yf:}
 ok:
```


## F5-align-dp-budget-edge — alignPreservedBounded：DP 预算判定从「小于等于」改成「小于」

文件：`src/hashline/align-bounded.ts`（改动前 422 行 → 改动后 422 行）

### 候选新形态（行业惯例 unified diff + 干净主体 + 删除行单列）

```text
Diff rows: <+|-><anchor>:<content> — the body is the new code (unchanged lines keep their anchor, `+` lines are new); the removed lines are listed under each hunk, and `~` marks their stale pre-edit anchor.
--- src/hashline/align-bounded.ts
+++ src/hashline/align-bounded.ts
@@ -134,81 +134,81 @@ alignPreservedBounded()
 jk: */
 1s:export function alignPreservedBounded<T>(
 JV:	oldSeg: readonly T[],
 Ap:	newSeg: readonly T[],
 wV:	options: AlignOptions = {},
 XY:): AlignResult {
 Pa:	const m = oldSeg.length;
 o2:	const n = newSeg.length;
 3o:	if (m === 0 || n === 0) return { pairs: new Map(), degraded: false };
 wz:
 XI:	// --- step 1: common prefix/suffix strip -----------------------------
 wv:	// O(min(m, n)). The stripped pairs pair by identity — the same `i` in both
 Xr:	// arrays is the same line, so they always match.
 RE:	let prefix = 0;
 EI:	const maxPrefix = m < n ? m : n;
 gV:	while (prefix < maxPrefix && oldSeg[prefix] === newSeg[prefix]) prefix++;
 D8:	let suffix = 0;
 Mh:	const maxSuffix = m - prefix < n - prefix ? m - prefix : n - prefix;
 yc:	while (
 DE:		suffix < maxSuffix &&
 OQ:		oldSeg[m - 1 - suffix] === newSeg[n - 1 - suffix]
 h6:	) {
 kg:		suffix++;
 sa:	}
 Ou:
 xK:	const mMid = m - prefix - suffix;
 2E:	const nMid = n - prefix - suffix;
 6p:
 YL:	// The prefix/suffix strips already pair everything — no DP needed.
 j8:	if (mMid <= 0 || nMid <= 0) {
 di:		return { pairs: identityPairs(m, n, prefix, suffix), degraded: false };
 S3:	}
 ok:
 tK:	const effective = effectiveDpBudget(options.effective);
 d6:	const lowSimilarityFloor = options.lowSimilarityFloor ?? 0.05;
 Gf:
 6a:// --- step 2: threshold check ----------------------------------------
 Bg:	// DP table bytes = 8 · m · n. Below the threshold, run the full DP; the
 7R:	// trim already collapsed the typical "small edit, large file" case down
 GG:	// to the changed region.
-~6N:	if (mMid * nMid <= effective) {
+Hg:	if (mMid * nMid < effective) {
 mx:		const midPairs = lcsBacktrace(
 9J:			oldSeg as readonly unknown[],
 go:			newSeg as readonly unknown[],
 BT:			prefix,
 qH:			m - prefix - suffix,
 ei:			prefix,
 6z:			n - prefix - suffix,
 KK:		);
 PZ:		return {
 7c:			pairs: assembleAllPairs(m, n, prefix, suffix, midPairs),
 a6:			degraded: false,
 S7:		};
 HP:	}
 Ya:
 Ew:// --- step 3: blocked DP ---
 x2:	// Block size so one block's DP table fits the budget: B² ≤ effective ⇒
 RA:	// B = floor(sqrt(effective)). No lower bound — a tiny `effective` (test
 T7:	// seam) gets a tiny block, which is still correct; the budget wins.
 1d:	const blockSize = Math.max(1, Math.floor(Math.sqrt(effective)));
 g5:
 C5:	const result = blockedAlign(
 9K:		oldSeg as readonly unknown[],
 gp:		newSeg as readonly unknown[],
 t6:		prefix,
 qI:		m - prefix - suffix,
 5v:		prefix,
 yE:		n - prefix - suffix,
 aV:		blockSize,
 Hb:		lowSimilarityFloor,
 KL:	);
 QN:	if (result.degraded) {
 3G:		return { pairs: new Map(), degraded: true };
 7I:	}
 Q0:	return {
 UM:		pairs: assembleAllPairs(m, n, prefix, suffix, result.pairs),
 L5:		degraded: false,
 TE:	};
 xB:}
 y0:
 1j:// ---------------------------------------------------------------------------
```


## F6-multi-line-delete — spansAreDisjoint：整函数删掉（8 行跨行删除，无新增）

文件：`src/ast/elide.ts`（改动前 170 行 → 改动后 164 行）

### 候选新形态（行业惯例 unified diff + 干净主体 + 删除行单列）

```text
Diff rows: <+|-><anchor>:<content> — the body is the new code (unchanged lines keep their anchor, `+` lines are new); the removed lines are listed under each hunk, and `~` marks their stale pre-edit anchor.
--- src/ast/elide.ts
+++ src/ast/elide.ts
@@ -124,46 +124,40 @@
 EP: * Fold the middle of a consecutive import run, keeping the first and last
 bn: * import visible. A run shorter than three imports has no middle worth
 fl: * folding, and its ends already anchor the group.
 1f: */
 Hu:function importRunSpans(root: Node, languageId: string): ElisionSpan[] {
 6a:	const types = IMPORT_NODE_TYPES[languageId] ?? [];
 QZ:	if (types.length === 0) return [];
 pY:	const isImport = (node: Node): boolean => types.includes(node.type);
 Su:	const out: ElisionSpan[] = [];
 Vj:	for (const child of root.namedChildren as unknown as Node[]) {
 nU:		if (!isImport(child)) continue;
 gg:		// Walk the whole run from its first member only.
 1a:		let last = child;
 Aq:		for (const sibling of (root.namedChildren as unknown as Node[])) {
 f9:			if (!isImport(sibling)) continue;
 Ds:			if (sibling.startPosition.row > last.endPosition.row) last = sibling;
 hW:		}
 ng:		const openerLine = child.startPosition.row + 1;
 Mb:		const closerLine = last.endPosition.row + 1;
 5c:		if (closerLine - openerLine - 1 < 1) return out;
 qY:		out.push({ startLine: openerLine + 1, endLine: closerLine - 1, openerLine, closerLine, kind: "imports" });
 FO:		return out;
 HP:	}
 FP:	return out;
 7I:}
 wz:
 EU:/** Remove spans fully contained in another; the outer fold already covers them. */
 P5:function dropNested(spans: readonly ElisionSpan[]): ElisionSpan[] {
 Y0:	const sorted = [...spans].sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
 Sv:	const out: ElisionSpan[] = [];
 R2:	let coveredTo = 0;
 u5:	for (const span of sorted) {
 fJ:		if (span.startLine <= coveredTo) continue;
 vh:		out.push(span);
 Sw:		coveredTo = span.endLine;
 xB:	}
 FQ:	return out;
 nn:}
 Ou:
 hP:/** Overlapping spans are not representable by the renderer; this is the check. */
-~6b:export function spansAreDisjoint(spans: readonly ElisionSpan[]): boolean {
-~Wb:	for (let i = 1; i < spans.length; i++) {
-~Qr:		if (spans[i]!.startLine <= spans[i - 1]!.endLine) return false;
-~Ng:	}
-~bi:	return true;
-~d9:}
```


## F7-two-deletes-one-hunk — elideImports：同一段里两处独立删除

文件：`src/ast/elide.ts`（改动前 170 行 → 改动后 168 行）

### 候选新形态（行业惯例 unified diff + 干净主体 + 删除行单列）

```text
Diff rows: <+|-><anchor>:<content> — the body is the new code (unchanged lines keep their anchor, `+` lines are new); the removed lines are listed under each hunk, and `~` marks their stale pre-edit anchor.
--- src/ast/elide.ts
+++ src/ast/elide.ts
@@ -103,67 +103,65 @@
 Sz:			if (!node.isNamed) continue;
 9y:			const span = interiorOf(node, "body", limits.minBodyLines);
 ml:			if (span !== undefined) spans.push(span);
 cv:		}
 Co:	}
 4Y:
 kf:	// A block comment is a `comment` node spanning more than one line; a `//`
 Bl:	// or `#` line comment never qualifies, which is correct — folding a single
 er:	// line saves nothing and would hide content for no gain.
 Uq:	for (const node of root.descendantsOfType(["comment"]) as unknown as Node[]) {
 0L:		if (node.startPosition.row === node.endPosition.row) continue;
 KF:		const span = interiorOf(node, "comment", limits.minCommentLines);
 mm:		if (span !== undefined) spans.push(span);
 2h:	}
 mT:
 Ky:	spans.push(...importRunSpans(root, languageId));
 EO:
 l6:	return dropNested(spans);
 sa:}
 eE:
 Gq:/**
 EP: * Fold the middle of a consecutive import run, keeping the first and last
 bn: * import visible. A run shorter than three imports has no middle worth
 fl: * folding, and its ends already anchor the group.
 1f: */
 Hu:function importRunSpans(root: Node, languageId: string): ElisionSpan[] {
 6a:	const types = IMPORT_NODE_TYPES[languageId] ?? [];
 QZ:	if (types.length === 0) return [];
 pY:	const isImport = (node: Node): boolean => types.includes(node.type);
 Su:	const out: ElisionSpan[] = [];
 Vj:	for (const child of root.namedChildren as unknown as Node[]) {
 nU:		if (!isImport(child)) continue;
 gg:		// Walk the whole run from its first member only.
 1a:		let last = child;
 Aq:		for (const sibling of (root.namedChildren as unknown as Node[])) {
 f9:			if (!isImport(sibling)) continue;
 Ds:			if (sibling.startPosition.row > last.endPosition.row) last = sibling;
 hW:		}
 ng:		const openerLine = child.startPosition.row + 1;
 Mb:		const closerLine = last.endPosition.row + 1;
-~5c:		if (closerLine - openerLine - 1 < 1) return out;
-~qY:		out.push({ startLine: openerLine + 1, endLine: closerLine - 1, openerLine, closerLine, kind: "imports" });
 FO:		return out;
 HP:	}
 FP:	return out;
 7I:}
 wz:
 EU:/** Remove spans fully contained in another; the outer fold already covers them. */
 P5:function dropNested(spans: readonly ElisionSpan[]): ElisionSpan[] {
 Y0:	const sorted = [...spans].sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
 Sv:	const out: ElisionSpan[] = [];
 R2:	let coveredTo = 0;
 u5:	for (const span of sorted) {
 fJ:		if (span.startLine <= coveredTo) continue;
 vh:		out.push(span);
 Sw:		coveredTo = span.endLine;
 xB:	}
 FQ:	return out;
 nn:}
 Ou:
 hP:/** Overlapping spans are not representable by the renderer; this is the check. */
 6b:export function spansAreDisjoint(spans: readonly ElisionSpan[]): boolean {
 Wb:	for (let i = 1; i < spans.length; i++) {
 Qr:		if (spans[i]!.startLine <= spans[i - 1]!.endLine) return false;
 Ng:	}
 bi:	return true;
 d9:}
```


## F8-multi-site-one-file — 一个文件里三处相距很远的改动（行 10 / 32 / 74，中间全是未改代码）

文件：`docs/research/diff-presentation-experiment/synthetic/multi-site.ts`（改动前 82 行 → 改动后 82 行）

### 候选新形态（行业惯例 unified diff + 干净主体 + 删除行单列）

```text
Diff rows: <+|-><anchor>:<content> — the body is the new code (unchanged lines keep their anchor, `+` lines are new); the removed lines are listed under each hunk, and `~` marks their stale pre-edit anchor.
--- docs/research/diff-presentation-experiment/synthetic/multi-site.ts
+++ docs/research/diff-presentation-experiment/synthetic/multi-site.ts
@@ -1,81 +1,81 @@ alpha()
 le:/**
 UC: * Synthetic fixture for the "one file, several change sites" shape.
 7V: *
 dL: * It exists so the experiment can show a file where changes sit far apart
 gp: * (line ~10, ~34, ~78) with unchanged code in between — the case where a diff
 Tu: * has several segments, not one.
 vd: */
 3x:
 df:export function alpha(n: number): number {
-~Ob:	let total = 0;
+wP:	let total = 1;
 ZV:	for (let i = 0; i < n; i += 1) {
 Ot:		total += i * 2;
 WQ:	}
 Yu:	return total;
 mJ:}
 ls:
 ml:export function beta(xs: readonly number[]): number {
 sd:	let best = xs.length > 0 ? xs[0]! : 0;
 jO:	for (const x of xs) {
 HC:		if (x > best) {
 F2:			best = x;
 MC:		}
 cv:	}
 v5:	return best;
 Co:}
 Dn:
 5h:export function gamma(text: string): string {
 Rr:	const trimmed = text.trim();
 SG:	if (trimmed.length === 0) {
 cc:		return "";
 2h:	}
-~eP:	return trimmed.toUpperCase();
+vi:	return trimmed.toLowerCase();
 sa:}
 Vi:
 lJ:export function delta(rows: readonly string[]): string[] {
 4a:	const out: string[] = [];
 WY:	for (const row of rows) {
 pz:		if (row.length === 0) {
 vX:			continue;
 S3:		}
 vj:		out.push(row.trim());
 hW:	}
 FO:	return out;
 HP:}
 dd:
 cf:export function epsilon(flag: boolean, a: number, b: number): number {
 AC:	if (flag) {
 cy:		return a + b;
 7I:	}
 ch:	return a - b;
 xB:}
 v8:
 eG:export function zeta(values: readonly number[]): number {
 wQ:	let sum = 0;
 FE:	for (const value of values) {
 Kl:		sum += value;
 Xu:	}
 9D:	return sum;
 nn:}
 N3:
 w1:export function eta(text: string): number {
 JK:	let count = 0;
 he:	for (const ch of text) {
 nR:		if (ch === "a") {
 lv:			count += 1;
 Ng:		}
 d9:	}
 s2:	return count;
 D2:}
 4Y:
 c5:export function theta(xs: readonly number[]): number {
 xZ:	let out = 0;
 OR:	for (const x of xs) {
-~Dr:		out += x * x;
+e1:		out += x * x * x;
 2V:	}
 FP:	return out;
 sO:}
 mT:
 sE:export function iota(text: string): string {
 Am:	return text.split("").reverse().join("");
 SH:}
```
