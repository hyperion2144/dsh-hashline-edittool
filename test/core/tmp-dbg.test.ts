import { describe, expect, it } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setupIntegrationTest, getText } from "../support/fixtures.js";

function bigContent(): string {
	const lines: string[] = [];
	for (let i = 1; i <= 3000; i++) {
		if (i % 10 === 0) lines.push("  }");
		else if (i % 5 === 0) lines.push("");
		else lines.push(`const mark${i} = ${i}; // ${i % 500 === 7 ? "needle-hit" : "miss"}`);
	}
	return lines.join("\n");
}

describe("dbg", () => {
	it("dumps", async () => {
		const cwd = (globalThis as any).__c ?? process.cwd();
		const dir = await (await import("node:fs/promises")).mkdtemp(join((await import("node:os")).tmpdir(), "dbg-vr-"));
		const p = join(dir, "big.ts");
		await writeFile(p, bigContent());
		const harness = setupIntegrationTest(dir);
		const res = await (harness.getTool("grep") as any).execute("g", { path: "big.ts", pattern: "needle-hit", context: 0, limit: 100 });
		const text = getText(res);
		const served = [...text.matchAll(/^\s*[A-Za-z0-9]{2,8}:\d+[:|]/gm)].length;
		console.log("SERVED:", served, "LINES:", text.split("\n").length, "LEN:", text.length);
		console.log("TEXT>>>\n" + text);
		expect(true).toBe(true);
	});
});
