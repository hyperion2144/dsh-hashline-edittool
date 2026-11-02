/**
 * The wire texts the host sends (#375): the row title and the lossy note.
 *
 * The host cannot read the reader's language (#369), so it names the wording
 * and hands over the facts; the client resolves the key through its own `t()`.
 * These tests pin the CLIENT half of that contract: the shapes it accepts, the
 * words it renders, and the legacy shape it still has to survive.
 *
 * @module dsh-hashline-edittool-client/test/wire-text
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EN_CARD_DICTIONARY, WIRE_TEXT_KEYS, ZH_CARD_DICTIONARY } from "../src/client/locale.js";
import type { CardLocaleKey } from "../src/client/locale.js";
import { readCardLabels } from "../src/client/labels.js";
import { readPresentationMeta, rowTitleFromMeta } from "../src/client/models.js";
import { resolveHostText } from "../src/client/wire-text.js";
import type { WireText } from "../src/client/types.js";

/** A translator over one language's dictionary — the shape the host's `t` has. */
function translator(dictionary: Record<string, string>) {
	return (key: CardLocaleKey, params?: Record<string, unknown>): string => {
		const template = dictionary[key] ?? key;
		return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(params?.[name] ?? ""));
	};
}

describe("the row title the host sent", () => {
	it("is read out of the meta and rendered in the reader's language", () => {
		const wire = rowTitleFromMeta({
			rowTitle: { key: "row.title.read.window", params: { path: "a.ts", start: 12, end: 61, total: 240 } },
		});
		expect(wire).toEqual({
			key: "row.title.read.window",
			params: { path: "a.ts", start: 12, end: 61, total: 240 },
		});
		expect(translator(EN_CARD_DICTIONARY)(wire!.key, wire!.params)).toBe("L12–61 · 240 lines total");
		expect(translator(ZH_CARD_DICTIONARY)(wire!.key, wire!.params)).toBe("L12–61 · 共 240 行");
	});

	it("carries the read's three wordings (#374)", () => {
		// The window the call served, the one the budget CUT, and the whole file's
		// length — three keys, three sentences, and the client resolves each one in
		// the reader's language.
		const cut = rowTitleFromMeta({
			rowTitle: { key: "row.title.read.window.truncated", params: { start: 240, end: 319, total: 374 } },
		});
		expect(translator(ZH_CARD_DICTIONARY)(cut!.key, cut!.params)).toBe(
			"L240–319 · 共 374 行 · 已按预算截断，resume 可续读",
		);
		expect(translator(EN_CARD_DICTIONARY)(cut!.key, cut!.params)).toBe(
			"L240–319 · 374 lines total — truncated by the budget; resume to continue",
		);
		const whole = rowTitleFromMeta({ rowTitle: { key: "row.title.read.total", params: { total: 374 } } });
		expect(translator(EN_CARD_DICTIONARY)(whole!.key, whole!.params)).toBe("374 lines total");
		expect(translator(ZH_CARD_DICTIONARY)(whole!.key, whole!.params)).toBe("共 374 行");
	});
	it("is absent for a meta that carries none — the row keeps its own label", () => {
		expect(rowTitleFromMeta(undefined)).toBeUndefined();
		expect(rowTitleFromMeta({})).toBeUndefined();
		expect(rowTitleFromMeta({ rowTitle: { key: "row.title.read" } })).toEqual({
			key: "row.title.read",
			params: undefined,
		});
	});

	it("refuses a key this vocabulary does not carry — a key literal is never shown", () => {
		// The shipped `conversation` seat had exactly this hole: four keys it did
		// not have rendered on screen as their own names (#369).
		expect(rowTitleFromMeta({ rowTitle: { key: "row.title.nope" } })).toBeUndefined();
		expect(rowTitleFromMeta({ rowTitle: { key: 42 } })).toBeUndefined();
		expect(rowTitleFromMeta({ rowTitle: { key: "row.title.read", params: { start: {} } } })).toBeUndefined();
	});
});

describe("the lossy note", () => {
	it("renders a key + params through the vocabulary", () => {
		const labels = readCardLabels(translator(EN_CARD_DICTIONARY));
		expect(labels.lossyNote({ key: "read.lossy" })).toContain("Undecodable bytes");
		const zh = readCardLabels(translator(ZH_CARD_DICTIONARY));
		expect(zh.lossyNote({ key: "read.lossy" })).toContain("无法解码的字节");
	});

	it("renders a LEGACY sentence verbatim — the shape old logs carry", () => {
		const labels = readCardLabels(translator(EN_CARD_DICTIONARY));
		expect(labels.lossyNote("[Undecodable bytes shown as U+FFFD; …]")).toBe(
			"[Undecodable bytes shown as U+FFFD; …]",
		);
	});

	it("accepts both shapes in the persisted meta", () => {
		const base = { path: "a.ts", offset: 1, totalLines: 1, lines: [], lossy: true };
		expect(readPresentationMeta({ ...base, lossyNote: { key: "read.lossy" } })?.lossyNote).toEqual({
			key: "read.lossy",
		});
		expect(readPresentationMeta({ ...base, lossyNote: "[legacy]" })?.lossyNote).toBe("[legacy]");
		// A malformed note is a malformed meta: the card does not draw half a fact.
		expect(readPresentationMeta({ ...base, lossyNote: 42 })).toBeNull();
	});
});

/**
 * The grep row's COUNTS (#386): how many hits the call found, how many it
 * served, and which cut took the rest away.
 *
 * The counts travel as FACTS (ADR-0026): the key names the wording, the
 * params fill it. The cut is its own key — a template cannot say "and it
 * was cut" without a conditional.
 */
describe("the grep row's counts (#386)", () => {
	it("renders the counts and the cut in the reader's language", () => {
		const en = translator(EN_CARD_DICTIONARY);
		const zh = translator(ZH_CARD_DICTIONARY);
		const wire = rowTitleFromMeta({
			rowTitle: { key: "row.title.grep.stats.limit", params: { hits: 300, served: 100 } },
		});
		expect(wire).toEqual({
			key: "row.title.grep.stats.limit",
			params: { hits: 300, served: 100 },
		});
		expect(en(wire!.key, wire!.params)).toBe(
			"300 matches · 100 served — truncated by the per-file limit",
		);
		expect(zh(wire!.key, wire!.params)).toBe("300 处匹配 · 已返回 100 处 · 已按每文件上限截断");
	});

	it("renders a lower bound as it is — the count is not exact", () => {
		const en = translator(EN_CARD_DICTIONARY);
		const zh = translator(ZH_CARD_DICTIONARY);
		const wire = rowTitleFromMeta({
			rowTitle: { key: "row.title.grep.stats", params: { hits: "≥100", served: 100 } },
		});
		expect(en(wire!.key, wire!.params)).toBe("≥100 matches · 100 served");
		expect(zh(wire!.key, wire!.params)).toBe("≥100 处匹配 · 已返回 100 处");
	});

	it("the host's grep keys and the client's accepted keys are ONE list", () => {
		// The host NAMES the keys, the client ACCEPTS them. A key the host
		// sends and the client does not carry would be REFUSED — the row would
		// show nothing at all.
		const named = [...HOST_WIRE_TEXT.matchAll(/"(row\.title\.grep[.A-Za-z0-9_]*)"/g)].map(
			(match) => match[1]!,
		);
		expect(named.length).toBeGreaterThanOrEqual(4);
		for (const key of named) {
			expect(Object.hasOwn(WIRE_TEXT_KEYS, key)).toBe(true);
			expect(Object.hasOwn(EN_CARD_DICTIONARY, key)).toBe(true);
			expect(Object.hasOwn(ZH_CARD_DICTIONARY, key)).toBe(true);
		}
	});
});

describe("the settings card's labels", () => {
	it("every key the card asks for exists in BOTH dictionaries", () => {
		// The card's labels used to be Chinese words in the component; they are
		// vocabulary keys now, so a typo'd key would render as its own NAME on
		// screen (#369). The sweep is what keeps that from coming back.
		const source = readFileSync(
			join(dirname(fileURLToPath(import.meta.url)), "..", "src", "client", "settings-card.tsx"),
			"utf-8",
		);
		const keys = [...source.matchAll(/t\("(settings\.[a-zA-Z.]+)"/g)].map((match) => match[1]!);
		expect(keys.length).toBeGreaterThan(20);
		for (const key of keys) {
			expect(Object.hasOwn(EN_CARD_DICTIONARY, key)).toBe(true);
			expect(Object.hasOwn(ZH_CARD_DICTIONARY, key)).toBe(true);
		}
	});
});

/** The host's own source: the half that NAMES the keys (ADR-0024). */
const HOST_WIRE_TEXT = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "render", "wire-text.ts"),
	"utf-8",
);

/** A wire text as it arrives — its shape is checked at RUNTIME, not by the type. */
function wire(value: unknown): string | WireText {
	return value as string | WireText;
}

/**
 * The language-server ROUTE's texts (#377).
 *
 * The host used to answer these routes in Chinese prose, so an English session
 * read Chinese. They are keys now, and these are the CLIENT half of that
 * contract: the reader's language, the legacy shape, and the refusal of a key
 * this vocabulary does not carry.
 */
describe("the language-server route's texts (#377)", () => {
	it("renders each key in the reader's language", () => {
		const en = translator(EN_CARD_DICTIONARY);
		const zh = translator(ZH_CARD_DICTIONARY);
		expect(resolveHostText(en, wire({ key: "lsp.status.noSubprocessSeam" }))).toBe(
			"This deployment has no subprocess seam, so npm cannot run.",
		);
		expect(resolveHostText(zh, wire({ key: "lsp.status.noSubprocessSeam" }))).toBe(
			"这个部署没有 subprocess seam，所以无法运行 npm。",
		);
		expect(resolveHostText(en, wire({ key: "lsp.status.noClient" }))).toContain("language-server client");
		expect(resolveHostText(zh, wire({ key: "lsp.status.noClient" }))).toContain("语言服务器客户端未启用");
		expect(resolveHostText(en, wire({ key: "lsp.row.canInstall" }))).toBe("One-click install available");
		expect(resolveHostText(zh, wire({ key: "lsp.row.canInstall" }))).toBe("可一键安装");
		expect(resolveHostText(en, wire({ key: "lsp.row.noBuiltinCommand" }))).toContain("built-in command");
		expect(resolveHostText(zh, wire({ key: "lsp.row.noBuiltinCommand" }))).toBe(
			"插件没有它的内置命令，可用下方「指定服务器」直接填",
		);
		expect(resolveHostText(en, wire({ key: "lsp.install.noCommand" }))).toContain("install command");
		expect(resolveHostText(zh, wire({ key: "lsp.install.noCommand" }))).toContain("没有可直接运行的安装命令");
		expect(resolveHostText(en, wire({ key: "lsp.install.npmOkButMissing" }))).toContain("npm reported success");
		expect(resolveHostText(zh, wire({ key: "lsp.install.npmOkButMissing" }))).toContain("npm 报成功");
		expect(resolveHostText(en, wire({ key: "lsp.install.doneBuiltinDir" }))).toContain("plugin's own directory");
		expect(resolveHostText(zh, wire({ key: "lsp.install.doneBuiltinDir" }))).toContain("已装进插件自己的目录");
		expect(resolveHostText(en, wire({ key: "lsp.install.doneOwnToolchain" }))).toContain("toolchain");
		expect(resolveHostText(zh, wire({ key: "lsp.install.doneOwnToolchain" }))).toContain("自己工具链的目录");
	});

	it("carries the FACTS as params — verbatim in every language", () => {
		const en = translator(EN_CARD_DICTIONARY);
		const zh = translator(ZH_CARD_DICTIONARY);
		// A command name, a display name, a platform, an exit code, a stderr tail:
		// these read the same in every language, so they are NOT translated.
		expect(resolveHostText(en, wire({ key: "lsp.row.selfInstall", params: { command: "clangd" } }))).toContain(
			"clangd",
		);
		expect(resolveHostText(zh, wire({ key: "lsp.row.selfInstall", params: { command: "clangd" } }))).toBe(
			"需自行安装 clangd（本机无内置安装命令）",
		);
		expect(
			resolveHostText(en, wire({ key: "lsp.install.noCommandForPlatform", params: { displayName: "Eclipse JDT Language Server", platform: "linux" } })),
		).toContain("linux");
		expect(
			resolveHostText(zh, wire({ key: "lsp.install.noCommandForPlatform", params: { displayName: "Eclipse JDT Language Server", platform: "linux" } })),
		).toBe(
			"Eclipse JDT Language Server 在这个系统（linux）上没有内置安装命令。装上后这个列表会自动找到它；也可以在下方的「指定服务器」里直接写命令。",
		);
		expect(resolveHostText(en, wire({ key: "lsp.install.exitCode", params: { code: 1, tail: "npm ERR!" } }))).toBe(
			"The install command exited with 1: npm ERR!",
		);
		expect(resolveHostText(zh, wire({ key: "lsp.install.exitCode", params: { code: 1, tail: "npm ERR!" } }))).toBe(
			"安装命令以 1 退出：npm ERR!",
		);
	});

	it("renders a LEGACY sentence verbatim — the shape an old host sent", () => {
		const en = translator(EN_CARD_DICTIONARY);
		expect(resolveHostText(en, "语言服务器客户端未启用，所以语义操作没有可用的服务器。")).toBe(
			"语言服务器客户端未启用，所以语义操作没有可用的服务器。",
		);
		expect(resolveHostText(en, undefined)).toBeUndefined();
	});

	it("refuses a key this vocabulary does not carry — a key literal is never shown", () => {
		const en = translator(EN_CARD_DICTIONARY);
		// The exact failure the shipped `conversation` seat had (#369).
		expect(resolveHostText(en, wire({ key: "lsp.row.nope" }))).toBeUndefined();
		// A vocabulary key the WIRE never carries is not a wire text either.
		expect(resolveHostText(en, wire({ key: "settings.hint.lspUnavailable" }))).toBeUndefined();
		expect(resolveHostText(en, wire({ key: 42 }))).toBeUndefined();
		expect(resolveHostText(en, wire(42))).toBeUndefined();
		expect(resolveHostText(en, wire({ key: "lsp.row.canInstall", params: { count: {} } }))).toBeUndefined();
	});

	it("the host's keys and the client's accepted keys are ONE list", () => {
		// The two halves live in one repo but in two workspaces: the host NAMES
		// the keys, the client ACCEPTS them. A key the host sends and the client
		// does not carry would be REFUSED — the card would show nothing at all.
		const named = [...HOST_WIRE_TEXT.matchAll(/"(lsp\.[A-Za-z0-9.]+)"/g)].map((match) => match[1]!);
		expect(named.length).toBeGreaterThanOrEqual(11);
		for (const key of named) {
			expect(Object.hasOwn(WIRE_TEXT_KEYS, key)).toBe(true);
			expect(Object.hasOwn(EN_CARD_DICTIONARY, key)).toBe(true);
			expect(Object.hasOwn(ZH_CARD_DICTIONARY, key)).toBe(true);
		}
		// And the other way round: the client accepts nothing the host never names.
		const accepted = Object.keys(WIRE_TEXT_KEYS).filter((key) => key.startsWith("lsp."));
		expect(accepted.length).toBeGreaterThanOrEqual(11);
		for (const key of accepted) {
			expect(HOST_WIRE_TEXT).toContain(`"${key}"`);
		}
	});
});
