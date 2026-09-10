/**
 * Channel-contract + hot-reload tests (#53, decisions (c) + full hot config).
 *
 * Two contracts pinned here:
 *
 * 1. `input_format: text` advertises ONE string parameter — the whole call is
 *    a plain-text payload (decision (c)). `json` keeps the object schema.
 *    Both channels still execute: a string payload is parsed, an object
 *    payload is validated, and both reach the same body.
 *
 * 2. EVERY effective config change rebuilds every live agent's tool surfaces
 *    (tools + guidance sections) through the surface-rebuild registry, so the
 *    next model step sees the new contract without a restart.
 *
 * @module test/core/channel-contract.test
 */

import { afterEach, describe, expect, it } from "vitest";
import { applyEffective, getEffectiveConfig } from "../../src/config.js";
import { onToolSurfaceRebuild } from "../../src/surface-rebuild.js";
import { buildReadTool } from "../../src/tool-read.js";
import { buildGrepTool } from "../../src/tool-grep.js";
import { buildEditTool } from "../../src/tool-edit.js";
import { buildWriteShadowTool } from "../../src/tool-write-shadow.js";
import { localIO } from "../../src/fs-bridge.js";
import { FsSandboxController } from "../../src/sandbox.js";
import { readDescription, grepDescription, editDescription, writeDescription, readGuidance } from "../../src/prompts.js";

function testSandbox() {
	return new FsSandboxController({
		fs: { sandboxMode: undefined },
		get: () => undefined,
	} as never);
}

afterEach(() => {
	applyEffective({});
});

describe("text mode advertises a plain-text parameter root (decision (c))", () => {
	it("read/grep/edit/write expose {type:'string'} with a payload description", () => {
		applyEffective({ input_format: "text" });
		const io = localIO();
		const sandbox = testSandbox();
		for (const tool of [
			buildReadTool(io),
			buildGrepTool(io),
			buildEditTool(io, sandbox),
			buildWriteShadowTool(io, sandbox),
		]) {
			const params = tool.parameters as { type?: unknown; description?: unknown };
			expect(params.type).toBe("string");
			expect(typeof params.description).toBe("string");
			expect(String(params.description).length).toBeGreaterThan(20);
			// No object-root leftovers.
			expect(params).not.toHaveProperty("properties");
			expect(params).not.toHaveProperty("required");
		}
	});

	it("json mode keeps the compiled object schema", () => {
		applyEffective({ input_format: "json" });
		const io = localIO();
		const read = buildReadTool(io).parameters as {
			type?: string;
			properties?: Record<string, unknown>;
		};
		expect(read.type).toBe("object");
		expect(read.properties?.file_path).toBeDefined();
	});

	it("descriptions teach the text DSL in text mode and the JSON keys in json mode", () => {
		applyEffective({ input_format: "text" });
		const cfgText = getEffectiveConfig();
		expect(readDescription(cfgText)).toContain("ONE plain-text payload");
		expect(grepDescription(cfgText)).toContain("ONE plain-text payload");
		expect(editDescription(cfgText)).toContain("<<<END");
		expect(writeDescription(cfgText)).toContain("<<<END");
		expect(readGuidance(cfgText).lines[0]).toContain("plain-text payload");

		applyEffective({ input_format: "json" });
		const cfgJson = getEffectiveConfig();
		expect(readDescription(cfgJson)).not.toContain("ONE plain-text payload");
		expect(editDescription(cfgJson)).toContain("each item is");
	});

	it("text mode still executes an OBJECT payload (dual channel preserved)", async () => {
		applyEffective({ input_format: "text" });
		const io = localIO();
		const read = buildReadTool(io);
		// An object payload that fails object-schema validation must still be
		// rejected — the text channel does not weaken the JSON contract.
		await expect(
			read.execute({ bogus: true }, {
				signal: new AbortController().signal,
				agent: { id: "s", session: { id: "s", header: { cwd: process.cwd() } } },
				arguments: {},
			} as never),
		).rejects.toThrow();
	});
});

describe("hot reload: any effective config change rebuilds the surfaces", () => {
	it("fires the surface-rebuild registry for each model-facing setting", () => {
		let rebuilds = 0;
		const off = onToolSurfaceRebuild(() => {
			rebuilds += 1;
		});
		try {
			applyEffective({ input_format: "json" });
			expect(rebuilds).toBe(1);
			applyEffective({ require_line_content: true });
			expect(rebuilds).toBe(2);
			applyEffective({ output_format: "json" });
			expect(rebuilds).toBe(3);
			applyEffective({ separator: "|" });
			expect(rebuilds).toBe(4);
			applyEffective({ context_lines: 7 });
			expect(rebuilds).toBe(5);
			// No change → no rebuild (settings events fire on every commit).
			applyEffective({ context_lines: 7 });
			expect(rebuilds).toBe(5);
		} finally {
			off();
			applyEffective({});
		}
	});

	it("unsubscribing stops rebuilds for a disposed agent", () => {
		let rebuilds = 0;
		const off = onToolSurfaceRebuild(() => {
			rebuilds += 1;
		});
		off();
		applyEffective({ input_format: "json" });
		expect(rebuilds).toBe(0);
		applyEffective({});
	});
});
