/**
 * One tool's guidance: a brief opener plus concise bullets. The `intro` is
 * shown above the bullets; it does not duplicate the tool-schema `description`
 * (that already reaches the model through the tool catalog).
 *
 * Lives in the contract layer — below every domain and below the guidance
 * resolver — so any domain can type its section text without reaching
 * sideways into a sibling domain (#447).
 * @module dsh-hashline-edittool/contract/tool-guidance
 */
export interface ToolGuidance {
	/** One-line lead shown above the bullets. */
	intro: string;
	/** Concise bullets; each is self-contained within its section. */
	lines: readonly string[];
}
