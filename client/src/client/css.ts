/**
 * Vendored row chrome for the hashline tool views.
 *
 * The declarations are the shipped `ToolRow.module.css` (dsh 0.1.2) verbatim,
 * with the build-hashed `o3BgMG_` class prefix renamed to a static `dshl-`
 * namespace — unique across plugins, so no build-time CSS-modules hashing is
 * needed. The style tag follows the shipped injection contract
 * (`data-plugin-css` id guard) so re-executing the factory never duplicates
 * the sheet, and the tag disappears only with the page (registration is
 * fiber-scoped; plugin unload removes the component, the sheet simply stops
 * being referenced).
 */

const CSS_TEXT = [
	".dshl-root{flex-direction:column;display:flex}",
	".dshl-row{position:relative;overflow:hidden}",
	'.dshl-root[data-state=running] .dshl-row:after{content:"";background:linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent) 55%, transparent 100%);pointer-events:none;width:300px;animation:2.6s ease-out infinite dshl-tool-row-sweep;position:absolute;top:0;bottom:0;left:0}',
	"@keyframes dshl-tool-row-sweep{0%{left:-300px}90%,to{left:100%}}",
	".dshl-leading{flex-shrink:0}",
	'.dshl-root[data-tool^=cordis_] .dshl-leading,.dshl-root[data-tool^=cordis_] .dshl-title{color:var(--dsw-alias-state-business-primary)}',
	".dshl-root[data-tool^=cordis_] .dshl-title{font-weight:500}",
	".dshl-root[data-tool^=cordis_] .dshl-sep{background:var(--dsw-alias-state-business-primary)}",
	".dshl-chevron{color:var(--dsw-alias-label-secondary)}",
	".dshl-title{font-weight:400}",
	".dshl-sep{background:var(--dsw-alias-label-caption);border-radius:1px;flex:none;width:2px;height:2px;margin:0 8px}",
	".dshl-summary{text-overflow:ellipsis;white-space:nowrap;min-width:0;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);flex:auto;overflow:hidden}",
	".dshl-summarySuffix{white-space:nowrap;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-tertiary);flex:none;margin-left:4px}",
	'.dshl-anchorHints{font-family:var(--ds-font-family-code);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 2px);color:var(--dsw-alias-label-caption);margin-left:10px;transform:translateY(.5px)}',
	".dshl-diffStat{font-family:var(--ds-font-family-code);font-size:calc(var(--dsh-content-font-size-secondary,13px) - 2px);color:var(--dsw-alias-label-caption);margin-left:10px;transform:translateY(.5px)}",
	".dshl-fileLink{text-overflow:ellipsis;white-space:nowrap;min-width:0;font:inherit;text-align:left;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(24px + var(--dsh-content-font-delta,0px));color:var(--dsw-alias-label-secondary);text-decoration:underline dotted;text-decoration-color:var(--dsw-alias-label-tertiary);text-underline-offset:3px;cursor:pointer;background:0 0;border:none;flex:0 auto;margin:0;padding:0;text-decoration-thickness:1px;overflow:hidden}",
	".dshl-fileLink:hover{color:var(--dsw-alias-label-primary);text-decoration-color:currentColor}",
	".dshl-errorSummary{color:var(--dsw-alias-state-error-primary)}",
	".dshl-bodyWrap{flex-direction:column;display:flex}",
	".dshl-inspectButton{border:.5px solid var(--dsw-alias-border-l3);corner-shape:round;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);cursor:pointer;opacity:0;border-radius:999px;align-self:flex-start;align-items:center;gap:4px;margin:4px 0 2px 4px;padding:2px 8px;font-size:11px;line-height:16px;transition:opacity .1s;display:inline-flex}",
	".dshl-root:hover .dshl-inspectButton,.dshl-inspectButton:focus-visible{opacity:1}",
	".dshl-inspectButton:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}",
	".dshl-ioCard{border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-markdown-code-block);font:var(--dsw-font-markdown-code-block-small);border-radius:12px;flex-direction:column;margin:4px 0 4px 4px;display:flex}",
	".dshl-ioSection{grid-template-columns:max-content 1fr;align-items:baseline;column-gap:14px;max-height:150px;padding:12px 16px;display:grid;overflow-y:auto}",
	".dshl-ioSection::-webkit-scrollbar-thumb{background-clip:padding-box;border:2px solid #0000;border-radius:6px}",
	".dshl-ioSection::-webkit-scrollbar-track{margin:6px 0}",
	".dshl-ioLabel{color:var(--dsw-alias-label-caption);align-self:start;position:sticky;top:0}",
	".dshl-ioDivider{background:var(--dsw-alias-border-l2);flex:none;height:.5px}",
	".dshl-ioText{white-space:pre-wrap;word-break:break-word;min-width:0;color:var(--dsw-alias-label-secondary)}",
	".dshl-ioText[data-error]{color:var(--dsw-alias-state-error-primary)}",
	".dshl-diffBody,.dshl-readBody{margin:4px 0 4px 4px}",
	".dshl-visuallyHidden{clip:rect(0 0 0 0);white-space:nowrap;width:1px;height:1px;position:absolute;overflow:hidden}",
].join("");

/** Style-tag id guard (one sheet per page regardless of factory executions). */
export const CSS_TAG_ID = "dsh-hashline-edittool-client/tool-row.css";

/** Install the sheet once, following the shipped tagged style-tag contract. */
export function ensureToolRowStyles(): void {
	if (typeof document === "undefined") return;
	if (document.querySelector(`style[data-plugin-css="${CSS_TAG_ID}"]`) !== null) return;
	const tag = document.createElement("style");
	tag.dataset.plugin = "dsh-hashline-edittool-client";
	tag.dataset.pluginCss = CSS_TAG_ID;
	tag.textContent = CSS_TEXT;
	document.head.appendChild(tag);
}

/** Class map for the vendored sheet (module-css shape, static names). */
export const css = {
	root: "dshl-root",
	row: "dshl-row",
	leading: "dshl-leading",
	title: "dshl-title",
	chevron: "dshl-chevron",
	sep: "dshl-sep",
	summary: "dshl-summary",
	summarySuffix: "dshl-summarySuffix",
	anchorHints: "dshl-anchorHints",
	diffStat: "dshl-diffStat",
	fileLink: "dshl-fileLink",
	errorSummary: "dshl-errorSummary",
	bodyWrap: "dshl-bodyWrap",
	inspectButton: "dshl-inspectButton",
	ioCard: "dshl-ioCard",
	ioSection: "dshl-ioSection",
	ioLabel: "dshl-ioLabel",
	ioDivider: "dshl-ioDivider",
	ioText: "dshl-ioText",
	readBody: "dshl-readBody",
	diffBody: "dshl-diffBody",
	visuallyHidden: "dshl-visuallyHidden",
} as const;
