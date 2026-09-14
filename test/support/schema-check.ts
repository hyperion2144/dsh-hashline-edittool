/**
 * The tool DSL validates a RETURNED value against the tool's declared output
 * schema when a session mounts it — not when a unit test calls `execute`.
 *
 * That gap is not theoretical: `modelText` was added to three tools whose
 * schemas did not name it (`value.modelText is not declared`), and a `dict`
 * field inside `ast_grep`'s matches was rejected the same way. Every test
 * passed, because tests call the body directly and the host is what checks the
 * contract. This walks the declaration and the value together, so the next
 * such field fails HERE instead of in a user's session.
 *
 * @module
 */

/** One declared property spec, in the subset this repo's tools use. */
interface ValueSpec {
	readonly type?: string;
	readonly required?: boolean;
	readonly additionalProperties?: boolean;
	readonly properties?: Record<string, ValueSpec>;
	readonly items?: ValueSpec;
}

/**
 * Collect every place a value disagrees with its declaration.
 *
 * @param schema - the declared spec (`tool.output.schema`).
 * @param value - the value `execute` returned.
 * @param at - the path being checked, for the message.
 * @returns one human-readable line per disagreement; empty means it conforms.
 */
export function schemaViolations(
	schema: ValueSpec,
	value: unknown,
	at = "value",
): string[] {
	const out: string[] = [];
	const type = schema.type ?? "json";
	if (type === "json") return out;
	if (type === "array") {
		if (!Array.isArray(value)) return [`${at}: expected an array, got ${typeof value}`];
		value.forEach((entry, index) => {
			if (schema.items !== undefined) out.push(...schemaViolations(schema.items, entry, `${at}[${index}]`));
		});
		return out;
	}
	if (type === "object") {
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return [`${at}: expected an object, got ${Array.isArray(value) ? "array" : typeof value}`];
		}
		const declared = schema.properties ?? {};
		for (const key of Object.keys(value as Record<string, unknown>)) {
			// The host rejects an undeclared field outright when the spec closes the
			// object — this is the check that would have caught `modelText`.
			if (schema.additionalProperties === false && declared[key] === undefined) {
				out.push(`${at}.${key}: not declared in the output schema`);
			}
		}
		for (const [key, spec] of Object.entries(declared)) {
			const present = Object.hasOwn(value as Record<string, unknown>, key);
			if (!present) {
				if (spec.required === true) out.push(`${at}.${key}: required but missing`);
				continue;
			}
			out.push(
				...schemaViolations(spec, (value as Record<string, unknown>)[key], `${at}.${key}`),
			);
		}
		return out;
	}
	if (type === "integer") {
		if (typeof value !== "number" || !Number.isInteger(value)) out.push(`${at}: expected an integer`);
		return out;
	}
	if (typeof value !== type) out.push(`${at}: expected ${type}, got ${typeof value}`);
	return out;
}

/**
 * The declared output schema of a tool, for {@link schemaViolations}.
 *
 * @param tool - a tool definition built by `defineTool`.
 * @returns its schema spec, typed for the checker above.
 */
export function outputSchemaOf(tool: unknown): ValueSpec {
	const schema = (tool as { output?: { schema?: unknown } }).output?.schema;
	if (schema === undefined) throw new Error("the tool declares no output schema");
	return schema as ValueSpec;
}
