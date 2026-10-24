import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { hustleApi } from "../ha-api";
import type { HustleState } from "../types";
import { signedFormatCents } from "../utils/money";
import { formatDate } from "../utils/time";
import { memberName } from "../utils/members";
import { glassCardStyle, formStyles } from "../styles";
import "../components/hustle-dialog";

type DialogState = "type" | "entry" | null;

@customElement("hustle-behavior-view")
export class HustleBehaviorView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) hustleState!: HustleState;

  @state() private _dialog: DialogState = null;
  @state() private _saving = false;

  // new type form
  @state() private _label = "";
  @state() private _category = "bonus";
  @state() private _defaultAmount = "1.00";
  @state() private _icon = "";

  // new entry form
  @state() private _memberId = "";
  @state() private _behaviorTypeId = "";
  @state() private _amountOverride = "";
  @state() private _note = "";

  static styles = [
    glassCardStyle,
    formStyles,
    css`
      .spread {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 12px;
      }
      ha-card {
        padding: 16px;
        margin-bottom: 16px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th,
      td {
        text-align: left;
        padding: 8px 6px;
        border-bottom: 1px solid var(--divider-color, #e0e0e0);
        font-size: 0.92rem;
      }
    `,
  ];

  private _openTypeDialog(): void {
    this._label = "";
    this._category = "bonus";
    this._defaultAmount = "1.00";
    this._icon = "";
    this._dialog = "type";
  }

  private async _saveType(): Promise<void> {
    if (!this._label.trim()) return;
    this._saving = true;
    try {
      await hustleApi.addBehaviorType(this.hass, {
        label: this._label.trim(),
        category: this._category,
        default_amount_cents: Math.round(Number(this._defaultAmount) * 100) || 0,
        icon: this._icon || null,
      });
      this._dialog = null;
    } finally {
      this._saving = false;
    }
  }

  private _openEntryDialog(): void {
    const types = this.hustleState.behaviorTypes.filter((t) => t.active);
    this._memberId = this.hustleState.members[0]?.memberId ?? "";
    this._behaviorTypeId = types[0]?.id ?? "";
    this._amountOverride = "";
    this._note = "";
    this._dialog = "entry";
  }

  private async _saveEntry(): Promise<void> {
    if (!this._memberId || !this._behaviorTypeId) return;
    this._saving = true;
    try {
      await hustleApi.recordBehaviorEntry(this.hass, {
        behavior_type_id: this._behaviorTypeId,
        member_id: this._memberId,
        amount_cents: this._amountOverride ? Math.round(Number(this._amountOverride) * 100) : null,
        note: this._note || null,
      });
      this._dialog = null;
    } finally {
      this._saving = false;
    }
  }

  render() {
    const s = this.hustleState;
    const types = s.behaviorTypes.filter((t) => t.active);
    const allEntries = s.behavior
      .flatMap((b) => b.recentEntries.map((e) => ({ ...e, memberId: b.memberId })))
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));

    return html`
      <div class="spread">
        <h1>Behavior</h1>
        <div class="row" style="width:auto; display:flex; gap:8px;">
          <button class="secondary" @click=${this._openTypeDialog}>+ New type</button>
          <button class="primary" @click=${this._openEntryDialog}>+ Record</button>
        </div>
      </div>

      <ha-card>
        <h3>Bonus &amp; deduction catalog</h3>
        <div class="wrap">
          ${types.length === 0
            ? html`<span class="muted small">No behavior types recorded yet - try "Good attitude" or "Left toys out".</span>`
            : types.map((t) => html`<span class="badge">${t.label}</span>`)}
        </div>
      </ha-card>

      <ha-card>
        <h3>History</h3>
        ${allEntries.length === 0
          ? html`<div class="empty">No behavior entries yet.</div>`
          : html`
              <table>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Child</th>
                    <th>Amount</th>
                    <th>Note</th>
                    <th>Date</th>
                  </tr>
                </thead>
                <tbody>
                  ${allEntries.map(
                    (e) => html`
                      <tr>
                        <td><span class="badge ${e.amountCents < 0 ? "error" : "success"}">${e.behaviorTypeLabel}</span></td>
                        <td>${memberName(this.hustleState,e.memberId)}</td>
                        <td style="color:${e.amountCents < 0 ? "var(--error-color, #c62828)" : "var(--success-color, #43a047)"};font-weight:600">
                          ${signedFormatCents(e.amountCents)}
                        </td>
                        <td class="muted">${e.note ?? ""}</td>
                        <td>${formatDate(e.recordedAt)}</td>
                      </tr>
                    `
                  )}
                </tbody>
              </table>
            `}
      </ha-card>

      <hustle-dialog
        heading=${this._dialog === "type" ? "New behavior type" : "Record behavior"}
        .open=${this._dialog !== null}
        @hustle-dialog-closed=${() => (this._dialog = null)}
      >
        ${this._dialog === "type"
          ? html`
              <label>Label</label>
              <input placeholder="e.g. Helped without being asked" .value=${this._label} @input=${(e: InputEvent) => (this._label = (e.target as HTMLInputElement).value)} />
              <div class="row">
                <div class="field grow">
                  <label>Category</label>
                  <select @change=${(e: Event) => (this._category = (e.target as HTMLSelectElement).value)}>
                    <option value="bonus" ?selected=${this._category === "bonus"}>Bonus</option>
                    <option value="deduction" ?selected=${this._category === "deduction"}>Deduction</option>
                  </select>
                </div>
                <div class="field grow">
                  <label>Default amount ($)</label>
                  <input type="number" step="0.01" min="0" .value=${this._defaultAmount} @input=${(e: InputEvent) => (this._defaultAmount = (e.target as HTMLInputElement).value)} />
                </div>
              </div>
              <label>Icon (optional)</label>
              <input placeholder="mdi:star" .value=${this._icon} @input=${(e: InputEvent) => (this._icon = (e.target as HTMLInputElement).value)} />
              <div class="actions">
                <button class="secondary" @click=${() => (this._dialog = null)}>Cancel</button>
                <button class="primary" ?disabled=${this._saving} @click=${this._saveType}>Save</button>
              </div>
            `
          : html`
              <label>Child</label>
              <select @change=${(e: Event) => (this._memberId = (e.target as HTMLSelectElement).value)}>
                ${s.members.map(
                  (m) => html`<option value=${m.memberId} ?selected=${m.memberId === this._memberId}>${memberName(this.hustleState,m.memberId)}</option>`
                )}
              </select>
              <label>Type</label>
              <select @change=${(e: Event) => (this._behaviorTypeId = (e.target as HTMLSelectElement).value)}>
                ${types.length === 0
                  ? html`<option value="">No types recorded yet</option>`
                  : types.map((t) => html`<option value=${t.id} ?selected=${t.id === this._behaviorTypeId}>${t.label}</option>`)}
              </select>
              <label>Override amount ($, optional)</label>
              <input type="number" step="0.01" min="0" .value=${this._amountOverride} @input=${(e: InputEvent) => (this._amountOverride = (e.target as HTMLInputElement).value)} />
              <label>Note (optional)</label>
              <input .value=${this._note} @input=${(e: InputEvent) => (this._note = (e.target as HTMLInputElement).value)} />
              <div class="actions">
                <button class="secondary" @click=${() => (this._dialog = null)}>Cancel</button>
                <button class="primary" ?disabled=${this._saving} @click=${this._saveEntry}>Record</button>
              </div>
            `}
      </hustle-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "hustle-behavior-view": HustleBehaviorView;
  }
}
