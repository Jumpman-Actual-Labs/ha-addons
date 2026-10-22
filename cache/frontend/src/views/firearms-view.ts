import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { cacheApi } from "../ha-api";
import type { CacheState, Firearm, InventoryItem, UsedValueEstimate } from "../types";
import { installedBySlot } from "../utils/installed-items";
import { firearmHeroImage } from "../utils/hero-image";
import { CONDITIONS, FIREARM_TYPES, FIREARM_USES, NFA_FIREARM_TYPES } from "../types";
import { glassCardStyle, formStyles } from "../styles";
import { formatCurrency, formatDate, formatNumber, todayIso } from "../utils/format";
import { knownCalibers, knownManufacturers } from "../utils/options";
import "../components/cache-dialog";
import "../components/photo-manager-section";
import "../components/image-source-button";
import "../components/document-manager-dialog";
import "../components/log-range-session-dialog";
import "../components/attachment-bar";
import "../components/slot-modal";
import "../components/wishlist-reorder-dialog";

interface FirearmDraft {
  customName: string;
  manufacturer: string;
  model: string;
  serialNumber: string;
  firearmType: string;
  caliber: string;
  barrelLength: string;
  overallLength: string;
  weight: string;
  twistRate: string;
  capacity: string;
  finish: string;
  color: string;
  condition: string;
  purchaseDate: string;
  purchasePrice: string;
  currentEstimatedValue: string;
  purchasedFrom: string;
  warrantyExpiration: string;
  warrantyNotes: string;
  productUrl: string;
  uses: string[];
  storageLocationId: string;
  notes: string;
  isWishlist: boolean;
}

const EMPTY_DRAFT: FirearmDraft = {
  customName: "",
  manufacturer: "",
  model: "",
  serialNumber: "",
  firearmType: "Rifle",
  caliber: "",
  barrelLength: "",
  overallLength: "",
  weight: "",
  twistRate: "",
  capacity: "",
  finish: "",
  color: "",
  condition: "",
  purchaseDate: "",
  purchasePrice: "",
  currentEstimatedValue: "",
  purchasedFrom: "",
  warrantyExpiration: "",
  warrantyNotes: "",
  productUrl: "",
  uses: [],
  storageLocationId: "",
  notes: "",
  isWishlist: false,
};

function draftFromFirearm(f: Firearm): FirearmDraft {
  return {
    customName: f.customName,
    manufacturer: f.manufacturer ?? "",
    model: f.model ?? "",
    serialNumber: f.serialNumber ?? "",
    firearmType: f.firearmType,
    caliber: f.caliber ?? "",
    barrelLength: f.barrelLength ?? "",
    overallLength: f.overallLength ?? "",
    weight: f.weight ?? "",
    twistRate: f.twistRate ?? "",
    capacity: f.capacity ?? "",
    finish: f.finish ?? "",
    color: f.color ?? "",
    condition: f.condition ?? "",
    purchaseDate: f.purchaseDate ?? "",
    purchasePrice: f.purchasePrice?.toString() ?? "",
    currentEstimatedValue: f.currentEstimatedValue?.toString() ?? "",
    purchasedFrom: f.purchasedFrom ?? "",
    warrantyExpiration: f.warrantyExpiration ?? "",
    warrantyNotes: f.warrantyNotes ?? "",
    productUrl: f.productUrl ?? "",
    uses: [...f.uses],
    storageLocationId: f.storageLocationId ?? "",
    notes: f.notes ?? "",
    isWishlist: f.isWishlist,
  };
}

function draftToPayload(d: FirearmDraft): Record<string, unknown> {
  return {
    custom_name: d.customName,
    firearm_type: d.firearmType,
    manufacturer: d.manufacturer || "",
    model: d.model || "",
    serial_number: d.serialNumber || "",
    caliber: d.caliber || "",
    barrel_length: d.barrelLength || "",
    overall_length: d.overallLength || "",
    weight: d.weight || "",
    twist_rate: d.twistRate || "",
    capacity: d.capacity || "",
    finish: d.finish || "",
    color: d.color || "",
    condition: d.condition || "",
    purchase_date: d.purchaseDate || "",
    purchase_price: d.purchasePrice === "" ? "" : Number(d.purchasePrice),
    current_estimated_value: d.currentEstimatedValue === "" ? "" : Number(d.currentEstimatedValue),
    purchased_from: d.purchasedFrom || "",
    warranty_expiration: d.warrantyExpiration || "",
    warranty_notes: d.warrantyNotes || "",
    product_url: d.productUrl || "",
    uses: d.uses,
    storage_location_id: d.storageLocationId || "",
    notes: d.notes || "",
    // wishlist_rank isn't sent here - it's not a plain settable field.
    // coordinator.async_add_firearm/async_update_firearm auto-assign it
    // the moment is_wishlist becomes true and clear it the moment it
    // becomes false again; the only way to REORDER existing ranks is the
    // dedicated reorder_wishlist_firearms service (wishlist-reorder-
    // dialog.ts), never this form.
    is_wishlist: d.isWishlist,
  };
}

@customElement("cache-firearms-view")
export class CacheFirearmsView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) cacheState!: CacheState;
  @property({ type: String }) initialFirearmId: string | null = null;
  // Set (once) by dashboard-view.ts's Wishlist panel "View Wishlist" link
  // via cache-panel.ts's cache-switch-tab wishlist flag, to land directly
  // on the Wishlist segment instead of the default Owned one.
  @property({ type: Boolean }) initialWishlistFilter = false;
  /** Preset filter from the dashboard's Armory Status (see cache-panel's
   * _pendingFilter): "cleaning-due" or "nfa". Shown as a removable chip. */
  @property({ type: String }) initialFilter: string | null = null;
  @state() private _preset: "cleaning-due" | "nfa" | null = null;

  @state() private _search = "";
  @state() private _typeFilter = "";
  @state() private _conditionFilter = "";
  @state() private _wishlistFilter: "owned" | "wishlist" | "all" = "owned";
  @state() private _sort: "custom_name" | "purchase_date" | "current_estimated_value" | "lifetime_round_count" = "custom_name";
  @state() private _selectedId: string | null = null;
  // Detail page's Estimated Value / Purchase Price stat buttons - reset
  // to collapsed whenever a different firearm is opened (willUpdate),
  // rather than carrying an expanded state over to a firearm that wasn't
  // the one it was opened on.
  @state() private _valueExpanded = false;
  @state() private _priceExpanded = false;
  // AI used-value estimate flow (cacheApi.estimateUsedValue) - also reset
  // on firearm switch, same as the two stat buttons above.
  @state() private _estimating = false;
  @state() private _valueEstimate: UsedValueEstimate | null = null;
  @state() private _estimateError: string | null = null;

  @state() private _formOpen = false;
  @state() private _editing: Firearm | null = null;
  @state() private _draft: FirearmDraft = { ...EMPTY_DRAFT };
  @state() private _error: string | null = null;

  // Staged (not yet uploaded) photos for the Add Firearm form - a
  // brand-new firearm has no id yet, so nothing can actually upload
  // until _save() creates the record and gets one back. Unused while
  // editing an existing firearm, which uploads live instead (see the
  // Photos section's two branches in _renderForm()).
  @state() private _addPhotoFiles: File[] = [];
  @state() private _savingPhotos = false;

  @state() private _rangeOpen = false;
  @state() private _addRoundsOpen = false;
  @state() private _removeRoundsOpen = false;
  @state() private _roundsAmount = "";
  @state() private _cleanedOpen = false;
  @state() private _cleanedDate = todayIso();
  @state() private _cleanedNotes = "";
  @state() private _docsOpen = false;
  @state() private _deleteTarget: Firearm | null = null;
  @state() private _activeSlot: string | null = null;
  @state() private _markPurchasedOpen = false;
  @state() private _purchaseDate = todayIso();
  @state() private _purchasePrice = "";
  @state() private _reorderOpen = false;

  private _onSlotClick = (e: CustomEvent<{ slotType: string }>): void => {
    this._activeSlot = e.detail.slotType;
  };

  static styles = [
    glassCardStyle,
    formStyles,
    css`
      /* The firearm grid gets its own explicit column-count breakpoints
         (large desktop 4 / medium desktop-tablet-landscape 3 / tablet 2 /
         mobile 1) rather than reusing the shared auto-fit .grid from
         styles.ts - that one is tuned for panel/list content elsewhere
         in the app (dashboard bars, settings cards) where "as many
         columns as fit" is the right behavior; a photo-forward card grid
         wants a firm, intentional column count at each size instead. */
      .firearms-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 22px;
      }
      @media (max-width: 1100px) {
        .firearms-grid {
          grid-template-columns: repeat(3, 1fr);
        }
      }
      @media (max-width: 760px) {
        .firearms-grid {
          grid-template-columns: repeat(2, 1fr);
        }
      }
      @media (max-width: 480px) {
        .firearms-grid {
          grid-template-columns: 1fr;
        }
      }
      ha-card.firearm {
        padding: 0;
        overflow: hidden;
        cursor: pointer;
      }
      /* Interactive but restrained - a small lift, a touch more border/
         fill, no glow. --ha-card-* custom properties are what
         glassCardStyle's ha-card rule actually reads for background/
         border/shadow (its own shadow-DOM internals consume them), so
         redefining them here at a higher specificity (:hover) is how an
         outside caller changes them conditionally; transform is a plain
         property this component fully controls, so it transitions
         smoothly via the base rule's own transition. */
      ha-card.firearm:hover {
        --ha-card-border-color: var(--hud-border-hover, rgba(255, 255, 255, 0.16));
        --ha-card-background: color-mix(in srgb, var(--card-background-color, #16181b) 78%, transparent);
        --ha-card-box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08), inset 0 -14px 22px -18px rgba(0, 0, 0, 0.24),
          0 3px 10px rgba(0, 0, 0, 0.22), 0 20px 42px -14px rgba(0, 0, 0, 0.4);
        transform: translateY(-2px);
      }
      /* Higher specificity than the plain .firearm:hover rule above (3
         classes vs. 2), so a wishlist card's purple tint survives hover
         instead of being clobbered by the neutral background it sets -
         see styles.ts's ha-card.wishlist rule for the resting-state
         version this reinforces. */
      ha-card.firearm.wishlist:hover {
        --ha-card-border-color: color-mix(in srgb, var(--hud-purple, #a78bfa) 50%, transparent);
        --ha-card-background: color-mix(in srgb, var(--hud-purple, #a78bfa) 14%, var(--card-background-color, #16181b));
      }
      /* A slightly different glass opacity than .firearm-body below it -
         a soft top-lit gradient rather than a flat fill - plus a
         barely-visible divider, so the image reads as a distinct "case"
         the firearm sits in without boxing it in an obvious frame. Taller
         than before (was 170px) to give the image more visual weight. */
      .firearm-image-wrap {
        position: relative;
        height: 196px;
        display: flex;
        align-items: center;
        justify-content: center;
        background: linear-gradient(180deg, rgba(255, 255, 255, 0.025), rgba(0, 0, 0, 0.1));
        border-bottom: 1px solid rgba(255, 255, 255, 0.05);
      }
      /* object-fit: contain never crops the source image - it only ever
         letterboxes - so if a photo still reads as cramped against the
         card edges, the cause is the photo file itself being framed
         tight against its own canvas (the AI background-removal step
         used to do this; its prompt now asks for a margin - see
         the backend's openai_client.py). This padding is a
         second, independent line of defense: guaranteed breathing room
         around whatever the source image contains, regardless of how
         tightly it happens to be framed. */
      .firearm-image {
        width: 100%;
        height: 100%;
        object-fit: contain;
        padding: 22px;
        box-sizing: border-box;
        display: block;
        transition: transform 220ms ease;
      }
      ha-card.firearm:hover .firearm-image {
        transform: scale(1.015);
      }
      .firearm-image-placeholder {
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .cleaning-flag {
        position: absolute;
        top: 10px;
        right: 10px;
        width: 30px;
        height: 30px;
        border-radius: 50%;
        background: rgba(10, 10, 11, 0.6);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        border: 1px solid rgba(255, 255, 255, 0.1);
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .firearm-body {
        padding: 14px 16px 16px;
      }
      .firearm-name {
        font-size: 1rem;
        font-weight: 600;
        color: var(--primary-text-color, #f2f4f6);
      }
      .chips {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        margin-top: 8px;
      }
      .row-bottom {
        display: flex;
        justify-content: space-between;
        margin-top: 10px;
        font-size: 0.8rem;
        color: var(--secondary-text-color, #727272);
      }
      .row-bottom span:last-child {
        color: var(--primary-text-color, #f2f4f6);
        font-weight: 600;
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
      .detail-card {
        padding: 20px;
      }
      .detail-header {
        display: flex;
        gap: 20px;
      }
      /* object-fit: contain, not cover - a firearm silhouette is
         typically much wider than it is tall, and cover would scale it
         to FILL this fixed square box, cropping the stock and/or muzzle
         off the sides to do it. contain letterboxes instead, showing
         the whole firearm regardless of its aspect ratio. */
      .detail-photo {
        width: 160px;
        height: 160px;
        border-radius: 16px;
        object-fit: contain;
        padding: 10px;
        box-sizing: border-box;
        background: var(--secondary-background-color, #eee);
        flex-shrink: 0;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      /* Below 600px .detail-header's photo+text row has no room left for
         the text column once the fixed 160px photo and its 20px gap are
         taken out - the title/badges/fields all get squeezed into a
         sliver and wrap awkwardly. Stack instead, same breakpoint
         reasoning as .firearms-grid going single-column at 480px, just a
         little wider since a single centered photo + full-width text
         needs less room to look right than a 2-column card grid does. */
      @media (max-width: 600px) {
        .detail-header {
          flex-direction: column;
        }
        .detail-photo {
          width: 100%;
          height: auto;
          aspect-ratio: 1;
          max-width: 280px;
          margin: 0 auto;
        }
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
      /* Estimated Value / Purchase Price as clickable disclosure buttons
         rather than plain .field entries - each toggles a breakdown of
         the firearm's own value/price plus every owned installed part's,
         matching how f.effectiveEstimatedValue is actually computed on
         the backend instead of just showing the opaque total. */
      .value-stats {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin-top: 12px;
      }
      .value-stat {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 180px;
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid var(--hud-border, rgba(255, 255, 255, 0.08));
        border-radius: var(--hud-radius-sm, 8px);
        padding: 10px 14px;
        cursor: pointer;
        text-align: left;
        color: inherit;
        font: inherit;
      }
      .value-stat:hover {
        border-color: var(--hud-border-hover, rgba(255, 255, 255, 0.16));
      }
      .value-stat .stat-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .value-stat label {
        margin: 0;
        cursor: pointer;
      }
      .value-stat ha-icon {
        --mdc-icon-size: 18px;
        color: var(--secondary-text-color, #727272);
      }
      .value-stat .amount {
        font-size: 1.15rem;
        font-weight: 600;
      }
      .value-breakdown {
        margin-top: 8px;
        padding-top: 8px;
        border-top: 1px solid var(--hud-border, rgba(255, 255, 255, 0.08));
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .value-breakdown .row {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        font-size: 0.85rem;
        font-weight: 400;
        color: var(--secondary-text-color, #727272);
      }
      .value-breakdown .row span:first-child {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .value-breakdown .row.total {
        margin-top: 2px;
        padding-top: 4px;
        border-top: 1px solid var(--hud-border, rgba(255, 255, 255, 0.08));
        color: var(--primary-text-color, #212121);
        font-weight: 600;
      }
      .ai-estimate {
        margin-top: 10px;
      }
      .ai-estimate-result {
        margin-top: 8px;
        padding: 10px 14px;
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid var(--hud-border, rgba(255, 255, 255, 0.08));
        border-radius: var(--hud-radius-sm, 8px);
      }
      .ai-estimate-result > span {
        font-weight: 600;
      }
      .ai-estimate-result button {
        margin-top: 8px;
      }
      section.sub {
        margin-top: 24px;
      }
      section.sub h3 {
        font-size: 0.95rem;
        margin: 0 0 8px;
      }
      .history-row {
        padding: 8px 0;
        border-bottom: 1px solid var(--divider-color, #e0e0e0);
      }
      .history-row:last-child {
        border-bottom: none;
      }
    `,
  ];

  willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("initialFirearmId") && this.initialFirearmId) {
      this._selectedId = this.initialFirearmId;
    }
    if (changed.has("initialWishlistFilter") && this.initialWishlistFilter) {
      this._wishlistFilter = "wishlist";
    }
    if (changed.has("initialFilter") && (this.initialFilter === "cleaning-due" || this.initialFilter === "nfa")) {
      // Both presets are about owned firearms - start from a clean slate so
      // a leftover search/type filter can't hide what the dashboard counted.
      this._preset = this.initialFilter;
      this._wishlistFilter = "owned";
      this._search = "";
      this._typeFilter = "";
      this._conditionFilter = "";
      this._selectedId = null;
    }
    if (changed.has("_selectedId")) {
      this._valueExpanded = false;
      this._priceExpanded = false;
      this._estimating = false;
      this._valueEstimate = null;
      this._estimateError = null;
    }
  }

  private get _filtered(): Firearm[] {
    const s = this._search.toLowerCase();
    let list = this.cacheState.firearms.filter((f) => {
      if (this._wishlistFilter === "owned" && f.isWishlist) return false;
      if (this._wishlistFilter === "wishlist" && !f.isWishlist) return false;
      if (this._typeFilter && f.firearmType !== this._typeFilter) return false;
      if (this._conditionFilter && f.condition !== this._conditionFilter) return false;
      if (this._preset === "cleaning-due" && !f.needsCleaning) return false;
      if (this._preset === "nfa" && !NFA_FIREARM_TYPES.includes(f.firearmType)) return false;
      if (!s) return true;
      return (
        f.customName.toLowerCase().includes(s) ||
        (f.manufacturer ?? "").toLowerCase().includes(s) ||
        (f.model ?? "").toLowerCase().includes(s) ||
        (f.serialNumber ?? "").toLowerCase().includes(s) ||
        (f.caliber ?? "").toLowerCase().includes(s) ||
        (f.notes ?? "").toLowerCase().includes(s) ||
        (f.storageLocationName ?? "").toLowerCase().includes(s)
      );
    });
    list = [...list].sort((a, b) => {
      switch (this._sort) {
        case "purchase_date":
          return (b.purchaseDate ?? "").localeCompare(a.purchaseDate ?? "");
        case "current_estimated_value":
          return (b.effectiveEstimatedValue ?? 0) - (a.effectiveEstimatedValue ?? 0);
        case "lifetime_round_count":
          return b.lifetimeRoundCount - a.lifetimeRoundCount;
        default:
          return a.customName.localeCompare(b.customName);
      }
    });
    return list;
  }

  private _openAdd(): void {
    this._editing = null;
    this._draft = { ...EMPTY_DRAFT };
    this._addPhotoFiles = [];
    this._error = null;
    this._formOpen = true;
  }

  private _openEdit(f: Firearm): void {
    this._editing = f;
    this._draft = draftFromFirearm(f);
    this._error = null;
    this._formOpen = true;
  }

  // Add and Edit diverge here: editing an existing firearm already
  // uploaded/removed photos live, independent of this Save button (see
  // the Photos section), so there's nothing left to do once
  // updateFirearm resolves. Adding a NEW firearm has no id until
  // addFirearm's response gives one back (see ha-api.ts's addFirearm/
  // the backend's services.py) - only then can any staged photo
  // file actually upload; the first one uploaded becomes primary
  // automatically (see coordinator.async_add_photo), so it doubles as the
  // new firearm's hero photo with no separate step. A failed photo
  // upload after a successful create is reported distinctly (the firearm
  // DOES exist by then) and keeps the dialog open, rather than silently
  // discarding the failure or misreporting it as the firearm itself
  // failing to save.
  private async _save(): Promise<void> {
    this._error = null;
    if (this._editing) {
      try {
        await cacheApi.updateFirearm(this.hass, this._editing.id, draftToPayload(this._draft));
        this._formOpen = false;
      } catch (err) {
        this._error = err instanceof Error ? err.message : "Failed to save firearm";
      }
      return;
    }

    let firearmId: string;
    try {
      firearmId = await cacheApi.addFirearm(this.hass, draftToPayload(this._draft));
    } catch (err) {
      this._error = err instanceof Error ? err.message : "Failed to save firearm";
      return;
    }

    if (this._addPhotoFiles.length > 0) {
      this._savingPhotos = true;
      try {
        for (const file of this._addPhotoFiles) {
          await cacheApi.uploadPhoto(this.hass, "firearm", firearmId, file);
        }
      } catch (err) {
        this._savingPhotos = false;
        this._error = `Firearm added, but a photo failed to upload (${
          err instanceof Error ? err.message : "unknown error"
        }) - add it from Edit Firearm instead.`;
        return;
      }
      this._savingPhotos = false;
    }
    this._formOpen = false;
  }

  private _toggleUse(use: string): void {
    const uses = this._draft.uses.includes(use)
      ? this._draft.uses.filter((u) => u !== use)
      : [...this._draft.uses, use];
    this._draft = { ...this._draft, uses };
  }

  private async _confirmDelete(): Promise<void> {
    if (!this._deleteTarget) return;
    await cacheApi.deleteFirearm(this.hass, this._deleteTarget.id);
    this._deleteTarget = null;
    this._selectedId = null;
  }

  private async _submitRounds(mode: "add" | "remove", firearmId: string): Promise<void> {
    const rounds = Number(this._roundsAmount);
    if (!rounds || rounds <= 0) return;
    if (mode === "add") {
      await cacheApi.addRounds(this.hass, firearmId, rounds);
      this._addRoundsOpen = false;
    } else {
      await cacheApi.removeRounds(this.hass, firearmId, rounds);
      this._removeRoundsOpen = false;
    }
    this._roundsAmount = "";
  }

  private async _submitMarkCleaned(firearmId: string): Promise<void> {
    await cacheApi.markCleaned(this.hass, firearmId, this._cleanedDate, this._cleanedNotes || undefined);
    this._cleanedOpen = false;
    this._cleanedDate = todayIso();
    this._cleanedNotes = "";
  }

  // "Mark as Purchased" isn't a dedicated backend service - a wishlist
  // firearm is a normal Firearm record, so "purchasing" it is just
  // clearing is_wishlist via the same update_firearm call the Edit
  // Firearm form already uses, with purchase_date/purchase_price filled
  // in at the same time. is_wishlist: false alone is enough to clear
  // wishlist_rank too - the coordinator does that automatically on the
  // is_wishlist transition, it isn't a field this call sets directly.
  private async _submitMarkPurchased(firearmId: string): Promise<void> {
    await cacheApi.updateFirearm(this.hass, firearmId, {
      is_wishlist: false,
      purchase_date: this._purchaseDate,
      purchase_price: this._purchasePrice === "" ? "" : Number(this._purchasePrice),
    });
    this._markPurchasedOpen = false;
    this._purchaseDate = todayIso();
    this._purchasePrice = "";
  }

  // Owned (non-wishlist) parts currently installed on a firearm - the
  // same population logic.firearm_effective_value sums server-side (a
  // wishlist part previewed on a build shouldn't count as money spent,
  // see that function's own comment on the backend).
  private _ownedInstalledParts(f: Firearm): InventoryItem[] {
    return this.cacheState.inventoryItems.filter(
      (i) => i.installedFirearmId === f.id && !i.isWishlist
    );
  }

  private _renderValueStat(opts: {
    label: string;
    total: number | null;
    rows: { label: string; value: number | null }[];
    expanded: boolean;
    onToggle: () => void;
  }) {
    const { label, total, rows, expanded, onToggle } = opts;
    return html`
      <button
        class="value-stat"
        type="button"
        aria-expanded=${expanded}
        @click=${onToggle}
      >
        <div class="stat-row">
          <label>${label}</label>
          <ha-icon icon=${expanded ? "mdi:chevron-up" : "mdi:chevron-down"}></ha-icon>
        </div>
        <div class="amount">${formatCurrency(total)}</div>
        ${expanded
          ? html`
              <div class="value-breakdown">
                ${rows.map(
                  (r) => html`<div class="row"><span>${r.label}</span><span>${formatCurrency(r.value)}</span></div>`
                )}
                <div class="row total"><span>Total</span><span>${formatCurrency(total)}</span></div>
              </div>
            `
          : ""}
      </button>
    `;
  }

  // Plain text summary fed to cacheApi.estimateUsedValue - only whatever
  // fields are actually on file, so the model isn't asked to reason about
  // blanks.
  private _describeFirearm(f: Firearm): string {
    const parts = [
      f.manufacturer,
      f.model,
      f.firearmType,
      f.caliber ? `${f.caliber} caliber` : null,
      f.condition ? `${f.condition} condition` : null,
    ].filter((p): p is string => Boolean(p));
    return parts.length > 0 ? parts.join(", ") : f.customName;
  }

  private async _estimateValue(f: Firearm): Promise<void> {
    this._estimating = true;
    this._estimateError = null;
    this._valueEstimate = null;
    try {
      this._valueEstimate = await cacheApi.estimateUsedValue(this.hass, this._describeFirearm(f));
    } catch (err) {
      this._estimateError = err instanceof Error ? err.message : "Failed to get an AI estimate";
    } finally {
      this._estimating = false;
    }
  }

  // Applying is a deliberate second click, never automatic - the estimate
  // is a guess, not something that should silently overwrite a real field.
  // Midpoint of the range, rounded to cents; falls back to whichever of
  // the two bounds came back if only one did.
  private async _applyEstimate(f: Firearm): Promise<void> {
    const estimate = this._valueEstimate;
    if (!estimate || (estimate.estimatedLow === null && estimate.estimatedHigh === null)) return;
    const mid =
      estimate.estimatedLow !== null && estimate.estimatedHigh !== null
        ? (estimate.estimatedLow + estimate.estimatedHigh) / 2
        : (estimate.estimatedLow ?? estimate.estimatedHigh)!;
    await cacheApi.updateFirearm(this.hass, f.id, { current_estimated_value: Math.round(mid * 100) / 100 });
    this._valueEstimate = null;
  }

  private _renderValueEstimate(f: Firearm) {
    return html`
      <div class="ai-estimate">
        <button
          class="secondary"
          type="button"
          ?disabled=${this._estimating}
          @click=${() => this._estimateValue(f)}
        >
          ${this._estimating ? "Estimating…" : "Get AI Used-Value Estimate"}
        </button>
        ${this._estimateError ? html`<p class="small muted">${this._estimateError}</p>` : ""}
        ${this._valueEstimate
          ? this._valueEstimate.estimatedLow === null && this._valueEstimate.estimatedHigh === null
            ? html`<p class="small muted">The AI couldn't estimate this item confidently - try filling in more details (manufacturer, model, condition) and edit the value by hand instead.</p>`
            : html`
                <div class="ai-estimate-result">
                  <span>
                    AI estimate: ${formatCurrency(this._valueEstimate.estimatedLow)} –
                    ${formatCurrency(this._valueEstimate.estimatedHigh)}${this._valueEstimate.confidence
                      ? ` (${this._valueEstimate.confidence} confidence)`
                      : ""}
                  </span>
                  <p class="small muted">Based on general knowledge, not live market data - review before applying.</p>
                  <button class="secondary" type="button" @click=${() => this._applyEstimate(f)}>
                    Apply to Estimated Value
                  </button>
                </div>
              `
          : ""}
      </div>
    `;
  }

  private _renderDetail(f: Firearm) {
    const heroPhoto = firearmHeroImage(this.cacheState, f);
    const rangeSessions = this.cacheState.rangeSessions.filter((s) =>
      s.firearms.some((entry) => entry.firearmId === f.id)
    );

    // Estimated Value mirrors the backend's firearm_effective_value: the
    // firearm's own estimate-or-purchase-price, plus each owned installed
    // part's own estimate-or-purchase-price - f.effectiveEstimatedValue
    // IS that backend-computed total, these rows are only the breakdown
    // of what it's made of. Purchase Price has no backend-computed
    // aggregate counterpart, so its total is summed client-side purely
    // for this display, from the same "own + owned installed parts"
    // population - never sent anywhere.
    const parts = this._ownedInstalledParts(f);
    const valueRows = [
      { label: f.customName, value: f.currentEstimatedValue ?? f.purchasePrice },
      ...parts.map((i) => ({ label: i.customName, value: i.estimatedValue ?? i.purchasePrice })),
    ];
    const priceRows = [
      { label: f.customName, value: f.purchasePrice },
      ...parts.map((i) => ({ label: i.customName, value: i.purchasePrice })),
    ];
    const priceTotal = priceRows.every((r) => r.value === null)
      ? null
      : priceRows.reduce((sum, r) => sum + (r.value ?? 0), 0);

    return html`
      <button class="back-link" @click=${() => (this._selectedId = null)}>
        <ha-icon icon="mdi:arrow-left"></ha-icon> Back to Firearms
      </button>
      <ha-card class="detail-card">
        <div class="detail-header">
          ${heroPhoto
            ? html`<img class="detail-photo" src=${heroPhoto} alt=${f.customName} />`
            : html`<div class="detail-photo"><ha-icon icon="mdi:target" style="opacity:0.3;--mdc-icon-size:56px"></ha-icon></div>`}
          <div style="flex:1">
            <h1 style="margin:0 0 4px;font-size:1.5rem">${f.customName}</h1>
            <p class="muted" style="margin:0 0 8px">
              ${[f.manufacturer, f.model].filter(Boolean).join(" ") || "—"} · ${f.firearmType}${f.caliber ? ` · ${f.caliber}` : ""}
            </p>
            <div class="chips">
              ${f.isWishlist
                ? html`<span class="badge wishlist">Wishlist${f.wishlistRank !== null ? ` · #${f.wishlistRank + 1}` : ""}</span>`
                : ""}
              ${f.uses.map((u) => html`<span class="badge info">${u}</span>`)}
            </div>

            <div class="fields" style="margin-top:16px">
              <div class="field"><label>Storage Location</label><div>${f.storageLocationName ?? "Unassigned"}</div></div>
              <div class="field"><label>Round Count</label><div>${formatNumber(f.lifetimeRoundCount)}</div></div>
              <div class="field"><label>Last Fired</label><div>${formatDate(f.lastFiredDate)}</div></div>
              <div class="field"><label>Last Cleaned</label><div>${formatDate(f.lastCleaningDate)}</div></div>
            </div>

            <div class="value-stats">
              ${this._renderValueStat({
                label: "Purchase Price",
                total: priceTotal,
                rows: priceRows,
                expanded: this._priceExpanded,
                onToggle: () => (this._priceExpanded = !this._priceExpanded),
              })}
              ${this._renderValueStat({
                label: "Estimated Value",
                total: f.effectiveEstimatedValue,
                rows: valueRows,
                expanded: this._valueExpanded,
                onToggle: () => (this._valueExpanded = !this._valueExpanded),
              })}
            </div>

            ${this._renderValueEstimate(f)}

            <div class="actions" style="justify-content:flex-start">
              <button class="primary" @click=${() => this._openEdit(f)}>Edit Firearm</button>
              ${f.isWishlist
                ? html`<button class="primary" @click=${() => (this._markPurchasedOpen = true)}>Mark as Purchased</button>`
                : ""}
              <button class="secondary" @click=${() => (this._rangeOpen = true)}>Log Range Session</button>
              <button class="secondary" @click=${() => (this._addRoundsOpen = true)}>Add Rounds</button>
              <button class="secondary" @click=${() => (this._removeRoundsOpen = true)}>Remove Rounds</button>
              <button class="secondary" @click=${() => (this._cleanedOpen = true)}>Mark Cleaned</button>
              <button class="secondary" @click=${() => (this._docsOpen = true)}>Manage Documents</button>
              <button class="secondary danger" @click=${() => (this._deleteTarget = f)}>Delete</button>
            </div>
          </div>
        </div>

        <section class="sub">
          <h3>Details</h3>
          <div class="fields">
            <div class="field"><label>Serial Number</label><div>${f.serialNumber ?? "—"}</div></div>
            <div class="field"><label>Barrel Length</label><div>${f.barrelLength ?? "—"}</div></div>
            <div class="field"><label>Overall Length</label><div>${f.overallLength ?? "—"}</div></div>
            <div class="field"><label>Weight</label><div>${f.weight ?? "—"}</div></div>
            <div class="field"><label>Twist Rate</label><div>${f.twistRate ?? "—"}</div></div>
            <div class="field"><label>Capacity</label><div>${f.capacity ?? "—"}</div></div>
            <div class="field"><label>Finish</label><div>${f.finish ?? "—"}</div></div>
            <div class="field"><label>Color</label><div>${f.color ?? "—"}</div></div>
            <div class="field"><label>Condition</label><div>${f.condition ?? "—"}</div></div>
            <div class="field"><label>Purchase Date</label><div>${formatDate(f.purchaseDate)}</div></div>
            <div class="field"><label>Purchased From</label><div>${f.purchasedFrom ?? "—"}</div></div>
            <div class="field"><label>Warranty Expiration</label><div>${formatDate(f.warrantyExpiration)}</div></div>
            ${f.productUrl
              ? html`<div class="field"><label>Product Link</label><div><a href=${f.productUrl} target="_blank" rel="noopener noreferrer">${f.productUrl}</a></div></div>`
              : ""}
          </div>
          ${f.warrantyNotes ? html`<p class="small muted">Warranty notes: ${f.warrantyNotes}</p>` : ""}
          ${f.notes ? html`<p>${f.notes}</p>` : ""}
          ${f.documents.length > 0
            ? html`
                <h3>Documents</h3>
                ${f.documents.map(
                  (doc) => html`<div class="history-row">
                    <a href=${doc.url} target="_blank" rel="noreferrer">${doc.originalFilename ?? doc.filename}</a>
                    <span class="small muted"> · ${doc.documentType}</span>
                  </div>`
                )}
              `
            : ""}
        </section>

        <section class="sub">
          <h3>Installed Parts (${f.installedItems.length})</h3>
          <cache-attachment-bar
            .installedBySlot=${installedBySlot(this.cacheState, f.id)}
            @cache-slot-click=${this._onSlotClick}
          ></cache-attachment-bar>
        </section>

        <section class="sub">
          <h3>Maintenance History (${f.cleaningHistory.length})</h3>
          ${f.cleaningHistory.length === 0
            ? html`<p class="muted small">No cleaning logged yet.</p>`
            : f.cleaningHistory.map(
                (log) => html`
                  <div class="history-row">
                    <strong>${formatDate(log.cleanedDate)}</strong>
                    <span class="small muted"> · At ${formatNumber(log.roundCountAtCleaning)} rounds${log.notes ? ` · ${log.notes}` : ""}</span>
                  </div>
                `
              )}
        </section>

        <section class="sub">
          <h3>Range History (${rangeSessions.length})</h3>
          ${rangeSessions.length === 0
            ? html`<p class="muted small">No range sessions logged yet.</p>`
            : rangeSessions.map((s) => {
                const entry = s.firearms.find((e) => e.firearmId === f.id);
                return html`
                  <div class="history-row">
                    <strong>${formatDate(s.date)}${s.location ? ` · ${s.location}` : ""}</strong>
                    <span class="small muted">
                      · ${formatNumber(entry?.roundsFired ?? 0)} rounds${entry?.ammunitionLabel ? ` · ${entry.ammunitionLabel}` : ""}${s.notes ? ` · ${s.notes}` : ""}
                    </span>
                  </div>
                `;
              })}
        </section>
      </ha-card>

      ${this._activeSlot
        ? html`
            <slot-modal
              .hass=${this.hass}
              .cacheState=${this.cacheState}
              .open=${true}
              .firearmId=${f.id}
              .slotType=${this._activeSlot}
              .installedBySlot=${installedBySlot(this.cacheState, f.id)}
              @cache-dialog-closed=${() => (this._activeSlot = null)}
            ></slot-modal>
          `
        : ""}

      <log-range-session-dialog
        .hass=${this.hass}
        .cacheState=${this.cacheState}
        .open=${this._rangeOpen}
        .presetFirearmId=${f.id}
        @cache-dialog-closed=${() => (this._rangeOpen = false)}
      ></log-range-session-dialog>

      <cache-dialog .open=${this._addRoundsOpen} heading="Add Rounds" width="340px" @cache-dialog-closed=${() => (this._addRoundsOpen = false)}>
        <label>Number of rounds</label>
        <input type="number" .value=${this._roundsAmount} @input=${(e: Event) => (this._roundsAmount = (e.target as HTMLInputElement).value)} />
        <div class="actions">
          <button class="secondary" @click=${() => (this._addRoundsOpen = false)}>Cancel</button>
          <button class="primary" ?disabled=${!this._roundsAmount} @click=${() => this._submitRounds("add", f.id)}>Add</button>
        </div>
      </cache-dialog>

      <cache-dialog .open=${this._removeRoundsOpen} heading="Remove Rounds" width="340px" @cache-dialog-closed=${() => (this._removeRoundsOpen = false)}>
        <label>Number of rounds</label>
        <input type="number" .value=${this._roundsAmount} @input=${(e: Event) => (this._roundsAmount = (e.target as HTMLInputElement).value)} />
        <div class="actions">
          <button class="secondary" @click=${() => (this._removeRoundsOpen = false)}>Cancel</button>
          <button class="primary" ?disabled=${!this._roundsAmount} @click=${() => this._submitRounds("remove", f.id)}>Remove</button>
        </div>
      </cache-dialog>

      <cache-dialog .open=${this._cleanedOpen} heading="Mark Cleaned" width="360px" @cache-dialog-closed=${() => (this._cleanedOpen = false)}>
        <label>Cleaning Date</label>
        <input type="date" .value=${this._cleanedDate} @input=${(e: Event) => (this._cleanedDate = (e.target as HTMLInputElement).value)} />
        <label>Cleaning Notes</label>
        <textarea .value=${this._cleanedNotes} @input=${(e: Event) => (this._cleanedNotes = (e.target as HTMLTextAreaElement).value)}></textarea>
        <div class="actions">
          <button class="secondary" @click=${() => (this._cleanedOpen = false)}>Cancel</button>
          <button class="primary" @click=${() => this._submitMarkCleaned(f.id)}>Save</button>
        </div>
      </cache-dialog>

      <cache-dialog .open=${this._markPurchasedOpen} heading="Mark as Purchased" width="360px" @cache-dialog-closed=${() => (this._markPurchasedOpen = false)}>
        <p class="small muted">Moves "${f.customName}" off the wishlist and into your collection.</p>
        <label>Purchase Date</label>
        <input type="date" .value=${this._purchaseDate} @input=${(e: Event) => (this._purchaseDate = (e.target as HTMLInputElement).value)} />
        <label>Purchase Price</label>
        <input type="number" .value=${this._purchasePrice} @input=${(e: Event) => (this._purchasePrice = (e.target as HTMLInputElement).value)} />
        <div class="actions">
          <button class="secondary" @click=${() => (this._markPurchasedOpen = false)}>Cancel</button>
          <button class="primary" @click=${() => this._submitMarkPurchased(f.id)}>Mark as Purchased</button>
        </div>
      </cache-dialog>

      <document-manager-dialog
        .hass=${this.hass}
        .open=${this._docsOpen}
        .firearmId=${f.id}
        .documents=${f.documents}
        @cache-dialog-closed=${() => (this._docsOpen = false)}
      ></document-manager-dialog>

      <cache-dialog .open=${!!this._deleteTarget} heading="Delete Firearm" width="400px" @cache-dialog-closed=${() => (this._deleteTarget = null)}>
        <p>Delete "${this._deleteTarget?.customName}"? Installed parts will be returned to its storage location. This cannot be undone.</p>
        <div class="actions">
          <button class="secondary" @click=${() => (this._deleteTarget = null)}>Cancel</button>
          <button class="secondary danger" @click=${this._confirmDelete}>Delete</button>
        </div>
      </cache-dialog>
    `;
  }

  // Editing an existing firearm - the gallery grid is live and
  // network-backed, independent of this dialog's own Save button (see
  // photo-manager-section.ts). No separate hero/build image control -
  // the firearm's hero photo (Dashboard Wishlist panel, detail page
  // header) is just whichever gallery photo is marked primary (the star
  // button below), see utils/hero-image.ts.
  private _renderEditPhotosSection(f: Firearm) {
    return html`
      <label>Photos</label>
      <photo-manager-section
        .hass=${this.hass}
        entityType="firearm"
        .entityId=${f.id}
        .photos=${f.photos}
      ></photo-manager-section>
    `;
  }

  // Adding a brand-new firearm - there's no id to upload against yet, so
  // this only STAGES local File objects (no network activity beyond the
  // Image URL/clipboard paths cache-image-source-button already handles
  // internally); _save() uploads them all once addFirearm hands back the
  // new firearm's id. The first one uploaded becomes primary/hero
  // automatically (coordinator.async_add_photo) - no separate "which one
  // is the hero" step needed here either.
  private _renderAddPhotosSection() {
    return html`
      <p class="small muted" style="margin-top:0">
        Uploads once the firearm is added below. The first photo becomes its hero photo automatically.
      </p>
      <label>Photos (optional)</label>
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
    `;
  }

  private _renderForm() {
    const d = this._draft;
    const set = (patch: Partial<FirearmDraft>) => (this._draft = { ...this._draft, ...patch });
    return html`
      <cache-dialog
        .open=${this._formOpen}
        .heading=${this._editing ? "Edit Firearm" : "Add Firearm"}
        width="640px"
        @cache-dialog-closed=${() => (this._formOpen = false)}
      >
        ${this._error ? html`<div class="error-banner">${this._error}</div>` : ""}
        <p class="small muted" style="text-transform:uppercase;letter-spacing:0.5px">Basic Information</p>
        <div class="field-row">
          <div>
            <label>Custom Name (optional)</label>
            <input placeholder="Defaults to manufacturer + model" .value=${d.customName} @input=${(e: Event) => set({ customName: (e.target as HTMLInputElement).value })} />
          </div>
          <div>
            <label>Firearm Type</label>
            <select .value=${d.firearmType} @change=${(e: Event) => set({ firearmType: (e.target as HTMLSelectElement).value })}>
              ${FIREARM_TYPES.map((t) => html`<option value=${t} ?selected=${t === d.firearmType}>${t}</option>`)}
            </select>
          </div>
        </div>
        <div class="field-row">
          <div>
            <label>Manufacturer</label>
            <input list="firearm-manufacturer-list" .value=${d.manufacturer} @input=${(e: Event) => set({ manufacturer: (e.target as HTMLInputElement).value })} />
            <datalist id="firearm-manufacturer-list">
              ${knownManufacturers(this.cacheState).map((m) => html`<option value=${m}></option>`)}
            </datalist>
          </div>
          <div><label>Model</label><input .value=${d.model} @input=${(e: Event) => set({ model: (e.target as HTMLInputElement).value })} /></div>
        </div>
        <div class="field-row">
          <div><label>Serial Number</label><input .value=${d.serialNumber} @input=${(e: Event) => set({ serialNumber: (e.target as HTMLInputElement).value })} /></div>
          <div>
            <label>Caliber</label>
            <input list="firearm-caliber-list" .value=${d.caliber} @input=${(e: Event) => set({ caliber: (e.target as HTMLInputElement).value })} />
            <datalist id="firearm-caliber-list">
              ${knownCalibers(this.cacheState, d.firearmType).map((c) => html`<option value=${c}></option>`)}
            </datalist>
          </div>
        </div>
        <div class="field-row">
          <div><label>Barrel Length</label><input .value=${d.barrelLength} @input=${(e: Event) => set({ barrelLength: (e.target as HTMLInputElement).value })} /></div>
          <div><label>Overall Length</label><input .value=${d.overallLength} @input=${(e: Event) => set({ overallLength: (e.target as HTMLInputElement).value })} /></div>
          <div><label>Weight</label><input .value=${d.weight} @input=${(e: Event) => set({ weight: (e.target as HTMLInputElement).value })} /></div>
          <div><label>Twist Rate</label><input .value=${d.twistRate} @input=${(e: Event) => set({ twistRate: (e.target as HTMLInputElement).value })} /></div>
        </div>
        <div class="field-row">
          <div><label>Capacity</label><input .value=${d.capacity} @input=${(e: Event) => set({ capacity: (e.target as HTMLInputElement).value })} /></div>
          <div><label>Finish</label><input .value=${d.finish} @input=${(e: Event) => set({ finish: (e.target as HTMLInputElement).value })} /></div>
          <div><label>Color</label><input .value=${d.color} @input=${(e: Event) => set({ color: (e.target as HTMLInputElement).value })} /></div>
          <div>
            <label>Condition</label>
            <select .value=${d.condition} @change=${(e: Event) => set({ condition: (e.target as HTMLSelectElement).value })}>
              <option value="">—</option>
              ${CONDITIONS.map((c) => html`<option value=${c} ?selected=${c === d.condition}>${c}</option>`)}
            </select>
          </div>
        </div>

        <p class="small muted" style="text-transform:uppercase;letter-spacing:0.5px;margin-top:16px">Photos</p>
        ${this._editing ? this._renderEditPhotosSection(this._editing) : this._renderAddPhotosSection()}

        <p class="small muted" style="text-transform:uppercase;letter-spacing:0.5px;margin-top:16px">Ownership</p>
        <div class="checkbox-row">
          <input type="checkbox" .checked=${d.isWishlist} @change=${(e: Event) => set({ isWishlist: (e.target as HTMLInputElement).checked })} />
          <label style="margin:0">This is a wishlist item (don't own it yet)</label>
        </div>
        ${d.isWishlist
          ? html`<p class="small muted">
              Priority is set by dragging this firearm's position in the Wishlist reorder list (Firearms
              toolbar, when viewing Wishlist or Both) - not from this form.
            </p>`
          : ""}
        <div class="field-row">
          <div><label>Purchase Date</label><input type="date" .value=${d.purchaseDate} @input=${(e: Event) => set({ purchaseDate: (e.target as HTMLInputElement).value })} /></div>
          <div><label>Purchase Price</label><input type="number" .value=${d.purchasePrice} @input=${(e: Event) => set({ purchasePrice: (e.target as HTMLInputElement).value })} /></div>
          <div><label>Current Estimated Value</label><input type="number" .value=${d.currentEstimatedValue} @input=${(e: Event) => set({ currentEstimatedValue: (e.target as HTMLInputElement).value })} /></div>
        </div>
        <div class="field-row">
          <div><label>Purchased From</label><input .value=${d.purchasedFrom} @input=${(e: Event) => set({ purchasedFrom: (e.target as HTMLInputElement).value })} /></div>
          <div><label>Warranty Expiration</label><input type="date" .value=${d.warrantyExpiration} @input=${(e: Event) => set({ warrantyExpiration: (e.target as HTMLInputElement).value })} /></div>
        </div>
        <label>Warranty Notes</label>
        <textarea .value=${d.warrantyNotes} @input=${(e: Event) => set({ warrantyNotes: (e.target as HTMLTextAreaElement).value })}></textarea>
        <label>Product Link (optional)</label>
        <input type="url" placeholder="https://..." .value=${d.productUrl} @input=${(e: Event) => set({ productUrl: (e.target as HTMLInputElement).value })} />

        <p class="small muted" style="text-transform:uppercase;letter-spacing:0.5px;margin-top:16px">Uses</p>
        <div class="field-row">
          ${FIREARM_USES.map(
            (use) => html`
              <div class="checkbox-row">
                <input type="checkbox" .checked=${d.uses.includes(use)} @change=${() => this._toggleUse(use)} />
                <label style="margin:0">${use}</label>
              </div>
            `
          )}
        </div>

        <p class="small muted" style="text-transform:uppercase;letter-spacing:0.5px;margin-top:16px">Additional Information</p>
        <label>Storage Location</label>
        <select .value=${d.storageLocationId} @change=${(e: Event) => set({ storageLocationId: (e.target as HTMLSelectElement).value })}>
          <option value="">Unassigned</option>
          ${this.cacheState.storageLocations.map((l) => html`<option value=${l.id} ?selected=${l.id === d.storageLocationId}>${l.name}</option>`)}
        </select>
        <label>Notes</label>
        <textarea .value=${d.notes} @input=${(e: Event) => set({ notes: (e.target as HTMLTextAreaElement).value })}></textarea>

        <div class="actions">
          <button class="secondary" @click=${() => (this._formOpen = false)}>Cancel</button>
          <button class="primary" ?disabled=${this._savingPhotos} @click=${this._save}>
            ${this._savingPhotos ? "Uploading Photos…" : this._editing ? "Save Changes" : "Add Firearm"}
          </button>
        </div>
      </cache-dialog>
    `;
  }

  render() {
    if (this._selectedId) {
      const firearm = this.cacheState.firearms.find((f) => f.id === this._selectedId);
      if (firearm) {
        return html`${this._renderDetail(firearm)}${this._renderForm()}`;
      }
      this._selectedId = null;
    }

    const firearms = this._filtered;
    return html`
      <div class="toolbar">
        <h1 style="margin:0;font-size:1.4rem;font-weight:600">Firearms</h1>
        <div style="display:flex;gap:8px">
          ${this._wishlistFilter !== "owned"
            ? html`<button class="secondary" @click=${() => (this._reorderOpen = true)}>Reorder Wishlist</button>`
            : ""}
          <button class="primary" @click=${this._openAdd}>+ Add Firearm</button>
        </div>
      </div>

      ${this._preset
        ? html`<div class="filter-chip">
            ${this._preset === "cleaning-due" ? "Needs cleaning" : "NFA firearms"}
            <button title="Clear filter" aria-label="Clear filter" @click=${() => (this._preset = null)}>
              <ha-icon icon="mdi:close"></ha-icon>
            </button>
          </div>`
        : ""}

      <div class="filters">
        <input
          placeholder="Search by name, manufacturer, model, serial, caliber, notes, location..."
          .value=${this._search}
          @input=${(e: Event) => (this._search = (e.target as HTMLInputElement).value)}
        />
        <select .value=${this._typeFilter} @change=${(e: Event) => (this._typeFilter = (e.target as HTMLSelectElement).value)}>
          <option value="">All Types</option>
          ${FIREARM_TYPES.map((t) => html`<option value=${t} ?selected=${t === this._typeFilter}>${t}</option>`)}
        </select>
        <select .value=${this._conditionFilter} @change=${(e: Event) => (this._conditionFilter = (e.target as HTMLSelectElement).value)}>
          <option value="">All Conditions</option>
          ${CONDITIONS.map((c) => html`<option value=${c} ?selected=${c === this._conditionFilter}>${c}</option>`)}
        </select>
        <div class="segmented">
          <button class=${this._wishlistFilter === "owned" ? "active" : ""} @click=${() => (this._wishlistFilter = "owned")}>Owned</button>
          <button class=${this._wishlistFilter === "all" ? "active" : ""} @click=${() => (this._wishlistFilter = "all")}>Both</button>
          <button class=${this._wishlistFilter === "wishlist" ? "active" : ""} @click=${() => (this._wishlistFilter = "wishlist")}>Wishlist</button>
        </div>
        <select .value=${this._sort} @change=${(e: Event) => (this._sort = (e.target as HTMLSelectElement).value as typeof this._sort)}>
          <option value="custom_name">Sort: Name</option>
          <option value="purchase_date">Sort: Purchase Date</option>
          <option value="current_estimated_value">Sort: Estimated Value</option>
          <option value="lifetime_round_count">Sort: Round Count</option>
        </select>
      </div>

      ${firearms.length === 0
        ? html`<div class="empty">
            ${this._search || this._typeFilter || this._conditionFilter
              ? "No firearms match your search."
              : "Add your first firearm to start building your collection."}
          </div>`
        : html`
            <div class="firearms-grid">
              ${firearms.map((f) => {
                const primaryPhoto = f.photos.find((p) => p.id === f.primaryPhotoId) ?? f.photos[0];
                return html`
                  <ha-card class="firearm ${f.isWishlist ? "wishlist" : ""}" @click=${() => (this._selectedId = f.id)}>
                    <div class="firearm-image-wrap">
                      ${primaryPhoto
                        ? html`<img class="firearm-image" src=${primaryPhoto.url} alt=${f.customName} />`
                        : html`<div class="firearm-image firearm-image-placeholder">
                            <ha-icon icon="mdi:target" style="opacity:0.35;--mdc-icon-size:56px"></ha-icon>
                          </div>`}
                      ${f.needsCleaning
                        ? html`<div class="cleaning-flag" title="Needs cleaning">
                            <ha-icon icon="mdi:spray-bottle" style="color:#ffb000;--mdc-icon-size:18px"></ha-icon>
                          </div>`
                        : ""}
                    </div>
                    <div class="firearm-body">
                      <div class="firearm-name">${f.customName}</div>
                      <div class="small muted">${[f.manufacturer, f.model].filter(Boolean).join(" ") || "—"}</div>
                      <div class="chips">
                        ${f.isWishlist
                          ? html`<span class="badge wishlist">Wishlist${f.wishlistRank !== null ? ` · #${f.wishlistRank + 1}` : ""}</span>`
                          : ""}
                        <span class="badge">${f.firearmType}</span>
                        ${f.caliber ? html`<span class="badge">${f.caliber}</span>` : ""}
                      </div>
                      <div class="row-bottom">
                        <span>${formatNumber(f.lifetimeRoundCount)} rounds</span>
                        <span>${formatCurrency(f.effectiveEstimatedValue)}</span>
                      </div>
                      ${f.storageLocationName ? html`<div class="small muted" style="margin-top:6px">📍 ${f.storageLocationName}</div>` : ""}
                    </div>
                  </ha-card>
                `;
              })}
            </div>
          `}
      ${this._renderForm()}

      <wishlist-reorder-dialog
        .hass=${this.hass}
        .open=${this._reorderOpen}
        .firearms=${this.cacheState.firearms.filter((f) => f.isWishlist)}
        @cache-dialog-closed=${() => (this._reorderOpen = false)}
      ></wishlist-reorder-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cache-firearms-view": CacheFirearmsView;
  }
}
