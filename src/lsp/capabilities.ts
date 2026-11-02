/**
 * What a server SAID it can do, read before anything is asked of it.
 *
 * A language server answers a method it never advertised with an error — or,
 * worse, with an empty list that reads exactly like "nothing there". The two
 * are different facts, so the vocabulary and the capability reads live here,
 * in one place both the provider (which serves the official seam) and the
 * tool (which asks directly) import: one shape, one negotiation.
 *
 * Everything here is a pure read of the `initialize` result. No I/O, no
 * session state.
 *
 * @module dsh-hashline-edittool/lsp/capabilities
 */

/** The four navigation queries a server can answer at a cursor. */
export type LspOperation = "goToDefinition" | "findReferences" | "goToImplementation" | "hover";

/** The operations, as a runtime tuple for schema enums and validation. */
export const LSP_OPERATIONS: readonly LspOperation[] = [
	"goToDefinition",
	"findReferences",
	"goToImplementation",
	"hover",
];

/** The LSP method each operation maps to. */
export const LSP_METHOD_FOR: Readonly<Record<LspOperation, string>> = {
	goToDefinition: "textDocument/definition",
	findReferences: "textDocument/references",
	goToImplementation: "textDocument/implementation",
	hover: "textDocument/hover",
};

/** Whether a string names one of the navigation operations. */
export function isLspOperation(value: string): value is LspOperation {
	return (LSP_OPERATIONS as readonly string[]).includes(value);
}

/** A `ServerCapabilities` value: absent, a boolean, or an options object. */
type ProviderCapability = boolean | Record<string, unknown> | undefined;

/** The capability field backing each operation. */
function capabilityFor(
	capabilities: Record<string, unknown>,
	operation: LspOperation,
): ProviderCapability {
	const raw = capabilities[
		operation === "goToDefinition"
			? "definitionProvider"
			: operation === "findReferences"
				? "referencesProvider"
				: operation === "goToImplementation"
					? "implementationProvider"
					: "hoverProvider"
	];
	if (raw === undefined) return undefined;
	if (typeof raw === "boolean") return raw;
	if (raw === null) return undefined;
	return typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
}

/**
 * Whether the server advertises an operation.
 *
 * `true` and an options object both mean yes; `false` and absent both mean no.
 * Absent is treated as NO on purpose: sending a method a server never
 * advertised is how a navigation answer turns into a protocol error the model
 * cannot act on.
 *
 * @param capabilities - the `initialize` result's `capabilities`.
 * @param operation - which operation to look up.
 * @returns true when the corresponding provider capability is present.
 */
export function supportsOperation(
	capabilities: Record<string, unknown>,
	operation: LspOperation,
): boolean {
	const value = capabilityFor(capabilities, operation);
	if (value === undefined) return false;
	if (typeof value === "boolean") return value;
	return true;
}

/**
 * Whether the server EXPLICITLY refuses transient `didOpen`/`didClose`.
 *
 * Deliberately weaker than the protocol's own default: only a server that says
 * `textDocumentSync: 0` (None) or `{ openClose: false }` is refused. An absent
 * `textDocumentSync` is treated as unknown rather than as "no", because many
 * working servers omit it and this plugin has always opened documents for
 * them — being strict here would break symbols and diagnostics on servers
 * that never complained.
 *
 * @param capabilities - the `initialize` result's `capabilities`.
 * @returns true only when open/close is explicitly unsupported.
 */
export function transientSyncUnsupported(capabilities: Record<string, unknown>): boolean {
	const sync = capabilities.textDocumentSync;
	if (sync === 0) return true;
	if (typeof sync !== "object" || sync === null) return false;
	return (sync as { openClose?: unknown }).openClose === false;
}

/**
 * The position encoding this host can speak, or a refusal.
 *
 * The protocol defaults to UTF-16, and this host measures columns in UTF-16
 * code units — so any other encoding makes every column it sends or renders
 * wrong by a varying amount. There is no silent fallback: a server that
 * negotiated something else is reported instead of being asked with offsets
 * that point at the wrong character.
 *
 * @param capabilities - the `initialize` result's `capabilities`.
 * @returns `"utf-16"` when the server agrees (or says nothing).
 * @throws {Error} for any other advertised encoding.
 */
export function negotiatedPositionEncoding(capabilities: Record<string, unknown>): "utf-16" {
	const encoding = capabilities.positionEncoding;
	if (encoding === undefined || encoding === "utf-16") return "utf-16";
	throw new Error(
		`[E_LSP_BAD_ENCODING] the server negotiated \`${String(encoding)}\` position encoding; this plugin speaks utf-16 only, so every column would land on the wrong character.`,
	);
}
