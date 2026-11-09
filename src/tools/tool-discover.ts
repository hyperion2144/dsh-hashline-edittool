/**
 * The discovery gate's resident entry tool (#421 ②) — `hashline_tools`.
 *
 * The cold tools (`ast_grep`, `ast_edit`, `format`, `lsp`) stay OFF the wire
 * schema until this tool is called: calling it unlocks them for the session,
 * persists the unlock across restarts, and re-registers them immediately
 * (the host re-assembles the tool surface every step, so the next step sees
 * them — the `require_line_content` flip rides the same behavior, #75).
 *
 * This tool itself is ALWAYS registered (a discovery entry that could be
 * cold would leave nothing to discover through). Its description is the
 * model's only in-schema hint that the advanced tools exist — there is no
 * runtime fallback for a model that calls a still-cold tool by name (the
 * host answers `UNKNOWN_TOOL`); the description prevents exactly that.
 *
 * @module dsh-hashline-edittool/tools/tool-discover
 */
import { defineTool } from "@deepseek-ai/dsh-tools";

export interface DiscoverToolOptions {
	/**
	 * Unlock + re-register the cold tools for the calling session. Runs
	 * inside `execute`; returns the tool names that are now available.
	 */
	readonly onUnlock: () => readonly string[];
}

export function buildDiscoverTool(options: DiscoverToolOptions) {
	return defineTool({
		name: "hashline_tools",
		description:
			"Unlock dsh-hashline-edittool's advanced tools: ast_grep (structural code search), " +
			"ast_edit (syntax-aware edit), format (language-server formatting), and lsp (symbol " +
			"navigation + diagnostics). Call this ONCE when you need any of them; after it returns " +
			"they are callable for the rest of the session and stay unlocked across restarts. " +
			"If you call one of them before unlocking, the call fails with UNKNOWN_TOOL — " +
			"call this tool first. Plain read/edit/write/grep need no unlocking.",
		parameters: {},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					unlocked: { type: "array", items: { type: "string" } },
				},
			},
			render: (_args: unknown, value: { unlocked: string[] }) => [
				{
					type: "text",
					text: `Unlocked: ${value.unlocked.join(", ")}. They are callable now and stay unlocked across restarts.`,
				},
			],
		},
		execute: async () => ({ unlocked: [...options.onUnlock()] }),
	});
}
