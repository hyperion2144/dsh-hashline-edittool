/**
 * 验收实验素材：5 个「agent 式改动」fixture。
 *
 * 每个 fixture 是一次真实形态的编辑——改在**有分支、逻辑不平凡的函数内部**，
 * 因此「光看 diff 行能不能读懂这个函数」就是可测的。
 *
 * 改动用**行块替换**表达（按 trim 后的行内容匹配），不依赖缩进猜测；
 * 匹配不唯一或找不到，脚本报错退出——素材必须可复现。
 *
 * 配套：`render-baseline.mjs` 渲染旧格式；新格式渲染器等形态定案后补。
 */

/** @typedef {{ id: string, title: string, path: string, edits: Array<{ find: string[], replace: string[] }>, truth: { q1: string, q2: string, q3: string, q4: string } }} Fixture */

/** @type {Fixture[]} */
export const FIXTURES = [
	{
		id: "F1-myers-tiebreak",
		title: "myersRange：回溯时相等元素的取舍从「严格小于」改成「小于等于」",
		path: "src/render/line-diff.ts",
		edits: [
			{
				find: ["if (k === -d || (k !== d && v[mid + k - 1]! < v[mid + k + 1]!)) x = v[mid + k + 1]!;"],
				replace: ["if (k === -d || (k !== d && v[mid + k - 1]! <= v[mid + k + 1]!)) x = v[mid + k + 1]!;"],
			},
		],
		truth: {
			q1: "myersRange —— src/render/line-diff.ts 里的 Myers 回溯函数（40 行左右，带 d/k 循环与 if/else 分支）。",
			q2: "在两个候选元素之间做比较时，严格小于（<）改成小于等于（<=）：两个候选**相等**时也走这一侧。",
			q3: "条件是 k !== d 且两个候选比较结果为真时才生效；相等时以前落在 else 分支，现在落在 if 分支。",
			q4: "只改变回溯在「相等」情形下选哪一侧前进，diff 的正确性不受影响；但输出的对齐/顺序可能变（tie-break 变了）。",
		},
	},
	{
		id: "F2-salvage-branch-merge",
		title: "salvageAnchorRef：把「+」与「-」两个警告分支合并成一个",
		path: "src/hashline/anchor-pipeline.ts",
		edits: [
			{
				find: [
					'} else if (match[1] === "+") {',
					'message = `[E_BAD_REF] stripped diff-preview "+" marker and trailing content — using "${anchor}" (from "${clipLine(trimmed, 60)}").`;',
					'} else if (match[1] === "-") {',
					'message = `[E_BAD_REF] stripped leading "-" marker and trailing content — using "${anchor}" (from "${clipLine(trimmed, 60)}").`;',
				],
				replace: [
					'\t\t} else if (match[1] === "+" || match[1] === "-") {',
					'\t\t\tconst which = match[1] === "+" ? `diff-preview "+"` : `leading "-"`;',
					'\t\t\tmessage = `[E_BAD_REF] stripped ${which} marker and trailing content — using "${anchor}" (from "${clipLine(trimmed, 60)}").`;',
				],
			},
		],
		truth: {
			q1: "salvageAnchorRef —— src/hashline/anchor-pipeline.ts 里把粘贴的 read/grep/diff 行还原成引用形式的函数（内部是一串 if/else 警告分支）。",
			q2: "把「+ 标记」和「- 标记」两个警告分支合并成一个条件分支，警告文案里的固定措辞改成按标记类型挑选的变量。",
			q3: "只影响 match[1] 是 \"+\" 或 \"-\" 的单行粘贴情况；多行块（正则 /\\r\\n?|\\n/ 命中）那一支仍然先判，不受影响。",
			q4: "行为等价：文案对 \"+\" 仍是 stripped diff-preview \"+\" marker、对 \"-\" 仍是 stripped leading \"-\" marker，锚点与截断长度都没变；只是代码结构变了。",
		},
	},
	{
		id: "F3-elide-drop-nested-order",
		title: "dropNested：跨度排序的第二关键字从「endLine 降序」改成「升序」",
		path: "src/ast/elide.ts",
		edits: [
			{
				find: ["const sorted = [...spans].sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);"],
				replace: ["const sorted = [...spans].sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);"],
			},
		],
		truth: {
			q1: "dropNested —— src/ast/elide.ts 里去掉被其它跨度完全包含的跨度的函数。",
			q2: "排序的第二个关键字反了：startLine 相同时，原来按 endLine 降序（大的先），现在按 endLine 升序（小的先）。",
			q3: "只有两个跨度 startLine 相同（第一关键字相等）时才会看到差别。",
			q4: "同起始行的跨度之间，原来先保留外层（endLine 大者、覆盖范围大），现在先保留内层（endLine 小者）→ 折叠范围变小、留下的跨度更多。",
		},
	},
	{
		id: "F4-symbol-rule-order",
		title: "ruleMatches：把六个判定条件重排（先判便宜的）",
		path: "src/ast/symbols.ts",
		edits: [
			{
				find: [
					"if (rule.parentType !== undefined && node.parent?.type !== rule.parentType) return false;",
					"if (rule.ancestorType !== undefined && !hasAncestor(node, rule.ancestorType)) return false;",
					"if (rule.ancestorAbsent !== undefined && hasAncestor(node, rule.ancestorAbsent)) return false;",
					"if (rule.childType !== undefined && !hasChildOfType(node, rule.childType)) return false;",
					"if (rule.childText !== undefined && !hasChildWithText(node, rule.childText)) return false;",
					"if (rule.childAbsent !== undefined && hasChildOfType(node, rule.childAbsent)) return false;",
				],
				replace: [
					"if (rule.childAbsent !== undefined && hasChildOfType(node, rule.childAbsent)) return false;",
					"if (rule.parentType !== undefined && node.parent?.type !== rule.parentType) return false;",
					"if (rule.ancestorType !== undefined && !hasAncestor(node, rule.ancestorType)) return false;",
					"if (rule.ancestorAbsent !== undefined && hasAncestor(node, rule.ancestorAbsent)) return false;",
					"if (rule.childType !== undefined && !hasChildOfType(node, rule.childType)) return false;",
					"if (rule.childText !== undefined && !hasChildWithText(node, rule.childText)) return false;",
				],
			},
		],
		truth: {
			q1: "ruleMatches —— src/ast/symbols.ts 里判断一个树节点是否满足某条 kind 规则的函数（六个条件的合取）。",
			q2: "六个判定条件的**先后顺序**变了：childAbsent 从最后一个提到最前，其余相对顺序保持。",
			q3: "只影响判定顺序；每个条件本身没改。",
			q4: "行为等价：六个条件是互相独立的合取项，短路顺序不改变结果（只有性能路径不同）。",
		},
	},
	{
		id: "F5-align-dp-budget-edge",
		title: "alignPreservedBounded：DP 预算判定从「小于等于」改成「小于」",
		path: "src/hashline/align-bounded.ts",
		edits: [
			{
				find: ["if (mMid * nMid <= effective) {"],
				replace: ["if (mMid * nMid < effective) {"],
			},
		],
		truth: {
			q1: "alignPreservedBounded —— src/hashline/align-bounded.ts 里把新行与旧行按存活内容配对的有界对齐函数（分前缀/后缀剥离、阈值判定、阻塞对齐三个阶段）。",
			q2: "第二步的预算判定从 <= 改成 <：中段规模乘积**恰好等于**预算时，不再走完整 DP，改走阻塞对齐。",
			q3: "条件是中段规模 mMid × nMid（剥掉公共前后缀之后）与有效预算 effective 的比较。",
			q4: "只影响「恰好等于预算」的边界情况；两条路径都产出正确配对，但性能特征不同，degraded 标志不变。",
		},
	},
	{
		id: "F6-multi-line-delete",
		title: "spansAreDisjoint：整函数删掉（8 行跨行删除，无新增）",
		path: "src/ast/elide.ts",
		edits: [
			{
				find: [
					"export function spansAreDisjoint(spans: readonly ElisionSpan[]): boolean {",
					"for (let i = 1; i < spans.length; i++) {",
					"if (spans[i]!.startLine <= spans[i - 1]!.endLine) return false;",
					"}",
					"return true;",
					"}",
				],
				replace: [],
			},
		],
		truth: {
			q1: "spansAreDisjoint —— src/ast/elide.ts 里检查区间是否重叠的导出函数。",
			q2: "整个函数被删掉了（8 行），没有新增任何行。",
			q3: "删除发生在文件末尾附近，函数定义 + 循环 + return 一起没了。",
			q4: "文件少了这个导出；调用方会编译失败——跨行删除的风险是「删掉一整块结构」而不是改一行。",
		},
	},
	{
		id: "F7-two-deletes-one-hunk",
		title: "importRunSpans：同一段里两处独立删除",
		path: "src/ast/elide.ts",
		edits: [
			{
				find: ["if (closerLine - openerLine - 1 < 1) return out;"],
				replace: [],
			},
			{
				find: [
					"out.push({ startLine: openerLine + 1, endLine: closerLine - 1, openerLine, closerLine, kind: \"imports\" });",
				],
				replace: [],
			},
		],
		truth: {
			q1: "importRunSpans（src/ast/elide.ts 里折叠连续 import 串中段的函数）。",
			q2: "两处独立的单行删除：一处提前 return，一处 push 区间。",
			q3: "两处删除相隔一行，会落在同一个段里。",
			q4: "语义上：不再丢弃空区间，也不再登记 imports 区间——两处独立改动混在同一个上下文窗口里。",
		},
	},
	{
		id: "F8-multi-site-one-file",
		title: "一个文件里三处相距很远的改动（行 10 / 32 / 74，中间全是未改代码）",
		path: "docs/research/diff-presentation-experiment/synthetic/multi-site.ts",
		edits: [
			{
				find: ["let total = 0;"],
				replace: ["let total = 1;"],
			},
			{
				find: ["return trimmed.toUpperCase();"],
				replace: ["return trimmed.toLowerCase();"],
			},
			{
				find: ["out += x * x;"],
				replace: ["out += x * x * x;"],
			},
		],
		truth: {
			q1: "三个函数：alpha（行 10）、gamma（行 32）、theta（行 74）——都在 synthetic/multi-site.ts。",
			q2: "三处各自独立的一行改动，彼此之间隔着大量没动过的代码。",
			q3: "分别在第 10、32、74 行。",
			q4: "alpha 的初值 0→1；gamma 的返回值从大写改成小写；theta 的累加从 x*x 变成 x*x*x。",
		},
	},
];

/**
 * 应用一个 fixture 的编辑到文件内容上。
 * 按 trim 后的行内容匹配连续行块；找不到或不唯一 → 抛错。
 *
 * @param {string} content 文件内容
 * @param {Fixture} fixture
 * @returns {string} 改后的内容
 */
export function applyFixture(content, fixture) {
	let out = content;
	for (const edit of fixture.edits) {
		const lines = out.split("\n");
		const hits = [];
		for (let i = 0; i + edit.find.length <= lines.length; i++) {
			let ok = true;
			for (let k = 0; k < edit.find.length; k++) {
				if (lines[i + k].trim() !== edit.find[k]) {
					ok = false;
					break;
				}
			}
			if (ok) hits.push(i);
		}
		if (hits.length !== 1) {
			throw new Error(
				`${fixture.id}: 行块匹配 ${hits.length} 次（期望 1 次）→ ${JSON.stringify(edit.find[0]).slice(0, 70)}`,
			);
		}
		const at = hits[0];
		const indent = (line) => /^\s*/.exec(line)[0];
		const replaced = edit.replace.map((line, k) => {
			// 替换行自带缩进就用自带的；否则继承它替换掉的那一行的缩进。
			if (/^\s/.test(line)) return line;
			const source = lines[at + k];
			return source === undefined ? line : indent(source) + line;
		});
		lines.splice(at, edit.find.length, ...replaced);
		out = lines.join("\n");
	}
	return out;
}

/**
 * 定位每个 edit 在改动前 / 改动后文件里的位置（顺带把内容应用一遍）。
 *
 * @param {string} content 改动前全文
 * @param {Fixture} fixture
 * @returns {Array<{at: number, afterAt: number, beforeLen: number, afterLen: number}>} 0-based 起始下标
 */
export function locateEdits(content, fixture) {
	let out = content;
	let shift = 0;
	const spots = [];
	for (const edit of fixture.edits) {
		const lines = out.split("\n");
		const hits = [];
		for (let i = 0; i + edit.find.length <= lines.length; i++) {
			let ok = true;
			for (let k = 0; k < edit.find.length; k++) {
				if (lines[i + k].trim() !== edit.find[k]) {
					ok = false;
					break;
				}
			}
			if (ok) hits.push(i);
		}
		if (hits.length !== 1) {
			throw new Error(
				`${fixture.id}: 行块匹配 ${hits.length} 次（期望 1 次）→ ${JSON.stringify(edit.find[0]).slice(0, 70)}`,
			);
		}
		const at = hits[0];
		// 用等长占位替换：只关心位置，不关心内容。
		lines.splice(at, edit.find.length, ...new Array(edit.replace.length).fill(""));
		out = lines.join("\n");
		spots.push({ at, afterAt: at + shift, beforeLen: edit.find.length, afterLen: edit.replace.length });
		shift += edit.replace.length - edit.find.length;
	}
	return spots;
}
