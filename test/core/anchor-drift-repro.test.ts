/**
 * 锚点漂移复现（#131 字段报告：edit 收到 `486:TX` 却改了 708 行）。
 *
 * 诊断用例，证明三件事：
 * 1. assignAnchors 对同内容行组按「出现顺序」分配组内槽位 ——
 *    在组内靠前的位置插入新的同内容行，会让组内后段所有行的锚点整体后移；
 * 2. 于是「上次 read 时 486 行的锚点 TX」，在全量重算后标识的是另一行（708 附近）；
 * 3. pinBound（edit-engine）用 indexOf(anchor) 的命中行**覆盖**行提示 ——
 *    这是「改了与锚点无关的行」的直接执行者。
 */
import { describe, expect, it } from "vitest";
import { assignAnchors } from "../../src/hashline/alloc.js";

// 20 行普通行 + 一批 `\t\t});` 形态的同内容行（模拟真实测试文件的闭合行组）。
const filler = (n: number) => Array.from({ length: n }, (_, i) => `const v${i} = ${i};`);

function fileWithClosers(closers: number[]): string[] {
	// closers: 出现 `\t\t});` 的行号（1-based，升序）
	const lines: string[] = [];
	let next = 1;
	for (const at of closers) {
		while (next < at) lines.push(`const v${next} = ${next};`), next++;
		lines.push("\t\t});");
		next++;
	}
	while (next <= closers[closers.length - 1]! + 8) lines.push(`const w${next} = ${next};`), next++;
	return lines;
}

describe("锚点漂移复现（BUG 诊断）", () => {
	it("同内容行组的锚点按出现顺序分配：组内前段插入同内容行 → 后段行锚点整体后移", () => {
		// 编辑前：`\t\t});` 出现在 200 和 210 行（486 行的角色 = 第一处）。
		const before = fileWithClosers([200, 210]);
		const beforeAnchors = assignAnchors(before);
		const anchorAt200 = beforeAnchors[199]!;
		expect(before[199]).toBe("\t\t});");

		// 编辑：在 100 行附近插入 10 行 —— 其中 3 行是与 200 行同内容的 `\t\t});`。
		const after = [...before];
		after.splice(99, 0, "\t\t});", "const injected = 1;", "\t\t});", "const injected = 2;", "\t\t});");
		// 全量重算（进程重启 / 外部变更 / store 逐出后 anchorsFor 走的正是这条路径）。
		const afterAnchors = assignAnchors(after);

		// TX（= 旧 200 行的锚点）现在标识的是哪一行？
		const driftedIndex = afterAnchors.indexOf(anchorAt200);
		const driftedLine = driftedIndex + 1;
		// 不再是原内容行（200，现已在 203）。TX 被插入区域内第一个同内容行
		// 抢走：同内容行组按出现顺序重新排队，锚点跟着「组内排位」走，
		// 不跟着「哪一行」走 —— 这就是 TX:486 命中别处的机制。
		expect(driftedLine).toBe(102);
		expect(after[driftedIndex]).toBe("\t\t});");
	});

	it("pinBound 的 indexOf 语义会把行提示覆盖成漂移后的行", () => {
		// edit-engine.ts::pinBound 的原样语义：
		const pinBound = (bound: { anchor: string; line?: number }, fileAnchors: string[]) => {
			const idx = fileAnchors.indexOf(bound.anchor);
			return { anchor: bound.anchor, line: idx >= 0 ? idx + 1 : undefined };
		};
		const before = fileWithClosers([200, 210]);
		const beforeAnchors = assignAnchors(before);
		const anchor = beforeAnchors[199]!; // 「200 行的锚点」

		const after = [...before];
		after.splice(99, 0, "\t\t});", "const injected = 1;", "\t\t});");
		const afterAnchors = assignAnchors(after);

		// 模型引用 `anchor:200`（行提示 200 + 锚点）。pinBound 无视 200，
		// 返回锚点漂移后的行 —— 编辑目标被静默改写。
		const pinned = pinBound({ anchor, line: 200 }, afterAnchors);
		expect(pinned.line).not.toBe(200);
		expect(pinned.line).toBe(afterAnchors.indexOf(anchor) + 1);
	});
});
