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
      /* Wider than the shared .grid's 260px minimum - a caliber card holds
         several loads per row, and narrow columns made every name wrap. */
      .ammo-grid {
        grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr));
        align-items: start;
      }
      ha-card.ammo {
        padding: 16px 18px 6px;
      }
      ha-card.ammo.menu-open {
        z-index: 5;
      }
      /* One card per caliber: a header (caliber, total rounds), then one
         compact row per load - text on the left, count and -/+/menu on the
         right. Plain muted text instead of chips keeps rows quiet. */
      .caliber-head {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 12px;
        padding-bottom: 12px;
        border-bottom: 1px solid var(--divider-color, rgba(255, 255, 255, 0.1));
      }
      .caliber-name {
        font-weight: 700;
        font-size: 1.1rem;
        letter-spacing: 0.01em;
      }
      .caliber-sub {
        margin-left: 8px;
        font-size: 0.8rem;
        color: var(--secondary-text-color, #a1a7b0);
      }
      .caliber-total {
        display: flex;
        align-items: center;
        gap: 6px;
        white-space: nowrap;
        font-size: 1.5rem;
        font-weight: 700;
      }
      .caliber-total small {
        font-size: 0.8rem;
        font-weight: 400;
        color: var(--secondary-text-color, #a1a7b0);
      }
      .low-icon {
        color: var(--hud-amber, #f5a524);
        --mdc-icon-size: 18px;
      }
      .ammo-line {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto auto;
        align-items: center;
        gap: 12px;
        padding: 12px 0;
      }
      .ammo-line + .ammo-line {
        border-top: 1px solid color-mix(in srgb, var(--divider-color, rgba(255, 255, 255, 0.1)) 60%, transparent);
      }
      .line-name {
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .line-meta {
        margin-top: 2px;
        font-size: 0.8rem;
        line-height: 1.35;
        color: var(--secondary-text-color, #a1a7b0);
      }
      .line-meta.dim {
        opacity: 0.75;
      }
      .line-qty {
        font-size: 1.1rem;
        font-weight: 700;
        white-space: nowrap;
        text-align: right;
        min-width: 3ch;
      }
      .line-qty.low {
        color: var(--hud-amber, #f5a524);
      }
      .line-actions {
        display: flex;
        align-items: center;
        gap: 2px;
      }
      .line-actions button.icon {
        width: 28px;
        height: 28px;
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

  /** One card per caliber. Calibers are free text, so "9mm"/"9MM " share a
   * card (keyed trimmed + lowercased, labelled by the first spelling seen);
   * a genuinely different spelling like "9x19" stays separate. Cards are
   * sorted by caliber; loads within a card by manufacturer/product. */
  private _groupByCaliber(items: Ammunition[]): { caliber: string; loads: Ammunition[] }[] {
    const groups = new Map<string, { caliber: string; loads: Ammunition[] }>();
    for (const a of items) {
      const key = a.caliber.trim().toLowerCase();
      const group = groups.get(key) ?? { caliber: a.caliber.trim(), loads: [] };
      group.loads.push(a);
      groups.set(key, group);
    }
    const label = (a: Ammunition) => [a.manufacturer, a.productName].filter(Boolean).join(" ");
    for (const g of groups.values()) g.loads.sort((x, y) => label(x).localeCompare(label(y)));
    return [...groups.values()].sort((x, y) => x.caliber.localeCompare(y.caliber));
  }

  private _renderCaliberCard(g: { caliber: string; loads: Ammunition[] }) {
    const total = g.loads.reduce((sum, a) => sum + a.quantity, 0);
    const anyLow = g.loads.some((a) => a.isLow);
    const menuOpen = g.loads.some((a) => a.id === this._menuFor);
    return html`
      <ha-card class="ammo ${menuOpen ? "menu-open" : ""}">
        <div class="caliber-head">
          <div>
            <span class="caliber-name">${g.caliber}</span>
            ${g.loads.length > 1 ? html`<span class="caliber-sub">${g.loads.length} loads</span>` : ""}
          </div>
          <div class="caliber-total">
            ${anyLow ? html`<ha-icon icon="mdi:alert" title="Some of this caliber is low" class="low-icon"></ha-icon>` : ""}
            ${formatNumber(total)}<small>rounds</small>
          </div>
        </div>
        ${g.loads.map((a) => this._renderLoad(a))}
      </ha-card>
    `;
  }

  /** One load = one row: name, a specs line (weight/type/velocity), a
   * details line (location/$ per round/speed class), then the count (amber
   * when low) and bare -/+/menu buttons. */
  private _renderLoad(a: Ammunition) {
    const name = [a.manufacturer, a.productName].filter(Boolean).join(" ") || "Unspecified";
    const specs = [a.bulletWeight, a.bulletType, a.muzzleVelocity].filter(Boolean).join(" · ");
    const details = [
      a.storageLocationName,
      a.costPerRound != null ? `${formatCurrency(a.costPerRound)}/rd` : null,
      a.speedClass,
    ]
      .filter(Boolean)
      .join(" · ");
    return html`
      <div class="ammo-line">
        <div>
          <div class="line-name" title=${name}>${name}</div>
          ${specs ? html`<div class="line-meta">${specs}</div>` : ""}
          ${details ? html`<div class="line-meta dim">${details}</div>` : ""}
        </div>
        <div class="line-qty ${a.isLow ? "low" : ""}" title=${a.isLow ? "Low inventory" : ""}>
          ${formatNumber(a.quantity)}
        </div>
        <div class="line-actions">
          <button class="icon bare" title="Remove rounds" aria-label="Remove rounds" @click=${() => this._openAdjust(a, "remove")}>
            <ha-icon icon="mdi:minus"></ha-icon>
          </button>
          <button class="icon bare" title="Add rounds" aria-label="Add rounds" @click=${() => this._openAdjust(a, "add")}>
            <ha-icon icon="mdi:plus"></ha-icon>
          </button>
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
                  <button role="menuitem" class="danger" @click=${() => this._menuAction(() => (this._deleteTarget = a))}>
                    <ha-icon icon="mdi:delete"></ha-icon>Delete
                  </button>
                </div>`
              : ""}
          </div>
        </div>
      </div>
    `;
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
            <div class="grid ammo-grid">
              ${this._groupByCaliber(items).map((g) => this._renderCaliberCard(g))}
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
