# 模型可见 diff —— 旧格式（arm: old）

> 由 `docs/research/diff-presentation-experiment/render.mjs` 渲染，用的是仓库自己的 `genDiff`。

> 同一份素材的另一臂（新格式）渲染出来后再比。**这份文件里没有答案**——答案在 `fixtures.mjs`。


## F1-myers-tiebreak — myersRange：回溯时相等元素的取舍从「严格小于」改成「小于等于」

文件：`src/render/line-diff.ts`（改动前 464 行 → 改动后 464 行）

```text
Diff rows: <+|-><anchor>:<content> — + and context rows carry fresh anchors for follow-up edits.
 ...
 B1:		trace.push(v.slice());
 Yc:		for (let k = -d; k <= d; k += 2) {
 jt:			let x: number;
-Tl:			if (k === -d || (k !== d && v[mid + k - 1]! < v[mid + k + 1]!)) x = v[mid + k + 1]!;
+bj:			if (k === -d || (k !== d && v[mid + k - 1]! <= v[mid + k + 1]!)) x = v[mid + k + 1]!;
 5X:			else x = v[mid + k - 1]! + 1;
 Tg:			let y = x - k;
 nm:			while (x < n && y < m && a[aLo + x] === b[bLo + y]) {
```


## F2-salvage-branch-merge — salvageAnchorRef：把「+」与「-」两个警告分支合并成一个

文件：`src/hashline/anchor-pipeline.ts`（改动前 1918 行 → 改动后 1917 行）

```text
Diff rows: <+|-><anchor>:<content> — + and context rows carry fresh anchors for follow-up edits.
 ...
 h4:		let message: string;
 MJ:		if (/\r\n?|\n/.test(rest)) {
 1X:			message = `[E_BAD_REF] ${fieldLabel} got a multi-line block; only the first row's anchor "${anchor}" was used, the rest was ignored.`;
-ku:		} else if (match[1] === "+") {
-OK:			message = `[E_BAD_REF] stripped diff-preview "+" marker and trailing content — using "${anchor}" (from "${clipLine(trimmed, 60)}").`;
-pu:		} else if (match[1] === "-") {
-Nx:			message = `[E_BAD_REF] stripped leading "-" marker and trailing content — using "${anchor}" (from "${clipLine(trimmed, 60)}").`;
+8M:		} else if (match[1] === "+" || match[1] === "-") {
+hr:			const which = match[1] === "+" ? `diff-preview "+"` : `leading "-"`;
+lm:			message = `[E_BAD_REF] stripped ${which} marker and trailing content — using "${anchor}" (from "${clipLine(trimmed, 60)}").`;
 Ne:		} else {
 8s:			message = `[E_BAD_REF] stripped trailing content — using "${anchor}" (from "${clipLine(trimmed, 60)}").`;
 zx:		}
```


## F3-elide-drop-nested-order — dropNested：跨度排序的第二关键字从「endLine 降序」改成「升序」

文件：`src/ast/elide.ts`（改动前 170 行 → 改动后 170 行）

```text
Diff rows: <+|-><anchor>:<content> — + and context rows carry fresh anchors for follow-up edits.
 ...
 wz:
 EU:/** Remove spans fully contained in another; the outer fold already covers them. */
 P5:function dropNested(spans: readonly ElisionSpan[]): ElisionSpan[] {
-Y0:	const sorted = [...spans].sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
+1X:	const sorted = [...spans].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
 Sv:	const out: ElisionSpan[] = [];
 R2:	let coveredTo = 0;
 u5:	for (const span of sorted) {
```


## F4-symbol-rule-order — ruleMatches：把六个判定条件重排（先判便宜的）

文件：`src/ast/symbols.ts`（改动前 503 行 → 改动后 503 行）

```text
Diff rows: <+|-><anchor>:<content> — + and context rows carry fresh anchors for follow-up edits.
 ...
 iA:}
 Ou:
 xC:function ruleMatches(rule: KindRule, node: Node): boolean {
+Qf:	if (rule.childAbsent !== undefined && hasChildOfType(node, rule.childAbsent)) return false;
 5L:	if (rule.parentType !== undefined && node.parent?.type !== rule.parentType) return false;
 sA:	if (rule.ancestorType !== undefined && !hasAncestor(node, rule.ancestorType)) return false;
 NZ:	if (rule.ancestorAbsent !== undefined && hasAncestor(node, rule.ancestorAbsent)) return false;
 8d:	if (rule.childType !== undefined && !hasChildOfType(node, rule.childType)) return false;
 Cz:	if (rule.childText !== undefined && !hasChildWithText(node, rule.childText)) return false;
-Qf:	if (rule.childAbsent !== undefined && hasChildOfType(node, rule.childAbsent)) return false;
 bi:	return true;
 It:}
 6p:
```


## F5-align-dp-budget-edge — alignPreservedBounded：DP 预算判定从「小于等于」改成「小于」

文件：`src/hashline/align-bounded.ts`（改动前 422 行 → 改动后 422 行）

```text
Diff rows: <+|-><anchor>:<content> — + and context rows carry fresh anchors for follow-up edits.
 ...
 Bg:	// DP table bytes = 8 · m · n. Below the threshold, run the full DP; the
 7R:	// trim already collapsed the typical "small edit, large file" case down
 GG:	// to the changed region.
-6N:	if (mMid * nMid <= effective) {
+Hg:	if (mMid * nMid < effective) {
 mx:		const midPairs = lcsBacktrace(
 9J:			oldSeg as readonly unknown[],
 go:			newSeg as readonly unknown[],
```


## F6-multi-line-delete — spansAreDisjoint：整函数删掉（8 行跨行删除，无新增）

文件：`src/ast/elide.ts`（改动前 170 行 → 改动后 164 行）

```text
Diff rows: <+|-><anchor>:<content> — + and context rows carry fresh anchors for follow-up edits.
 ...
 nn:}
 Ou:
 hP:/** Overlapping spans are not representable by the renderer; this is the check. */
-6b:export function spansAreDisjoint(spans: readonly ElisionSpan[]): boolean {
-Wb:	for (let i = 1; i < spans.length; i++) {
-Qr:		if (spans[i]!.startLine <= spans[i - 1]!.endLine) return false;
-Ng:	}
-bi:	return true;
-d9:}
```


## F7-two-deletes-one-hunk — elideImports：同一段里两处独立删除

文件：`src/ast/elide.ts`（改动前 170 行 → 改动后 168 行）

```text
Diff rows: <+|-><anchor>:<content> — + and context rows carry fresh anchors for follow-up edits.
 ...
 hW:		}
 ng:		const openerLine = child.startPosition.row + 1;
 Mb:		const closerLine = last.endPosition.row + 1;
-5c:		if (closerLine - openerLine - 1 < 1) return out;
-qY:		out.push({ startLine: openerLine + 1, endLine: closerLine - 1, openerLine, closerLine, kind: "imports" });
 FO:		return out;
 HP:	}
 FP:	return out;
```


## F8-multi-site-one-file — 一个文件里三处相距很远的改动（行 10 / 32 / 74，中间全是未改代码）

文件：`docs/research/diff-presentation-experiment/synthetic/multi-site.ts`（改动前 82 行 → 改动后 82 行）

```text
Diff rows: <+|-><anchor>:<content> — + and context rows carry fresh anchors for follow-up edits.
 ...
 vd: */
 3x:
 df:export function alpha(n: number): number {
-Ob:	let total = 0;
+wP:	let total = 1;
 ZV:	for (let i = 0; i < n; i += 1) {
 Ot:		total += i * 2;
 WQ:	}
 ...
 SG:	if (trimmed.length === 0) {
 cc:		return "";
 2h:	}
-eP:	return trimmed.toUpperCase();
+vi:	return trimmed.toLowerCase();
 sa:}
 Vi:
 lJ:export function delta(rows: readonly string[]): string[] {
 ...
 c5:export function theta(xs: readonly number[]): number {
 xZ:	let out = 0;
 OR:	for (const x of xs) {
-Dr:		out += x * x;
+e1:		out += x * x * x;
 2V:	}
 FP:	return out;
 sO:}
```
