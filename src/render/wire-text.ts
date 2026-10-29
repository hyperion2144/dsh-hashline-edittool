/**
 * The host's texts on the wire: FACTS, never prose (issue 375).
 *
 * WHY THIS SHAPE: the host cannot read the active UI language. `locale` is a
 * CLIENT service — the host only ever stores the user's preference, and the
 * browser's provisional locale is invisible to it (#369). So a host that
 * assembles a sentence for a card has already picked a language the reader
 * did not ask for, and no cleverness on the host side can fix that: the host
 * does not know the answer.
 *
 * The way out is to stop sending prose. The wire carries a STABLE KEY plus the
 * params that fill its template, and the client resolves both through its own
 * `t()` seat — in the language the reader actually chose. The templates live in
 * the client's vocabulary (`hashline.card`); this module owns the FACTS and the
 * key that names the wording, never the wording itself.
 *
 * WHAT IS NOT ON THIS WIRE: the model channel. A tool's model-facing text (the
 * window sentence, the anchor protocol, the error codes, the error card's
 * message/context/hint) stays English by contract — the MODEL reads it, and the
 * model speaks English. ADR-0024 records the whole contract.
 *
 * @module dsh-hashline-edittool/wire-text
 */

/**
 * One text the client resolves: a stable key plus the params that fill it.
 *
 * `params` is optional because not every wording needs a value — the lossy
 * note is one sentence with nothing to fill in.
 */
export interface LocalizedText {
	/** The vocabulary key the client resolves (`hashline.card`). */
	readonly key: string;
	/** The values that fill the key's template. */
	readonly params?: Readonly<Record<string, string | number>>;
}

/**
 * The lossy read's footnote, as the wire carries it (issue 375).
 *
 * The MODEL-facing wording stays where it was — `LOSSY_BYTES_NOTE`, English,
 * appended to the read text the model reads. This is the card's copy of the
 * same fact: resolved in the reader's language.
 */
export const LOSSY_NOTE_TEXT: LocalizedText = { key: "read.lossy" };

/** The tools whose folded row carries a title of its own. */
export type RowTitleKind = "read" | "edit" | "write" | "grep";

/** What the host knows about the row it is titling. */
export interface RowTitleFacts {
	/** The path the call touched — the row's summary, not its title. */
	readonly path?: string;
	/** The served window's first line (a read that served a window). */
	readonly start?: number;
	/** The served window's last line. */
	readonly end?: number;
	/** The file's length in lines (a read). */
	readonly total?: number;
	/**
	 * The response budget CUT the window, so the rest of the file is reachable
	 * through a resume token (issue 374).
	 */
	readonly truncated?: boolean;
}

/**
 * Build the folded row's title as a key + params.
 *
 * ONE function for every tool, so the shape cannot drift per tool: the key
 * names the wording, the params carry the facts that fill it. The path rides
 * along as the host's authoritative path for the call, but it is NOT part of
 * the title template — a path reads the same in every language, and the row
 * already shows it as its summary (where it stays clickable).
 *
 * A READ is the one case with THREE wordings, and the KEY says which one:
 * `row.title.read.window` for a window it served (`L12–61 · 共 240 行`),
 * `row.title.read.window.truncated` for a window the response budget CUT (the
 * resume hint rides with the range), and `row.title.read.total` for the whole
 * file (`共 240 行` — the length is the only thing worth saying). A template
 * that could swallow every case would need a conditional, and a template with
 * an empty hole renders a stray space in the one case that has none.
 *
 * @param kind - which tool the row belongs to.
 * @param facts - what the host knows about the call.
 * @returns the wire text: a stable key plus its params.
 */
export function rowTitle(kind: RowTitleKind, facts: RowTitleFacts): LocalizedText {
	const params: Record<string, string | number> = {};
	if (facts.path !== undefined) params.path = facts.path;
	// A window is a READ concept: only a read serves a line range.
	if (kind !== "read") return { key: `row.title.${kind}`, params };
	const { start, end, total } = facts;
	// A window needs BOTH ends and the file's length: half a range is not a
	// range, and a range without the length cannot fill the template.
	if (typeof start === "number" && typeof end === "number" && typeof total === "number") {
		const windowParams = { ...params, start, end, total };
		// The cut is its OWN key: the resume hint is a fact, not a decoration, and
		// a template cannot say "and resume" without a conditional.
		if (facts.truncated === true) {
			return { key: "row.title.read.window.truncated", params: windowParams };
		}
		// The whole file is not a window — it says how long the file is.
		if (start > 1 || end < total) return { key: "row.title.read.window", params: windowParams };
		return { key: "row.title.read.total", params: { ...params, total } };
	}
	// A call that named no window read the whole file.
	if (typeof total === "number") return { key: "row.title.read.total", params: { ...params, total } };
	return { key: "row.title.read", params };
}

/**
 * The language-server texts the host sends (ADR-0024, issue 377).
 *
 * THE LSP ROUTES TALK ABOUT A MACHINE: why an install was refused, what a
 * missing server means, what an install actually did. Those sentences are read
 * in the settings card, so they obey the same rule as every other host text — a
 * stable KEY plus the facts that fill it — and the client resolves them in the
 * reader's language. Before this they were Chinese prose on the wire, so an
 * English session read Chinese.
 *
 * THE FACTS STAY FACTS. A command name, a display name, a platform, an exit
 * code, a stderr tail: those read the same in every language, so they ride as
 * params and are never translated.
 *
 * Every key the LSP routes put on the wire is named HERE, so the two route
 * modules and the manager cannot drift apart in their wording.
 */
export const LSP_NO_SUBPROCESS_SEAM: LocalizedText = { key: "lsp.status.noSubprocessSeam" };
export const LSP_NO_CLIENT: LocalizedText = { key: "lsp.status.noClient" };
export const LSP_CAN_INSTALL: LocalizedText = { key: "lsp.row.canInstall" };
export const LSP_SERVER_NOT_STARTED: LocalizedText = { key: "lsp.status.serverNotStarted" };
export const LSP_SERVER_STARTING: LocalizedText = { key: "lsp.status.serverStarting" };
export const LSP_NO_BUILTIN_COMMAND: LocalizedText = { key: "lsp.row.noBuiltinCommand" };

/**
 * The row's own hint: this one has to be installed by hand, and the command
 * to install is the fact that fills the sentence.
 *
 * @param command - the executable the reader has to install themselves.
 * @returns the wire text: a stable key plus its params.
 */
export function lspSelfInstall(command: string): LocalizedText {
	return { key: "lsp.row.selfInstall", params: { command } };
}

/**
 * The refusal for a server that arrives through a system package manager or a
 * release zip: there is no command to run, and the sentence names the server.
 *
 * @param displayName - the server's display name.
 * @returns the wire text: a stable key plus its params.
 */
export function lspInstallNoCommand(displayName: string): LocalizedText {
	return { key: "lsp.install.noCommand", params: { displayName } };
}

/**
 * The refusal for a server this platform cannot install: the same shape as the
 * no-command refusal, plus the platform that decided it.
 *
 * @param displayName - the server's display name.
 * @param platform - the platform the catalog has no command for.
 * @returns the wire text: a stable key plus its params.
 */
export function lspInstallNoCommandForPlatform(displayName: string, platform: string): LocalizedText {
	return { key: "lsp.install.noCommandForPlatform", params: { displayName, platform } };
}

/**
 * The failed install: the command's exit status, and the tail of what it said.
 *
 * @param code - the exit code, or `"unknown"` when the command was killed.
 * @param tail - the last of the command's output, verbatim.
 * @returns the wire text: a stable key plus its params.
 */
export function lspInstallExitCode(code: string | number, tail: string): LocalizedText {
	return { key: "lsp.install.exitCode", params: { code, tail } };
}

/**
 * npm reported success but the launcher is not where npm puts it — the package's
 * executable simply has another name.
 *
 * @param command - the command the catalog expects to find.
 * @returns the wire text: a stable key plus its params.
 */
export function lspInstallNpmOkButMissing(command: string): LocalizedText {
	return { key: "lsp.install.npmOkButMissing", params: { command } };
}

/**
 * The successful install that landed in the plugin's own directory.
 *
 * @param displayName - the server's display name.
 * @returns the wire text: a stable key plus its params.
 */
export function lspInstallDoneBuiltinDir(displayName: string): LocalizedText {
	return { key: "lsp.install.doneBuiltinDir", params: { displayName } };
}

/**
 * The successful install that landed in its own toolchain's directory.
 *
 * @param displayName - the server's display name.
 * @returns the wire text: a stable key plus its params.
 */
export function lspInstallDoneOwnToolchain(displayName: string): LocalizedText {
	return { key: "lsp.install.doneOwnToolchain", params: { displayName } };
}
