import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { cacheApi } from "../ha-api";
import type { CacheState, RangeScheduleTarget, TrainingPlan } from "../types";
import { FIREARM_TYPES, MONTH_LABELS, TRAINING_PLAN_MODE_LABELS } from "../types";
import { glassCardStyle, formStyles } from "../styles";
import { formatDate, todayIso } from "../utils/format";
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

interface StepDraft {
  label: string;
  targets: TargetDraft[];
  notes: string;
}

function emptyStep(): StepDraft {
  return {
    label: "",
    targets: [{ ...EMPTY_TARGET }],
    notes: "",
  };
}

function targetDraftFrom(t: RangeScheduleTarget): TargetDraft {
  return {
    targetType: t.targetType,
    firearmId: t.firearmId ?? "",
    firearmType: t.firearmType ?? "Handgun",
    caliber: t.caliber ?? "",
    speedClass: t.speedClass ?? "",
    bulletType: t.bulletType ?? "",
    roundsMin: t.roundsMin?.toString() ?? "",
  };
}

interface PlanDraft {
  label: string;
  mode: "calendar" | "sequential";
  startMonth: string;
  startYear: string;
  ammoAlertEnabled: boolean;
  notes: string;
  steps: StepDraft[];
}

function emptyDraft(): PlanDraft {
  const now = new Date();
  return {
    label: "",
    mode: "sequential",
    startMonth: String(now.getMonth() + 1),
    startYear: String(now.getFullYear()),
    ammoAlertEnabled: false,
    notes: "",
    steps: [emptyStep()],
  };
}

/** Training Plans - an ORDERED, ROTATING curriculum where only one step is
 * "current" at a time (e.g. a 6-month rifle/shotgun rotation: 300 BLK one
 * month, 5.56 the next), distinct from a Training Schedule's single
 * standalone recurring goal. Each plan picks its rotation mode at creation
 * time - "calendar" computes the current step from start_month/start_year
 * every time (fully automatic, but doesn't wait for you if you miss a
 * month); "sequential" tracks progress directly and only advances once the
 * current step is completed (self-paced, no calendar coupling). Matches the
 * backend's TrainingPlan/TrainingPlanStep shape (see
 * the repo's CLAUDE.md) - each step reuses the exact same
 * target-row shape as a Training Schedule's targets list. */
@customElement("cache-training-plan-view")
export class CacheTrainingPlanView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) cacheState!: CacheState;

  @state() private _formOpen = false;
  @state() private _editing: TrainingPlan | null = null;
  @state() private _draft: PlanDraft = emptyDraft();
  @state() private _error: string | null = null;
  @state() private _deleteTarget: TrainingPlan | null = null;
  @state() private _expandedId: string | null = null;

  static styles = [
    glassCardStyle,
    formStyles,
    css`
      ha-card.plan {
        padding: 16px;
      }
      .plan-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 8px;
      }
      .plan-title {
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
      .plan-actions {
        display: flex;
        gap: 4px;
        flex-shrink: 0;
      }
      .plan-actions button {
        background: none;
        border: none;
        cursor: pointer;
        color: var(--secondary-text-color, #727272);
      }
      .step-list {
        margin: 10px 0;
        padding: 0;
        list-style: none;
      }
      .step-list li {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        padding: 6px 8px;
        border-radius: 6px;
        font-size: 0.85rem;
      }
      .step-list li.current {
        background: color-mix(in srgb, var(--primary-color, #03a9f4) 12%, transparent);
        font-weight: 600;
      }
      .toggle-steps {
        background: none;
        border: none;
        color: var(--primary-color, #03a9f4);
        cursor: pointer;
        padding: 0;
        font-size: 0.85rem;
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
        margin-bottom: 12px;
      }
      .step-card {
        border: 1px solid var(--divider-color, #e0e0e0);
        border-radius: 10px;
        padding: 12px;
        margin-bottom: 12px;
      }
      .step-card-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 4px;
      }
      .step-card-header .step-number {
        font-weight: 600;
        font-size: 0.9rem;
      }
      .step-card-header .step-buttons {
        display: flex;
        gap: 2px;
      }
      .step-card-header button {
        background: none;
        border: none;
        cursor: pointer;
        color: var(--secondary-text-color, #727272);
        padding: 4px;
      }
      .step-card-header button[disabled] {
        opacity: 0.3;
        cursor: default;
      }
      .add-step {
        background: none;
        border: 1px dashed var(--divider-color, #e0e0e0);
        border-radius: 8px;
        color: var(--primary-color, #03a9f4);
        cursor: pointer;
        padding: 10px;
        width: 100%;
        font-size: 0.9rem;
        margin-bottom: 8px;
      }
    `,
  ];

  private _openAdd(): void {
    this._editing = null;
    this._draft = emptyDraft();
    this._error = null;
    this._formOpen = true;
  }

  private _openEdit(p: TrainingPlan): void {
    this._editing = p;
    const now = new Date();
    this._draft = {
      label: p.label ?? "",
      mode: p.mode,
      startMonth: p.startMonth ? String(p.startMonth) : String(now.getMonth() + 1),
      startYear: p.startYear ? String(p.startYear) : String(now.getFullYear()),
      ammoAlertEnabled: p.ammoAlertEnabled,
      notes: p.notes ?? "",
      steps:
        p.steps.length > 0
          ? p.steps.map((s) => ({
              label: s.label,
              targets: s.targets.length > 0 ? s.targets.map(targetDraftFrom) : [{ ...EMPTY_TARGET }],
              notes: s.notes ?? "",
            }))
          : [emptyStep()],
    };
    this._error = null;
    this._formOpen = true;
  }

  private _updateStep(index: number, patch: Partial<StepDraft>): void {
    const steps = this._draft.steps.map((s, i) => (i === index ? { ...s, ...patch } : s));
    this._draft = { ...this._draft, steps };
  }

  private _addStep(): void {
    this._draft = { ...this._draft, steps: [...this._draft.steps, emptyStep()] };
  }

  private _removeStep(index: number): void {
    if (this._draft.steps.length <= 1) return;
    this._draft = { ...this._draft, steps: this._draft.steps.filter((_, i) => i !== index) };
  }

  private _moveStep(index: number, direction: -1 | 1): void {
    const target = index + direction;
    if (target < 0 || target >= this._draft.steps.length) return;
    const steps = [...this._draft.steps];
    [steps[index], steps[target]] = [steps[target], steps[index]];
    this._draft = { ...this._draft, steps };
  }

  private _updateStepTarget(stepIndex: number, targetIndex: number, patch: Partial<TargetDraft>): void {
    const step = this._draft.steps[stepIndex];
    const targets = step.targets.map((t, i) => (i === targetIndex ? { ...t, ...patch } : t));
    this._updateStep(stepIndex, { targets });
  }

  private _addStepTarget(stepIndex: number): void {
    const step = this._draft.steps[stepIndex];
    this._updateStep(stepIndex, { targets: [...step.targets, { ...EMPTY_TARGET }] });
  }

  private _removeStepTarget(stepIndex: number, targetIndex: number): void {
    const step = this._draft.steps[stepIndex];
    if (step.targets.length <= 1) return;
    this._updateStep(stepIndex, { targets: step.targets.filter((_, i) => i !== targetIndex) });
  }

  private async _save(): Promise<void> {
    this._error = null;
    const d = this._draft;
    const payload: Record<string, unknown> = {
      mode: d.mode,
      steps: d.steps.map((s) => ({
        label: s.label,
        targets: s.targets.map((t) => ({
          target_type: t.targetType,
          firearm_id: t.targetType === "firearm" ? t.firearmId : "",
          firearm_type: t.targetType === "firearm_type" ? t.firearmType : "",
          caliber: t.targetType === "caliber" ? t.caliber : "",
          speed_class: t.speedClass || "",
          bullet_type: t.bulletType || "",
          rounds_min: t.roundsMin === "" ? "" : Number(t.roundsMin),
        })),
        notes: s.notes || "",
      })),
      label: d.label || "",
      start_month: d.mode === "calendar" ? Number(d.startMonth) : "",
      start_year: d.mode === "calendar" ? Number(d.startYear) : "",
      ammo_alert_enabled: d.ammoAlertEnabled,
      notes: d.notes || "",
    };
    try {
      if (this._editing) {
        await cacheApi.updateTrainingPlan(this.hass, this._editing.id, payload);
      } else {
        await cacheApi.addTrainingPlan(this.hass, payload);
      }
      this._formOpen = false;
    } catch (err) {
      this._error = err instanceof Error ? err.message : "Failed to save training plan";
    }
  }

  private async _confirmDelete(): Promise<void> {
    if (!this._deleteTarget) return;
    await cacheApi.deleteTrainingPlan(this.hass, this._deleteTarget.id);
    this._deleteTarget = null;
  }

  private async _markDone(p: TrainingPlan): Promise<void> {
    await cacheApi.advanceTrainingPlan(this.hass, p.id, todayIso());
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

  private _describeStepTargets(targets: RangeScheduleTarget[]): string {
    return targets.map((t) => this._describeSingleTarget(t)).join(" + ");
  }

  private _currentStepLabel(p: TrainingPlan): string {
    const step = p.steps.find((s) => s.isCurrent);
    if (!step) return "No steps";
    const index = p.steps.indexOf(step);
    const unit = p.mode === "calendar" ? "Month" : "Step";
    return `${unit} ${index + 1} of ${p.steps.length}: ${step.label}`;
  }

  render() {
    const plans = this.cacheState.trainingPlans;
    const firearms = this.cacheState.firearms;
    const invalidTarget = this._draft.steps.some((s) =>
      s.targets.some(
        (t) =>
          (t.targetType === "firearm" && !t.firearmId) || (t.targetType === "caliber" && !t.caliber)
      )
    );
    const invalidStep = this._draft.steps.some((s) => !s.label.trim());
    const invalidCalendar =
      this._draft.mode === "calendar" && (!this._draft.startMonth || !this._draft.startYear);

    return html`
      <div class="toolbar">
        <h1 style="margin:0;font-size:1.4rem;font-weight:600">Training Plans</h1>
        <button class="primary" @click=${this._openAdd}>+ Add Plan</button>
      </div>

      ${plans.length === 0
        ? html`<div class="empty">
            No training plans yet. Create one to schedule a rotating curriculum up to a year in
            advance - for example, a 6-month rotation between 300 BLK, 5.56, and 12 gauge home
            defense loads, one step trained per occurrence.
          </div>`
        : html`
            <div class="grid">
              ${plans.map((p) => {
                const expanded = this._expandedId === p.id;
                return html`
                  <ha-card class="plan">
                    <div class="plan-header">
                      <div>
                        <div class="plan-title">${p.label}</div>
                        <div class="small muted">
                          ${TRAINING_PLAN_MODE_LABELS[p.mode] ?? p.mode} · ${this._currentStepLabel(p)}
                        </div>
                      </div>
                      <div class="plan-actions">
                        <button @click=${() => this._openEdit(p)} aria-label="Edit">
                          <ha-icon icon="mdi:pencil"></ha-icon>
                        </button>
                        <button @click=${() => (this._deleteTarget = p)} aria-label="Delete">
                          <ha-icon icon="mdi:delete"></ha-icon>
                        </button>
                      </div>
                    </div>
                    <div class="chips" style="display:flex;gap:6px;flex-wrap:wrap;margin:8px 0">
                      ${!p.active ? html`<span class="badge">Paused</span>` : ""}
                    </div>
                    <div class="due-status ${p.isDue ? "due" : "ok"}">
                      ${p.isDue ? "⚠ Training due" : "✓ Up to date"}
                    </div>
                    ${p.ammoAlertEnabled && p.ammoOk !== null
                      ? html`
                          <div class="small ${p.ammoOk === false ? "due-status due" : "muted"}">
                            ${p.ammoOk === false
                              ? "Not enough ammo on hand for the current step"
                              : "Ammo check: on track for the current step"}
                          </div>
                        `
                      : ""}
                    <div>
                      <button class="toggle-steps" @click=${() => (this._expandedId = expanded ? null : p.id)}>
                        ${expanded ? "Hide steps" : "Show steps"}
                      </button>
                      ${expanded
                        ? html`
                            <ul class="step-list">
                              ${p.steps.map(
                                (s, i) => html`
                                  <li class=${s.isCurrent ? "current" : ""}>
                                    <span>${i + 1}. ${s.label} — ${this._describeStepTargets(s.targets)}</span>
                                    <span class="muted"
                                      >${s.lastCompletedDate ? formatDate(s.lastCompletedDate) : "Never"}</span
                                    >
                                  </li>
                                `
                              )}
                            </ul>
                          `
                        : ""}
                    </div>
                    ${p.notes ? html`<p class="small muted">${p.notes}</p>` : ""}
                    <div class="actions" style="margin-top:8px">
                      <button class="secondary" @click=${() => this._markDone(p)}>Mark Current Step Done</button>
                    </div>
                  </ha-card>
                `;
              })}
            </div>
          `}

      <cache-dialog
        .open=${this._formOpen}
        .heading=${this._editing ? "Edit Training Plan" : "Add Training Plan"}
        width="560px"
        @cache-dialog-closed=${() => (this._formOpen = false)}
      >
        ${this._error ? html`<div class="error-banner">${this._error}</div>` : ""}
        <label>Label (optional)</label>
        <input
          placeholder="e.g. Rifle/Shotgun Rotation"
          .value=${this._draft.label}
          @input=${(e: Event) => (this._draft = { ...this._draft, label: (e.target as HTMLInputElement).value })}
        />

        <label>Rotation type</label>
        <select
          .value=${this._draft.mode}
          @change=${(e: Event) =>
            (this._draft = { ...this._draft, mode: (e.target as HTMLSelectElement).value as "calendar" | "sequential" })}
        >
          <option value="sequential" ?selected=${this._draft.mode === "sequential"}>
            ${TRAINING_PLAN_MODE_LABELS.sequential} - advances only once you log the current step
          </option>
          <option value="calendar" ?selected=${this._draft.mode === "calendar"}>
            ${TRAINING_PLAN_MODE_LABELS.calendar} - automatic, doesn't wait for a missed month
          </option>
        </select>

        ${this._draft.mode === "calendar"
          ? html`
              <div class="field-row">
                <div>
                  <label>Start month</label>
                  <select
                    .value=${this._draft.startMonth}
                    @change=${(e: Event) =>
                      (this._draft = { ...this._draft, startMonth: (e.target as HTMLSelectElement).value })}
                  >
                    ${MONTH_LABELS.map(
                      (m, i) => html`<option value=${i + 1} ?selected=${String(i + 1) === this._draft.startMonth}>${m}</option>`
                    )}
                  </select>
                </div>
                <div>
                  <label>Start year</label>
                  <input
                    type="number"
                    .value=${this._draft.startYear}
                    @input=${(e: Event) =>
                      (this._draft = { ...this._draft, startYear: (e.target as HTMLInputElement).value })}
                  />
                </div>
              </div>
            `
          : ""}

        <label>${this._draft.mode === "calendar" ? "Months" : "Steps"} (trained in order, then repeats)</label>
        ${this._draft.steps.map(
          (s, si) => html`
            <div class="step-card">
              <div class="step-card-header">
                <span class="step-number">${this._draft.mode === "calendar" ? "Month" : "Step"} ${si + 1}</span>
                <div class="step-buttons">
                  <button ?disabled=${si === 0} @click=${() => this._moveStep(si, -1)} aria-label="Move up">
                    <ha-icon icon="mdi:arrow-up"></ha-icon>
                  </button>
                  <button
                    ?disabled=${si === this._draft.steps.length - 1}
                    @click=${() => this._moveStep(si, 1)}
                    aria-label="Move down"
                  >
                    <ha-icon icon="mdi:arrow-down"></ha-icon>
                  </button>
                  <button
                    ?disabled=${this._draft.steps.length <= 1}
                    @click=${() => this._removeStep(si)}
                    aria-label="Remove step"
                  >
                    <ha-icon icon="mdi:close"></ha-icon>
                  </button>
                </div>
              </div>
              <input
                placeholder="e.g. .300 BLK Supers"
                .value=${s.label}
                @input=${(e: Event) => this._updateStep(si, { label: (e.target as HTMLInputElement).value })}
              />
              ${s.targets.map(
                (t, ti) => html`
                  <div class="target-row">
                    <div>
                      <select
                        .value=${t.targetType}
                        @change=${(e: Event) =>
                          this._updateStepTarget(si, ti, {
                            targetType: (e.target as HTMLSelectElement).value as TargetDraft["targetType"],
                          })}
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
                              @change=${(e: Event) =>
                                this._updateStepTarget(si, ti, { firearmType: (e.target as HTMLSelectElement).value })}
                            >
                              ${FIREARM_TYPES.map((ft) => html`<option value=${ft} ?selected=${ft === t.firearmType}>${ft}</option>`)}
                            </select>
                          `
                        : t.targetType === "caliber"
                          ? html`
                              <input
                                list="training-plan-caliber-list"
                                placeholder="e.g. 300 BLK"
                                .value=${t.caliber}
                                @input=${(e: Event) => this._updateStepTarget(si, ti, { caliber: (e.target as HTMLInputElement).value })}
                              />
                            `
                          : html`
                              <select
                                .value=${t.firearmId}
                                @change=${(e: Event) =>
                                  this._updateStepTarget(si, ti, { firearmId: (e.target as HTMLSelectElement).value })}
                              >
                                <option value="">Select firearm</option>
                                ${firearms.map((f) => html`<option value=${f.id} ?selected=${f.id === t.firearmId}>${f.customName}</option>`)}
                              </select>
                            `}
                    </div>
                    <div>
                      <select
                        .value=${t.speedClass}
                        @change=${(e: Event) =>
                          this._updateStepTarget(si, ti, {
                            speedClass: (e.target as HTMLSelectElement).value as TargetDraft["speedClass"],
                          })}
                      >
                        <option value="" ?selected=${t.speedClass === ""}>Any ammo</option>
                        <option value="Subsonic" ?selected=${t.speedClass === "Subsonic"}>Subsonic only</option>
                        <option value="Supersonic" ?selected=${t.speedClass === "Supersonic"}>Supersonic only</option>
                      </select>
                    </div>
                    <div>
                      <input
                        list="training-plan-bullet-type-list"
                        placeholder="Bullet type (any)"
                        .value=${t.bulletType}
                        @input=${(e: Event) => this._updateStepTarget(si, ti, { bulletType: (e.target as HTMLInputElement).value })}
                      />
                    </div>
                    <div class="rounds-min">
                      <input
                        type="number"
                        placeholder="Min rounds"
                        .value=${t.roundsMin}
                        @input=${(e: Event) => this._updateStepTarget(si, ti, { roundsMin: (e.target as HTMLInputElement).value })}
                      />
                    </div>
                    ${s.targets.length > 1
                      ? html`<button class="remove-target" aria-label="Remove target" @click=${() => this._removeStepTarget(si, ti)}>
                          <ha-icon icon="mdi:close"></ha-icon>
                        </button>`
                      : ""}
                  </div>
                `
              )}
              <button class="add-target" @click=${() => this._addStepTarget(si)}>+ Add another target</button>

              <label>Notes (optional)</label>
              <input
                placeholder="e.g. 1 mag Hornady Sub-X, 4 mags Magtech supers"
                .value=${s.notes}
                @input=${(e: Event) => this._updateStep(si, { notes: (e.target as HTMLInputElement).value })}
              />
            </div>
          `
        )}
        <datalist id="training-plan-caliber-list">
          ${knownCalibers(this.cacheState).map((c) => html`<option value=${c}></option>`)}
        </datalist>
        <datalist id="training-plan-bullet-type-list">
          ${knownBulletTypes(this.cacheState).map((b) => html`<option value=${b}></option>`)}
        </datalist>
        <button class="add-step" @click=${this._addStep}>+ Add step</button>

        <div class="checkbox-row">
          <input
            type="checkbox"
            .checked=${this._draft.ammoAlertEnabled}
            @change=${(e: Event) => (this._draft = { ...this._draft, ammoAlertEnabled: (e.target as HTMLInputElement).checked })}
          />
          <label style="margin:0">Alert me if I don't have enough ammo for the current step (set a min rounds on each target above)</label>
        </div>

        <label>Notes</label>
        <textarea
          .value=${this._draft.notes}
          @input=${(e: Event) => (this._draft = { ...this._draft, notes: (e.target as HTMLTextAreaElement).value })}
        ></textarea>

        <div class="actions">
          <button class="secondary" @click=${() => (this._formOpen = false)}>Cancel</button>
          <button class="primary" ?disabled=${invalidTarget || invalidStep || invalidCalendar} @click=${this._save}>
            ${this._editing ? "Save Changes" : "Add Plan"}
          </button>
        </div>
      </cache-dialog>

      <cache-dialog
        .open=${!!this._deleteTarget}
        heading="Delete Training Plan"
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
    "cache-training-plan-view": CacheTrainingPlanView;
  }
}
