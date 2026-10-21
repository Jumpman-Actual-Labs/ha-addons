import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { cacheApi } from "../ha-api";
import type { Ammunition, CacheState, RangeSession } from "../types";
import { formStyles } from "../styles";
import { todayIso } from "../utils/format";
import "./cache-dialog";

interface Row {
  firearmId: string;
  ammunitionId: string;
  roundsFired: string;
}

const EMPTY_ROW: Row = { firearmId: "", ammunitionId: "", roundsFired: "" };

/** Log Range Session dialog - shared between the Range Sessions tab (no
 * preset, or editing an existing session via `editingSession`) and a
 * firearm's detail view (preselects that firearm's first row). Saving
 * calls cache.log_range_session or cache.update_range_session, both of
 * which the backend applies atomically (round counts + ammo deduction
 * either all happen or none do; editing additionally reverses the old
 * entries' effects before applying the new ones). Ammo selection is a
 * two-step picker (caliber, then the specific entry within that caliber)
 * rather than one flat dropdown - a collection with more than one product
 * in the same caliber (e.g. two different 300 BLK loads) would otherwise
 * show that caliber's label more than once with nothing but the quantity
 * to tell the entries apart. Once a row has a firearm selected, the
 * caliber step is narrowed to only that firearm's own caliber (skipped
 * entirely when there's exactly one match) rather than every caliber in
 * the collection, since ammo in an unrelated caliber can't be fired from
 * it anyway. */
@customElement("log-range-session-dialog")
export class LogRangeSessionDialog extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) cacheState!: CacheState;
  @property({ type: Boolean }) open = false;
  @property({ type: String }) presetFirearmId = "";
  @property({ attribute: false }) editingSession: RangeSession | null = null;

  @state() private _date = todayIso();
  @state() private _location = "";
  @state() private _notes = "";
  @state() private _rows: Row[] = [{ ...EMPTY_ROW }];
  @state() private _error: string | null = null;
  @state() private _saving = false;

  @state() private _ammoPickerRow: number | null = null;
  @state() private _ammoPickerCaliber: string | null = null;

  static styles = [
    formStyles,
    css`
      .row {
        display: grid;
        grid-template-columns: 2fr 2fr 1fr auto;
        gap: 8px;
        align-items: end;
        margin-bottom: 8px;
      }
      .row label {
        margin: 0 0 4px;
      }
      .remove-row {
        background: none;
        border: none;
        cursor: pointer;
        color: var(--secondary-text-color, #727272);
        padding: 8px 0;
      }
      .ammo-trigger {
        display: block;
        width: 100%;
        box-sizing: border-box;
        padding: 8px 10px;
        border-radius: 6px;
        border: 1px solid var(--divider-color, #e0e0e0);
        background: var(--card-background-color, #fff);
        color: var(--primary-text-color, #212121);
        font-size: 1rem;
        font-family: inherit;
        text-align: left;
        cursor: pointer;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .picker-back {
        background: none;
        border: none;
        color: var(--primary-color, #03a9f4);
        cursor: pointer;
        padding: 0;
        font-size: 0.9rem;
        margin-bottom: 8px;
      }
      .picker-list {
        display: flex;
        flex-direction: column;
        gap: 2px;
        max-height: 50vh;
        overflow-y: auto;
      }
      .picker-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
        width: 100%;
        box-sizing: border-box;
        background: none;
        border: none;
        text-align: left;
        padding: 10px 12px;
        border-radius: 8px;
        cursor: pointer;
        color: var(--primary-text-color, #212121);
        font-size: 0.95rem;
      }
      .picker-item:hover {
        background: var(--secondary-background-color, #f0f0f0);
      }
      .picker-item .muted {
        flex-shrink: 0;
      }
    `,
  ];

  willUpdate(changed: Map<string, unknown>): void {
    if (changed.has("open") && this.open) {
      this._error = null;
      this._ammoPickerRow = null;
      this._ammoPickerCaliber = null;
      if (this.editingSession) {
        const session = this.editingSession;
        this._date = session.date;
        this._location = session.location ?? "";
        this._notes = session.notes ?? "";
        this._rows = session.firearms.length
          ? session.firearms.map((f) => ({
              firearmId: f.firearmId,
              ammunitionId: f.ammunitionId ?? "",
              roundsFired: f.roundsFired.toString(),
            }))
          : [{ ...EMPTY_ROW }];
      } else {
        this._date = todayIso();
        this._location = "";
        this._notes = "";
        this._rows = [{ ...EMPTY_ROW, firearmId: this.presetFirearmId }];
      }
    }
  }

  private _updateRow(index: number, patch: Partial<Row>): void {
    this._rows = this._rows.map((r, i) => (i === index ? { ...r, ...patch } : r));
  }

  private _updateRowFirearm(index: number, firearmId: string): void {
    const row = this._rows[index];
    const firearm = (this.cacheState?.firearms ?? []).find((f) => f.id === firearmId);
    const currentAmmo = (this.cacheState?.ammunition ?? []).find((a) => a.id === row.ammunitionId);
    const stillCompatible = !firearm?.caliber || !currentAmmo || currentAmmo.caliber === firearm.caliber;
    this._updateRow(index, { firearmId, ammunitionId: stillCompatible ? row.ammunitionId : "" });
  }

  private _close(): void {
    this.dispatchEvent(new CustomEvent("cache-dialog-closed"));
  }

  private _ammoLabel(ammunitionId: string): string {
    if (!ammunitionId) return "Not tracked";
    const ammo = (this.cacheState?.ammunition ?? []).find((a) => a.id === ammunitionId);
    if (!ammo) return "Not tracked";
    const desc = [ammo.manufacturer, ammo.productName].filter(Boolean).join(" ");
    return `${ammo.caliber}${desc ? ` — ${desc}` : ""} (${ammo.quantity} left)`;
  }

  /** The calibers reachable from a row's ammo picker - narrowed to the
   * row's selected firearm's own caliber (if it has one and ammo exists
   * in it) rather than every caliber in the collection, since ammo in an
   * unrelated caliber isn't something that firearm can fire. Falls back
   * to every caliber when no firearm is selected yet, or the firearm has
   * no caliber recorded, since there's nothing to narrow against. */
  private _calibersForRow(rowIndex: number): string[] {
    const ammo = this.cacheState?.ammunition ?? [];
    const allCalibers = Array.from(new Set(ammo.map((a) => a.caliber))).sort((a, b) =>
      a.localeCompare(b)
    );
    const firearm = (this.cacheState?.firearms ?? []).find(
      (f) => f.id === this._rows[rowIndex]?.firearmId
    );
    if (!firearm?.caliber) return allCalibers;
    return allCalibers.includes(firearm.caliber) ? [firearm.caliber] : [];
  }

  private _openAmmoPicker(rowIndex: number): void {
    const current = (this.cacheState?.ammunition ?? []).find(
      (a) => a.id === this._rows[rowIndex].ammunitionId
    );
    const calibers = this._calibersForRow(rowIndex);
    this._ammoPickerCaliber = current?.caliber ?? (calibers.length === 1 ? calibers[0] : null);
    this._ammoPickerRow = rowIndex;
  }

  private _closeAmmoPicker(): void {
    this._ammoPickerRow = null;
    this._ammoPickerCaliber = null;
  }

  private _pickAmmo(ammunitionId: string): void {
    if (this._ammoPickerRow !== null) {
      this._updateRow(this._ammoPickerRow, { ammunitionId });
    }
    this._closeAmmoPicker();
  }

  private async _save(): Promise<void> {
    this._error = null;
    const firearms = this._rows
      .filter((r) => r.firearmId && Number(r.roundsFired) > 0)
      .map((r) => ({
        firearm_id: r.firearmId,
        ammunition_id: r.ammunitionId || undefined,
        rounds_fired: Number(r.roundsFired),
      }));
    if (firearms.length === 0) {
      this._error = "Add at least one firearm with rounds fired.";
      return;
    }
    this._saving = true;
    try {
      const fields = {
        date: this._date,
        location: this._location || undefined,
        notes: this._notes || undefined,
        firearms,
      };
      if (this.editingSession) {
        await cacheApi.updateRangeSession(this.hass, this.editingSession.id, fields);
      } else {
        await cacheApi.logRangeSession(this.hass, fields);
      }
      this._close();
    } catch (err) {
      this._error = err instanceof Error ? err.message : "Failed to save range session";
    } finally {
      this._saving = false;
    }
  }

  render() {
    const firearms = this.cacheState?.firearms ?? [];
    const ammo = this.cacheState?.ammunition ?? [];

    const pickerCalibers = this._ammoPickerRow !== null ? this._calibersForRow(this._ammoPickerRow) : [];
    const caliberTotal = (caliber: string): number =>
      ammo.filter((a) => a.caliber === caliber).reduce((sum, a) => sum + a.quantity, 0);
    const ammoLabel = (a: Ammunition): string =>
      [a.manufacturer, a.productName].filter(Boolean).join(" ") || "Unlabeled";

    return html`
      <cache-dialog
        .open=${this.open}
        heading=${this.editingSession ? "Edit Range Session" : "Log Range Session"}
        width="620px"
        @cache-dialog-closed=${this._close}
      >
        ${this._error ? html`<div class="error-banner">${this._error}</div>` : ""}
        <div class="field-row">
          <div>
            <label>Date</label>
            <input type="date" .value=${this._date} @input=${(e: Event) => (this._date = (e.target as HTMLInputElement).value)} />
          </div>
          <div>
            <label>Location</label>
            <input .value=${this._location} @input=${(e: Event) => (this._location = (e.target as HTMLInputElement).value)} />
          </div>
        </div>

        <label>Firearms Used</label>
        ${this._rows.map(
          (row, i) => html`
            <div class="row">
              <div>
                <select
                  .value=${row.firearmId}
                  @change=${(e: Event) => this._updateRowFirearm(i, (e.target as HTMLSelectElement).value)}
                >
                  <option value="">Select firearm</option>
                  ${firearms.map((f) => html`<option value=${f.id} ?selected=${f.id === row.firearmId}>${f.customName}</option>`)}
                </select>
              </div>
              <div>
                <button type="button" class="ammo-trigger" @click=${() => this._openAmmoPicker(i)}>
                  ${this._ammoLabel(row.ammunitionId)}
                </button>
              </div>
              <div>
                <input
                  type="number"
                  placeholder="Rounds"
                  .value=${row.roundsFired}
                  @input=${(e: Event) => this._updateRow(i, { roundsFired: (e.target as HTMLInputElement).value })}
                />
              </div>
              <button
                class="remove-row"
                ?disabled=${this._rows.length === 1}
                @click=${() => (this._rows = this._rows.filter((_, idx) => idx !== i))}
                aria-label="Remove row"
              >
                <ha-icon icon="mdi:close"></ha-icon>
              </button>
            </div>
          `
        )}
        <button class="link" @click=${() => (this._rows = [...this._rows, { ...EMPTY_ROW }])}>
          + Add Firearm
        </button>

        <label>Notes</label>
        <textarea .value=${this._notes} @input=${(e: Event) => (this._notes = (e.target as HTMLTextAreaElement).value)}></textarea>

        <div class="actions">
          <button class="secondary" @click=${this._close}>Cancel</button>
          <button class="primary" ?disabled=${this._saving} @click=${this._save}>
            ${this.editingSession ? "Save Changes" : "Save Session"}
          </button>
        </div>
      </cache-dialog>

      <cache-dialog
        .open=${this._ammoPickerRow !== null}
        heading=${this._ammoPickerCaliber ? this._ammoPickerCaliber : "Select Ammunition"}
        width="420px"
        @cache-dialog-closed=${this._closeAmmoPicker}
      >
        ${this._ammoPickerCaliber === null
          ? html`
              <div class="picker-list">
                <button class="picker-item" @click=${() => this._pickAmmo("")}>
                  <span>Not tracked</span>
                </button>
                ${pickerCalibers.length === 0
                  ? html`<p class="small muted">No ammunition tracked in this firearm's caliber yet.</p>`
                  : pickerCalibers.map(
                      (c) => html`
                        <button class="picker-item" @click=${() => (this._ammoPickerCaliber = c)}>
                          <span>${c}</span>
                          <span class="muted small">${caliberTotal(c)} left</span>
                        </button>
                      `
                    )}
              </div>
            `
          : html`
              <button class="picker-back" @click=${() => (this._ammoPickerCaliber = null)}>
                <ha-icon icon="mdi:arrow-left" style="vertical-align:middle"></ha-icon> Back
              </button>
              <div class="picker-list">
                ${ammo
                  .filter((a) => a.caliber === this._ammoPickerCaliber)
                  .map(
                    (a) => html`
                      <button class="picker-item" @click=${() => this._pickAmmo(a.id)}>
                        <span>${ammoLabel(a)}${a.bulletType ? ` · ${a.bulletType}` : ""}</span>
                        <span class="muted small">${a.quantity} left</span>
                      </button>
                    `
                  )}
              </div>
            `}
      </cache-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "log-range-session-dialog": LogRangeSessionDialog;
  }
}
