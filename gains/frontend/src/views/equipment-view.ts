import { defaultInventoryWeight } from "../inventory-units";
import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { gainsApi } from "../ha-api";
import type { EquipmentConfig, EquipmentItem, GainsState, GymProfile } from "../types";
import { EQUIPMENT_CATALOG, EQUIPMENT_CATEGORY_LABELS } from "../types";
import { glassCardStyle, formStyles } from "../styles";

const CATEGORY_ORDER = [
  "machines",
  "cable_machines",
  "plate_loaded_machines",
  "bars_and_plates",
  "small_weights",
  "racks_and_benches",
  "balls_and_accessories",
  "rope",
  "cardio",
];

/** For these two items, "which weights do you have" is the whole point of
 * checking them off -- a dumbbell rack or a plate tree is a set of
 * standard sizes, not one generic weight. Chips make picking a whole set
 * fast; a custom-weight input still covers anything non-standard (a
 * metric plate, an odd dumbbell). Every other catalog item keeps the
 * simpler toggle + "Add another unit" flow, since most gym gear (a squat
 * rack, a lat pulldown) isn't something you own in a range of weights. */
const WEIGHT_PICKER_OPTIONS: Record<string, number[]> = {
  dumbbells: [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80],
  plates: [2.5, 5, 10, 15, 25, 35, 45, 55],
};

/**
 * Gym profiles are named, reusable equipment checklists shared
 * instance-wide (see ha-gains-integration's GymProfile) -- any Home
 * Assistant member on this instance can create one, select it as their
 * own, or edit any gym's checklist (not just ones they created). This
 * view has two layers: picking which shared gym is "mine"
 * (gainsApi.selectGymProfile), and managing a gym's checked-equipment
 * list (the same catalog checklist Phase-1's per-athlete equipment view
 * used, now scoped to whichever GymProfile is open for editing).
 *
 * Each checked item is a *list* of weights, one per physical unit owned
 * (a gym can own more than one of the same item at different weights,
 * e.g. two Short Bars) -- "Add another" appends a new unit, each unit is
 * independently editable/removable, and removing the last unit un-checks
 * the item entirely.
 *
 * gains.update_gym_profile always replaces the whole checked equipment
 * set, so every toggle/edit/add/remove here sends the complete current
 * state rather than a diff.
 */
@customElement("gains-equipment-view")
export class GainsEquipmentView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) gainsState!: GainsState;

  @state() private _editingGymId: string | null = null;
  @state() private _renamingGymId: string | null = null;
  @state() private _renameInput = "";
  @state() private _creatingNew = false;
  @state() private _newGymName = "";
  @state() private _busyGymId: string | null = null;

  @state() private _search = "";
  @state() private _editingKey: string | null = null;
  @state() private _editWeightInput = "";
  @state() private _collapsedCategories = new Set<string>();
  @state() private _customWeightItemId: string | null = null;
  @state() private _customWeightInput = "";

  static styles = [
    glassCardStyle,
    formStyles,
    css`
      ha-card.panel {
        padding: 20px;
        margin-bottom: 20px;
        max-width: 640px;
      }
      ul.gym-list {
        list-style: none;
        margin: 8px 0 0;
        padding: 0;
      }
      ul.gym-list li {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 0;
        border-bottom: 1px solid var(--divider-color, #e0e0e0);
      }
      ul.gym-list li:last-child {
        border-bottom: none;
      }
      .gym-name-row {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .gym-actions {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      .new-gym-row {
        display: flex;
        gap: 8px;
        margin-top: 12px;
        align-items: center;
      }
      .new-gym-row input {
        flex: 1;
      }
      .search-row {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid var(--divider-color, #e0e0e0);
        margin-bottom: 16px;
      }
      .search-row ha-icon {
        color: var(--secondary-text-color, #727272);
      }
      .search-row input {
        border: none;
        outline: none;
        flex: 1;
        font-size: 1rem;
        background: none;
        color: var(--primary-text-color, #212121);
      }
      button.category-header {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
        box-sizing: border-box;
        margin: 20px 0 4px;
        padding: 4px 0;
        background: none;
        border: none;
        font-size: 0.95rem;
        font-weight: 600;
        font-family: inherit;
        color: var(--secondary-text-color, #727272);
        text-transform: uppercase;
        letter-spacing: 0.02em;
        text-align: left;
        cursor: pointer;
      }
      button.category-header:first-of-type {
        margin-top: 0;
      }
      button.category-header ha-icon {
        --mdc-icon-size: 18px;
        flex-shrink: 0;
      }
      .equipment-list {
        margin: 0;
        padding: 0;
      }
      .equipment-group {
        border-bottom: 1px solid var(--divider-color, #e0e0e0);
        padding: 8px 0;
      }
      .item-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .item-name {
        font-size: 0.95rem;
      }
      .instances {
        margin: 4px 0 0 0;
        padding-left: 4px;
      }
      .instance-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 4px 0;
        font-size: 0.8rem;
        color: var(--secondary-text-color, #727272);
      }
      .instance-row button {
        background: none;
        border: none;
        color: var(--primary-color, #03a9f4);
        cursor: pointer;
        font-size: 0.8rem;
        padding: 0;
        margin-left: 8px;
      }
      .add-another {
        background: none;
        border: none;
        color: var(--primary-color, #03a9f4);
        cursor: pointer;
        font-size: 0.8rem;
        padding: 4px 0 0;
      }
      .weight-edit {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .weight-edit input {
        width: 64px;
      }
      .weight-chip-row {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 6px;
      }
      .weight-chip {
        background: var(--secondary-background-color, #f5f5f5);
        border: 1px solid var(--divider-color, #e0e0e0);
        border-radius: 16px;
        padding: 4px 10px;
        font-size: 0.8rem;
        font-family: inherit;
        cursor: pointer;
        color: var(--primary-text-color, #212121);
      }
      .weight-chip.active {
        background: var(--primary-color, #03a9f4);
        border-color: var(--primary-color, #03a9f4);
        color: var(--text-primary-color, #fff);
      }
      .weight-chip.add-chip {
        background: none;
        border-style: dashed;
      }
      .custom-weight-input {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      .custom-weight-input input {
        width: 70px;
      }
      .plate-inventory {
        display: grid;
        gap: 8px;
        margin-top: 10px;
      }
      .plate-inventory-row {
        display: grid;
        grid-template-columns: minmax(86px, 1fr) auto;
        gap: 12px;
        align-items: center;
        padding: 9px 10px;
        border: 1px solid var(--divider-color, #e0e0e0);
        border-radius: 12px;
        background: var(--secondary-background-color, #f5f5f5);
      }
      .plate-inventory-row.inactive {
        opacity: 0.7;
      }
      .plate-weight-label {
        display: grid;
        gap: 2px;
      }
      .plate-weight-label strong {
        font-size: 0.9rem;
      }
      .plate-weight-label small {
        color: var(--secondary-text-color, #727272);
      }
      .plate-quantity {
        display: grid;
        grid-template-columns: 34px 52px 34px;
        align-items: center;
        gap: 5px;
      }
      .plate-quantity button {
        width: 34px;
        height: 34px;
        padding: 0;
        border: 1px solid var(--divider-color, #e0e0e0);
        border-radius: 10px;
        background: var(--card-background-color, #fff);
        color: var(--primary-text-color, #212121);
        font: inherit;
        font-size: 1.05rem;
        cursor: pointer;
      }
      .plate-quantity button:disabled {
        opacity: 0.35;
        cursor: default;
      }
      .plate-count {
        text-align: center;
        font-size: 0.8rem;
        line-height: 1.15;
        font-variant-numeric: tabular-nums;
      }
      .plate-count strong {
        display: block;
        font-size: 1rem;
        color: var(--primary-text-color, #212121);
      }
      .cable-config {
        margin: 10px 0 2px 4px;
        padding: 12px;
        border-radius: 12px;
        background: var(--secondary-background-color, #f5f5f5);
        display: grid;
        gap: 12px;
      }
      .cable-config-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
      }
      .cable-config-label {
        font-size: 0.8rem;
        font-weight: 650;
        color: var(--secondary-text-color, #727272);
      }
      .cable-choice {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }
      .cable-choice button {
        border: 1px solid var(--divider-color, #e0e0e0);
        border-radius: 999px;
        background: var(--card-background-color, #fff);
        color: var(--primary-text-color, #212121);
        padding: 7px 10px;
        font-family: inherit;
        cursor: pointer;
      }
      .cable-choice button.active {
        border-color: var(--primary-color, #03a9f4);
        background: color-mix(in srgb, var(--primary-color, #03a9f4) 15%, transparent);
        color: var(--primary-color, #03a9f4);
        font-weight: 700;
      }
      .cable-help {
        margin: 0;
        font-size: 0.78rem;
        line-height: 1.4;
        color: var(--secondary-text-color, #727272);
      }
      .stack-fields {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      .stack-fields label {
        margin: 0;
        font-size: 0.75rem;
      }
      .stack-fields input {
        width: 100%;
        box-sizing: border-box;
        margin-top: 4px;
      }
    `,
  ];

  private get _gymProfiles(): GymProfile[] {
    return this.gainsState.gymProfiles;
  }

  private get _editingGym(): GymProfile | null {
    if (!this._editingGymId) return null;
    return this._gymProfiles.find((g) => g.id === this._editingGymId) ?? null;
  }

  private async _select(gymId: string | null): Promise<void> {
    this._busyGymId = gymId ?? "__clearing__";
    try {
      await gainsApi.selectGymProfile(this.hass, gymId);
    } finally {
      this._busyGymId = null;
    }
  }

  private async _createGym(): Promise<void> {
    const name = this._newGymName.trim();
    if (!name) return;
    this._busyGymId = "__creating__";
    try {
      await gainsApi.createGymProfile(this.hass, name);
      this._newGymName = "";
      this._creatingNew = false;
    } finally {
      this._busyGymId = null;
    }
  }

  private async _deleteGym(gym: GymProfile): Promise<void> {
    if (!window.confirm(`Delete "${gym.name}"? This can't be undone.`)) return;
    this._busyGymId = gym.id;
    try {
      await gainsApi.deleteGymProfile(this.hass, gym.id);
      if (this._editingGymId === gym.id) this._editingGymId = null;
    } finally {
      this._busyGymId = null;
    }
  }

  private _startRename(gym: GymProfile): void {
    this._renamingGymId = gym.id;
    this._renameInput = gym.name;
  }

  private async _saveRename(gym: GymProfile): Promise<void> {
    const name = this._renameInput.trim();
    this._renamingGymId = null;
    if (!name || name === gym.name) return;
    await gainsApi.updateGymProfile(this.hass, gym.id, { name });
  }

  private _instanceKey(itemId: string, index: number): string {
    return `${itemId}:${index}`;
  }

  private async _toggle(gym: GymProfile, item: EquipmentItem, checked: boolean): Promise<void> {
    const next = { ...gym.equipment };
    const nextConfig = { ...gym.equipmentConfig };
    if (checked) {
      next[item.id] = [item.category === "cable_machines" ? null : defaultInventoryWeight(item.defaultWeight, this.gainsState.profile?.units ?? "imperial")];
      if (item.category === "cable_machines" && !nextConfig[item.id]) {
        nextConfig[item.id] = { loadType: "plate_loaded", pulleyRatio: 1 };
      }
    } else {
      delete next[item.id];
      delete nextConfig[item.id];
    }
    this._editingKey = null;
    await gainsApi.updateGymProfile(this.hass, gym.id, {
      equipment: next,
      equipmentConfig: nextConfig,
    });
  }

  private _cableConfig(gym: GymProfile, item: EquipmentItem): Required<Pick<EquipmentConfig, "loadType" | "pulleyRatio">> & EquipmentConfig {
    const stored = gym.equipmentConfig[item.id] ?? {};
    return {
      ...stored,
      loadType: stored.loadType ?? "plate_loaded",
      pulleyRatio: stored.pulleyRatio ?? 1,
    };
  }

  private async _updateCableConfig(
    gym: GymProfile,
    item: EquipmentItem,
    patch: EquipmentConfig,
  ): Promise<void> {
    const current = this._cableConfig(gym, item);
    const nextConfig = {
      ...gym.equipmentConfig,
      [item.id]: { ...current, ...patch },
    };
    // Normalise legacy cable entries that used the old fake 5 lb unit value.
    const nextEquipment = {
      ...gym.equipment,
      [item.id]: [null],
    };
    await gainsApi.updateGymProfile(this.hass, gym.id, {
      equipment: nextEquipment,
      equipmentConfig: nextConfig,
    });
  }

  private async _addInstance(gym: GymProfile, item: EquipmentItem): Promise<void> {
    const current = gym.equipment[item.id] ?? [];
    const next = { ...gym.equipment, [item.id]: [...current, defaultInventoryWeight(item.defaultWeight, this.gainsState.profile?.units ?? "imperial")] };
    await gainsApi.updateGymProfile(this.hass, gym.id, { equipment: next });
  }

  private async _removeInstance(gym: GymProfile, item: EquipmentItem, index: number): Promise<void> {
    const current = gym.equipment[item.id] ?? [];
    const remaining = current.filter((_: number | null, i: number) => i !== index);
    const next = { ...gym.equipment };
    if (remaining.length === 0) {
      delete next[item.id];
    } else {
      next[item.id] = remaining;
    }
    this._editingKey = null;
    await gainsApi.updateGymProfile(this.hass, gym.id, { equipment: next });
  }

  private _startEdit(item: EquipmentItem, index: number, currentWeight: number | null): void {
    this._editingKey = this._instanceKey(item.id, index);
    this._editWeightInput =
      currentWeight !== null
        ? String(currentWeight)
        : defaultInventoryWeight(item.defaultWeight, this.gainsState.profile?.units ?? "imperial") !== null
          ? String(defaultInventoryWeight(item.defaultWeight, this.gainsState.profile?.units ?? "imperial"))
          : "";
  }

  private async _saveEdit(gym: GymProfile, item: EquipmentItem, index: number): Promise<void> {
    const parsed = this._editWeightInput.trim() === "" ? null : Number(this._editWeightInput);
    const current = [...(gym.equipment[item.id] ?? [])];
    current[index] = Number.isFinite(parsed) ? parsed : null;
    const next = { ...gym.equipment, [item.id]: current };
    await gainsApi.updateGymProfile(this.hass, gym.id, { equipment: next });
    this._editingKey = null;
  }

  private _renderInstance(gym: GymProfile, item: EquipmentItem, index: number, weight: number | null) {
    const key = this._instanceKey(item.id, index);
    const displayWeight = weight ?? defaultInventoryWeight(item.defaultWeight, this.gainsState.profile?.units ?? "imperial");

    if (this._editingKey === key) {
      return html`
        <div class="instance-row weight-edit">
          <input
            type="number"
            .value=${this._editWeightInput}
            @input=${(e: Event) => (this._editWeightInput = (e.target as HTMLInputElement).value)}
          />
          <button @click=${() => this._saveEdit(gym, item, index)}>Save</button>
          <button @click=${() => (this._editingKey = null)}>Cancel</button>
        </div>
      `;
    }

    return html`
      <div class="instance-row">
        <span>${displayWeight !== null ? `${displayWeight} lb` : `Unit ${index + 1}`}</span>
        <span>
          <button @click=${() => this._startEdit(item, index, weight)}>Edit</button>
          <button @click=${() => this._removeInstance(gym, item, index)}>Remove</button>
        </span>
      </div>
    `;
  }

  private _toggleCategoryCollapse(category: string): void {
    const next = new Set(this._collapsedCategories);
    if (next.has(category)) {
      next.delete(category);
    } else {
      next.add(category);
    }
    this._collapsedCategories = next;
  }

  private async _toggleWeight(
    gym: GymProfile,
    item: EquipmentItem,
    weight: number,
    checked: boolean
  ): Promise<void> {
    const current = gym.equipment[item.id] ?? [];
    const withoutWeight = current.filter((w) => w !== weight);
    const nextWeights = checked ? [...withoutWeight, weight] : withoutWeight;
    const next = { ...gym.equipment };
    if (nextWeights.length === 0) {
      delete next[item.id];
    } else {
      next[item.id] = nextWeights;
    }
    await gainsApi.updateGymProfile(this.hass, gym.id, { equipment: next });
  }

  private _weightQuantity(values: (number | null)[], weight: number): number {
    return values.filter((value) => value === weight).length;
  }

  private async _setPlateQuantity(
    gym: GymProfile,
    item: EquipmentItem,
    weight: number,
    quantity: number,
  ): Promise<void> {
    const current = gym.equipment[item.id] ?? [];
    const withoutWeight = current.filter((value) => value !== weight);
    const nextQuantity = Math.max(0, Math.min(20, Math.floor(quantity)));
    const nextWeights = [
      ...withoutWeight,
      ...Array.from({ length: nextQuantity }, () => weight),
    ].sort((a, b) => Number(a ?? 0) - Number(b ?? 0));

    const next = { ...gym.equipment };
    if (nextWeights.length === 0) {
      delete next[item.id];
    } else {
      next[item.id] = nextWeights;
    }
    await gainsApi.updateGymProfile(this.hass, gym.id, { equipment: next });
  }

  private async _addCustomWeight(gym: GymProfile, item: EquipmentItem): Promise<void> {
    const weight = Number(this._customWeightInput);
    this._customWeightItemId = null;
    if (!Number.isFinite(weight) || weight <= 0) return;
    if (item.id === "plates") {
      const current = gym.equipment[item.id] ?? [];
      const existing = this._weightQuantity(current, weight);
      await this._setPlateQuantity(gym, item, weight, Math.max(1, existing));
      return;
    }
    await this._toggleWeight(gym, item, weight, true);
  }

  private _renderPlateInventoryItem(gym: GymProfile, item: EquipmentItem) {
    const owned = gym.equipment[item.id] ?? [];
    const standardOptions = WEIGHT_PICKER_OPTIONS[item.id];
    const ownedWeights = [...new Set(owned.filter((weight): weight is number => weight !== null))];
    const customWeights = ownedWeights
      .filter((weight) => !standardOptions.includes(weight))
      .sort((a, b) => a - b);
    const allWeights = [...standardOptions, ...customWeights];
    const addingCustom = this._customWeightItemId === item.id;
    const totalSets = owned.filter((weight): weight is number => weight !== null).length;

    return html`
      <div class="equipment-group">
        <div class="item-row">
          <span class="item-name">${item.name}</span>
          ${totalSets > 0
            ? html`<span class="badge">${totalSets} set${totalSets === 1 ? "" : "s"}</span>`
            : ""}
        </div>
        <p class="muted small">Quantity is counted as matched pairs: 1 set = one plate per side.</p>
        <div class="plate-inventory">
          ${allWeights.map((weight) => {
            const quantity = this._weightQuantity(owned, weight);
            return html`
              <div class="plate-inventory-row ${quantity === 0 ? "inactive" : ""}">
                <span class="plate-weight-label">
                  <strong>${weight} lb</strong>
                  <small>${quantity === 0 ? "Not in this gym" : `${quantity * 2} individual plates`}</small>
                </span>
                <span class="plate-quantity">
                  <button
                    aria-label=${`Remove one set of ${weight} lb plates`}
                    ?disabled=${quantity === 0}
                    @click=${() => this._setPlateQuantity(gym, item, weight, quantity - 1)}
                  >−</button>
                  <span class="plate-count"><strong>${quantity}</strong>set${quantity === 1 ? "" : "s"}</span>
                  <button
                    aria-label=${`Add one set of ${weight} lb plates`}
                    @click=${() => this._setPlateQuantity(gym, item, weight, quantity + 1)}
                  >+</button>
                </span>
              </div>
            `;
          })}
        </div>
        <div class="weight-chip-row">
          ${addingCustom
            ? html`
                <span class="custom-weight-input">
                  <input
                    type="number"
                    placeholder="Weight"
                    .value=${this._customWeightInput}
                    @input=${(e: Event) =>
                      (this._customWeightInput = (e.target as HTMLInputElement).value)}
                    @keydown=${(e: KeyboardEvent) => {
                      if (e.key === "Enter") this._addCustomWeight(gym, item);
                    }}
                  />
                  <button class="secondary" @click=${() => this._addCustomWeight(gym, item)}>Add</button>
                  <button class="secondary" @click=${() => (this._customWeightItemId = null)}>Cancel</button>
                </span>
              `
            : html`
                <button
                  class="weight-chip add-chip"
                  @click=${() => {
                    this._customWeightItemId = item.id;
                    this._customWeightInput = "";
                  }}
                >+ Custom weight</button>
              `}
        </div>
      </div>
    `;
  }

  private _renderWeightPickerItem(gym: GymProfile, item: EquipmentItem) {
    if (item.id === "plates") {
      return this._renderPlateInventoryItem(gym, item);
    }
    const owned = gym.equipment[item.id] ?? [];
    const ownedWeights = new Set(owned.filter((w): w is number => w !== null));
    const standardOptions = WEIGHT_PICKER_OPTIONS[item.id];
    const customWeights = [...ownedWeights]
      .filter((w) => !standardOptions.includes(w))
      .sort((a, b) => a - b);
    const addingCustom = this._customWeightItemId === item.id;

    return html`
      <div class="equipment-group">
        <div class="item-row">
          <span class="item-name">${item.name}</span>
          ${ownedWeights.size > 0
            ? html`<span class="badge"
                >${ownedWeights.size} weight${ownedWeights.size === 1 ? "" : "s"}</span
              >`
            : ""}
        </div>
        <div class="weight-chip-row">
          ${standardOptions.map(
            (w) => html`
              <button
                class="weight-chip ${ownedWeights.has(w) ? "active" : ""}"
                @click=${() => this._toggleWeight(gym, item, w, !ownedWeights.has(w))}
              >
                ${w} lb
              </button>
            `
          )}
          ${customWeights.map(
            (w) => html`
              <button class="weight-chip active" @click=${() => this._toggleWeight(gym, item, w, false)}>
                ${w} lb &times;
              </button>
            `
          )}
          ${addingCustom
            ? html`
                <span class="custom-weight-input">
                  <input
                    type="number"
                    placeholder="Weight"
                    .value=${this._customWeightInput}
                    @input=${(e: Event) =>
                      (this._customWeightInput = (e.target as HTMLInputElement).value)}
                    @keydown=${(e: KeyboardEvent) => {
                      if (e.key === "Enter") this._addCustomWeight(gym, item);
                    }}
                  />
                  <button class="secondary" @click=${() => this._addCustomWeight(gym, item)}>
                    Add
                  </button>
                  <button class="secondary" @click=${() => (this._customWeightItemId = null)}>
                    Cancel
                  </button>
                </span>
              `
            : html`
                <button
                  class="weight-chip add-chip"
                  @click=${() => {
                    this._customWeightItemId = item.id;
                    this._customWeightInput = "";
                  }}
                >
                  + Custom
                </button>
              `}
        </div>
      </div>
    `;
  }

  private _renderCableItem(gym: GymProfile, item: EquipmentItem) {
    const checked = gym.equipment[item.id] !== undefined;
    const config = this._cableConfig(gym, item);
    const isPlateLoaded = config.loadType === "plate_loaded";

    return html`
      <div class="equipment-group">
        <div class="item-row">
          <span class="item-name">${item.name}</span>
          <input
            type="checkbox"
            class="toggle"
            .checked=${checked}
            @change=${(e: Event) => this._toggle(gym, item, (e.target as HTMLInputElement).checked)}
          />
        </div>
        ${checked ? html`
          <div class="cable-config">
            <div class="cable-config-row">
              <span class="cable-config-label">Load type</span>
              <span class="cable-choice">
                <button
                  class=${isPlateLoaded ? "active" : ""}
                  @click=${() => this._updateCableConfig(gym, item, {
                    loadType: "plate_loaded",
                    stackMax: null,
                    stackIncrement: null,
                  })}
                >Plate loaded</button>
                <button
                  class=${!isPlateLoaded ? "active" : ""}
                  @click=${() => this._updateCableConfig(gym, item, { loadType: "weight_stack" })}
                >Weight stack</button>
              </span>
            </div>
            <div class="cable-config-row">
              <span class="cable-config-label">Pulley ratio</span>
              <span class="cable-choice">
                ${[1, 2].map((ratio) => html`
                  <button
                    class=${config.pulleyRatio === ratio ? "active" : ""}
                    @click=${() => this._updateCableConfig(gym, item, { pulleyRatio: ratio })}
                  >${ratio}:1</button>
                `)}
              </span>
            </div>
            ${isPlateLoaded
              ? html`
                  <div class="stack-fields">
                    <label>Loading points<select .value=${String(config.loadingPoints ?? "")} @change=${(e: Event) => this._updateCableConfig(gym, item, { loadingPoints: Number((e.target as HTMLSelectElement).value) || null })}>
                      <option value="">Select configuration</option><option value="1">Single pin</option><option value="2">Two balanced horns</option></select></label>
                    <label>Base load (${this.gainsState.profile?.units === "metric" ? "kg" : "lb"})<input type="number" min="0" step="any" .value=${config.baseWeight == null ? "" : String(config.baseWeight)} @change=${(e: Event) => this._updateCableConfig(gym, item, { baseWeight: (e.target as HTMLInputElement).value === "" ? null : Number((e.target as HTMLInputElement).value) })}></label>
                  </div>
                  <p class="cable-help">
                    Uses the plates in this gym profile. During a workout, log the plate load
                    you actually put on the cable carriage; Gains stores the pulley ratio separately.
                  </p>
                `
              : html`
                  <div class="stack-fields">
                    <label>First stack setting (${this.gainsState.profile?.units === "metric" ? "kg" : "lb"})
                      <input type="number" min="0" step="any" placeholder="Same as increment"
                        .value=${config.stackMin == null ? "" : String(config.stackMin)}
                        @change=${(e: Event) => this._updateCableConfig(gym, item, { stackMin: (e.target as HTMLInputElement).value === "" ? null : Number((e.target as HTMLInputElement).value) })}>
                    </label>
                    <label>Stack max (${this.gainsState.profile?.units === "metric" ? "kg" : "lb"})
                      <input
                        type="number"
                        min="1"
                        step="any"
                        .value=${config.stackMax != null ? String(config.stackMax) : ""}
                        @change=${(e: Event) => this._updateCableConfig(gym, item, {
                          stackMax: Number((e.target as HTMLInputElement).value) || null,
                        })}
                      />
                    </label>
                    <label>Increment (${this.gainsState.profile?.units === "metric" ? "kg" : "lb"})
                      <input
                        type="number"
                        min="1"
                        step="any"
                        .value=${config.stackIncrement != null ? String(config.stackIncrement) : ""}
                        @change=${(e: Event) => this._updateCableConfig(gym, item, {
                          stackIncrement: Number((e.target as HTMLInputElement).value) || null,
                        })}
                      />
                    </label>
                  </div>
                  <p class="cable-help">
                    Stack max and increment describe the selectorized machine. Workout sets still
                    record the weight selected for that exercise.
                  </p>
                `}
          </div>
        ` : ""}
      </div>
    `;
  }

  private _renderItem(gym: GymProfile, item: EquipmentItem) {
    if (item.id in WEIGHT_PICKER_OPTIONS) {
      return this._renderWeightPickerItem(gym, item);
    }
    if (["cable_machines", "machines", "plate_loaded_machines"].includes(item.category)) {
      return this._renderCableItem(gym, item);
    }

    const instances = gym.equipment[item.id];
    const checked = instances !== undefined;

    return html`
      <div class="equipment-group">
        <div class="item-row">
          <span class="item-name">${item.name}</span>
          <input
            type="checkbox"
            class="toggle"
            .checked=${checked}
            @change=${(e: Event) => this._toggle(gym, item, (e.target as HTMLInputElement).checked)}
          />
        </div>
        ${checked
          ? html`
              <div class="instances">
                ${instances!.map((weight, i) => this._renderInstance(gym, item, i, weight))}
                <button class="add-another" @click=${() => this._addInstance(gym, item)}>
                  + Add another
                </button>
              </div>
            `
          : ""}
      </div>
    `;
  }

  private _renderGymList() {
    const profile = this.gainsState.profile!;
    const gyms = this._gymProfiles;

    return html`
      <ha-card class="panel">
        <h2>Gym Profile</h2>
        <p class="muted small">
          Gym profiles are shared with every Home Assistant member on this
          instance -- select which one is yours, or manage any of them.
        </p>

        ${gyms.length === 0
          ? html`<p class="muted small">No gym profiles yet. Create one below.</p>`
          : html`
              <ul class="gym-list">
                ${gyms.map((gym) => {
                  const isSelected = profile.gymProfileId === gym.id;
                  const isRenaming = this._renamingGymId === gym.id;
                  return html`
                    <li>
                      ${isRenaming
                        ? html`
                            <span class="gym-name-row">
                              <input
                                type="text"
                                .value=${this._renameInput}
                                @input=${(e: Event) =>
                                  (this._renameInput = (e.target as HTMLInputElement).value)}
                              />
                              <button class="secondary" @click=${() => this._saveRename(gym)}>
                                Save
                              </button>
                              <button
                                class="secondary"
                                @click=${() => (this._renamingGymId = null)}
                              >
                                Cancel
                              </button>
                            </span>
                          `
                        : html`
                            <span class="gym-name-row">
                              <strong>${gym.name}</strong>
                              ${isSelected ? html`<span class="badge success">Selected</span>` : ""}
                            </span>
                          `}
                      ${!isRenaming
                        ? html`
                            <span class="gym-actions">
                              ${!isSelected
                                ? html`
                                    <button
                                      class="secondary"
                                      ?disabled=${this._busyGymId === gym.id}
                                      @click=${() => this._select(gym.id)}
                                    >
                                      Select
                                    </button>
                                  `
                                : ""}
                              <button
                                class="secondary"
                                @click=${() =>
                                  (this._editingGymId =
                                    this._editingGymId === gym.id ? null : gym.id)}
                              >
                                ${this._editingGymId === gym.id ? "Close" : "Manage equipment"}
                              </button>
                              <button class="secondary" @click=${() => this._startRename(gym)}>
                                Rename
                              </button>
                              <button
                                class="secondary"
                                ?disabled=${this._busyGymId === gym.id}
                                @click=${() => this._deleteGym(gym)}
                              >
                                Delete
                              </button>
                            </span>
                          `
                        : ""}
                    </li>
                  `;
                })}
              </ul>
            `}
        ${profile.gymProfileId !== null
          ? html`
              <div class="actions">
                <button
                  class="secondary"
                  ?disabled=${this._busyGymId === "__clearing__"}
                  @click=${() => this._select(null)}
                >
                  Clear selection (bodyweight-only)
                </button>
              </div>
            `
          : ""}

        ${this._creatingNew
          ? html`
              <div class="new-gym-row">
                <input
                  type="text"
                  placeholder="e.g. Home Gym"
                  .value=${this._newGymName}
                  @input=${(e: Event) => (this._newGymName = (e.target as HTMLInputElement).value)}
                />
                <button
                  class="primary"
                  ?disabled=${!this._newGymName.trim() || this._busyGymId === "__creating__"}
                  @click=${this._createGym}
                >
                  Create
                </button>
                <button class="secondary" @click=${() => (this._creatingNew = false)}>
                  Cancel
                </button>
              </div>
            `
          : html`
              <div class="actions">
                <button class="primary" @click=${() => (this._creatingNew = true)}>
                  + New Gym Profile
                </button>
              </div>
            `}
      </ha-card>
    `;
  }

  private _renderEquipmentEditor(gym: GymProfile) {
    const search = this._search.trim().toLowerCase();
    const filtered = search
      ? EQUIPMENT_CATALOG.filter((e) => e.name.toLowerCase().includes(search))
      : EQUIPMENT_CATALOG;

    return html`
      <ha-card class="panel">
        <h2>${gym.name}'s Equipment</h2>
        <div class="search-row">
          <ha-icon icon="mdi:magnify"></ha-icon>
          <input
            type="text"
            placeholder="Search equipment"
            .value=${this._search}
            @input=${(e: Event) => (this._search = (e.target as HTMLInputElement).value)}
          />
        </div>
        ${filtered.length === 0 ? html`<p class="muted">No matches.</p>` : ""}
        ${CATEGORY_ORDER.map((category) => {
          const items = filtered.filter((e) => e.category === category);
          if (items.length === 0) return "";
          // Searching implies "show me matches now" -- collapse state is
          // ignored while a search is active so a match hidden inside a
          // collapsed category can't silently disappear.
          const isCollapsed = !search && this._collapsedCategories.has(category);
          return html`
            <button class="category-header" @click=${() => this._toggleCategoryCollapse(category)}>
              <ha-icon icon=${isCollapsed ? "mdi:chevron-right" : "mdi:chevron-down"}></ha-icon>
              ${EQUIPMENT_CATEGORY_LABELS[category] ?? category}
            </button>
            ${isCollapsed
              ? ""
              : html`
                  <div class="equipment-list">
                    ${items.map((item) => this._renderItem(gym, item))}
                  </div>
                `}
          `;
        })}
      </ha-card>
    `;
  }

  render() {
    if (!this.gainsState.profile) {
      return html`<ha-card class="panel"><p class="muted">Loading&hellip;</p></ha-card>`;
    }

    const editingGym = this._editingGym;

    return html`
      ${this._renderGymList()} ${editingGym ? this._renderEquipmentEditor(editingGym) : ""}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "gains-equipment-view": GainsEquipmentView;
  }
}
