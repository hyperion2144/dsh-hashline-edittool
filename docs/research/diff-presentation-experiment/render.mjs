/**
 * 渲染实验素材的「模型可见 diff」。
 *
 * 用仓库自己的渲染器渲染（`lib/render/edit-diff.js` 的 `genDiff`），所以两臂
 * （旧格式 / 新格式）走的是**同一份**生产代码，差别只在渲染形态本身。
 *
 *   node docs/research/diff-presentation-experiment/render.mjs --arm old
 *   node docs/research/diff-presentation-experiment/render.mjs --arm new   # 新格式实现后
 *
 * 产物：`baseline-old-format.md`（只含 diff，不含答案；答案在 fixtures.mjs）。
 *
 * 前置：仓库根跑过一次 `npm run build`（需要 lib/ 存在）。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURES, applyFixture, locateEdits } from "./fixtures.mjs";
import { renderCandidate, NEW_LEGEND } from "./render-new.mjs";


const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");

const args = process.argv.slice(2);
const armIndex = args.indexOf("--arm");
const arm = armIndex === -1 ? "new" : args[armIndex + 1];
const variantIndex = args.indexOf("--variant");
const variant = variantIndex === -1 ? "clean-inplace" : args[variantIndex + 1];
const contextIndex = args.indexOf("--context");
const contextLines = contextIndex === -1 ? 3 : Number(args[contextIndex + 1]);

if (arm !== "new" && arm !== "old" && arm !== "proto") {
	console.error(`--arm 只能是 new、old（已冻结）或 proto。`);
	process.exit(2);
}
if (arm === "old") {
	console.error(
		"旧臂已冻结：baseline-old-format.md 是改动前的生产代码渲染出来的产物——渲染器改了之后回不去，所以不再重新生成。",
	);
	process.exit(2);
}

const libEditDiff = join(repoRoot, "lib/render/edit-diff.js");
const libHashAssign = join(repoRoot, "lib/hashline/hash-assign.js");
if (!existsSync(libEditDiff) || !existsSync(libHashAssign)) {
	console.error("lib/ 不存在——先在仓库根跑 `npm run build`。");
	process.exit(2);
}

const { genDiff } = await import(`file://${libEditDiff}`);
const { renderUnifiedDiff } = await import(
	`file://${join(repoRoot, "lib/domain/edit/edit-response.js")}`,
);
const { lineHashesPure } = await import(`file://${libHashAssign}`);


/** 改动的原文件行区间（公共前后缀之外的部分），给 `-` 行做归属。 */
function changedRange(before, after) {
	const a = before.split("\n");
	const b = after.split("\n");
	let p = 0;
	while (p < a.length && p < b.length && a[p] === b[p]) p += 1;
	let s = 0;
	while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s += 1;
	return { originalStartLine: p + 1, originalEndLine: Math.max(p + 1, a.length - s) };
}

const parts = [];
	parts.push(
		arm === "proto"
			? `# 模型可见 diff —— 候选新格式（arm: proto, variant: ${variant}）\n`
			: "# 模型可见 diff —— 新格式（arm: new，生产代码渲染）\n",
	);
parts.push("> 由 `docs/research/diff-presentation-experiment/render.mjs` 渲染，用的是仓库自己的 `genDiff`。\n");
parts.push("> 旧臂（改动前的生产代码渲染）在 `baseline-old-format.md` 里，已冻结。**这份文件里没有答案**——答案在 `fixtures.mjs`。\n");

for (const fixture of FIXTURES) {
	const before = readFileSync(join(repoRoot, fixture.path), "utf8");
	const after = applyFixture(before, fixture);
	parts.push(`\n## ${fixture.id} — ${fixture.title}\n`);
	parts.push(
		`文件：\`${fixture.path}\`（改动前 ${before.split("\n").length} 行 → 改动后 ${after.split("\n").length} 行）\n`,
	);
	if (arm === "new") {
		const range = changedRange(before, after);
		const result = genDiff(
			before,
			after,
			contextLines,
			lineHashesPure(after),
			lineHashesPure(before),
			false,
			undefined,
			[range],
		);
		parts.push("### 新形态（生产代码渲染：unified diff + @@ 段头）\n");
		parts.push("```text");
		parts.push(renderUnifiedDiff([{ path: fixture.path, blocks: result.blocks }], false));
		parts.push("```\n");
		continue;
	}
	const rendered = renderCandidate({
		before,
		after,
		path: fixture.path,
		newAnchors: lineHashesPure(after),
		oldAnchors: lineHashesPure(before),
		variant,
		contextLines,
	});
	parts.push(`### 候选新形态（原型渲染：${variant}）\n`);
	parts.push("```text");
	parts.push(`${NEW_LEGEND}\n${rendered}`);
	parts.push("```\n");
}

const outFile = join(
	here,
	arm === "proto" ? `candidate-${variant}.md` : "candidate-new-format.md",
);
writeFileSync(outFile, parts.join("\n"), "utf8");
console.log(`已写 ${outFile}`);
console.log(`素材 ${FIXTURES.length} 个：${FIXTURES.map((f) => f.id).join(", ")}`);
