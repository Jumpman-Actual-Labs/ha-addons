import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { cacheApi } from "../ha-api";
import type { CacheState, InstalledItemSummary, InventoryItem } from "../types";
import { CATEGORY_FOR_PART, PART_TAXONOMY } from "../types";
import { formStyles } from "../styles";
import { knownManufacturers } from "../utils/options";
import "./cache-dialog";

/** Build Slot Modal - scoped to a whole Category (e.g. "Optic"), not a
 * single Part, since `attachment-bar.ts` only ever shows one clickable
 * card per Category - clicking that card (whichever of the category's
 * Parts it happens to represent) opens this same modal, and the heading/
 * "Currently Installed" section cover every Part in the category (one row
 * each), not just the one that was clicked. `slotType` (the prop set from
 * whichever card/stack-half was clicked) only seeds `_focusedPart` -
 * search/install/remove/create all operate on `_focusedPart`, which the
 * user can freely switch between the category's Parts via each
 * "Currently Installed" row's own View/Remove (switches focus to that
 * row's Part first) or the generic "Attach Part" button (toggles focus to
 * the OTHER Part in a two-Part category) - entirely internal state, no
 * event needs to reach the parent view to pivot within the same modal
 * instance. Only part_type matching is enforced when installing (never
 * physical compatibility) - see logic.validate_install on the backend.
 *
 * A Part isn't exclusive on the backend - any number of items can share
 * the same Part on the same firearm (e.g. two Optics), so
 * `installedBySlot` maps each Part to an ARRAY, and "Currently Installed"
 * lists every item in it (one row per item, not one row per Part).
 * Installing never evicts anything, so the install button always reads
 * "Install" (there's no more "Replace" wording). Removing targets one
 * specific item by its own id (`_removeTarget`) rather than "whatever's
 * in this Part's slot" - that phrase is ambiguous once a Part can hold
 * more than one item. */
@customElement("slot-modal")
export class SlotModal extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) cacheState!: CacheState;
  @property({ type: Boolean }) open = false;
  @property({ type: String }) firearmId = "";
  @property({ type: String }) slotType = "";
  @property({ attribute: false }) installedBySlot: Record<string, InstalledItemSummary[]> = {};

  @state() private _focusedPart = "";
  @state() private _search = "";
  @state() private _showInstalled = false;
  @state() private _error: string | null = null;
  @state() private _pendingMoveItem: InventoryItem | null = null;
  @state() private _removeTarget: InstalledItemSummary | null = null;
  @state() private _removeLocationId = "";
  @state() private _addNewOpen = false;
  @state() private _newName = "";
  @state() private _newManufacturer = "";
  @state() private _newModel = "";
  @state() private _newLocationId = "";

  static styles = [
    formStyles,
    css`
      .current {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-bottom: 12px;
      }
      .current .info {
        flex: 1;
      }
      ul {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      li {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        padding: 10px 0;
        border-bottom: 1px solid var(--divider-color, #e0e0e0);
      }
      li:last-child {
        border-bottom: none;
      }
      li .row-actions {
        display: flex;
        gap: 6px;
        flex-shrink: 0;
      }
    `,
  ];

  willUpdate(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("slotType") && this.slotType) {
      this._focusedPart = this.slotType;
    }
  }

  private get _category(): string {
    return CATEGORY_FOR_PART[this.slotType] ?? "";
  }

  private get _categoryParts(): string[] {
    return PART_TAXONOMY[this._category] ?? [this.slotType];
  }

  private _focusPart(part: string): void {
    this._focusedPart = part;
  }

  private _attachOtherPart(): void {
    const other = this._categoryParts.find((p) => p !== this._focusedPart);
    if (other) this._focusedPart = other;
  }

  private get _items(): InventoryItem[] {
    const s = this._search.toLowerCase();
    const focusedItemIds = new Set(
      (this.installedBySlot[this._focusedPart] ?? []).map((i) => i.id)
    );
    return this.cacheState.inventoryItems.filter((i) => {
      if (i.partType !== this._focusedPart) return false;
      if (focusedItemIds.has(i.id)) return false;
      if (!this._showInstalled && i.installedFirearmId) return false;
      if (!s) return true;
      return (
        i.customName.toLowerCase().includes(s) || (i.manufacturer ?? "").toLowerCase().includes(s)
      );
    });
  }

  private _close(): void {
    this.dispatchEvent(new CustomEvent("cache-dialog-closed"));
  }

  private async _install(item: InventoryItem, confirmMove = false): Promise<void> {
    this._error = null;
    try {
      await cacheApi.installItem(this.hass, this.firearmId, item.id, this._focusedPart, confirmMove);
      this._pendingMoveItem = null;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to install item";
      if (message.toLowerCase().includes("already installed on another firearm")) {
        this._pendingMoveItem = item;
      } else {
        this._error = message;
      }
    }
  }

  private async _confirmRemove(): Promise<void> {
    if (!this._removeTarget) return;
    // A wishlist item was only ever installed to preview a build - it has
    // no physical location to return to, so a location is optional for
    // it (the backend accepts an empty one). An owned item still needs a
    // real one.
    if (!this._removeTarget.isWishlist && !this._removeLocationId) return;
    try {
      await cacheApi.removeItem(this.hass, this._removeTarget.id, this._removeLocationId);
      this._removeTarget = null;
      this._removeLocationId = "";
    } catch (err) {
      this._error = err instanceof Error ? err.message : "Failed to remove item";
    }
  }

  private async _addNewAndInstall(): Promise<void> {
    const manufacturer = this._newManufacturer;
    const model = this._newModel;
    await cacheApi.addInventoryItem(this.hass, {
      custom_name: this._newName || "",
      category: this._category,
      part_type: this._focusedPart,
      manufacturer: manufacturer || "",
      model: model || "",
      storage_location_id: this._newLocationId || "",
    });
    this._addNewOpen = false;
    this._newName = "";
    this._newManufacturer = "";
    this._newModel = "";
    this._newLocationId = "";
    // The service call doesn't return the created item's id directly (HA
    // service responses aren't guaranteed round-tripped like a REST POST),
    // so find it by matching part_type+manufacturer+model among
    // not-yet-installed items, picking the most recently created match -
    // good enough immediately after creation in this single-user flow, and
    // the item can always be picked manually from the list below if two
    // items share every field.
    const candidates = this.cacheState.inventoryItems.filter(
      (i) =>
        i.partType === this._focusedPart &&
        !i.installedFirearmId &&
        (i.manufacturer ?? "") === manufacturer &&
        (i.model ?? "") === model
    );
    const created = candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    if (created) {
      await this._install(created);
    }
  }

  private _viewItem(itemId: string): void {
    this.dispatchEvent(
      new CustomEvent("cache-view-item", { detail: { itemId }, bubbles: true, composed: true })
    );
  }

  render() {
    const items = this._items;
    return html`
      <cache-dialog .open=${this.open} heading="${this._category} Slot" width="560px" @cache-dialog-closed=${this._close}>
        ${this._error ? html`<div class="error-banner">${this._error}</div>` : ""}

        <p class="small muted" style="margin:0 0 4px">Currently Installed</p>
        ${this._categoryParts.map((part) => {
          const partItems = this.installedBySlot[part] ?? [];
          if (partItems.length === 0) {
            return html`
              <div class="current">
                <ha-icon icon="mdi:cube-outline"></ha-icon>
                <div class="info">
                  <div class="small muted">${part}</div>
                </div>
              </div>
            `;
          }
          return partItems.map(
            (item, idx) => html`
              <div class="current">
                <ha-icon icon="mdi:cube-outline"></ha-icon>
                <div class="info">
                  ${idx === 0 ? html`<div class="small muted">${part}</div>` : ""}
                  <div style="font-weight:600">${item.customName}</div>
                </div>
                <button class="link" @click=${() => this._viewItem(item.id)}>View</button>
                <button
                  class="link danger"
                  @click=${() => {
                    this._focusPart(part);
                    this._removeTarget = item;
                  }}
                >
                  Remove
                </button>
              </div>
            `
          );
        })}

        <div class="field-row" style="align-items:center">
          <input
            placeholder="Search inventory..."
            .value=${this._search}
            @input=${(e: Event) => (this._search = (e.target as HTMLInputElement).value)}
          />
          <div class="checkbox-row" style="margin:0">
            <input
              type="checkbox"
              .checked=${this._showInstalled}
              @change=${(e: Event) => (this._showInstalled = (e.target as HTMLInputElement).checked)}
            />
            <label style="margin:0">Show Installed</label>
          </div>
        </div>

        ${items.length === 0
          ? html`<div class="empty">No ${this._focusedPart.toLowerCase()} items found in inventory.</div>`
          : html`
              <ul>
                ${items.map(
                  (item) => html`
                    <li>
                      <div>
                        <div style="font-weight:500">
                          ${item.customName}
                          ${item.installedFirearmId
                            ? html`<span class="badge warning" style="margin-left:6px">Installed elsewhere</span>`
                            : ""}
                        </div>
                        <div class="small muted">
                          ${[item.manufacturer, item.model].filter(Boolean).join(" ") || "—"} ·
                          ${item.condition ?? "Condition unknown"} · ${item.effectiveLocationName ?? "No location"}
                        </div>
                      </div>
                      <div class="row-actions">
                        <button class="link" @click=${() => this._viewItem(item.id)}>View</button>
                        <button class="primary" @click=${() => this._install(item)}>Install</button>
                      </div>
                    </li>
                  `
                )}
              </ul>
            `}

        <div class="actions" style="justify-content:space-between">
          <div style="display:flex;gap:12px">
            <button class="link" @click=${() => (this._addNewOpen = true)}>+ Create New Part</button>
            ${this._categoryParts.length > 1
              ? html`<button class="link" @click=${this._attachOtherPart}>Attach Part</button>`
              : ""}
          </div>
          <button class="secondary" @click=${this._close}>Close</button>
        </div>
      </cache-dialog>

      <cache-dialog
        .open=${!!this._pendingMoveItem}
        heading="Move Item?"
        width="420px"
        @cache-dialog-closed=${() => (this._pendingMoveItem = null)}
      >
        <p>
          "${this._pendingMoveItem?.customName}" is currently installed on another firearm. Moving
          it here will remove it from that build.
        </p>
        <div class="actions">
          <button class="secondary" @click=${() => (this._pendingMoveItem = null)}>Cancel</button>
          <button class="primary" @click=${() => this._pendingMoveItem && this._install(this._pendingMoveItem, true)}>
            Move Item
          </button>
        </div>
      </cache-dialog>

      <cache-dialog
        .open=${!!this._removeTarget}
        heading="Remove ${this._removeTarget?.customName ?? ""}"
        width="380px"
        @cache-dialog-closed=${() => (this._removeTarget = null)}
      >
        <p class="small muted">
          ${this._removeTarget?.isWishlist
            ? "This is a wishlist item - it isn't physically anywhere, so a storage location is optional."
            : "Choose a storage location for this item once it's removed."}
        </p>
        <label>Storage Location${this._removeTarget?.isWishlist ? " (optional)" : ""}</label>
        <select .value=${this._removeLocationId} @change=${(e: Event) => (this._removeLocationId = (e.target as HTMLSelectElement).value)}>
          <option value="">${this._removeTarget?.isWishlist ? "None" : "Select a location"}</option>
          ${this.cacheState.storageLocations.map((l) => html`<option value=${l.id} ?selected=${l.id === this._removeLocationId}>${l.name}</option>`)}
        </select>
        <div class="actions">
          <button class="secondary" @click=${() => (this._removeTarget = null)}>Cancel</button>
          <button
            class="secondary danger"
            ?disabled=${!this._removeTarget?.isWishlist && !this._removeLocationId}
            @click=${this._confirmRemove}
          >
            Remove
          </button>
        </div>
      </cache-dialog>

      <cache-dialog
        .open=${this._addNewOpen}
        heading="Create New ${this._focusedPart}"
        width="420px"
        @cache-dialog-closed=${() => (this._addNewOpen = false)}
      >
        ${this._categoryParts.length > 1
          ? html`
              <label>Part</label>
              <select .value=${this._focusedPart} @change=${(e: Event) => (this._focusedPart = (e.target as HTMLSelectElement).value)}>
                ${this._categoryParts.map((p) => html`<option value=${p} ?selected=${p === this._focusedPart}>${p}</option>`)}
              </select>
            `
          : ""}
        <label>Custom Name (optional)</label>
        <input placeholder="Defaults to manufacturer + model" .value=${this._newName} @input=${(e: Event) => (this._newName = (e.target as HTMLInputElement).value)} />
        <label>Manufacturer</label>
        <input list="slot-modal-manufacturer-list" .value=${this._newManufacturer} @input=${(e: Event) => (this._newManufacturer = (e.target as HTMLInputElement).value)} />
        <datalist id="slot-modal-manufacturer-list">
          ${knownManufacturers(this.cacheState).map((m) => html`<option value=${m}></option>`)}
        </datalist>
        <label>Model</label>
        <input .value=${this._newModel} @input=${(e: Event) => (this._newModel = (e.target as HTMLInputElement).value)} />
        <label>Storage Location</label>
        <select .value=${this._newLocationId} @change=${(e: Event) => (this._newLocationId = (e.target as HTMLSelectElement).value)}>
          <option value="">Unassigned</option>
          ${this.cacheState.storageLocations.map((l) => html`<option value=${l.id} ?selected=${l.id === this._newLocationId}>${l.name}</option>`)}
        </select>
        <div class="actions">
          <button class="secondary" @click=${() => (this._addNewOpen = false)}>Cancel</button>
          <button class="primary" @click=${this._addNewAndInstall}>
            Add &amp; Install
          </button>
        </div>
      </cache-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "slot-modal": SlotModal;
  }
}
