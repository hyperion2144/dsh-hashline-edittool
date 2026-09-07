/**
 * Edit-surface rebuild registry — the dynamic-schema mechanism
 * (research issue #75, contract issue #76).
 *
 * The `edit` tool's model-facing schema (and its guidance section) depend
 * on the `hashline.require_line_content` flag. dsh tool registrations are
 * hot-swappable: `register()` returns an exact disposer and a dispose →
 * re-register cycle on the agent's own scope layer is picked up by the
 * model on the very next step (agent-loop reassembles the tool list every
 * step — tools are not session-snapshotted).
 *
 * `config.applyEffective` calls `rebuildEditSurfaces()` when the flag
 * flips; every live agent's registered rebuilder disposes its current
 * edit surface and reinstalls it against the new effective config.
 * Agents started later simply install with the current config.
 *
 * @module dsh-hashline-edittool/edit-rebuild
 */

type EditSurfaceRebuilder = () => void;

const rebuilders = new Set<EditSurfaceRebuilder>();

/**
 * Register one agent's edit-surface rebuilder. Returns the unsubscriber
 * (the agent's effect cleanup calls it when the agent is disposed).
 */
export function onEditSurfaceRebuild(rebuild: EditSurfaceRebuilder): () => void {
	rebuilders.add(rebuild);
	return () => {
		rebuilders.delete(rebuild);
	};
}

/**
 * Rebuild every live agent's edit surface. Called only when the
 * `require_line_content` flag actually changed, so rebuilder callbacks can
 * reinstall unconditionally. One failing agent must not block the others.
 */
export function rebuildEditSurfaces(): void {
	for (const rebuild of [...rebuilders]) {
		try {
			rebuild();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`dsh-hashline-edittool: edit schema rebuild failed: ${message}`);
		}
	}
}
