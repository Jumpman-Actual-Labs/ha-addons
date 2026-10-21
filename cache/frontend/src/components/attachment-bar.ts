import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { InstalledItemSummary } from "../types";
import { PART_TAXONOMY } from "../types";

function truncate(text: string, len: number): string {
  return text.length > len ? `${text.slice(0, len - 1)}…` : text;
}

const SLOT_ICONS: Record<string, string> = {
  Optic: "mdi:crosshairs",
  "Optic Mount": "mdi:link-variant",
  "Muzzle Device": "mdi:circle-outline",
  Suppressor: "mdi:volume-off",
  Barrel: "mdi:pipe",
  Foregrip: "mdi:hand-front-right",
  Bipod: "mdi:triangle-outline",
  Light: "mdi:flashlight",
  Laser: "mdi:laser-pointer",
  Stock: "mdi:rectangle-outline",
  Brace: "mdi:link-box-variant-outline",
  Grip: "mdi:hand-back-right",
  Trigger: "mdi:gesture-tap-button",
  Safety: "mdi:lock-outline",
  Bolt: "mdi:screw-lag",
  "Charging Handle": "mdi:drag-horizontal-variant",
  Handguard: "mdi:hand-back-right-outline",
  "Other / Miscellaneous": "mdi:dots-horizontal-circle-outline",
};
const DEFAULT_SLOT_ICON = "mdi:puzzle-outline";

const CARD_W = 150;
const CARD_H = 190;
const REST_STEP = 6; // px offset per stacked layer at rest
const HOVER_GAP = 12; // px gap between fanned-out cards on hover
const MIN_CARD_W = 24; // never shrink a fanned card narrower than this
// A stack never shows more than this many card SLOTS - past that, the
// last slot becomes a "+N more" overflow card instead of shrinking
// every card in an unbounded stack down toward unreadability. Fixed at
// 4 so the hover fan-out below can always use a 2-column grid (2 rows
// max) rather than an ever-widening single row.
const MAX_STACK_CARDS = 4;
// Hover fan-out is always exactly 2 columns wide (1 row for n=2, 2 rows
// for n=3/4) instead of one wide row - a single row of 3-4 shrunk cards
// used to spill past the group's own 150px-wide column into whichever
// category sits next to it. 2 columns means the fan-out's WIDTH never
// exceeds a single card's own width no matter how many are stacked.
const FAN_COLS = 2;

interface StackEntry {
  part: string;
  item: InstalledItemSummary;
}

interface CardTransform {
  restX: number;
  restY: number;
  hoverX: number;
  hoverY: number;
  hoverScale: number;
  z: number;
}

/** Computes each stacked card's resting (piled, offset by REST_STEP per
 * layer) and hovered (fanned out into a `FAN_COLS`-wide grid, shrunk to
 * fit within the SAME 150px-wide footprint the group occupies at rest)
 * transform. Since `FAN_COLS` is fixed at 2 regardless of how many cards
 * are stacked (n is always 2-4 here - MAX_STACK_CARDS caps it), the
 * horizontal scale this produces is CONSTANT (0.46 - the original
 * hand-tuned n=2 value: `69 + 12(gap) + 69 = 150`) whether n is 2, 3, or
 * 4 - only the row count changes (1 row for n=2, 2 rows for n=3/4). That
 * constant scale is what keeps the fan-out's width pinned to the
 * group's own column no matter how many cards are in it, instead of
 * shrinking further (and reading worse) as more items share a slot.
 * `usable` is still clamped by MIN_CARD_W as a defensive floor, though
 * with FAN_COLS fixed at 2 it can't actually be reached at this n range.
 */
function stackTransforms(n: number): CardTransform[] {
  const cols = Math.min(n, FAN_COLS);
  const rows = Math.ceil(n / cols);
  let hGap = HOVER_GAP;
  let usableW = CARD_W - (cols - 1) * hGap;
  if (usableW < cols * MIN_CARD_W) {
    usableW = cols * MIN_CARD_W;
    hGap = cols > 1 ? Math.max(0, (CARD_W - usableW) / (cols - 1)) : 0;
  }
  const slotW = usableW / cols;
  const scale = slotW / CARD_W;
  const scaledH = CARD_H * scale;
  const vGap = HOVER_GAP;
  const totalFanH = rows * scaledH + (rows - 1) * vGap;
  const baseY = Math.max(0, (CARD_H - totalFanH) / 2);
  return Array.from({ length: n }, (_, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return {
      restX: i * REST_STEP,
      restY: i * REST_STEP,
      hoverX: col * (slotW + hGap),
      hoverY: baseY + row * (scaledH + vGap),
      hoverScale: scale,
      z: n - i,
    };
  });
}

/** A flat bar of attachment-category cards (styled after Call of Duty's
 * Gunsmith screen) - one group per PART_TAXONOMY Category (the same
 * universal 10 categories for every firearm now, no more per-firearm-type
 * slot list), each showing that category's installed item(s) or "Empty".
 * Used by the firearm detail page's "Installed Parts" section
 * (firearms-view.ts) - the only place it renders now; a separate
 * full-screen "My Build" overlay (my-build-view.ts) used to render the
 * same bar too, before it was removed in favor of this inline section
 * plus folding its hero/build-image upload into Edit Firearm. Clicking a
 * card doesn't open
 * anything itself - it emits `cache-slot-click` with `{ slotType }` (the
 * specific Part that card's item is installed under, e.g. "Optic Mount" -
 * a slot is always a Part, never just the Category) and leaves opening
 * slot-modal (or whatever else) to the caller, same event contract the
 * old cache-build-diagram used. Since slot-modal is scoped to the whole
 * Category regardless of which Part seeded it, which specific card in a
 * stack gets clicked barely matters beyond which Part starts focused.
 *
 * A Part isn't exclusive on the backend - any number of items can share
 * the same Part on the same firearm (e.g. two Optics) - and a Category
 * can hold up to two Parts (see `PART_TAXONOMY`), so the total number of
 * items attached under one Category can exceed 2. Every one of those
 * items gets its OWN card - none are collapsed behind a count badge.
 * `installedBySlot[part]` arrays for every Part in the category are
 * flattened into one ordered list of `{ part, item }` entries:
 * - 0 entries: a single empty placeholder card (`+`), keyed to the
 *   category's first Part for its click target.
 * - 1 entry: a single filled card, no stacking.
 * - 2+ entries: a `.stack` of that many cards, up to `MAX_STACK_CARDS`
 *   (4). At rest they're piled with each successive card offset by
 *   `REST_STEP` and stacked in z-order (first entry frontmost). Hovering
 *   the group fans every card out side by side, shrunk via
 *   `stackTransforms()` so the whole fanned row still fits within the
 *   resting card's own 150px footprint rather than spilling wider than
 *   the group itself. Past `MAX_STACK_CARDS` entries, only the first
 *   `MAX_STACK_CARDS - 1` get their own card - the last slot becomes an
 *   overflow card reading "+N more" (`_renderOverflowCard`) instead of a
 *   5th+ card, so an unusually full slot (e.g. five Optics) doesn't
 *   shrink every card in the stack toward unreadability trying to fit
 *   them all. The overflow card still opens the same `slot-modal` on
 *   click (seeded from its first hidden entry's Part) - everything past
 *   the visible cards is still just a row away, never truly hidden.
 *
 * Each card's category label lives OUTSIDE the card box, in its own
 * left-justified header row above it (not overlapping the border like an
 * earlier pass) - the reference screenshot's labels read as a caption
 * above a photo tile, not a badge on the tile itself. The card body is
 * square-cornered rather than rounded, and shows the installed item's own
 * photo (InstalledItemSummary.photoUrl) when it has one; falls back to a
 * SLOT_ICONS glyph for a filled slot with no photo, or a plain "+" for an
 * empty one. No corner-accent marks - an earlier pass drew real 4-corner
 * bracket elements here; removed on request for a plain transparent-glass
 * card with nothing drawn on top of its edges. */
@customElement("cache-attachment-bar")
export class CacheAttachmentBar extends LitElement {
  @property({ attribute: false }) installedBySlot: Record<string, InstalledItemSummary[]> = {};

  static styles = css`
    .attachment-bar {
      display: grid;
      /* Explicit 5 fixed-width columns (matching .attachment-card-wrap's
         own 150px) rather than repeat(auto-fill, 150px) - auto-fill would
         pack in as many columns as the container's width allows (my-build-
         view.ts's 1000px max-width fits 6), when 10 categories laid out
         5x2 is the deliberate default regardless of how wide the
         container happens to be. Only narrower viewports (not container
         width - there's no container query context set up here) step the
         column count down. */
      grid-template-columns: repeat(5, 150px);
      /* Wider than a plain visual gap would need on its own - this is
         also the buffer a stacked card's resting REST_STEP offset has
         to stay inside so a 3-4-card pile never bleeds into whichever
         category sits next to it (max rest offset is (MAX_STACK_CARDS-1)
         * REST_STEP = 18px, comfortably under this 20px). */
      gap: 20px;
      width: 100%;
    }
    @media (max-width: 860px) {
      .attachment-bar {
        grid-template-columns: repeat(3, 150px);
      }
    }
    @media (max-width: 560px) {
      .attachment-bar {
        grid-template-columns: repeat(2, 150px);
      }
    }
    @media (max-width: 360px) {
      .attachment-bar {
        grid-template-columns: 150px;
      }
    }
    .category-group {
      display: flex;
      flex-direction: column;
    }
    .attachment-card-wrap {
      display: flex;
      flex-direction: column;
      width: 150px;
    }
    .cat {
      display: flex;
      align-items: center;
      gap: 1px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #a0a0a6;
      margin-bottom: 4px;
      padding-left: 1px;
    }
    .cat ha-icon {
      --mdc-icon-size: 13px;
    }
    .stack {
      position: relative;
      width: 150px;
      height: 190px;
    }
    /* Without this, a hovered stack (which fans out but still stays
       within its own 150x190 box - see stackTransforms()) would paint
       BEHIND whichever category's cards come later in DOM order, since
       plain in-flow siblings paint by DOM order otherwise. Elevating it
       only on hover means it doesn't otherwise sit above dialogs/menus
       opened from elsewhere in the app. */
    .stack:hover {
      z-index: 5;
    }
    .stack .attachment-card-wrap {
      position: absolute;
      top: 0;
      left: 0;
      transform-origin: top left;
      transition: transform 0.2s ease;
      transform: translate(var(--rx), var(--ry));
      z-index: var(--z);
    }
    /* On hover every card in the stack shrinks and fans out so they're
       each fully visible side by side, rather than the front card merely
       sliding aside to peek at the ones behind it - this replaces (does
       not compose with) the resting transform above. Values come from
       stackTransforms(), computed per-card in JS since the fan-out
       geometry depends on how many cards are in the stack. */
    .stack:hover .attachment-card-wrap {
      transform: translate(var(--hx), var(--hy)) scale(var(--hscale));
    }
    /* Same restrained glass shadow recipe as glassCardStyle's ha-card
       (styles.ts) - inset top highlight + inset bottom vignette for a
       sense of real glass thickness, a tight contact shadow, and a soft
       ambient shadow - scaled down for this card's smaller 150x190 size,
       and kept deliberately low-alpha ("barely visible" material cues,
       not a dramatic floating effect). */
    .attachment-card {
      position: relative;
      background: var(--cache-surface);
      backdrop-filter: blur(var(--hud-blur, 18px)) saturate(120%);
      -webkit-backdrop-filter: blur(var(--hud-blur, 18px)) saturate(120%);
      border: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06), inset 0 -8px 14px -12px rgba(0, 0, 0, 0.22),
        0 2px 6px rgba(0, 0, 0, 0.16), 0 10px 22px -10px rgba(0, 0, 0, 0.3);
      border-radius: var(--hud-radius-sm, 8px);
      width: 100%;
      height: 190px;
      box-sizing: border-box;
      padding: 10px;
      cursor: pointer;
      color: #f2f4f6;
      display: flex;
      flex-direction: column;
      gap: 8px;
      text-align: center;
      font: inherit;
      transition: transform 200ms ease, border-color 180ms ease, box-shadow 200ms ease;
    }
    .attachment-card:hover {
      border-color: var(--hud-border-hover, rgba(255, 255, 255, 0.16));
      transform: translateY(-2px);
    }
    .attachment-card.filled {
      border-color: rgba(255, 255, 255, 0.3);
      background: color-mix(in srgb, rgba(255, 255, 255, 0.05) 46%, transparent);
    }
    /* A wishlist part installed to preview a build (see ha-cache-
       integration's CLAUDE.md - installing a wishlist item onto a real
       firearm doesn't count as money spent, it's a preview) gets the
       same purple tint every other wishlist card in the app uses - see
       styles.ts's ha-card.wishlist. --hud-purple is a cache-panel.ts
       :host custom property, so it's readable here despite this
       component's otherwise-hardcoded-hex styling (see this file's own
       doc comment on why: an always-dark surface that predates the
       theme-variable cascade). */
    .attachment-card.filled.wishlist {
      border-color: color-mix(in srgb, var(--hud-purple, #a78bfa) 45%, transparent);
      background: color-mix(in srgb, var(--hud-purple, #a78bfa) 16%, transparent);
    }
    .art {
      flex: 1;
      min-height: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .art img {
      width: 100%;
      height: 100%;
      object-fit: contain;
    }
    .art ha-icon {
      --mdc-icon-size: 40px;
      opacity: 0.6;
    }
    .attachment-card.filled .art ha-icon {
      opacity: 1;
      color: #f2f4f6;
    }
    .val {
      font-size: 12px;
      color: #f2f4f6;
      line-height: 1.3;
      padding-top: 8px;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .val.empty {
      color: var(--cache-text-muted);
      font-style: italic;
    }
    .overflow-count {
      font-size: 22px;
      font-weight: 700;
      color: #f2f4f6;
    }
    @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  `;

  private _onSlotClick(slotType: string): void {
    this.dispatchEvent(
      new CustomEvent("cache-slot-click", { detail: { slotType }, bubbles: true, composed: true })
    );
  }

  private _renderEmptyCard(part: string) {
    return html`
      <div class="attachment-card-wrap">
        <button class="attachment-card" @click=${() => this._onSlotClick(part)}>
          <div class="art"><ha-icon icon="mdi:plus"></ha-icon></div>
          <div class="val empty">Empty</div>
        </button>
      </div>
    `;
  }

  private _cardStyle(transform: CardTransform): string {
    return (
      `--rx:${transform.restX}px; --ry:${transform.restY}px; --z:${transform.z}; ` +
      `--hx:${transform.hoverX}px; --hy:${transform.hoverY}px; --hscale:${transform.hoverScale}`
    );
  }

  private _renderItemCard(entry: StackEntry, transform?: CardTransform) {
    const { part, item } = entry;
    return html`
      <div class="attachment-card-wrap" style=${transform ? this._cardStyle(transform) : ""}>
        <button class="attachment-card filled ${item.isWishlist ? "wishlist" : ""}" @click=${() => this._onSlotClick(part)}>
          <div class="art">
            ${item.photoUrl
              ? html`<img src=${item.photoUrl} alt=${item.customName} />`
              : html`<ha-icon icon=${SLOT_ICONS[part] ?? DEFAULT_SLOT_ICON}></ha-icon>`}
          </div>
          <div class="val">${truncate(item.customName, 22)}</div>
        </button>
      </div>
    `;
  }

  // The last slot in an over-full stack, in place of a 5th+ item card -
  // reads "+N more" rather than shrinking every card in the stack down
  // toward unreadability trying to fit them all. Still opens the same
  // slot-modal on click (seeded from the first hidden entry's Part),
  // since the modal lists everything regardless of which card opened it.
  private _renderOverflowCard(hidden: StackEntry[], transform: CardTransform) {
    const anyWishlist = hidden.some((entry) => entry.item.isWishlist);
    return html`
      <div class="attachment-card-wrap" style=${this._cardStyle(transform)}>
        <button class="attachment-card filled ${anyWishlist ? "wishlist" : ""}" @click=${() => this._onSlotClick(hidden[0].part)}>
          <div class="art"><span class="overflow-count">+${hidden.length}</span></div>
          <div class="val">${hidden.length === 1 ? "1 more" : `${hidden.length} more`}</div>
        </button>
      </div>
    `;
  }

  render() {
    return html`
      <div class="attachment-bar">
        ${Object.entries(PART_TAXONOMY).map(([category, parts]) => {
          const entries: StackEntry[] = parts.flatMap((part) =>
            (this.installedBySlot[part] ?? []).map((item) => ({ part, item }))
          );
          let body;
          if (entries.length === 0) {
            body = this._renderEmptyCard(parts[0]);
          } else if (entries.length === 1) {
            body = this._renderItemCard(entries[0]);
          } else if (entries.length <= MAX_STACK_CARDS) {
            const transforms = stackTransforms(entries.length);
            body = html`
              <div class="stack">
                ${entries.map((entry, i) => this._renderItemCard(entry, transforms[i]))}
              </div>
            `;
          } else {
            const shown = entries.slice(0, MAX_STACK_CARDS - 1);
            const hidden = entries.slice(MAX_STACK_CARDS - 1);
            const transforms = stackTransforms(MAX_STACK_CARDS);
            body = html`
              <div class="stack">
                ${shown.map((entry, i) => this._renderItemCard(entry, transforms[i]))}
                ${this._renderOverflowCard(hidden, transforms[MAX_STACK_CARDS - 1])}
              </div>
            `;
          }
          return html`
            <div class="category-group">
              <div class="cat"><ha-icon icon="mdi:chevron-right"></ha-icon>${category}</div>
              ${body}
            </div>
          `;
        })}
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cache-attachment-bar": CacheAttachmentBar;
  }
}

