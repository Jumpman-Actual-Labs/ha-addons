import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { cacheApi } from "../ha-api";
import type { CacheState, RangeSchedule, RangeScheduleTarget } from "../types";
import { FIREARM_TYPES, RANGE_SCHEDULE_FREQUENCIES, RANGE_SCHEDULE_FREQUENCY_LABELS } from "../types";
import { glassCardStyle, formStyles } from "../styles";
import { formatDate } from "../utils/format";
import { knownBulletTypes, knownCalibers } from "../utils/options";
import "../components/cache-dialog";

interface TargetDraft {
  targetType: "firearm" | "firearm_type" | "caliber";
  firearmId: string;
  firearmType: string;
  caliber: string;
  speedClass: "" | "Subsonic" | "Supersonic";
  bulletType: string;
  roundsMin: string;
}

const EMPTY_TARGET: TargetDraft = {
  targetType: "firearm_type",
  firearmId: "",
  firearmType: "Handgun",
  caliber: "",
  speedClass: "",
  bulletType: "",
  roundsMin: "",
};

interface ScheduleDraft {
  targets: TargetDraft[];
  frequency: string;
  label: string;
  ammoAlertEnabled: boolean;
  notes: string;
}

const EMPTY_DRAFT: ScheduleDraft = {
  targets: [{ ...EMPTY_TARGET }],
  frequency: "quarterly",
  label: "",
  ammoAlertEnabled: false,
  notes: "",
};

/** Training Schedule - recurring range goals. Each schedule has a list of
 * targets - each independently one specific firearm, every firearm of a
 * given type, or every firearm chambered in a given caliber, with optional
 * per-target ammo filters (speed class - Subsonic/Supersonic only - and
 * bullet type, e.g. "JHP" or "Buckshot") - and matches a firearm/session if
 * it satisfies ANY target. That's what lets one schedule cover a
 * multi-caliber AR upper (a 300 BLK target + a 5.56 target), "train with
 * either my AR or my shotgun," or "train with my suppressed pistol, but
 * only subsonic JHP." Logging a matching Range Session (see
 * range-sessions-view / firearm detail) automatically marks it trained.
 * Ammo alert (optional) flags a schedule where ANY target with its own
 * minimum-rounds set doesn't have enough on-hand ammo matching its
 * caliber(s)/speed_class/bullet_type. */
@customElement("cache-training-schedule-view")
export class CacheTrainingScheduleView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) cacheState!: CacheState;

  @state() private _formOpen = false;
  @state() private _editing: RangeSchedule | null = null;
  @state() private _draft: ScheduleDraft = { ...EMPTY_DRAFT, targets: [{ ...EMPTY_TARGET }] };
  @state() private _error: string | null = null;
  @state() private _deleteTarget: RangeSchedule | null = null;

  static styles = [
    glassCardStyle,
    formStyles,
    css`
      ha-card.schedule {
        padding: 16px;
      }
      .schedule-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 8px;
      }
      .schedule-title {
        font-weight: 600;
        font-size: 1.05rem;
      }
      .due-status {
        font-size: 0.85rem;
        margin: 8px 0;
      }
      .due-status.due {
        color: var(--error-color, #c62828);
        font-weight: 600;
      }
      .due-status.ok {
        color: var(--success-color, #43a047);
      }
      .schedule-actions {
        display: flex;
        gap: 4px;
        flex-shrink: 0;
      }
      .schedule-actions button {
        background: none;
        border: none;
        cursor: pointer;
        color: var(--secondary-text-color, #727272);
      }
      .target-row {
        display: flex;
        gap: 8px;
        align-items: flex-start;
        margin-bottom: 8px;
        flex-wrap: wrap;
      }
      .target-row > div {
        flex: 1;
        min-width: 120px;
      }
      .target-row .rounds-min {
        flex: 0 1 100px;
        min-width: 90px;
      }
      .target-row .remove-target {
        background: none;
        border: none;
        cursor: pointer;
        color: var(--secondary-text-color, #727272);
        padding: 8px 0 0;
        flex-shrink: 0;
      }
      .add-target {
        background: none;
        border: none;
        color: var(--primary-color, #03a9f4);
        cursor: pointer;
        padding: 0;
        font-size: 0.9rem;
        margin-bottom: 16px;
      }
    `,
  ];

  private _openAdd(): void {
    this._editing = null;
    this._draft = { ...EMPTY_DRAFT, targets: [{ ...EMPTY_TARGET }] };
    this._error = null;
    this._formOpen = true;
  }

  private _openEdit(s: RangeSchedule): void {
    this._editing = s;
    this._draft = {
      targets:
        s.targets.length > 0
          ? s.targets.map((t) => ({
              targetType: t.targetType,
              firearmId: t.firearmId ?? "",
              firearmType: t.firearmType ?? "Handgun",
              caliber: t.caliber ?? "",
              speedClass: t.speedClass ?? "",
              bulletType: t.bulletType ?? "",
              roundsMin: t.roundsMin?.toString() ?? "",
            }))
          : [{ ...EMPTY_TARGET }],
      frequency: s.frequency,
      label: s.label ?? "",
      ammoAlertEnabled: s.ammoAlertEnabled,
      notes: s.notes ?? "",
    };
    this._error = null;
    this._formOpen = true;
  }

  private _updateTarget(index: number, patch: Partial<TargetDraft>): void {
    const targets = this._draft.targets.map((t, i) => (i === index ? { ...t, ...patch } : t));
    this._draft = { ...this._draft, targets };
  }

  private _addTarget(): void {
    this._draft = { ...this._draft, targets: [...this._draft.targets, { ...EMPTY_TARGET }] };
  }

  private _removeTarget(index: number): void {
    if (this._draft.targets.length <= 1) return;
    this._draft = { ...this._draft, targets: this._draft.targets.filter((_, i) => i !== index) };
  }

  private async _save(): Promise<void> {
    this._error = null;
    const d = this._draft;
    const payload: Record<string, unknown> = {
      targets: d.targets.map((t) => ({
        target_type: t.targetType,
        firearm_id: t.targetType === "firearm" ? t.firearmId : "",
        firearm_type: t.targetType === "firearm_type" ? t.firearmType : "",
        caliber: t.targetType === "caliber" ? t.caliber : "",
        speed_class: t.speedClass || "",
        bullet_type: t.bulletType || "",
        rounds_min: t.roundsMin === "" ? "" : Number(t.roundsMin),
      })),
      frequency: d.frequency,
      label: d.label || "",
      ammo_alert_enabled: d.ammoAlertEnabled,
      notes: d.notes || "",
    };
    try {
      if (this._editing) {
        await cacheApi.updateRangeSchedule(this.hass, this._editing.id, payload);
      } else {
        await cacheApi.addRangeSchedule(this.hass, payload);
      }
      this._formOpen = false;
    } catch (err) {
      this._error = err instanceof Error ? err.message : "Failed to save training schedule";
    }
  }

  private async _confirmDelete(): Promise<void> {
    if (!this._deleteTarget) return;
    await cacheApi.deleteRangeSchedule(this.hass, this._deleteTarget.id);
    this._deleteTarget = null;
  }

  private _describeSingleTarget(t: RangeScheduleTarget): string {
    let label: string;
    if (t.targetType === "firearm") {
      const firearm = this.cacheState.firearms.find((f) => f.id === t.firearmId);
      label = firearm ? firearm.customName : "Firearm (deleted)";
    } else if (t.targetType === "caliber") {
      label = `${t.caliber} ammo`;
    } else {
      label = `All ${t.firearmType}s`;
    }
    const qualifiers = [t.speedClass?.toLowerCase(), t.bulletType].filter(Boolean);
    return qualifiers.length ? `${label} (${qualifiers.join(", ")} only)` : label;
  }

  private _describeTargets(s: RangeSchedule): string {
    const desc = s.targets.map((t) => this._describeSingleTarget(t)).join(" + ");
    return `${desc} (${s.matchingFirearmNames.length})`;
  }

  render() {
    const schedules = this.cacheState.rangeSchedules;
    const firearms = this.cacheState.firearms;
    const invalidTarget = this._draft.targets.some(
      (t) =>
        (t.targetType === "firearm" && !t.firearmId) || (t.targetType === "caliber" && !t.caliber)
    );

    return html`
      <div class="toolbar">
        <h1 style="margin:0;font-size:1.4rem;font-weight:600">Training Schedule</h1>
        <button class="primary" @click=${this._openAdd}>+ Add Schedule</button>
      </div>

      ${schedules.length === 0
        ? html`<div class="empty">
            No training schedules yet. Create one to set a recurring goal - for example, "Home
            Defense AR" quarterly, "All Shotguns" quarterly, or "All 300 BLK" monthly. Add more
            than one target to cover a multi-caliber AR (300 BLK + 5.56) in a single schedule.
          </div>`
        : html`
            <div class="grid">
              ${schedules.map((s) => {
                const dueLabel = s.lastCompletedDate
                  ? `Last trained ${formatDate(s.lastCompletedDate)} · next due ${formatDate(s.nextDueDate)}`
                  : "Never trained";
                return html`
                  <ha-card class="schedule">
                    <div class="schedule-header">
                      <div>
                        <div class="schedule-title">${s.label}</div>
                        <div class="small muted">${this._describeTargets(s)}</div>
                      </div>
                      <div class="schedule-actions">
                        <button @click=${() => this._openEdit(s)} aria-label="Edit">
                          <ha-icon icon="mdi:pencil"></ha-icon>
                        </button>
                        <button @click=${() => (this._deleteTarget = s)} aria-label="Delete">
                          <ha-icon icon="mdi:delete"></ha-icon>
                        </button>
                      </div>
                    </div>
                    <div class="chips" style="display:flex;gap:6px;flex-wrap:wrap;margin:8px 0">
                      <span class="badge">${RANGE_SCHEDULE_FREQUENCY_LABELS[s.frequency] ?? s.frequency}</span>
                      ${!s.active ? html`<span class="badge">Paused</span>` : ""}
                    </div>
                    <div class="due-status ${s.isDue ? "due" : "ok"}">
                      ${s.isDue ? "⚠ Training due" : "✓ Up to date"} — ${dueLabel}
                    </div>
                    ${s.ammoAlertEnabled && s.ammoOk !== null
                      ? html`
                          <div class="small ${s.ammoOk === false ? "due-status due" : "muted"}">
                            ${s.ammoOk === false
                              ? `Not enough ammo on hand (${s.matchingCalibers.join(", ") || "no caliber set"})`
                              : "Ammo check: on track"}
                          </div>
                        `
                      : ""}
                    ${s.notes ? html`<p class="small muted">${s.notes}</p>` : ""}
                  </ha-card>
                `;
              })}
            </div>
          `}

      <cache-dialog
        .open=${this._formOpen}
        .heading=${this._editing ? "Edit Training Schedule" : "Add Training Schedule"}
        width="480px"
        @cache-dialog-closed=${() => (this._formOpen = false)}
      >
        ${this._error ? html`<div class="error-banner">${this._error}</div>` : ""}
        <label>Label (optional)</label>
        <input
          placeholder="e.g. Home Defense AR"
          .value=${this._draft.label}
          @input=${(e: Event) => (this._draft = { ...this._draft, label: (e.target as HTMLInputElement).value })}
        />

        <label>Train with</label>
        ${this._draft.targets.map(
          (t, i) => html`
            <div class="target-row">
              <div>
                <select
                  .value=${t.targetType}
                  @change=${(e: Event) => this._updateTarget(i, { targetType: (e.target as HTMLSelectElement).value as TargetDraft["targetType"] })}
                >
                  <option value="firearm_type" ?selected=${t.targetType === "firearm_type"}>A firearm type</option>
                  <option value="firearm" ?selected=${t.targetType === "firearm"}>A specific firearm</option>
                  <option value="caliber" ?selected=${t.targetType === "caliber"}>An ammo type</option>
                </select>
              </div>
              <div>
                ${t.targetType === "firearm_type"
                  ? html`
                      <select
                        .value=${t.firearmType}
                        @change=${(e: Event) => this._updateTarget(i, { firearmType: (e.target as HTMLSelectElement).value })}
                      >
                        ${FIREARM_TYPES.map((ft) => html`<option value=${ft} ?selected=${ft === t.firearmType}>${ft}</option>`)}
                      </select>
                    `
                  : t.targetType === "caliber"
                    ? html`
                        <input
                          list="training-schedule-caliber-list"
                          placeholder="e.g. 300 BLK"
                          .value=${t.caliber}
                          @input=${(e: Event) => this._updateTarget(i, { caliber: (e.target as HTMLInputElement).value })}
                        />
                      `
                    : html`
                        <select
                          .value=${t.firearmId}
                          @change=${(e: Event) => this._updateTarget(i, { firearmId: (e.target as HTMLSelectElement).value })}
                        >
                          <option value="">Select firearm</option>
                          ${firearms.map((f) => html`<option value=${f.id} ?selected=${f.id === t.firearmId}>${f.customName}</option>`)}
                        </select>
                      `}
              </div>
              <div>
                <select
                  .value=${t.speedClass}
                  @change=${(e: Event) => this._updateTarget(i, { speedClass: (e.target as HTMLSelectElement).value as TargetDraft["speedClass"] })}
                >
                  <option value="" ?selected=${t.speedClass === ""}>Any ammo</option>
                  <option value="Subsonic" ?selected=${t.speedClass === "Subsonic"}>Subsonic only</option>
                  <option value="Supersonic" ?selected=${t.speedClass === "Supersonic"}>Supersonic only</option>
                </select>
              </div>
              <div>
                <input
                  list="training-schedule-bullet-type-list"
                  placeholder="Bullet type (any)"
                  .value=${t.bulletType}
                  @input=${(e: Event) => this._updateTarget(i, { bulletType: (e.target as HTMLInputElement).value })}
                />
              </div>
              <div class="rounds-min">
                <input
                  type="number"
                  placeholder="Min rounds"
                  .value=${t.roundsMin}
                  @input=${(e: Event) => this._updateTarget(i, { roundsMin: (e.target as HTMLInputElement).value })}
                />
              </div>
              ${this._draft.targets.length > 1
                ? html`<button class="remove-target" aria-label="Remove" @click=${() => this._removeTarget(i)}>
                    <ha-icon icon="mdi:close"></ha-icon>
                  </button>`
                : ""}
            </div>
          `
        )}
        <datalist id="training-schedule-caliber-list">
          ${knownCalibers(this.cacheState).map((c) => html`<option value=${c}></option>`)}
        </datalist>
        <datalist id="training-schedule-bullet-type-list">
          ${knownBulletTypes(this.cacheState).map((b) => html`<option value=${b}></option>`)}
        </datalist>
        <button class="add-target" @click=${this._addTarget}>+ Add another</button>

        <label>Frequency</label>
        <select
          .value=${this._draft.frequency}
          @change=${(e: Event) => (this._draft = { ...this._draft, frequency: (e.target as HTMLSelectElement).value })}
        >
          ${RANGE_SCHEDULE_FREQUENCIES.map(
            (f) => html`<option value=${f} ?selected=${f === this._draft.frequency}>${RANGE_SCHEDULE_FREQUENCY_LABELS[f]}</option>`
          )}
        </select>

        <div class="checkbox-row">
          <input
            type="checkbox"
            .checked=${this._draft.ammoAlertEnabled}
            @change=${(e: Event) => (this._draft = { ...this._draft, ammoAlertEnabled: (e.target as HTMLInputElement).checked })}
          />
          <label style="margin:0">Alert me if I don't have enough ammo for this (set a min rounds on each target above)</label>
        </div>

        <label>Notes</label>
        <textarea
          .value=${this._draft.notes}
          @input=${(e: Event) => (this._draft = { ...this._draft, notes: (e.target as HTMLTextAreaElement).value })}
        ></textarea>

        <div class="actions">
          <button class="secondary" @click=${() => (this._formOpen = false)}>Cancel</button>
          <button class="primary" ?disabled=${invalidTarget} @click=${this._save}>
            ${this._editing ? "Save Changes" : "Add Schedule"}
          </button>
        </div>
      </cache-dialog>

      <cache-dialog
        .open=${!!this._deleteTarget}
        heading="Delete Training Schedule"
        width="380px"
        @cache-dialog-closed=${() => (this._deleteTarget = null)}
      >
        <p>Delete "${this._deleteTarget?.label}"? This cannot be undone.</p>
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
    "cache-training-schedule-view": CacheTrainingScheduleView;
  }
}
