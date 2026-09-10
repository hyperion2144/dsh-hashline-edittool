/**
 * Mode-aware tool builder (spec #85, decision (c) 2026-09-08).
 *
 * `hashline.input_format` selects the model-facing parameter contract:
 *
 *   - `json` (legacy channel): the tool is built with `defineTool` exactly as
 *     before — the compiled object schema is advertised and `defineTool`
 *     validates every call.
 *   - `text` (default): the tool advertises `parameters: { type: "string" }`,
 *     i.e. THE WHOLE CALL IS ONE PLAIN-TEXT PAYLOAD (the tool name is the call
 *     symbol, not a payload prefix). The payload is parsed by the tool's text
 *     parser into the JSON-equivalent args, validated against the same object
 *     schema the JSON channel uses, and handed to the SAME execute body —
 *     payload equivalence is the parity contract.
 *
 * Text mode does NOT drop the JSON channel: an object payload is still
 * accepted at runtime and validated the same way (defensive: a model may wrap
 * its call in JSON even though the advertised root is a string).
 *
 * Both modes share one `execute`, one `output` projection (schema + render +
 * presentationMeta) and the same presenters; only the advertised `parameters`
 * and the description differ.
 *
 * @module dsh-hashline-edittool/text-input/channel-tool
 */

import {
	defineTool,
	parameterSchemaSpecToJsonSchema,
	ToolArgsError,
	validateJsonSchemaValue,
	valueSchemaSpecToJsonSchema,
} from "@deepseek-ai/dsh-tools";
import type {
	DefineToolOptions,
	ParameterSchemaSpec,
	ValueSchemaSpec,
} from "@deepseek-ai/dsh-tools";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { isTextInput } from "../config.js";

/** One channel-tool spec: `defineTool` options plus the text-channel binding. */
export interface ChannelToolOptions<
	S extends ParameterSchemaSpec,
	O extends ValueSchemaSpec,
> extends DefineToolOptions<S, O> {
	/** Parse the plain-text payload into the JSON-equivalent args. Throws E_PARSE_*. */
	parseText: (text: string) => unknown;
	/** Model-facing description of the string parameter (text mode only). */
	textParameterDescription: string;
}

/**
 * Build one tool definition for the active `input_format`.
 *
 * @param options - the tool spec (same shape `defineTool` takes) plus
 *   `parseText` / `textParameterDescription` for the text channel.
 * @returns A registry-ready definition; text mode advertises a string root.
 */
export function buildChannelTool<
	S extends ParameterSchemaSpec,
	O extends ValueSchemaSpec,
>(options: ChannelToolOptions<S, O>): ToolDefinition {
	if (!isTextInput()) {
		// JSON channel: byte-identical to the pre-#53 construction.
		// The spec is structurally DefineToolOptions; the type-erased call
		// avoids a deep generic-inference blowup on the const type parameter.
		const define = defineTool as unknown as (o: unknown) => ToolDefinition;
		return define(options);
	}

	// ---- text channel: raw definition with a string parameter root ----
	const objectSchema = parameterSchemaSpecToJsonSchema(options.parameters);
	const outputSchema = valueSchemaSpecToJsonSchema(options.output.schema);
	const validateObject = (args: unknown): string[] =>
		validateJsonSchemaValue(objectSchema, args, "");

	/** Strict resolve (execute path): parse errors propagate as E_PARSE_*. */
	const resolve = (args: unknown): unknown =>
		typeof args === "string" ? options.parseText(args) : args;

	/** Soft resolve (presenter/render path): never throws. */
	const resolveSoft = (args: unknown): unknown => {
		if (typeof args !== "string") return args;
		try {
			return options.parseText(args);
		} catch {
			return undefined;
		}
	};

	const tool: ToolDefinition = {
		name: options.name,
		description: options.description,
		parameters: {
			type: "string",
			description: options.textParameterDescription,
		},
		output: {
			schema: outputSchema,
			render: (args, value) =>
				options.output.render(resolveSoft(args) as never, value as never),
			...(options.output.presentationMeta === undefined
				? {}
				: {
						presentationMeta: (args, value) =>
							options.output.presentationMeta!(
								(resolveSoft(args) ?? {}) as never,
								value as never,
							),
					}),
		},
		async execute(args, exec) {
			const resolved = resolve(args);
			const violations = validateObject(resolved);
			if (violations.length > 0) throw new ToolArgsError(violations);
			return options.execute(resolved as never, exec);
		},
	};
	if (options.timeoutMs !== undefined) tool.timeoutMs = options.timeoutMs;
	if (options.presentCall !== undefined) {
		tool.presentCall = (args) => {
			const resolved = resolveSoft(args);
			if (resolved === undefined || validateObject(resolved).length > 0) {
				return undefined;
			}
			return options.presentCall!(resolved as never);
		};
	}
	if (options.presentResult !== undefined) {
		tool.presentResult = (args, result) => {
			const resolved = resolveSoft(args);
			if (resolved === undefined || validateObject(resolved).length > 0) {
				return undefined;
			}
			return options.presentResult!(resolved as never, result);
		};
	}
	if (options.isConcurrencySafe !== undefined) {
		tool.isConcurrencySafe = (args) => {
			const resolved = resolveSoft(args);
			if (resolved === undefined || validateObject(resolved).length > 0) {
				return false;
			}
			return options.isConcurrencySafe!(resolved as never);
		};
	}
	if (options.finalizeContent !== undefined) {
		tool.finalizeContent = options.finalizeContent;
	}
	return tool;
}
