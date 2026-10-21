import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { cacheApi } from "../ha-api";
import type { Ammunition, CacheState, ScannedAmmoFields } from "../types";
import { glassCardStyle, formStyles } from "../styles";
import { formatCurrency, formatNumber } from "../utils/format";
import { knownCalibers, knownManufacturers } from "../utils/options";
import "../components/cache-dialog";
import "../components/image-source-button";

// The Shape Detection API (Chrome/Edge on Android + desktop, not in
// Firefox/Safari as of writing) isn't part of TypeScript's bundled DOM
// types - declared here rather than globally since it's only used in this
// one view. _handleBarcodeFile checks for its presence before using it and
// falls back to a clear error message pointing at Scan Box Photo instead.
declare global {
  interface Window {
    BarcodeDetector?: {
      new (options?: { formats?: string[] }): {
        detect(image: ImageBitmapSource): Promise<{ rawValue: string }[]>;
      };
    };
  }
}

interface AmmoDraft {
  caliber: string;
  manufacturer: string;
  productName: string;
  bulletWeight: string;
  bulletType: string;
  muzzleVelocity: string;
  quantity: string;
  costPerBox: string;
  roundsPerBox: string;
  purchaseDate: string;
  storageLocationId: string;
  notes: string;
  lowInventoryThreshold: string;
}

const EMPTY_DRAFT: AmmoDraft = {
  caliber: "",
  manufacturer: "",
  productName: "",
  bulletWeight: "",
  bulletType: "",
  muzzleVelocity: "",
  quantity: "",
  costPerBox: "",
  roundsPerBox: "",
  purchaseDate: "",
  storageLocationId: "",
  notes: "",
  lowInventoryThreshold: "",
};

function computedCostPerRound(costPerBox: string, roundsPerBox: string): number | null {
  const box = Number(costPerBox);
  const rounds = Number(roundsPerBox);
  if (!costPerBox || !roundsPerBox || !Number.isFinite(box) || !rounds) return null;
  return box / rounds;
}

@customElement("cache-ammunition-view")
export class CacheAmmunitionView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) cacheState!: CacheState;

  @state() private _search = "";
  @state() private _lowOnly = false;
  @state() private _formOpen = false;
  @state() private _editing: Ammunition | null = null;
  @state() private _draft: AmmoDraft = { ...EMPTY_DRAFT };
  @state() private _error: string | null = null;
  @state() private _scanning = false;
  @state() private _scanningBarcode = false;
  @state() private _adjustTarget: { ammo: Ammunition; mode: "add" | "remove" } | null = null;
  @state() private _adjustAmount = "";
  @state() private _adjustUnit: "rounds" | "boxes" = "rounds";
  @state() private _adjustNote = "";
  @state() private _deleteTarget: Ammunition | null = null;

  static styles = [
    glassCardStyle,
    formStyles,
    css`
      ha-card.ammo {
        padding: 16px;
      }
      ha-card.ammo.menu-open {
        z-index: 5;
      }
      .ammo-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 8px;
      }
      .header-icons {
        display: flex;
        align-items: center;
        gap: 2px;
        margin: -6px -8px 0 0;
      }
      .qty-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .qty-buttons {
        display: flex;
        gap: 6px;
      }
      .qty {
        font-size: 1.8rem;
        font-weight: 700;
        margin: 6px 0;
      }
      .qty small {
        font-size: 0.9rem;
        font-weight: 400;
        color: var(--secondary-text-color, #727272);
      }
      .chips {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        margin: 6px 0;
      }
    `,
  ];

  /** Which ammo card's ⋮ menu is open (its id), if any - only one at a
   * time. Closed by picking an item, clicking anywhere outside a menu, or
   * Escape. */
  @state() private _menuFor: string | null = null;

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("click", this._closeMenuOnOutsideClick);
    document.addEventListener("keydown", this._closeMenuOnEscape);
  }

  disconnectedCallback(): void {
    document.removeEventListener("click", this._closeMenuOnOutsideClick);
    document.removeEventListener("keydown", this._closeMenuOnEscape);
    super.disconnectedCallback();
  }

  private _closeMenuOnOutsideClick = (e: MouseEvent): void => {
    if (!this._menuFor) return;
    const insideMenu = e
      .composedPath()
      .some((el) => el instanceof HTMLElement && el.classList.contains("card-menu"));
    if (!insideMenu) this._menuFor = null;
  };

  private _closeMenuOnEscape = (e: KeyboardEvent): void => {
    if (e.key === "Escape") this._menuFor = null;
  };

  private _menuAction(action: () => void): void {
    this._menuFor = null;
    action();
  }

  private get _filtered(): Ammunition[] {
    const s = this._search.toLowerCase();
    return this.cacheState.ammunition.filter((a) => {
      if (this._lowOnly && !a.isLow) return false;
      if (!s) return true;
      return (
        a.caliber.toLowerCase().includes(s) || (a.manufacturer ?? "").toLowerCase().includes(s)
      );
    });
  }

  private _openAdd(): void {
    this._editing = null;
    this._draft = { ...EMPTY_DRAFT };
    this._error = null;
    this._formOpen = true;
  }

  private _openEdit(a: Ammunition): void {
    this._editing = a;
    this._draft = {
      caliber: a.caliber,
      manufacturer: a.manufacturer ?? "",
      productName: a.productName ?? "",
      bulletWeight: a.bulletWeight ?? "",
      bulletType: a.bulletType ?? "",
      muzzleVelocity: a.muzzleVelocity ?? "",
      quantity: String(a.quantity),
      costPerBox: a.costPerBox?.toString() ?? "",
      roundsPerBox: a.roundsPerBox?.toString() ?? "",
      purchaseDate: a.purchaseDate ?? "",
      storageLocationId: a.storageLocationId ?? "",
      notes: a.notes ?? "",
      lowInventoryThreshold: a.lowInventoryThreshold?.toString() ?? "",
    };
    this._error = null;
    this._formOpen = true;
  }

  private async _save(): Promise<void> {
    this._error = null;
    const d = this._draft;
    try {
      const payload: Record<string, unknown> = {
        caliber: d.caliber,
        manufacturer: d.manufacturer || "",
        product_name: d.productName || "",
        bullet_weight: d.bulletWeight || "",
        bullet_type: d.bulletType || "",
        muzzle_velocity: d.muzzleVelocity || "",
        cost_per_box: d.costPerBox === "" ? "" : Number(d.costPerBox),
        rounds_per_box: d.roundsPerBox === "" ? "" : Number(d.roundsPerBox),
        purchase_date: d.purchaseDate || "",
        storage_location_id: d.storageLocationId || "",
        notes: d.notes || "",
        low_inventory_threshold: d.lowInventoryThreshold === "" ? "" : Number(d.lowInventoryThreshold),
      };
      if (this._editing) {
        await cacheApi.updateAmmunition(this.hass, this._editing.id, payload);
      } else {
        await cacheApi.addAmmunition(this.hass, { ...payload, quantity: d.quantity ? Number(d.quantity) : 0 });
      }
      this._formOpen = false;
    } catch (err) {
      this._error = err instanceof Error ? err.message : "Failed to save ammunition";
    }
  }

  private _mergeScannedFields(scanned: ScannedAmmoFields): void {
    this._draft = {
      ...this._draft,
      caliber: scanned.caliber ?? this._draft.caliber,
      manufacturer: scanned.manufacturer ?? this._draft.manufacturer,
      productName: scanned.productName ?? this._draft.productName,
      bulletWeight: scanned.bulletWeight ?? this._draft.bulletWeight,
      bulletType: scanned.bulletType ?? this._draft.bulletType,
      muzzleVelocity: scanned.muzzleVelocity ?? this._draft.muzzleVelocity,
      roundsPerBox: scanned.roundsPerBox?.toString() ?? this._draft.roundsPerBox,
    };
  }

  private async _handleScanFile(files: File[]): Promise<void> {
    const file = files[0];
    if (!file) return;
    this._error = null;
    this._scanning = true;
    try {
      const scanned = await cacheApi.scanAmmoBox(this.hass, file);
      this._mergeScannedFields(scanned);
    } catch (err) {
      this._error = err instanceof Error ? err.message : "Failed to scan photo";
    } finally {
      this._scanning = false;
    }
  }

  private async _handleBarcodeFile(files: File[]): Promise<void> {
    const file = files[0];
    if (!file) return;
    this._error = null;

    const BarcodeDetectorCtor = window.BarcodeDetector;
    if (!BarcodeDetectorCtor) {
      this._error =
        "Barcode scanning isn't supported in this browser (try Chrome or Edge on Android) - use Scan Box Photo instead.";
      return;
    }

    this._scanningBarcode = true;
    try {
      const bitmap = await createImageBitmap(file);
      const detector = new BarcodeDetectorCtor({
        formats: ["upc_a", "upc_e", "ean_13", "ean_8"],
      });
      const results = await detector.detect(bitmap);
      if (results.length === 0) {
        this._error = "Couldn't read a barcode in that photo - try again with it in sharper focus.";
        return;
      }
      const scanned = await cacheApi.lookupAmmoBarcode(this.hass, results[0].rawValue);
      this._mergeScannedFields(scanned);
    } catch (err) {
      this._error = err instanceof Error ? err.message : "Failed to scan barcode";
    } finally {
      this._scanningBarcode = false;
    }
  }

  private _openAdjust(ammo: Ammunition, mode: "add" | "remove"): void {
    this._adjustTarget = { ammo, mode };
    this._adjustAmount = "";
    this._adjustUnit = "rounds";
    this._adjustNote = "";
  }

  private async _confirmAdjust(): Promise<void> {
    if (!this._adjustTarget || !this._adjustAmount) return;
    const entered = Number(this._adjustAmount);
    const roundsPerBox = this._adjustTarget.ammo.roundsPerBox;
    const amount = this._adjustUnit === "boxes" && roundsPerBox ? entered * roundsPerBox : entered;
    try {
      if (this._adjustTarget.mode === "add") {
        await cacheApi.addAmmoQuantity(this.hass, this._adjustTarget.ammo.id, amount, this._adjustNote || undefined);
      } else {
        await cacheApi.removeAmmoQuantity(
          this.hass,
          this._adjustTarget.ammo.id,
          amount,
          this._adjustNote || undefined
        );
      }
      this._adjustTarget = null;
      this._adjustAmount = "";
      this._adjustUnit = "rounds";
      this._adjustNote = "";
    } catch {
      // Leave dialog open on failure - user's amount/note stays filled in.
    }
  }

  private async _confirmDelete(): Promise<void> {
    if (!this._deleteTarget) return;
    await cacheApi.deleteAmmunition(this.hass, this._deleteTarget.id);
    this._deleteTarget = null;
  }

  render() {
    const items = this._filtered;
    return html`
      <div class="toolbar">
        <h1 style="margin:0;font-size:1.4rem;font-weight:600">Ammunition</h1>
        <button class="primary" @click=${this._openAdd}>+ Add Ammunition</button>
      </div>

      <div class="filters">
        <input
          placeholder="Search by caliber, manufacturer..."
          .value=${this._search}
          @input=${(e: Event) => (this._search = (e.target as HTMLInputElement).value)}
        />
        <div class="checkbox-row" style="margin:0">
          <input
            type="checkbox"
            .checked=${this._lowOnly}
            @change=${(e: Event) => (this._lowOnly = (e.target as HTMLInputElement).checked)}
          />
          <label style="margin:0">Low inventory only</label>
        </div>
      </div>

      ${items.length === 0
        ? html`<div class="empty">
            ${this._search || this._lowOnly ? "No ammunition matches your search." : "No ammunition tracked yet."}
          </div>`
        : html`
            <div class="grid">
              ${items.map(
                (a) => html`
                  <ha-card class="ammo ${this._menuFor === a.id ? "menu-open" : ""}">
                    <div class="ammo-header">
                      <div>
                        <div style="font-weight:600">${a.caliber}</div>
                        <div class="small muted">
                          ${[a.manufacturer, a.productName, a.bulletWeight, a.bulletType, a.muzzleVelocity]
                            .filter(Boolean)
                            .join(" · ") || "—"}
                        </div>
                      </div>
                      <div class="header-icons">
                        ${a.isLow
                          ? html`<ha-icon icon="mdi:alert" title="Low inventory" style="color:#f57f17"></ha-icon>`
                          : ""}
                        <div class="card-menu">
                          <button
                            class="icon bare"
                            title="More options"
                            aria-label="More options"
                            aria-haspopup="menu"
                            aria-expanded=${this._menuFor === a.id ? "true" : "false"}
                            @click=${() => (this._menuFor = this._menuFor === a.id ? null : a.id)}
                          >
                            <ha-icon icon="mdi:dots-vertical"></ha-icon>
                          </button>
                          ${this._menuFor === a.id
                            ? html`<div class="menu" role="menu">
                                <button role="menuitem" @click=${() => this._menuAction(() => this._openEdit(a))}>
                                  <ha-icon icon="mdi:pencil"></ha-icon>Edit
                                </button>
                                <button
                                  role="menuitem"
                                  class="danger"
                                  @click=${() => this._menuAction(() => (this._deleteTarget = a))}
                                >
                                  <ha-icon icon="mdi:delete"></ha-icon>Delete
                                </button>
                              </div>`
                            : ""}
                        </div>
                      </div>
                    </div>
                    <div class="qty-row">
                      <div class="qty">${formatNumber(a.quantity)} <small>rounds</small></div>
                      <div class="qty-buttons">
                        <button
                          class="icon"
                          title="Remove rounds"
                          aria-label="Remove rounds"
                          @click=${() => this._openAdjust(a, "remove")}
                        >
                          <ha-icon icon="mdi:minus"></ha-icon>
                        </button>
                        <button
                          class="icon"
                          title="Add rounds"
                          aria-label="Add rounds"
                          @click=${() => this._openAdjust(a, "add")}
                        >
                          <ha-icon icon="mdi:plus"></ha-icon>
                        </button>
                      </div>
                    </div>
                    <div class="chips">
                      ${a.storageLocationName ? html`<span class="badge">${a.storageLocationName}</span>` : ""}
                      ${a.costPerRound != null
                        ? html`<span class="badge info">${formatCurrency(a.costPerRound)}/rd</span>`
                        : ""}
                      ${a.speedClass ? html`<span class="badge">${a.speedClass}</span>` : ""}
                    </div>
                  </ha-card>
                `
              )}
            </div>
          `}

      <cache-dialog
        .open=${this._formOpen}
        .heading=${this._editing ? "Edit Ammunition" : "Add Ammunition"}
        width="480px"
        @cache-dialog-closed=${() => (this._formOpen = false)}
      >
        ${this._error ? html`<div class="error-banner">${this._error}</div>` : ""}
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:12px">
          <cache-image-source-button
            label="Scan Box Photo"
            busyLabel="Scanning..."
            icon="mdi:camera"
            capture="environment"
            ?disabled=${this._scanning}
            @cache-image-selected=${(e: CustomEvent<{ files: File[] }>) => void this._handleScanFile(e.detail.files)}
            @cache-image-error=${(e: CustomEvent<{ message: string }>) => (this._error = e.detail.message)}
          ></cache-image-source-button>
          <cache-image-source-button
            label="Scan Barcode"
            busyLabel="Looking up..."
            icon="mdi:barcode-scan"
            capture="environment"
            ?disabled=${this._scanningBarcode}
            @cache-image-selected=${(e: CustomEvent<{ files: File[] }>) => void this._handleBarcodeFile(e.detail.files)}
            @cache-image-error=${(e: CustomEvent<{ message: string }>) => (this._error = e.detail.message)}
          ></cache-image-source-button>
        </div>
        <div class="field-row">
          <div>
            <label>Caliber</label>
            <input list="ammo-caliber-list" .value=${this._draft.caliber} @input=${(e: Event) => (this._draft = { ...this._draft, caliber: (e.target as HTMLInputElement).value })} />
            <datalist id="ammo-caliber-list">
              ${knownCalibers(this.cacheState).map((c) => html`<option value=${c}></option>`)}
            </datalist>
          </div>
          <div>
            <label>Manufacturer</label>
            <input list="ammo-manufacturer-list" .value=${this._draft.manufacturer} @input=${(e: Event) => (this._draft = { ...this._draft, manufacturer: (e.target as HTMLInputElement).value })} />
            <datalist id="ammo-manufacturer-list">
              ${knownManufacturers(this.cacheState).map((m) => html`<option value=${m}></option>`)}
            </datalist>
          </div>
        </div>
        <div class="field-row">
          <div>
            <label>Product Name (optional)</label>
            <input placeholder="e.g. Gold Medal Match" .value=${this._draft.productName} @input=${(e: Event) => (this._draft = { ...this._draft, productName: (e.target as HTMLInputElement).value })} />
          </div>
          <div>
            <label>Muzzle Velocity (optional)</label>
            <input placeholder="e.g. 2100 fps" .value=${this._draft.muzzleVelocity} @input=${(e: Event) => (this._draft = { ...this._draft, muzzleVelocity: (e.target as HTMLInputElement).value })} />
          </div>
        </div>
        <div class="field-row">
          <div>
            <label>Bullet Weight</label>
            <input placeholder="e.g. 55gr" .value=${this._draft.bulletWeight} @input=${(e: Event) => (this._draft = { ...this._draft, bulletWeight: (e.target as HTMLInputElement).value })} />
          </div>
          <div>
            <label>Bullet Type</label>
            <input placeholder="e.g. FMJ" .value=${this._draft.bulletType} @input=${(e: Event) => (this._draft = { ...this._draft, bulletType: (e.target as HTMLInputElement).value })} />
          </div>
        </div>
        ${!this._editing
          ? html`<label>Starting Quantity</label>
              <input type="number" .value=${this._draft.quantity} @input=${(e: Event) => (this._draft = { ...this._draft, quantity: (e.target as HTMLInputElement).value })} />`
          : ""}
        <div class="field-row">
          <div>
            <label>Cost Per Box (optional)</label>
            <input type="number" step="0.01" placeholder="e.g. 20.00" .value=${this._draft.costPerBox} @input=${(e: Event) => (this._draft = { ...this._draft, costPerBox: (e.target as HTMLInputElement).value })} />
          </div>
          <div>
            <label>Rounds Per Box (optional)</label>
            <input type="number" placeholder="e.g. 50" .value=${this._draft.roundsPerBox} @input=${(e: Event) => (this._draft = { ...this._draft, roundsPerBox: (e.target as HTMLInputElement).value })} />
          </div>
        </div>
        ${(() => {
          const cpr = computedCostPerRound(this._draft.costPerBox, this._draft.roundsPerBox);
          return cpr != null
            ? html`<p class="small muted" style="margin-top:-8px">≈ ${formatCurrency(cpr)}/round</p>`
            : "";
        })()}
        <label>Purchase Date</label>
        <input type="date" .value=${this._draft.purchaseDate} @input=${(e: Event) => (this._draft = { ...this._draft, purchaseDate: (e.target as HTMLInputElement).value })} />
        <label>Low Inventory Alert Threshold</label>
        <input type="number" placeholder="Leave blank to use the Settings default" .value=${this._draft.lowInventoryThreshold} @input=${(e: Event) => (this._draft = { ...this._draft, lowInventoryThreshold: (e.target as HTMLInputElement).value })} />
        <label>Storage Location</label>
        <select .value=${this._draft.storageLocationId} @change=${(e: Event) => (this._draft = { ...this._draft, storageLocationId: (e.target as HTMLSelectElement).value })}>
          <option value="">Unassigned</option>
          ${this.cacheState.storageLocations.map((l) => html`<option value=${l.id} ?selected=${l.id === this._draft.storageLocationId}>${l.name}</option>`)}
        </select>
        <label>Notes</label>
        <textarea .value=${this._draft.notes} @input=${(e: Event) => (this._draft = { ...this._draft, notes: (e.target as HTMLTextAreaElement).value })}></textarea>
        <div class="actions">
          <button class="secondary" @click=${() => (this._formOpen = false)}>Cancel</button>
          <button class="primary" ?disabled=${!this._draft.caliber} @click=${this._save}>
            ${this._editing ? "Save Changes" : "Add Ammunition"}
          </button>
        </div>
      </cache-dialog>

      <cache-dialog
        .open=${!!this._adjustTarget}
        .heading=${this._adjustTarget ? `${this._adjustTarget.mode === "add" ? "Add" : "Remove"} ${this._adjustTarget.ammo.caliber} Rounds` : ""}
        width="380px"
        @cache-dialog-closed=${() => (this._adjustTarget = null)}
      >
        <p class="small muted">Current quantity: ${formatNumber(this._adjustTarget?.ammo.quantity)}</p>
        ${this._adjustTarget?.ammo.roundsPerBox
          ? html`
              <label>Add by</label>
              <select
                .value=${this._adjustUnit}
                @change=${(e: Event) => (this._adjustUnit = (e.target as HTMLSelectElement).value as "rounds" | "boxes")}
              >
                <option value="rounds" ?selected=${this._adjustUnit === "rounds"}>Rounds</option>
                <option value="boxes" ?selected=${this._adjustUnit === "boxes"}>
                  Boxes (${this._adjustTarget.ammo.roundsPerBox}/box)
                </option>
              </select>
            `
          : ""}
        <label>${this._adjustUnit === "boxes" ? "Number of Boxes" : "Quantity (rounds)"}</label>
        <input type="number" .value=${this._adjustAmount} @input=${(e: Event) => (this._adjustAmount = (e.target as HTMLInputElement).value)} />
        ${this._adjustUnit === "boxes" && this._adjustAmount && this._adjustTarget?.ammo.roundsPerBox
          ? html`<p class="small muted">
              = ${formatNumber(Number(this._adjustAmount) * this._adjustTarget.ammo.roundsPerBox)} rounds
            </p>`
          : ""}
        <label>Note (optional)</label>
        <input .value=${this._adjustNote} @input=${(e: Event) => (this._adjustNote = (e.target as HTMLInputElement).value)} />
        <div class="actions">
          <button class="secondary" @click=${() => (this._adjustTarget = null)}>Cancel</button>
          <button class="primary" ?disabled=${!this._adjustAmount} @click=${this._confirmAdjust}>
            ${this._adjustTarget?.mode === "add" ? "Add" : "Remove"}
          </button>
        </div>
      </cache-dialog>

      <cache-dialog
        .open=${!!this._deleteTarget}
        heading="Delete Ammunition"
        width="380px"
        @cache-dialog-closed=${() => (this._deleteTarget = null)}
      >
        <p>Delete ${this._deleteTarget?.caliber}? This cannot be undone.</p>
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
    "cache-ammunition-view": CacheAmmunitionView;
  }
}
