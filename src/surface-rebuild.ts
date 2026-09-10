/**
 * Tool-surface rebuild registry — the dynamic-schema mechanism
 * (research issue #75, contract issue #76; generalized in #53).
 *
 * EVERY model-facing surface depends on the effective hashline config: the
 * advertised parameter contract (`input_format`), the edit schema
 * (`require_line_content`) and the description/guidance text
 * (`output_format`, flags). dsh tool registrations are hot-swappable:
 * `register()` returns an exact disposer and a dispose → re-register cycle
 * on the agent's own scope layer is picked up by the model on the very next
 * step (agent-loop reassembles the tool list every step — tools are not
 * session-snapshotted).
 *
 * `config.applyEffective` calls `rebuildToolSurfaces()` whenever ANY
 * effective setting changed; every live agent's registered rebuilder
 * disposes its current surfaces (tools + guidance sections) and reinstalls
 * them against the new effective config. Agents started later simply
 * install with the current config.
 *
 * @module dsh-hashline-edittool/surface-rebuild
 */

type ToolSurfaceRebuilder = () => void;

const rebuilders = new Set<ToolSurfaceRebuilder>();

/**
 * Register one agent's surface rebuilder. Returns the unsubscriber
 * (the agent's effect cleanup calls it when the agent is disposed).
 */
export function onToolSurfaceRebuild(rebuild: ToolSurfaceRebuilder): () => void {
	rebuilders.add(rebuild);
	return () => {
		rebuilders.delete(rebuild);
	};
}

/**
 * Rebuild every live agent's tool surfaces + guidance sections. Called only
 * when the effective config actually changed, so rebuilder callbacks can
 * reinstall unconditionally. One failing agent must not block the others.
 */
export function rebuildToolSurfaces(): void {
	for (const rebuild of [...rebuilders]) {
		try {
			rebuild();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`dsh-hashline-edittool: tool surface rebuild failed: ${message}`);
		}
	}
}
