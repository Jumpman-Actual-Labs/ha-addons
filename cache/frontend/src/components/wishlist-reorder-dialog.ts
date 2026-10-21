import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { cacheApi } from "../ha-api";
import type { Firearm } from "../types";
import { formStyles } from "../styles";
import "./cache-dialog";

/** Replaces the old High/Medium/Low priority tiers for wishlist firearms
 * with a full, user-controlled drag-and-drop order - see ha-cache-
 * integration's CLAUDE.md for why (a 3-tier field can't express "I want
 * this MORE than that other High-priority thing"). Reordering saves the
 * complete new order in one call on "Save Order" (cacheApi.
 * reorderWishlistFirearms - rank = position in the list), not per-drag
 * deltas - simpler, and matches the backend's own atomic-reorder design
 * (see coordinator.async_reorder_wishlist_firearms).
 *
 * Drag-and-drop uses the native HTML5 DnD API (draggable + dragstart/
 * dragover/drop) rather than a library - one list, one axis, nothing
 * fancy enough to justify a dependency. Native DnD doesn't work on touch
 * devices, so each row also gets plain up/down buttons as a non-drag,
 * touch-friendly way to reorder - not just an accessibility nicety, the
 * only way to reorder at all on a phone/tablet. */
@customElement("wishlist-reorder-dialog")
export class WishlistReorderDialog extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ type: Boolean }) open = false;
  // The current wishlist firearms, any order - re-sorted by existing
  // wishlistRank (nulls last) into `_order` whenever the dialog opens, so
  // a firearm wishlisted before this feature existed (rank still null)
  // still shows up somewhere sane rather than crashing the sort.
  @property({ attribute: false }) firearms: Firearm[] = [];

  @state() private _order: Firearm[] = [];
  @state() private _dragIndex: number | null = null;
  @state() private _saving = false;
  @state() private _error: string | null = null;

  static styles = [
    formStyles,
    css`
      .hint {
        margin: 0 0 12px;
      }
      .reorder-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
        max-height: 50vh;
        overflow-y: auto;
      }
      .reorder-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 10px;
        border-radius: 8px;
        border: 1px solid var(--divider-color, rgba(255, 255, 255, 0.1));
        background: color-mix(in srgb, var(--card-background-color, #16181b) 55%, transparent);
        cursor: grab;
      }
      .reorder-row.dragging {
        opacity: 0.4;
      }
      .drag-handle {
        --mdc-icon-size: 18px;
        color: var(--secondary-text-color, #a3adb6);
        flex-shrink: 0;
      }
      .reorder-rank {
        width: 22px;
        flex-shrink: 0;
        font-size: 0.8rem;
        font-weight: 700;
        color: var(--secondary-text-color, #a3adb6);
        font-variant-numeric: tabular-nums;
      }
      .reorder-name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 0.9rem;
        font-weight: 600;
      }
      .reorder-move {
        display: flex;
        gap: 2px;
        flex-shrink: 0;
      }
      .reorder-move button {
        background: none;
        border: none;
        cursor: pointer;
        color: var(--secondary-text-color, #a3adb6);
        display: flex;
        padding: 2px;
      }
      .reorder-move button:hover:not([disabled]) {
        color: var(--primary-text-color, #f2f4f6);
      }
      .reorder-move button[disabled] {
        opacity: 0.25;
        cursor: default;
      }
      .reorder-move ha-icon {
        --mdc-icon-size: 18px;
      }
    `,
  ];

  willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("open") && this.open) {
      this._order = [...this.firearms].sort(
        (a, b) => (a.wishlistRank ?? Infinity) - (b.wishlistRank ?? Infinity)
      );
      this._error = null;
    }
  }

  private _move(index: number, delta: number): void {
    const target = index + delta;
    if (target < 0 || target >= this._order.length) return;
    const arr = [...this._order];
    [arr[index], arr[target]] = [arr[target], arr[index]];
    this._order = arr;
  }

  private _onDragStart(index: number, e: DragEvent): void {
    this._dragIndex = index;
    e.dataTransfer?.setData("text/plain", String(index));
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
  }

  private _onDragOver(e: DragEvent): void {
    e.preventDefault();
  }

  private _onDrop(index: number, e: DragEvent): void {
    e.preventDefault();
    if (this._dragIndex === null || this._dragIndex === index) {
      this._dragIndex = null;
      return;
    }
    const arr = [...this._order];
    const [moved] = arr.splice(this._dragIndex, 1);
    arr.splice(index, 0, moved);
    this._order = arr;
    this._dragIndex = null;
  }

  private _close(): void {
    this.dispatchEvent(new CustomEvent("cache-dialog-closed"));
  }

  private async _save(): Promise<void> {
    this._saving = true;
    this._error = null;
    try {
      await cacheApi.reorderWishlistFirearms(
        this.hass,
        this._order.map((f) => f.id)
      );
      this._close();
    } catch (err) {
      this._error = err instanceof Error ? err.message : "Failed to save order";
    } finally {
      this._saving = false;
    }
  }

  render() {
    return html`
      <cache-dialog .open=${this.open} heading="Reorder Wishlist" width="440px" @cache-dialog-closed=${this._close}>
        ${this._error ? html`<div class="error-banner">${this._error}</div>` : ""}
        ${this._order.length === 0
          ? html`<p class="muted">No wishlist firearms to reorder yet.</p>`
          : html`
              <p class="small muted hint">Drag to reorder - top is what you want most.</p>
              <div class="reorder-list">
                ${this._order.map(
                  (f, i) => html`
                    <div
                      class="reorder-row ${this._dragIndex === i ? "dragging" : ""}"
                      draggable="true"
                      @dragstart=${(e: DragEvent) => this._onDragStart(i, e)}
                      @dragover=${this._onDragOver}
                      @drop=${(e: DragEvent) => this._onDrop(i, e)}
                    >
                      <ha-icon class="drag-handle" icon="mdi:drag-vertical"></ha-icon>
                      <span class="reorder-rank">${i + 1}</span>
                      <span class="reorder-name">${f.customName}</span>
                      <div class="reorder-move">
                        <button ?disabled=${i === 0} title="Move up" @click=${() => this._move(i, -1)}>
                          <ha-icon icon="mdi:chevron-up"></ha-icon>
                        </button>
                        <button
                          ?disabled=${i === this._order.length - 1}
                          title="Move down"
                          @click=${() => this._move(i, 1)}
                        >
                          <ha-icon icon="mdi:chevron-down"></ha-icon>
                        </button>
                      </div>
                    </div>
                  `
                )}
              </div>
            `}
        <div class="actions">
          <button class="secondary" @click=${this._close}>Cancel</button>
          <button class="primary" ?disabled=${this._saving || this._order.length === 0} @click=${this._save}>
            ${this._saving ? "Saving…" : "Save Order"}
          </button>
        </div>
      </cache-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "wishlist-reorder-dialog": WishlistReorderDialog;
  }
}
