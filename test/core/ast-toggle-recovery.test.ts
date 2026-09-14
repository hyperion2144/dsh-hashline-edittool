/**
 * Turning AST off and back on must come back — the settings card offers that
 * switch, so "off" cannot be a one-way door.
 *
 * Reported by the smoke session as: with `ast.enabled: false` a symbol read
 * answered `E_AST_WORKER_FAILED: AST client is disposed` instead of the
 * expected `E_BAD_SHAPE`, and flipping the setting back to `true` did NOT
 * recover — every AST feature stayed dead for the rest of the process.
 */
import { afterEach, describe, expect, it } from "vitest";
import { applyEffective } from "../../src/config.js";
import { getAstClient, setAstClient } from "../../src/ast/client.js";

afterEach(() => {
	setAstClient(undefined);
	applyEffective({ ast: { enabled: true } });
});

describe("AST toggle recovery", () => {
	it("hands back a LIVE client after off -> on", () => {
		applyEffective({ ast: { enabled: true } });
		const first = getAstClient();

		applyEffective({ ast: { enabled: false } });
		applyEffective({ ast: { enabled: true } });

		const second = getAstClient();
		// `dispose()` sets a private `#disposed` flag that nothing ever clears,
		// and the singleton is not dropped — so without an explicit rebuild the
		// second call returns the same corpse.
		expect(second).not.toBe(first);
	});

	it("does not leave the client permanently disposed", () => {
		applyEffective({ ast: { enabled: true } });
		applyEffective({ ast: { enabled: false } });
		applyEffective({ ast: { enabled: true } });

		// Asserted on the flag itself rather than by calling an operation: an op
		// would need a spawned worker, and in the test tree `worker.js` does not
		// exist — so an op-based assertion would pass for the WRONG reason.
		expect(getAstClient().disposed).toBe(false);
	});
});
