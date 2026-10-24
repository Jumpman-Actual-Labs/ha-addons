import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { gainsApi } from "../ha-api";
import type { GainsState, Run, RunType } from "../types";
import { RUN_TYPES } from "../types";
import { glassCardStyle, formStyles } from "../styles";

function labelize(value: string): string {
  return value[0].toUpperCase() + value.slice(1);
}

/**
 * Run (Strength MVP's running counterpart): plan a run, then log its
 * actual distance/duration once done. Unlike a Workout there's no
 * per-set structure or "active" state -- a run is logged as a whole
 * after the fact, so this view is a create form + a list with an
 * inline log form per planned run.
 */
@customElement("gains-runs-view")
export class GainsRunsView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) gainsState!: GainsState;

  @state() private _name = "";
  @state() private _runType: RunType = "easy";
  @state() private _targetDistance = "";
  @state() private _targetDurationMinutes = "";
  @state() private _busy = false;

  @state() private _loggingRunId: string | null = null;
  @state() private _logDistance = "";
  @state() private _logDurationMinutes = "";

  @state() private _sharingRun: Run | null = null;
  @state() private _shareBusy = false;

  static styles = [
    glassCardStyle,
    formStyles,
    css`
      ha-card.panel {
        padding: 20px;
        margin-bottom: 20px;
        max-width: 640px;
      }
      .run-controls {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      ul.run-list {
        list-style: none;
        margin: 12px 0 0;
        padding: 0;
      }
      ul.run-list li {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 10px 0;
        border-bottom: 1px solid var(--divider-color, #e0e0e0);
      }
      .run-row-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .run-meta {
        font-size: 0.85rem;
        color: var(--secondary-text-color, #727272);
      }
      .log-form {
        display: flex;
        gap: 8px;
        align-items: end;
        flex-wrap: wrap;
      }
      .log-form div {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .log-form label {
        font-size: 0.8rem;
        color: var(--secondary-text-color, #727272);
      }
      .log-form input {
        width: 100px;
      }
      ul.share-list {
        list-style: none;
        margin: 8px 0 0;
        padding: 0;
      }
      ul.share-list li {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 8px 0;
        border-bottom: 1px solid var(--divider-color, #e0e0e0);
      }
      ul.share-list li:last-child {
        border-bottom: none;
      }
    `,
  ];

  private async _createRun(): Promise<void> {
    if (this._busy || !this._name.trim()) return;
    this._busy = true;
    try {
      await gainsApi.createRun(
        this.hass,
        this._name.trim(),
        this._runType,
        this._targetDistance ? Number(this._targetDistance) : undefined,
        this._targetDurationMinutes ? Number(this._targetDurationMinutes) : undefined
      );
      this._name = "";
      this._targetDistance = "";
      this._targetDurationMinutes = "";
      this._runType = "easy";
    } finally {
      this._busy = false;
    }
  }

  private _openLogForm(run: Run): void {
    this._loggingRunId = run.id;
    this._logDistance = run.targetDistance ? String(run.targetDistance) : "";
    this._logDurationMinutes = run.targetDurationMinutes ? String(run.targetDurationMinutes) : "";
  }

  private async _submitLog(runId: string): Promise<void> {
    await gainsApi.logRun(
      this.hass,
      runId,
      this._logDistance ? Number(this._logDistance) : undefined,
      this._logDurationMinutes ? Number(this._logDurationMinutes) : undefined
    );
    this._loggingRunId = null;
  }

  private async _skipRun(runId: string): Promise<void> {
    await gainsApi.skipRun(this.hass, runId);
  }

  private async _shareRun(targetProfileId: string): Promise<void> {
    const run = this._sharingRun;
    if (!run) return;
    this._shareBusy = true;
    try {
      await gainsApi.shareRun(this.hass, run.id, targetProfileId);
      this._sharingRun = null;
    } finally {
      this._shareBusy = false;
    }
  }

  private _renderShareDialog() {
    const run = this._sharingRun;
    const shareTargets = this.gainsState.profile?.shareTargets ?? [];

    return html`
      <ha-dialog
        .open=${run !== null}
        hideActions
        @closed=${() => (this._sharingRun = null)}
      >
        ${run
          ? html`
              <h2>Share Run</h2>
              <p class="muted small">"${run.name}" &middot; they'll need to accept it first.</p>
              ${shareTargets.length === 0
                ? html`<p class="muted">No other Home Assistant members on this instance yet.</p>`
                : html`
                    <ul class="share-list">
                      ${shareTargets.map(
                        (p) => html`
                          <li>
                            <span>${p.displayName}</span>
                            <button
                              class="secondary"
                              ?disabled=${this._shareBusy}
                              @click=${() => this._shareRun(p.profileId)}
                            >
                              Share
                            </button>
                          </li>
                        `
                      )}
                    </ul>
                  `}
            `
          : ""}
      </ha-dialog>
    `;
  }

  private _renderRun(run: Run) {
    if (this._loggingRunId === run.id) {
      return html`
        <li>
          <div class="run-row-header">
            <span><strong>${run.name}</strong> <span class="badge">${run.runType}</span></span>
          </div>
          <div class="log-form">
            <div>
              <label>Distance</label>
              <input
                type="number"
                min="0"
                step="0.1"
                .value=${this._logDistance}
                @input=${(e: Event) => (this._logDistance = (e.target as HTMLInputElement).value)}
              />
            </div>
            <div>
              <label>Duration (min)</label>
              <input
                type="number"
                min="0"
                .value=${this._logDurationMinutes}
                @input=${(e: Event) =>
                  (this._logDurationMinutes = (e.target as HTMLInputElement).value)}
              />
            </div>
            <button class="primary" @click=${() => this._submitLog(run.id)}>Save</button>
            <button class="secondary" @click=${() => (this._loggingRunId = null)}>Cancel</button>
          </div>
        </li>
      `;
    }

    return html`
      <li>
        <div class="run-row-header">
          <span><strong>${run.name}</strong> <span class="badge">${run.status}</span></span>
          <span>
            ${run.status === "planned"
              ? html`
                  <button class="secondary" @click=${() => this._openLogForm(run)}>Log</button>
                  <button class="secondary" @click=${() => this._skipRun(run.id)}>Skip</button>
                `
              : ""}
            <button class="secondary" @click=${() => (this._sharingRun = run)}>Share Run</button>
          </span>
        </div>
        ${run.segments?.length ? html`<details><summary>Run prescription</summary>${run.segments.map(s=>html`<p><strong>${s.phase} · ${s.label}</strong><br>${s.repetitions} × ${s.distance_m?`${s.distance_m} m`:`${(s.duration_seconds??0)/60} min`}${s.recovery_seconds?` · ${s.recovery_seconds}s recovery`:""}${s.rpe?` · Effort ${s.rpe}/10`:""}${s.pace_min_seconds_per_km?html`<br>Pace: ${Math.floor(s.pace_min_seconds_per_km/60)}:${String(s.pace_min_seconds_per_km%60).padStart(2,"0")}–${Math.floor((s.pace_max_seconds_per_km??s.pace_min_seconds_per_km)/60)}:${String((s.pace_max_seconds_per_km??s.pace_min_seconds_per_km)%60).padStart(2,"0")}/km`:""}</p>`)}</details>`:""}
        <div class="run-meta">
          ${run.status === "completed"
            ? html`${run.actualDistance ?? "?"} distance &middot;
              ${run.actualDurationMinutes ?? "?"} min`
            : html`${labelize(run.runType)}
              ${run.targetDistance ? html`&middot; target ${run.targetDistance} distance` : ""}
              ${run.targetDurationMinutes
                ? html`&middot; target ${run.targetDurationMinutes} min`
                : ""}`}
        </div>
      </li>
    `;
  }

  render() {
    if (!this.gainsState.profile) {
      return html`<ha-card class="panel"><p class="muted">Loading&hellip;</p></ha-card>`;
    }

    const runs = this.gainsState.runs;

    return html`
      <ha-card class="panel">
        <h2>Plan a Run</h2>
        <label for="run-name">Name</label>
        <input
          id="run-name"
          type="text"
          placeholder="Easy Run"
          .value=${this._name}
          @input=${(e: Event) => (this._name = (e.target as HTMLInputElement).value)}
        />

        <div class="run-controls">
          <div>
            <label for="run-type">Type</label>
            <select
              id="run-type"
              @change=${(e: Event) =>
                (this._runType = (e.target as HTMLSelectElement).value as RunType)}
            >
              ${RUN_TYPES.map(
                (t) =>
                  html`<option value=${t} ?selected=${this._runType === t}>${labelize(t)}</option>`
              )}
            </select>
          </div>
          <div>
            <label for="target-distance">Target distance</label>
            <input
              id="target-distance"
              type="number"
              min="0"
              step="0.1"
              .value=${this._targetDistance}
              @input=${(e: Event) =>
                (this._targetDistance = (e.target as HTMLInputElement).value)}
            />
          </div>
          <div>
            <label for="target-duration">Target duration (min)</label>
            <input
              id="target-duration"
              type="number"
              min="0"
              .value=${this._targetDurationMinutes}
              @input=${(e: Event) =>
                (this._targetDurationMinutes = (e.target as HTMLInputElement).value)}
            />
          </div>
        </div>

        <div class="actions">
          <button class="primary" ?disabled=${this._busy || !this._name.trim()} @click=${this._createRun}>
            Plan Run
          </button>
        </div>
      </ha-card>

      <ha-card class="panel">
        <h2>Your Runs</h2>
        ${runs.length === 0 ? html`<p class="muted">No runs yet.</p>` : ""}
        <ul class="run-list">
          ${runs
            .slice()
            .reverse()
            .map((r) => this._renderRun(r))}
        </ul>
      </ha-card>
      ${this._renderShareDialog()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "gains-runs-view": GainsRunsView;
  }
}

