/**
 * Probe verdict — the domain's ONE interpretation of a path probe: the shape
 * found mapped to its error code and message skeleton, with the tool's verb
 * injected. Every prober (delete, rename, patch preflight, both fs backends)
 * obtains probes; only this module EXPLAINS them.
 *
 * Before this module the same table — symlink→`E_SYMLINK`, non-file→
 * `E_NOT_FILE`, absent→`E_NOT_FOUND`, occupied destination→`E_EXISTS` — was
 * hand-copied six times, and the copies' wording drifted per site. A change
 * to one rule had to touch six places, two of them in infra with no
 * compile-time link to the rest. The skeleton now lives once; a site declares
 * what it NEEDS the path to be and which verb it speaks.
 *
 * Pure: no imports, no IO. `FileProbe` satisfies the structural
 * {@link ProbeShape} the verdict reads.
 *
 * @module dsh-hashline-edittool/infra/probe-verdict
 */

/** The probe facts the verdict reads — structurally `FileProbe`. */
export interface ProbeShape {
	readonly kind: "file" | "symlink" | "directory" | "absent" | "other";
}

/** What the caller needs the path to BE. */
export type ProbeExpectation =
	/** A regular file (delete/rename target, patch update section). */
	| "file"
	/** Nothing — a patch's `new` section: anything present is `E_EXISTS`. */
	| "absent"
	/** An unoccupied destination (`rename`'s `to`): anything present is `E_EXISTS`. */
	| "unoccupied"
	/** A directory (a patch `new` section's parent). */
	| "directory";

/** The refusal a probe produces: the domain code and its message. */
export interface ProbeVerdict {
	code: string;
	message: string;
}

/** `delete` → `deletable`, `rename` → `renamable`, anything else → `editable`. */
function verbable(verb: string): string {
	if (verb === "delete") return "deletable";
	if (verb === "rename") return "renamable";
	return "editable";
}

/** `delete` → `Delete`, `rename` → `Rename`, anything else → `Edit`. */
function capped(verb: string): string {
	return verb.charAt(0).toUpperCase() + verb.slice(1);
}

/**
 * Interpret one probe against one expectation. `undefined` means the
 * expectation is SATISFIED — the caller proceeds; a verdict is the refusal,
 * already carrying its `[E_*]` code (brackets excluded) and the unified
 * message skeleton with this caller's verb in it.
 */
export function probeVerdict(opts: {
	probe: ProbeShape;
	expect: ProbeExpectation;
	/** The tool's verb ("delete", "rename", "edit"), spoken in the message. */
	verb: string;
	path: string;
}): ProbeVerdict | undefined {
	const { probe, expect, verb, path } = opts;
	if (expect === "absent" || expect === "unoccupied") {
		if (probe.kind === "absent") return undefined;
		const noun = expect === "unoccupied" ? "Destination" : "Path";
		return {
			code: "E_EXISTS",
			message: `${noun} already exists: ${path}. Remove it first or pick another name.`,
		};
	}
	if (expect === "directory") {
		if (probe.kind === "directory") return undefined;
		if (probe.kind === "absent") {
			return { code: "E_NOT_FOUND", message: `Parent directory does not exist: ${path}` };
		}
		return { code: "E_NOT_FILE", message: `Parent is not a directory: ${path}` };
	}
	// expect === "file"
	if (probe.kind === "file") return undefined;
	if (probe.kind === "absent") {
		return { code: "E_NOT_FOUND", message: `File not found: ${path}` };
	}
	if (probe.kind === "symlink") {
		return {
			code: "E_SYMLINK",
			message:
				`Refusing to ${verb} a symbolic link: ${path}. ${capped(verb)} handles regular files only; ` +
				`use bash to ${verb === "rename" ? "move" : "remove"} the link itself.`,
		};
	}
	return {
		code: "E_NOT_FILE",
		message:
			`Path is not a regular file: ${path}. Directories and special files are not ${verbable(verb)} here; ` +
			"use bash for directories.",
	};
}
