/**
 * Anchor-column selection semantics (#131 field feedback).
 *
 * The per-row card layout put the anchor cell and the code cell in one DOM
 * subtree, so EVERY cross-row drag carried the anchors along — even when the
 * user started the drag in the code and only wanted the text. The wanted
 * semantics are drag-origin dependent:
 *
 * - drag starts in the CODE  → the selection covers text only (anchors are
 *   passed over, exactly like `user-select: none` content);
 * - drag starts in the ANCHOR column → anchors and text are selected
 *   together.
 *
 * CSS alone cannot switch on drag origin, so this installs ONE capturing
 * `mousedown` listener: at drag start it decides, per card, whether the
 * anchor cells participate in this drag (toggling a class that turns their
 * `user-select` off for the non-anchor case). The class persists until the
 * next mousedown inside a card — removing it mid-selection would re-expand
 * the live selection.
 *
 * @module dsh-hashline-edittool-client/anchor-select
 */

const CARD_SELECTOR = ".dshl-read, .dshl-grep-block, .dshl-diff-block, .dshl-lsp-block";

/** A card's anchor cells: drag starting here selects anchors together with text. */
const ANCHOR_CELL_SELECTOR = [
	".dshl-read-gutter",
	".dshl-grep-gutter",
	".dshl-diff-gutter-line",
	".dshl-lsp-gutter",
].join(", ");

/** Marks the card whose CURRENT drag excludes the anchor column. */
const SUPPRESS_CLASS = "dshl-suppress-anchor-select";

let installed = false;

/**
 * Install the drag-origin classifier once per page (idempotent). Cards must
 * also carry the matching CSS: `.SUPPRESS_CLASS .<anchor-cell> { user-select: none }`.
 */
export function installAnchorColumnSelection(): void {
	if (installed || typeof document === "undefined") return;
	installed = true;
	// Capturing so the decision is made before the browser starts the selection.
	document.addEventListener(
		"mousedown",
		(event) => {
			const target = event.target;
			if (!(target instanceof Element)) return;
			const card = target.closest(CARD_SELECTOR);
			if (card === null) return;
			const dragStartsInAnchor = target.closest(ANCHOR_CELL_SELECTOR) !== null;
			card.classList.toggle(SUPPRESS_CLASS, !dragStartsInAnchor);
		},
		true,
	);
}
