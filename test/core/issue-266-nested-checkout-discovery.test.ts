import { describe, expect, test } from "vitest";

import config from "../../vitest.config.js";

/**
 * #266 — the repo keeps one checkout per issue under `.agents/worktrees/<branch>`.
 * Vitest resolves `exclude` against the root of whichever checkout runs the
 * suite, so a root-relative entry is the only thing keeping a leftover nested
 * checkout out of the run: without it the discovery set doubles (133 → 272 in the
 * reproduction) and the copy's client tests fail on build artifacts that this
 * checkout never built.
 *
 * These assertions read the config instead of spawning `vitest list`: starting
 * the runner from inside the runner is slow and is a flake source of its own.
 * The observable proof stays outside — `npx vitest list --filesOnly` in a
 * checkout that has a worktree under it, with `.agents/` count 0.
 */
type ConfigNode = { test?: { exclude?: unknown; projects?: unknown[] } };

const asNode = (value: unknown): ConfigNode => value as ConfigNode;

/** The glob shapes this repo may use to keep the tooling directory out. */
const coversToolingDirectory = (pattern: string): boolean => /^(\*\*\/)?\.agents\/\*\*$/.test(pattern);

const excludeList = (value: unknown): string[] => {
	const exclude = asNode(value).test?.exclude;
	return Array.isArray(exclude) ? exclude.filter((entry): entry is string => typeof entry === "string") : [];
};

const projectsOf = (value: unknown): unknown[] => {
	const projects = asNode(value).test?.projects;
	return Array.isArray(projects) ? projects : [];
};

describe("#266 a nested checkout never joins the repo suite", () => {
	test("the root exclude list keeps the tooling directory out", () => {
		expect(excludeList(config).some(coversToolingDirectory)).toBe(true);
	});

	test("a project that narrows the exclude keeps the tooling directory out too", () => {
		const projects = projectsOf(config);
		expect(projects.length).toBeGreaterThan(0);
		for (const project of projects) {
			const exclude = excludeList(project);
			if (exclude.length === 0) continue; // no own list: the root one is inherited through `extends`
			expect(exclude.some(coversToolingDirectory)).toBe(true);
		}
	});

	test("a project that narrows the exclude keeps every root pattern", () => {
		const root = excludeList(config);
		expect(root.length).toBeGreaterThan(0);
		for (const project of projectsOf(config)) {
			const exclude = excludeList(project);
			if (exclude.length === 0) continue;
			// A project's own `exclude` replaces the inherited array, so a re-typed
			// list drifts: dropping one pattern here silently re-admits it (#266).
			for (const pattern of root) expect(exclude).toContain(pattern);
		}
	});

	test("every exclude pattern is a relative glob, never a platform path", () => {
		const patterns = [config, ...projectsOf(config)].flatMap((node) => excludeList(node));
		expect(patterns.length).toBeGreaterThan(0);
		for (const pattern of patterns) {
			expect(pattern.startsWith("/")).toBe(false);
			expect(/^[A-Za-z]:[\\/]/.test(pattern)).toBe(false);
			expect(pattern).not.toContain("\\");
		}
	});
});
