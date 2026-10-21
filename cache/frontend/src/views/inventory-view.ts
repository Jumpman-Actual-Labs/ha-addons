import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { cacheApi } from "../ha-api";
import type { CacheState, InventoryItem } from "../types";
import { CATEGORY_FOR_PART, CONDITIONS, INVENTORY_CATEGORIES, PART_TYPES, WISHLIST_PRIORITIES } from "../types";
import { glassCardStyle, formStyles } from "../styles";
import { formatCurrency, formatDate, formatDateTime, todayIso } from "../utils/format";
import { knownManufacturers } from "../utils/options";
import "../components/cache-dialog";
import "../components/photo-manager-section";
import "../components/image-source-button";

interface ItemDraft {
  customName: string;
  // Category isn't chosen directly in this form anymore - it's just the
  // coarser grouping used for the Parts Inventory grid's filter/sorting,
  // auto-derived from partType via CATEGORY_FOR_PART at save time (see
  // _save()).
  partType: string;
  manufacturer: string;
  model: string;
  serialNumber: string;
  purchaseDate: string;
  purchasePrice: string;
  estimatedValue: string;
  condition: string;
  notes: string;
  storageLocationId: string;
  isWishlist: boolean;
  wishlistPriority: string;
  productUrl: string;
}

const EMPTY_DRAFT: ItemDraft = {
  customName: "",
  partType: "Optic",
  manufacturer: "",
  model: "",
  serialNumber: "",
  purchaseDate: "",
  purchasePrice: "",
  estimatedValue: "",
  condition: "",
  notes: "",
  storageLocationId: "",
  isWishlist: false,
  wishlistPriority: "",
  productUrl: "",
};

@customElement("cache-inventory-view")
export class CacheInventoryView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) cacheState!: CacheState;
  @property({ type: String }) initialItemId: string | null = null;

  @state() private _search = "";
  @state() private _category = "";
  @state() private _wishlistFilter: "owned" | "wishlist" | "all" = "owned";
  @state() private _selectedId: string | null = null;
  @state() private _formOpen = false;
  @state() private _editing: InventoryItem | null = null;
  @state() private _draft: ItemDraft = { ...EMPTY_DRAFT };
  @state() private _error: string | null = null;
  // Staged (not yet uploaded) photos for the Add Item form - same
  // reasoning as firearms-view.ts's _addPhotoFiles: a brand-new item has
  // no id until _save() creates it and gets one back, so nothing can
  // upload until then. Editing an existing item uploads live instead via
  // photo-manager-section.ts.
  @state() private _addPhotoFiles: File[] = [];
  @state() private _savingPhotos = false;
  @state() private _deleteTarget: InventoryItem | null = null;
  @state() private _markPurchasedOpen = false;
  @state() private _purchaseDate = todayIso();
  @state() private _purchasePrice = "";

  static styles = [
    glassCardStyle,
    formStyles,
    css`
      ha-card.item {
        padding: 16px;
        cursor: pointer;
      }
      ha-card.item.stacked {
        position: relative;
        cursor: default;
      }
      .item-header {
        display: flex;
        gap: 12px;
        align-items: center;
      }
      .thumb {
        width: 48px;
        height: 48px;
        border-radius: 10px;
        background: var(--secondary-background-color, #eee);
        object-fit: cover;
        flex-shrink: 0;
      }
      .item-name {
        font-weight: 600;
      }
      .qty-corner-badge {
        position: absolute;
        top: 10px;
        right: 10px;
        min-width: 22px;
        height: 22px;
        padding: 0 5px;
        box-sizing: border-box;
        border-radius: 5px;
        background: var(--primary-color, #03a9f4);
        color: var(--text-primary-color, #fff);
        font-size: 0.75rem;
        font-weight: 700;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .unit-list {
        margin-top: 10px;
        border-top: 1px solid var(--divider-color, #e0e0e0);
      }
      .unit-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 8px;
        padding: 8px 0;
        border-bottom: 1px solid var(--divider-color, #e0e0e0);
        cursor: pointer;
      }
      .unit-row:last-child {
        border-bottom: none;
      }
      .unit-row:hover {
        color: var(--primary-color, #03a9f4);
      }
      .location-qty-badge {
        min-width: 18px;
        height: 18px;
        padding: 0 4px;
        box-sizing: border-box;
        border-radius: 4px;
        background: var(--secondary-background-color, #eee);
        color: var(--secondary-text-color, #616161);
        font-size: 0.7rem;
        font-weight: 700;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
      }
      .chips {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        margin-top: 8px;
      }
      .detail-card {
        padding: 20px;
      }
      .detail-header {
        display: flex;
        gap: 20px;
      }
      .detail-photo {
        width: 140px;
        height: 140px;
        border-radius: 14px;
        /* contain, not cover - a part's own product photo is often shot
           wide/rectangular (a scope mount, a suppressor), and cover was
           cropping real content off the edges to fill this square box.
           contain letterboxes it against the background color instead,
           same reasoning as attachment-bar.ts's .art img. */
        object-fit: contain;
        background: var(--secondary-background-color, #eee);
        flex-shrink: 0;
      }
      .fields {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
        gap: 12px;
        margin: 16px 0;
      }
      .field label {
        display: block;
        font-size: 0.75rem;
        color: var(--secondary-text-color, #727272);
        margin: 0;
      }
      .back-link {
        background: none;
        border: none;
        cursor: pointer;
        color: var(--primary-color, #03a9f4);
        display: flex;
        align-items: center;
        gap: 4px;
        margin-bottom: 12px;
        padding: 0;
      }
    `,
  ];

  willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("initialItemId") && this.initialItemId) {
      this._selectedId = this.initialItemId;
    }
  }

  private get _filtered(): InventoryItem[] {
    const s = this._search.toLowerCase();
    return this.cacheState.inventoryItems.filter((i) => {
      if (this._wishlistFilter === "owned" && i.isWishlist) return false;
      if (this._wishlistFilter === "wishlist" && !i.isWishlist) return false;
      if (this._category && i.category !== this._category) return false;
      if (!s) return true;
      return (
        i.customName.toLowerCase().includes(s) ||
        (i.manufacturer ?? "").toLowerCase().includes(s) ||
        (i.model ?? "").toLowerCase().includes(s)
      );
    });
  }

  // Groups items sharing a manufacturer+model into one card (a physical
  // stack of the same part) - each grouped item stays its own record with
  // its own serial number/location/install status, this is purely a
  // display grouping, not a data merge. Items missing manufacturer or
  // model never group (nothing reliable to match on), and group order
  // follows each group's first member's position in `_filtered` rather
  // than sorting groups after singles, so the grid's overall order stays
  // stable as items are added/edited.
  private get _groups(): InventoryItem[][] {
    const order: string[] = [];
    const groups = new Map<string, InventoryItem[]>();
    for (const item of this._filtered) {
      const key =
        item.manufacturer?.trim() && item.model?.trim()
          ? `${item.manufacturer.trim().toLowerCase()}|${item.model.trim().toLowerCase()}`
          : `__single_${item.id}`;
      const existing = groups.get(key);
      if (existing) {
        existing.push(item);
      } else {
        groups.set(key, [item]);
        order.push(key);
      }
    }
    return order.map((k) => groups.get(k)!);
  }

  // Collapses a stacked card's units by where they are - "On <firearm>"
  // or "📍 <location>" - so two units sitting in the exact same spot
  // render as one row with a quantity badge instead of two identical
  // rows. `firstId` is which unit that row's click navigates to; with
  // more than one unit at the same spot there's no way to tell them
  // apart from this list alone, so it's an arbitrary but functional
  // choice among an otherwise-interchangeable set.
  private _locationGroups(items: InventoryItem[]): { label: string; count: number; firstId: string }[] {
    const order: string[] = [];
    const counts = new Map<string, number>();
    const firstIds = new Map<string, string>();
    for (const item of items) {
      const label = item.installedFirearmName
        ? `On ${item.installedFirearmName}`
        : `📍 ${item.effectiveLocationName ?? "No location"}`;
      const count = (counts.get(label) ?? 0) + 1;
      counts.set(label, count);
      if (count === 1) {
        order.push(label);
        firstIds.set(label, item.id);
      }
    }
    return order.map((label) => ({ label, count: counts.get(label)!, firstId: firstIds.get(label)! }));
  }

  private _openAdd(): void {
    this._editing = null;
    this._draft = { ...EMPTY_DRAFT };
    this._addPhotoFiles = [];
    this._error = null;
    this._formOpen = true;
  }

  // Prefills the Add form from an existing item so buying a second one of
  // the same part doesn't mean retyping manufacturer/model/category from
  // scratch - `_editing` stays null so `_save()` creates a new item
  // rather than overwriting this one. Serial number is deliberately left
  // blank rather than copied: it identifies one specific physical unit,
  // so carrying it over would give two different items the same serial.
  private _openDuplicate(item: InventoryItem): void {
    this._editing = null;
    this._draft = {
      customName: item.customName,
      partType: item.partType ?? "",
      manufacturer: item.manufacturer ?? "",
      model: item.model ?? "",
      serialNumber: "",
      purchaseDate: item.purchaseDate ?? "",
      purchasePrice: item.purchasePrice?.toString() ?? "",
      estimatedValue: item.estimatedValue?.toString() ?? "",
      condition: item.condition ?? "",
      notes: item.notes ?? "",
      storageLocationId: item.storageLocationId ?? "",
      isWishlist: item.isWishlist,
      wishlistPriority: item.wishlistPriority ?? "",
      productUrl: item.productUrl ?? "",
    };
    this._addPhotoFiles = [];
    this._error = null;
    this._formOpen = true;
  }

  private _openEdit(item: InventoryItem): void {
    this._editing = item;
    this._draft = {
      customName: item.customName,
      partType: item.partType ?? "",
      manufacturer: item.manufacturer ?? "",
      model: item.model ?? "",
      serialNumber: item.serialNumber ?? "",
      purchaseDate: item.purchaseDate ?? "",
      purchasePrice: item.purchasePrice?.toString() ?? "",
      estimatedValue: item.estimatedValue?.toString() ?? "",
      condition: item.condition ?? "",
      notes: item.notes ?? "",
      storageLocationId: item.storageLocationId ?? "",
      isWishlist: item.isWishlist,
      wishlistPriority: item.wishlistPriority ?? "",
      productUrl: item.productUrl ?? "",
    };
    this._error = null;
    this._formOpen = true;
  }

  private async _save(): Promise<void> {
    this._error = null;
    const d = this._draft;
    const payload: Record<string, unknown> = {
      custom_name: d.customName,
      category: CATEGORY_FOR_PART[d.partType] ?? "",
      part_type: d.partType,
      manufacturer: d.manufacturer || "",
      model: d.model || "",
      serial_number: d.serialNumber || "",
      purchase_date: d.purchaseDate || "",
      purchase_price: d.purchasePrice === "" ? "" : Number(d.purchasePrice),
      estimated_value: d.estimatedValue === "" ? "" : Number(d.estimatedValue),
      condition: d.condition || "",
      notes: d.notes || "",
      storage_location_id: d.storageLocationId || "",
      is_wishlist: d.isWishlist,
      wishlist_priority: d.isWishlist ? d.wishlistPriority || "" : "",
      product_url: d.productUrl || "",
    };
    if (this._editing) {
      try {
        await cacheApi.updateInventoryItem(this.hass, this._editing.id, payload);
        this._formOpen = false;
      } catch (err) {
        this._error = err instanceof Error ? err.message : "Failed to save item";
      }
      return;
    }

    let itemId: string;
    try {
      itemId = await cacheApi.addInventoryItem(this.hass, payload);
    } catch (err) {
      this._error = err instanceof Error ? err.message : "Failed to save item";
      return;
    }

    if (this._addPhotoFiles.length > 0) {
      this._savingPhotos = true;
      try {
        for (const file of this._addPhotoFiles) {
          await cacheApi.uploadPhoto(this.hass, "inventory_item", itemId, file);
        }
      } catch (err) {
        this._savingPhotos = false;
        this._error = `Item added, but a photo failed to upload (${
          err instanceof Error ? err.message : "unknown error"
        }) - add it from Edit Item instead.`;
        return;
      }
      this._savingPhotos = false;
    }
    this._formOpen = false;
  }

  private async _confirmDelete(): Promise<void> {
    if (!this._deleteTarget) return;
    await cacheApi.deleteInventoryItem(this.hass, this._deleteTarget.id);
    this._deleteTarget = null;
    this._selectedId = null;
  }

  // "Mark as Purchased" isn't a dedicated backend service - a wishlist
  // part is a normal InventoryItem record, so "purchasing" it is just
  // clearing is_wishlist/wishlist_priority via the same updateInventoryItem
  // call the Edit Item form already uses, with purchase_date/
  // purchase_price filled in at the same time.
  private async _submitMarkPurchased(itemId: string): Promise<void> {
    await cacheApi.updateInventoryItem(this.hass, itemId, {
      is_wishlist: false,
      wishlist_priority: "",
      purchase_date: this._purchaseDate,
      purchase_price: this._purchasePrice === "" ? "" : Number(this._purchasePrice),
    });
    this._markPurchasedOpen = false;
    this._purchaseDate = todayIso();
    this._purchasePrice = "";
  }

  private _renderDetail(item: InventoryItem) {
    return html`
      <button class="back-link" @click=${() => (this._selectedId = null)}>
        <ha-icon icon="mdi:arrow-left"></ha-icon> Back to Parts Inventory
      </button>
      <ha-card class="detail-card">
        <div class="detail-header">
          ${item.photos[0]
            ? html`<img class="detail-photo" src=${item.photos[0].url} alt=${item.customName} />`
            : html`<div class="detail-photo" style="display:flex;align-items:center;justify-content:center">
                <ha-icon icon="mdi:toolbox" style="opacity:0.3;--mdc-icon-size:48px"></ha-icon>
              </div>`}
          <div style="flex:1">
            <h1 style="margin:0 0 4px;font-size:1.4rem">${item.customName}</h1>
            ${item.isWishlist
              ? html`<span class="badge wishlist">Wishlist${item.wishlistPriority ? ` · ${item.wishlistPriority} Priority` : ""}</span>`
              : ""}
            <span class="badge">${item.partType ?? item.category}</span>
            ${item.installedFirearmName
              ? html`<span
                  class="badge info"
                  style="cursor:pointer"
                  @click=${() =>
                    this.dispatchEvent(
                      new CustomEvent("cache-open-firearm", {
                        detail: { firearmId: item.installedFirearmId },
                        bubbles: true,
                        composed: true,
                      })
                    )}
                  >Installed on ${item.installedFirearmName}</span
                >`
              : ""}
          </div>
        </div>

        <div class="fields">
          <div class="field"><label>Manufacturer</label><div>${item.manufacturer ?? "—"}</div></div>
          <div class="field"><label>Model</label><div>${item.model ?? "—"}</div></div>
          <div class="field"><label>Condition</label><div>${item.condition ?? "—"}</div></div>
          <div class="field"><label>Current Location</label><div>${item.effectiveLocationName ?? "—"}</div></div>
          <div class="field"><label>Serial Number</label><div>${item.serialNumber ?? "—"}</div></div>
          <div class="field"><label>Purchase Date</label><div>${formatDate(item.purchaseDate)}</div></div>
          <div class="field"><label>Purchase Price</label><div>${formatCurrency(item.purchasePrice)}</div></div>
          <div class="field"><label>Estimated Value</label><div>${formatCurrency(item.estimatedValue)}</div></div>
          ${item.installedAt
            ? html`<div class="field"><label>Installed On</label><div>${formatDateTime(item.installedAt)}</div></div>`
            : ""}
          ${item.productUrl
            ? html`<div class="field"><label>Product Link</label><div><a href=${item.productUrl} target="_blank" rel="noopener noreferrer">${item.productUrl}</a></div></div>`
            : ""}
        </div>
        ${item.notes ? html`<p>${item.notes}</p>` : ""}

        <div class="actions" style="justify-content:flex-start">
          <button class="secondary" @click=${() => this._openEdit(item)}>Edit Item</button>
          ${item.isWishlist
            ? html`<button class="secondary" @click=${() => (this._markPurchasedOpen = true)}>Mark as Purchased</button>`
            : ""}
          <button class="secondary" @click=${() => this._openDuplicate(item)}>Add Another</button>
          <button class="secondary danger" @click=${() => (this._deleteTarget = item)}>Delete</button>
        </div>
      </ha-card>

      <cache-dialog .open=${this._markPurchasedOpen} heading="Mark as Purchased" width="360px" @cache-dialog-closed=${() => (this._markPurchasedOpen = false)}>
        <p class="small muted">Moves "${item.customName}" off the wishlist and into your inventory.</p>
        <label>Purchase Date</label>
        <input type="date" .value=${this._purchaseDate} @input=${(e: Event) => (this._purchaseDate = (e.target as HTMLInputElement).value)} />
        <label>Purchase Price</label>
        <input type="number" .value=${this._purchasePrice} @input=${(e: Event) => (this._purchasePrice = (e.target as HTMLInputElement).value)} />
        <div class="actions">
          <button class="secondary" @click=${() => (this._markPurchasedOpen = false)}>Cancel</button>
          <button class="primary" @click=${() => this._submitMarkPurchased(item.id)}>Mark as Purchased</button>
        </div>
      </cache-dialog>
    `;
  }

  render() {
    if (this._selectedId) {
      const item = this.cacheState.inventoryItems.find((i) => i.id === this._selectedId);
      if (item) {
        return html`${this._renderDetail(item)}${this._renderFormAndDeleteDialogs()}`;
      }
      this._selectedId = null;
    }

    const items = this._filtered;
    const groups = this._groups;
    return html`
      <div class="toolbar">
        <h1 style="margin:0;font-size:1.4rem;font-weight:600">Parts Inventory</h1>
        <button class="primary" @click=${this._openAdd}>+ Add Item</button>
      </div>

      <div class="filters">
        <input
          placeholder="Search by name, manufacturer, model..."
          .value=${this._search}
          @input=${(e: Event) => (this._search = (e.target as HTMLInputElement).value)}
        />
        <select .value=${this._category} @change=${(e: Event) => (this._category = (e.target as HTMLSelectElement).value)}>
          <option value="">All Categories</option>
          ${INVENTORY_CATEGORIES.map((c) => html`<option value=${c} ?selected=${c === this._category}>${c}</option>`)}
        </select>
        <div class="segmented">
          <button class=${this._wishlistFilter === "owned" ? "active" : ""} @click=${() => (this._wishlistFilter = "owned")}>Owned</button>
          <button class=${this._wishlistFilter === "all" ? "active" : ""} @click=${() => (this._wishlistFilter = "all")}>Both</button>
          <button class=${this._wishlistFilter === "wishlist" ? "active" : ""} @click=${() => (this._wishlistFilter = "wishlist")}>Wishlist</button>
        </div>
      </div>

      ${items.length === 0
        ? html`<div class="empty">
            ${this._search || this._category
              ? "No items match your search."
              : "Add optics, stocks, holsters, and other gear to your inventory."}
          </div>`
        : html`
            <div class="grid">
              ${groups.map((group) => {
                if (group.length === 1) {
                  const item = group[0];
                  return html`
                    <ha-card class="item ${item.isWishlist ? "wishlist" : ""}" @click=${() => (this._selectedId = item.id)}>
                      <div class="item-header">
                        ${item.photos[0]
                          ? html`<img class="thumb" src=${item.photos[0].url} alt=${item.customName} />`
                          : html`<div class="thumb" style="display:flex;align-items:center;justify-content:center">
                              <ha-icon icon="mdi:toolbox" style="opacity:0.4"></ha-icon>
                            </div>`}
                        <div>
                          <div class="item-name">${item.customName}</div>
                          <div class="small muted">${[item.manufacturer, item.model].filter(Boolean).join(" ") || "—"}</div>
                        </div>
                      </div>
                      <div class="chips">
                        ${item.isWishlist ? html`<span class="badge wishlist">Wishlist</span>` : ""}
                        <span class="badge">${item.partType ?? item.category}</span>
                        ${item.installedFirearmName ? html`<span class="badge info">On ${item.installedFirearmName}</span>` : ""}
                      </div>
                      <div class="small muted" style="margin-top:8px">📍 ${item.effectiveLocationName ?? "No location"}</div>
                    </ha-card>
                  `;
                }
                // A stack of separate records sharing a manufacturer+model
                // (see _groups) - the card itself isn't a click target,
                // each row is a link to one of the underlying item's own
                // detail page, since stacking is purely visual grouping,
                // not a merge. Rows are further grouped by location/install
                // status (_locationGroups) rather than listing every unit
                // individually - the part's own name/model is already the
                // card title, so repeating it per row added nothing; two
                // units sitting in the same spot collapse into one row
                // with its own small quantity badge instead.
                const first = group.find((i) => i.photos[0]) ?? group[0];
                return html`
                  <ha-card class="item stacked ${group.some((i) => i.isWishlist) ? "wishlist" : ""}">
                    <span class="qty-corner-badge">${group.length}</span>
                    <div class="item-header">
                      ${first.photos[0]
                        ? html`<img class="thumb" src=${first.photos[0].url} alt=${first.customName} />`
                        : html`<div class="thumb" style="display:flex;align-items:center;justify-content:center">
                            <ha-icon icon="mdi:toolbox" style="opacity:0.4"></ha-icon>
                          </div>`}
                      <div>
                        <div class="item-name">${[first.manufacturer, first.model].filter(Boolean).join(" ")}</div>
                        <div class="small muted">${first.partType ?? first.category}</div>
                      </div>
                    </div>
                    <div class="unit-list">
                      ${this._locationGroups(group).map(
                        (loc) => html`
                          <div class="unit-row" @click=${() => (this._selectedId = loc.firstId)}>
                            <span>${loc.label}</span>
                            ${loc.count > 1 ? html`<span class="location-qty-badge">${loc.count}</span>` : ""}
                          </div>
                        `
                      )}
                    </div>
                  </ha-card>
                `;
              })}
            </div>
          `}
      ${this._renderFormAndDeleteDialogs()}
    `;
  }

  private _renderFormAndDeleteDialogs() {
    return html`
      <cache-dialog
        .open=${this._formOpen}
        .heading=${this._editing ? "Edit Item" : "Add Inventory Item"}
        width="520px"
        @cache-dialog-closed=${() => (this._formOpen = false)}
      >
        ${this._error ? html`<div class="error-banner">${this._error}</div>` : ""}
        <div class="field-row">
          <div>
            <label>Custom Name (optional)</label>
            <input placeholder="Defaults to manufacturer + model" .value=${this._draft.customName} @input=${(e: Event) => (this._draft = { ...this._draft, customName: (e.target as HTMLInputElement).value })} />
          </div>
          <div>
            <label>Part</label>
            <select
              .value=${this._draft.partType}
              @change=${(e: Event) => (this._draft = { ...this._draft, partType: (e.target as HTMLSelectElement).value })}
            >
              ${PART_TYPES.map((p) => html`<option value=${p} ?selected=${p === this._draft.partType}>${p}</option>`)}
            </select>
          </div>
        </div>
        <div class="field-row">
          <div>
            <label>Manufacturer</label>
            <input list="item-manufacturer-list" .value=${this._draft.manufacturer} @input=${(e: Event) => (this._draft = { ...this._draft, manufacturer: (e.target as HTMLInputElement).value })} />
            <datalist id="item-manufacturer-list">
              ${knownManufacturers(this.cacheState).map((m) => html`<option value=${m}></option>`)}
            </datalist>
          </div>
          <div>
            <label>Model</label>
            <input .value=${this._draft.model} @input=${(e: Event) => (this._draft = { ...this._draft, model: (e.target as HTMLInputElement).value })} />
          </div>
        </div>
        <div class="field-row">
          <div>
            <label>Serial Number (optional)</label>
            <input .value=${this._draft.serialNumber} @input=${(e: Event) => (this._draft = { ...this._draft, serialNumber: (e.target as HTMLInputElement).value })} />
          </div>
          <div>
            <label>Condition</label>
            <select .value=${this._draft.condition} @change=${(e: Event) => (this._draft = { ...this._draft, condition: (e.target as HTMLSelectElement).value })}>
              <option value="">—</option>
              ${CONDITIONS.map((c) => html`<option value=${c} ?selected=${c === this._draft.condition}>${c}</option>`)}
            </select>
          </div>
        </div>

        <p class="small muted" style="text-transform:uppercase;letter-spacing:0.5px;margin-top:16px">Photos</p>
        ${this._editing
          ? html`<photo-manager-section
              .hass=${this.hass}
              entityType="inventory_item"
              .entityId=${this._editing.id}
              .photos=${this._editing.photos}
            ></photo-manager-section>`
          : html`
              <p class="small muted" style="margin-top:0">Uploads once the item is added below.</p>
              ${this._addPhotoFiles.length > 0
                ? html`<div style="margin-bottom:8px">
                    ${this._addPhotoFiles.map(
                      (file, i) => html`
                        <div class="small" style="display:flex;align-items:center;gap:8px;padding:2px 0">
                          <span>${file.name}</span>
                          <button
                            class="secondary"
                            style="padding:3px 10px"
                            @click=${() => (this._addPhotoFiles = this._addPhotoFiles.filter((_, j) => j !== i))}
                          >
                            Remove
                          </button>
                        </div>
                      `
                    )}
                  </div>`
                : ""}
              <cache-image-source-button
                label="Choose Photos"
                multiple
                @cache-image-selected=${(e: CustomEvent<{ files: File[] }>) =>
                  (this._addPhotoFiles = [...this._addPhotoFiles, ...e.detail.files])}
                @cache-image-error=${(e: CustomEvent<{ message: string }>) => (this._error = e.detail.message)}
              ></cache-image-source-button>
            `}

        <p class="small muted" style="text-transform:uppercase;letter-spacing:0.5px;margin-top:16px">Purchase</p>
        <div class="field-row">
          <div>
            <label>Purchase Date</label>
            <input type="date" .value=${this._draft.purchaseDate} @input=${(e: Event) => (this._draft = { ...this._draft, purchaseDate: (e.target as HTMLInputElement).value })} />
          </div>
          <div>
            <label>Purchase Price</label>
            <input type="number" .value=${this._draft.purchasePrice} @input=${(e: Event) => (this._draft = { ...this._draft, purchasePrice: (e.target as HTMLInputElement).value })} />
          </div>
          <div>
            <label>Estimated Value</label>
            <input type="number" .value=${this._draft.estimatedValue} @input=${(e: Event) => (this._draft = { ...this._draft, estimatedValue: (e.target as HTMLInputElement).value })} />
          </div>
        </div>
        <label>Storage Location</label>
        <select
          .value=${this._draft.storageLocationId}
          ?disabled=${!!this._editing?.installedFirearmId}
          @change=${(e: Event) => (this._draft = { ...this._draft, storageLocationId: (e.target as HTMLSelectElement).value })}
        >
          <option value="">Unassigned</option>
          ${this.cacheState.storageLocations.map((l) => html`<option value=${l.id} ?selected=${l.id === this._draft.storageLocationId}>${l.name}</option>`)}
        </select>
        ${this._editing?.installedFirearmId
          ? html`<p class="small muted">Location is inherited from the installed firearm.</p>`
          : ""}
        <div class="checkbox-row">
          <input type="checkbox" .checked=${this._draft.isWishlist} @change=${(e: Event) => (this._draft = { ...this._draft, isWishlist: (e.target as HTMLInputElement).checked })} />
          <label style="margin:0">This is a wishlist item (don't own it yet)</label>
        </div>
        ${this._draft.isWishlist
          ? html`
              <label>Priority</label>
              <select .value=${this._draft.wishlistPriority} @change=${(e: Event) => (this._draft = { ...this._draft, wishlistPriority: (e.target as HTMLSelectElement).value })}>
                <option value="">—</option>
                ${WISHLIST_PRIORITIES.map((p) => html`<option value=${p} ?selected=${p === this._draft.wishlistPriority}>${p}</option>`)}
              </select>
            `
          : ""}
        <label>Product Link (optional)</label>
        <input
          type="url"
          placeholder="https://..."
          .value=${this._draft.productUrl}
          @input=${(e: Event) => (this._draft = { ...this._draft, productUrl: (e.target as HTMLInputElement).value })}
        />
        <label>Notes</label>
        <textarea .value=${this._draft.notes} @input=${(e: Event) => (this._draft = { ...this._draft, notes: (e.target as HTMLTextAreaElement).value })}></textarea>
        <div class="actions">
          <button class="secondary" @click=${() => (this._formOpen = false)}>Cancel</button>
          <button class="primary" ?disabled=${this._savingPhotos} @click=${this._save}>
            ${this._savingPhotos ? "Uploading Photos…" : this._editing ? "Save Changes" : "Add Item"}
          </button>
        </div>
      </cache-dialog>

      <cache-dialog
        .open=${!!this._deleteTarget}
        heading="Delete Item"
        width="380px"
        @cache-dialog-closed=${() => (this._deleteTarget = null)}
      >
        <p>Delete "${this._deleteTarget?.customName}"? This cannot be undone.</p>
        <div class="actions">
          <button class="secondary" @click=${() => (this._deleteTarget = null)}>Cancel</button>
          <button class="secondary danger" @click=${this._confirmDelete}>Delete</button>
        </div>
      </cache-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cache-inventory-view": CacheInventoryView;
  }
}
