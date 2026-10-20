/**
 * 「结构优先」新形态渲染器（**原型**）：把两种候选形态渲染出来，供人眼比对。
 *
 *   V1 = 整函数粒度 + 行号 + `-`/`+` 交错（Aider high-level 风格）
 *   V2 = 整函数粒度 + 行号 + **干净代码主体**（改动行标 `+`，被删的行单列在下方）
 *
 * 与旧格式（V0 = 仓库自己的 `genDiff`）的差别不在「给多少上下文」，而在
 * **主体是不是合法、可读的代码**：
 *   - V0 的主体是 ±3 行的浮空片段：花括号不配对、缩进暗示的嵌套看不到闭合；
 *   - V1 的主体是整个函数：结构看得见，但改动的行仍以 `-`/`+` 两份出现，读起来不是干净代码；
 *   - V2 的主体就是**改后的干净代码**（只有改动行带 `+`），旧行单独成块。
 *
 * 原型只回答「哪种形态读得懂」，不承担产品实现（见 scope.mjs 的说明）。
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectScopes, scopeChainAt, enclosingScope, chainText } from "./scope.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
// 用仓库自己的渲染器产出行（原型不重写 diff 逻辑，只重新排版）。
const { genDiff } = await import(`file://${join(repoRoot, "lib/render/edit-diff.js")}`);

/** 新形态的图例（产品实现时要和 src/domain/edit/edit-response.ts 的图例同步）。 */
export const NEW_LEGEND =
	"Diff rows: <+|-><anchor>:<content> — the body is the new code (unchanged lines keep their anchor, `+` lines are new); the removed lines are listed under each hunk, and `~` marks their stale pre-edit anchor.";

/** 行号开着时图例要带上 :line:。 */
export function legendFor(lineNumbers) {
	return lineNumbers
		? "Diff rows: <+|-><anchor>:<line>:<content> — the body is the new code (unchanged lines keep their anchor, `+` lines are new); the removed lines are listed under each hunk, and `~` marks their stale pre-edit anchor."
		: NEW_LEGEND;
}

/** 一行的标记。 */
function prefixOf(kind) {
	if (kind === "+") return "+";
	if (kind === "-") return "-";
	return " ";
}

/**
 * 一行文本。
 * @param {string} anchor 锚点（旧锚点带 `~` 前缀）
 * @param {number} line 行号
 * @param {string} content 行内容
 * @param {string} prefix 行标记
 */
function rowText(anchor, line, content, prefix) {
	return `${prefix}${anchor}:${line}:${content}`;
}


/** 改动的原文件行区间（公共前后缀之外的部分）。 */
function changedRange(before, after) {
	const a = before.split("\n");
	const b = after.split("\n");
	let p = 0;
	while (p < a.length && p < b.length && a[p] === b[p]) p += 1;
	let s = 0;
	while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s += 1;
	return { originalStartLine: p + 1, originalEndLine: Math.max(p + 1, a.length - s) };
}

/** 把 genDiff 的行按「一次改动」分组：`-` 行属于紧随其后的 `+` 行。 */
function groupChanges(rows) {
	const changes = [];
	let removed = [];
	let added = [];
	const flush = () => {
		if (removed.length > 0 || added.length > 0) changes.push({ removed, added });
		removed = [];
		added = [];
	};
	for (const row of rows) {
		if (row.kind === "-") {
			if (added.length > 0) flush();
			removed.push(row);
			continue;
		}
		// 上下文行（空格前缀）不属于任何改动块，跳过。
		if (row.kind !== "+") continue;
		added.push(row);
	}
	flush();
	return changes;
}

/** 包住这些行的、最内层的任意块（控制流也算）。 */
function innermostScope(scopes, lines) {
	const covers = (s) => lines.every((l) => l >= s.startLine && l <= s.endLine);
	const hits = scopes.filter(covers);
	if (hits.length === 0) return undefined;
	return hits.reduce((best, s) => (s.startLine > best.startLine ? s : best));
}
/**
 * 把 genDiff 的行切成 unified diff 的段。
 *
 * genDiff 的结构化 rows 里没有段边界（只有文本里的 ` ... `），所以文本与 rows
 * 按顺序对齐走一遍：遇到 ` ... ` 就是中间省略了若干行，下一行的行号反推跳了多少。
 *
 * @param {Array<{kind: string, lineNumber: number}>} rows
 * @param {string} diffText genDiff 产出的文本
 * @returns {Array<{rows: object[], oldStart: number, newStart: number}>}
 */
function buildHunks(rows, diffText) {
	const hunks = [];
	const textLines = diffText.split("\n");
	let current = null;
	let oldLine = 1;
	let newLine = 1;
	let textIndex = 0;
	for (const row of rows) {
		while (textIndex < textLines.length && textLines[textIndex].trim() === "...") {
			textIndex += 1;
		}
		textIndex += 1;
		if (row.kind !== "-") {
			const gap = row.lineNumber - newLine;
			if (gap > 0) {
				oldLine += gap;
				newLine += gap;
				current = null;
			}
		}
		if (current === null) {
			current = { rows: [], oldStart: oldLine, newStart: newLine };
			hunks.push(current);
		}
		current.rows.push(row);
		if (row.kind === " ") {
			oldLine += 1;
			newLine += 1;
		} else if (row.kind === "-") {
			oldLine += 1;
		} else {
			newLine += 1;
		}
	}
	return hunks;
}

/** 段头后面那截作用域名（git 的 funcname 位）。 */
function scopeLabel(scopes, line) {
	const scope = enclosingScope(scopes, [line]);
	if (scope === undefined) return "";
	if (scope.kind === "class" || scope.kind === "type") return scope.name;
	return `${scope.name}()`;
}

/**
 * 渲染一个 fixture 的**候选新形态**：行业惯例的 unified diff + 主体干净化。
 *
 * 与旧形态只有一处实质差别：**主体里不再夹着 `-` 旧行**。
 * 主体 = 改后的干净代码（未改行 ` ` 前缀、新增/改动行 `+` 前缀），被删的行单独列在
 * 该段下面。段头照 unified diff 写 `@@ -起点,行数 +起点,行数 @@ 作用域名`。
 *
 * @param {object} args
 * @param {string} args.before 改动前全文
 * @param {string} args.after 改动后全文
 * @param {string} args.path 相对路径
 * @param {string[]} args.newAnchors 改动后每行的锚点
 * @param {string[]} args.oldAnchors 改动前每行的锚点
 * @param {number} [args.contextLines] 上下文行数（= 现有配置 context_lines，默认 3）
 * @param {boolean} [args.lineNumbers] 行号（= 现有 #244 开关，默认关）
 * @returns {string}
 */
export function renderCandidate({
	before,
	after,
	path,
	newAnchors,
	oldAnchors,
	contextLines = 3,
	lineNumbers = false,
	variant = "clean-inplace",
}) {
	const range = changedRange(before, after);
	const result = genDiff(before, after, contextLines, newAnchors, oldAnchors, lineNumbers, undefined, [range]);
	if (result.rows.length === 0) return "";
	const scopes = detectScopes(after);
	const hunks = buildHunks(result.rows, result.diff);
	const out = [`--- ${path}`, `+++ ${path}`];
	for (const hunk of hunks) {
		const oldCount = hunk.rows.filter((r) => r.kind !== "+").length;
		const newCount = hunk.rows.filter((r) => r.kind !== "-").length;
		const changed = hunk.rows.find((r) => r.kind === "+");
		const label = changed === undefined ? "" : scopeLabel(scopes, changed.lineNumber);
		out.push(
			`@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@${label === "" ? "" : ` ${label}`}`,
		);
		const tail = [];
		const groups = groupChanges(hunk.rows);
		const groupOf = new Map();
		for (const g of groups) {
			for (const r of g.removed) groupOf.set(r, g);
			for (const a of g.added) groupOf.set(a, g);
		}
		const emitted = new Set();
		for (const row of hunk.rows) {
			if (row.kind === " ") {
				out.push(` ${row.anchor}:${row.content}`);
				continue;
			}
			const g = groupOf.get(row);
			if (g === undefined) continue;
			if (emitted.has(g)) continue;
			emitted.add(g);
			if (variant === "interleaved") {
				for (const r of g.removed) out.push(`-~${r.anchor}:${r.content}`);
				for (const a of g.added) out.push(`+${a.anchor}:${a.content}`);
				continue;
			}
			for (const a of g.added) out.push(`+${a.anchor}:${a.content}`);
			if (g.removed.length === 0) continue;
			if (variant === "clean-inplace") {
				out.push(`  removed (${g.removed.length} line(s)):`);
				for (const r of g.removed) out.push(`-~${r.anchor}:${r.content}`);
			} else {
				for (const r of g.removed) tail.push(`-~${r.anchor}:${r.content}`);
			}
		}
		if (tail.length > 0) {
			out.push(`  removed (${tail.length} line(s)):`);
			out.push(...tail);
		}
	}
	return out.join("\n");
}

export { detectScopes, scopeChainAt, enclosingScope, chainText };
