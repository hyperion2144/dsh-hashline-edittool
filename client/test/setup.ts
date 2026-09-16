/**
 * Client-workspace test setup.
 *
 * The client tests are pure unit tests (models, projections, highlight) — no
 * fs, no harness home. This file exists so the ROOT vitest.config.ts
 * `setupFiles: ["./test/setup.ts"]` — which vitest also resolves relative to
 * this workspace when CI runs `npm test -w client` — always finds a module,
 * instead of failing with "Cannot find module client/test/setup.ts".
 *
 * @module dsh-hashline-edittool-client/setup
 */
export {};
