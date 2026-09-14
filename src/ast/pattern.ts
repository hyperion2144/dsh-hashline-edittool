/**
 * Structural pattern matching over tree-sitter trees — built here, no new
 * dependency.
 *
 * A pattern is ordinary source for the target language, parsed by that language's
 * own grammar, in which certain identifiers are METAVARIABLES:
 *
 *   `$NAME`   matches one node, captured under `NAME`
 *   `$$$NAME` matches zero or more nodes, captured as a list
 *   `$_`      matches one node without capturing
 *
 * The trick is that nothing special has to happen at parse time: `f($$$ARGS)`
 * parses as a call with an identifier argument, and the matcher recognises that
 * identifier's text as a wildcard when it compares. That is why a pattern must
 * parse as ONE node — a fragment the grammar cannot accept has no tree to
 * compare against, and saying so beats silently matching nothing.
 *
 * Matching is STRUCTURAL: node types and named children, never text. `$A == $A`
 * therefore requires the same code on both sides, because a name captured twice
 * is compared with itself rather than re-matched.
 *
 * @module dsh-hashline-edittool/ast/pattern
 */
import { Parser, type Language, type Node } from "web-tree-sitter";
import { languageById } from "./language.js";
import { E_AST_PATTERN } from "./codes.js";

/** One place the pattern matched, with what its metavariables captured. */
export interface PatternMatch {
	/** The node the pattern's root matched. */
	readonly node: Node;
	/** Captures by name; a `$$$` capture holds every node it spanned. */
	readonly captures: ReadonlyMap<string, readonly Node[]>;
}

/** A parsed pattern: the tree to compare, plus the parser that produced it. */
export interface CompiledPattern {
	/** The pattern's root node. */
	readonly root: Node;
	/** The pattern as written, for messages. */
	readonly source: string;
}

/**
 * Metavariables are REWRITTEN before parsing, and this is not cosmetic.
 *
 * `$` is not a legal identifier character in every grammar — Python rejects
 * `print($$$A)` outright — and in some positions the grammar demands a specific
 * token, so a metavariable cannot appear there as written (`from $M` is not a
 * module specifier; only a string is). Substituting a plain identifier first
 * means the pattern is parsed by the real grammar with no special casing, and
 * the matcher recognises the sentinel on the way back.
 *
 * The sentinel is deliberately ugly: it has to be a valid identifier in every
 * target language, and colliding with a real name would turn that name into a
 * wildcard.
 */
const SENTINEL_ONE = "__HASHLINE_PAT_ONE_";
const SENTINEL_MANY = "__HASHLINE_PAT_MANY_";
const ONE = /^__HASHLINE_PAT_ONE_([A-Za-z_][A-Za-z0-9_]*)?__$/;
const MANY = /^__HASHLINE_PAT_MANY_([A-Za-z_][A-Za-z0-9_]*)?__$/;

/** Rewrite `$NAME` / `$$$NAME` / `$_` / `$$$` into identifier-safe sentinels. */
function substitute(pattern: string): string {
	// `$$$` first: the one-node rule would otherwise consume `$` and leave `$$`.
	return pattern
		.replace(/\$\$\$([A-Za-z_][A-Za-z0-9_]*)?/g, (_m, name: string | undefined) =>
			name === undefined ? `${SENTINEL_MANY}__` : `${SENTINEL_MANY}${name}__`)
		.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => `${SENTINEL_ONE}${name}__`);
}

/** How a pattern node stands in for the target. */
type Role =
	| { readonly kind: "node"; readonly name: string | undefined }
	| { readonly kind: "list"; readonly name: string | undefined }
	| { readonly kind: "literal" };

/** `$NAME` / `$$$NAME` / `$_`, or a node to compare literally. */
function roleOf(node: Node): Role {
	// Only LEAF tokens can be metavariables: a sentinel has to have parsed as a
	// single token, so a node with children is always literal.
	if (node.namedChildCount > 0) return { kind: "literal" };
	const text = node.text;
	const many = MANY.exec(text);
	// A sentinel with no name — or the bare  — matches without binding.
	const bare = (n: string | undefined): string | undefined => (n === undefined || n === "_" ? undefined : n);
	if (many !== null) return { kind: "list", name: bare(many[1]) };
	const one = ONE.exec(text);
	if (one !== null) return { kind: "node", name: bare(one[1]) };
	return { kind: "literal" };
}

/**
 * Parse a pattern for a language.
 *
 * @param pattern - source for the target language, with metavariables.
 * @param languageId - the language whose grammar parses it.
 * @returns the compiled pattern, or undefined when the language is unknown.
 * @throws when the pattern does not parse as exactly one node.
 */
export function compilePattern(pattern: string, languageId: string): CompiledPattern | undefined {
	const language = languageById(languageId);
	if (language === undefined) return undefined;
	const parser = new Parser();
	parser.setLanguage(languageHandle(languageId) as Language);
	const tree = parser.parse(substitute(pattern));
	if (tree === null) throw new Error(`${E_AST_PATTERN} the pattern did not parse: ${pattern}`);
	if (tree.rootNode.hasError) {
		throw new Error(`${E_AST_PATTERN} the pattern has a syntax error, so it cannot be compared: ${pattern}`);
	}
	const named = tree.rootNode.namedChildren;
	if (named.length !== 1) {
		throw new Error(
			`${E_AST_PATTERN} a pattern must parse as ONE node, got ${named.length}. Wrap it: \`class $_ { … }\`: ${pattern}`,
		);
	}
	// `expression_statement` is a WRAPPER, not part of what the caller asked
	// for: `entry.install` parses as `expression_statement(member_expression)`
	// only because a pattern is a whole program. Keeping it as the pattern root
	// locked the search to expressions that happen to BE statements — `f(x);`
	// matched while `const plan = entry.install;` (a member expression inside a
	// declaration) matched NOTHING, silently. The expression is the pattern.
	const first = named[0]!;
	const root =
		first.type === "expression_statement" && first.namedChildCount === 1
			? first.namedChildren[0]!
			: first;
	return { root, source: pattern };
}

/** Grammar handles, cached per language — parsing a pattern is not free. */
const handles = new Map<string, unknown>();
function languageHandle(languageId: string): unknown {
	const cached = handles.get(languageId);
	if (cached !== undefined) return cached;
	throw new Error(`${E_AST_PATTERN} no grammar is loaded for ${languageId}`);
}

/** Remember a loaded grammar so patterns for it can be parsed. */
export function registerPatternLanguage(languageId: string, language: unknown): void {
	handles.set(languageId, language);
}

/** Compare one pattern node against one target node, collecting captures. */
function matchNode(
	pattern: Node,
	target: Node,
	captures: Map<string, readonly Node[]>,
): boolean {
	const patternChildren = pattern.namedChildren;
	const targetChildren = target.namedChildren;
	let p = 0;
	let t = 0;
	while (p < patternChildren.length) {
		const child = patternChildren[p]!;
		const role = roleOf(child);
		if (role.kind === "list") {
			// `$$$NAME` spans as many as it takes for the REST to match, which is
			// why it has to look ahead rather than consume greedily.
			const rest = patternChildren.slice(p + 1);
			for (let take = targetChildren.length - t; take >= 0; take--) {
				const candidate = new Map(captures);
				if (role.name !== undefined) candidate.set(role.name, targetChildren.slice(t, t + take));
				if (matchesRest(rest, targetChildren, t + take, candidate)) {
					for (const [k, v] of candidate) captures.set(k, v);
					return true;
				}
			}
			return false;
		}
		const targetChild = targetChildren[t];
		if (targetChild === undefined) return false;
		if (role.kind === "node") {
			if (role.name !== undefined) captures.set(role.name, [targetChild]);
			t += 1;
			p += 1;
			continue;
		}
		// Literal: same type, and the same text when the node has no children —
		// which is what makes `from "old-package"` name a specific package.
		//
		// TRANSPARENT WRAPPER: `$$$B` inside `{ … }` substitutes to
		// `expression_statement(SENTINEL)` — the statement wrapper is an ARTIFACT of
		// the substitution, and its type then locked the match: a body of `return`
		// statements could never be the `expression_statement` the pattern carried.
		// A node whose sole content is a sentinel is the sentinel speaking, and
		// matches any single target node regardless of the wrapper's type.
		const wrapperChild = child.namedChildCount === 1 ? child.namedChildren[0]! : undefined;
		const transparentWrapper =
			wrapperChild !== undefined && roleOf(wrapperChild).kind !== "literal";
		const literalMatches =
			(child.type === targetChild.type &&
				(child.namedChildCount > 0 || child.text === targetChild.text) &&
				matchNode(child, targetChild, captures)) ||
			transparentWrapper;
		if (literalMatches) {
			t += 1;
			p += 1;
			continue;
		}
		// SUBSEQUENCE semantics, and this is what makes a shape search usable:
		// when the target child cannot be the pattern child, the target child is
		// SKIPPED and the same pattern child retries against the next one.
		//
		// This is why `function f($$$P) { $$$B }` finds a function whose signature
		// carries a return type, an `async` keyword or a decorator — nodes the
		// pattern does not mention, sitting between the children it does. Lockstep
		// matching rejected every one of those functions, which turned "read the
		// function named X" into an absence and made the tool useless for its job.
		//
		// The guard keeps skipping bounded: enough targets must remain for the
		// rest of the pattern, so the walk still terminates and cannot skip past
		// something the tail genuinely needs.
		if (targetChildren.length - t > patternChildren.length - p) {
			t += 1;
			continue;
		}
		return false;
	}
	// PREFIX: the pattern's children are exhausted, so every target child after
	// this point is absorbed — a return type, an `else` clause, trailing
	// statements the pattern never named. Without this the subsequence walk
	// above could match everything up to the last child and then fail on the
	// one extra node the target happens to carry.
	return true;
}

/** Whether the remaining pattern children match the target's tail. */
function matchesRest(
	rest: readonly Node[],
	targetChildren: readonly Node[],
	from: number,
	captures: Map<string, readonly Node[]>,
): boolean {
	if (rest.length === 0) return from === targetChildren.length;
	const [head, ...tail] = rest;
	const role = roleOf(head!);
	if (role.kind === "list") {
		for (let take = targetChildren.length - from; take >= 0; take--) {
			const candidate = new Map(captures);
			if (role.name !== undefined) candidate.set(role.name, targetChildren.slice(from, from + take));
			if (matchesRest(tail, targetChildren, from + take, candidate)) {
				for (const [k, v] of candidate) captures.set(k, v);
				return true;
			}
		}
		return false;
	}
	const targetChild = targetChildren[from];
	if (targetChild === undefined) return false;
	if (role.kind === "node") {
		if (role.name !== undefined) captures.set(role.name, [targetChild]);
		return matchesRest(tail, targetChildren, from + 1, captures);
	}
	if (head!.type !== targetChild.type) return false;
	return matchNode(head!, targetChild, captures) && matchesRest(tail, targetChildren, from + 1, captures);
}

/**
 * Every place the pattern matches in a tree.
 *
 * @param root - the tree to search.
 * @param pattern - a compiled pattern for the same language.
 * @returns one entry per match, in document order.
 */
export function matchPattern(root: Node, pattern: CompiledPattern): PatternMatch[] {
	const out: PatternMatch[] = [];
	const walk = (node: Node): void => {
		// The root's own type has to agree: `f($$$A)` is a call, and matching it
		// against every node would compare children of the wrong shape.
		if (node.type === pattern.root.type) {
			const captures = new Map<string, readonly Node[]>();
			if (matchNode(pattern.root, node, captures)) out.push({ node, captures });
		}
		for (const child of node.namedChildren) walk(child);
	};
	walk(root);
	return out;
}
