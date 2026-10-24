import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { progressApi, serviceErrorMessage } from "../ha-api";
import type { GainsState } from "../types";
import type { ProgressState, StrengthScoreGroup } from "../training-types";
import { glassCardStyle, formStyles } from "../styles";

/**
 * Progress tab: Strength Score (adults only -- see backend
 * strength_standards.py) and Activity (streak, this month's totals, most
 * improved exercises, muscle-group workout frequency). Fetches its own
 * gains.progress_state snapshot rather than riding gains-panel's
 * continuously-polled training snapshot, matching gains-coaching-permissions'
 * own lazy-load-on-profile-change pattern -- this data is heavier to compute
 * and not needed on every 2-second poll tick.
 */
@customElement("gains-progress-view")
export class GainsProgressView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) gainsState!: GainsState;
  @property() target?: string;

  @state() private progress: ProgressState | null = null;
  @state() private error = "";
  @state() private loading = false;
  @state() private openGroup: string | null = null;
  @state() private showMonth = false;
  private loadedKey = "";

  static styles = [
    glassCardStyle,
    formStyles,
    css`
      ha-card.panel {
        padding: 20px;
        margin-bottom: 20px;
        max-width: 640px;
      }
      .score-hero {
        display: flex;
        align-items: center;
        gap: 16px;
      }
      .score-circle {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 84px;
        height: 84px;
        border-radius: 50%;
        border: 3px solid var(--primary-color, #3b82f6);
        font-size: 1.6rem;
        font-weight: 800;
        flex-shrink: 0;
      }
      .score-hero h3 {
        margin: 0 0 4px;
      }
      .muted {
        color: var(--secondary-text-color, #727272);
        font-size: 0.9rem;
      }
      ul.group-list,
      ul.exercise-list,
      ul.improved-list,
      ul.muscle-list {
        list-style: none;
        margin: 12px 0 0;
        padding: 0;
      }
      ul.group-list li,
      ul.exercise-list li,
      ul.improved-list li {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 0;
        border-bottom: 1px solid var(--divider-color, #e0e0e0);
        cursor: pointer;
      }
      ul.exercise-list li,
      ul.improved-list li {
        cursor: default;
      }
      ul.group-list li:last-child,
      ul.exercise-list li:last-child,
      ul.improved-list li:last-child {
        border-bottom: none;
      }
      .group-name {
        font-weight: 600;
      }
      .group-score {
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 40px;
        padding: 4px 10px;
        border-radius: 999px;
        border: 2px solid var(--primary-color, #3b82f6);
        font-weight: 700;
      }
      .stat-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
        margin-top: 12px;
      }
      .stat-tile {
        background: var(--secondary-background-color, #f2f4f7);
        border-radius: 12px;
        padding: 14px;
      }
      .stat-tile .value {
        font-size: 1.3rem;
        font-weight: 800;
      }
      .streak-tile {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .streak-flame {
        font-size: 2rem;
      }
      .improved-percent {
        color: var(--success-color, #2e7d32);
        font-weight: 700;
      }
      .muscle-bar-row {
        margin: 10px 0;
      }
      .muscle-bar-row .row-top {
        display: flex;
        justify-content: space-between;
        font-size: 0.9rem;
        margin-bottom: 4px;
      }
      .muscle-bar-track {
        background: var(--divider-color, #e0e0e0);
        border-radius: 999px;
        height: 10px;
        overflow: hidden;
      }
      .muscle-bar-fill {
        background: var(--primary-color, #3b82f6);
        height: 100%;
        border-radius: 999px;
      }
      .back-button {
        margin-bottom: 12px;
      }
    `,
  ];

  private key(): string {
    return `${this.gainsState?.profile?.profileId ?? ""}:${this.target ?? ""}`;
  }

  protected willUpdate(changedProps: Map<string, unknown>): void {
    if (!changedProps.has("gainsState") && !changedProps.has("target")) return;
    const k = this.key();
    if (k && k !== this.loadedKey) {
      this.loadedKey = k;
      void this.load();
    }
  }

  private async load(): Promise<void> {
    this.loading = true;
    this.error = "";
    try {
      this.progress = await progressApi.state(this.hass, this.target);
    } catch (e) {
      this.error = serviceErrorMessage(e);
    } finally {
      this.loading = false;
    }
  }

  private renderStrengthScore() {
    const isKids = this.gainsState?.profile?.experienceLevel === "kids";
    if (isKids) {
      return html`<ha-card class="panel">
        <h2>Strength Score</h2>
        <p class="muted">
          Strength Score compares lifts against an adult population standard,
          so it isn't shown for a kids profile.
        </p>
      </ha-card>`;
    }
    const score = this.progress?.strength_score;
    if (!score) return "";
    const group = this.openGroup
      ? score.groups.find((g) => g.muscle_group === this.openGroup)
      : null;
    if (group) return this.renderGroupDetail(group);

    return html`<ha-card class="panel">
      <h2>Strength Score</h2>
      ${score.overall_score === null
        ? html`<p class="muted">
            Log a set on one of the major lifts (bench, row, press, squat,
            deadlift, curl...) to see your Strength Score. Setting your
            bodyweight and age in Settings makes it more accurate.
          </p>`
        : html`
            <div class="score-hero">
              <div class="score-circle">${score.overall_score}</div>
              <div>
                <h3>${score.overall_tier}</h3>
                <span class="muted">Overall Strength Score</span>
              </div>
            </div>
          `}
      <ul class="group-list">
        ${score.groups
          .filter((g) => g.score !== null)
          .map(
            (g) => html`
              <li @click=${() => (this.openGroup = g.muscle_group)}>
                <span class="group-name">${g.label}</span>
                <span class="group-score">${g.score}</span>
              </li>
            `,
          )}
      </ul>
    </ha-card>`;
  }

  private renderGroupDetail(group: StrengthScoreGroup) {
    return html`<ha-card class="panel">
      <button class="secondary back-button" @click=${() => (this.openGroup = null)}>
        &larr; Strength Score
      </button>
      <div class="score-hero">
        <div class="score-circle">${group.score}</div>
        <div>
          <h3>${group.label}</h3>
          <span class="muted">${group.tier}</span>
        </div>
      </div>
      <h3>Exercises</h3>
      <ul class="exercise-list">
        ${group.exercises.map(
          (e) => html`
            <li>
              <span>${e.exercise_name}<br /><span class="muted">${e.tier}</span></span>
              <span class="group-score">${e.score}</span>
            </li>
          `,
        )}
      </ul>
    </ha-card>`;
  }

  private renderActivity() {
    const progress = this.progress;
    if (!progress) return "";
    if (this.showMonth) return this.renderMonthDetail();

    const month = progress.this_month;
    return html`<ha-card class="panel">
      <h2>Activity</h2>
      <div class="stat-grid">
        <div class="stat-tile streak-tile">
          <span class="streak-flame">${progress.streak_days > 0 ? "🔥" : "💤"}</span>
          <div>
            <div class="value">${progress.streak_days}</div>
            <span class="muted">day streak</span>
          </div>
        </div>
        <div class="stat-tile" style="cursor:pointer" @click=${() => (this.showMonth = true)}>
          <div class="value">${month.workouts_completed}</div>
          <span class="muted">workouts this month &rsaquo;</span>
        </div>
      </div>
    </ha-card>`;
  }

  private renderMonthDetail() {
    const month = this.progress!.this_month;
    const monthName = new Date(month.year, month.month - 1, 1).toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    });
    const maxSets = Math.max(1, ...month.muscle_breakdown.map((g) => g.sets));
    return html`<ha-card class="panel">
      <button class="secondary back-button" @click=${() => (this.showMonth = false)}>
        &larr; Activity
      </button>
      <h2>${monthName}</h2>
      <div class="stat-grid">
        <div class="stat-tile">
          <div class="value">${month.workouts_completed}</div>
          <span class="muted">Workouts</span>
        </div>
        <div class="stat-tile">
          <div class="value">${this.formatDuration(month.duration_minutes)}</div>
          <span class="muted">Duration</span>
        </div>
        <div class="stat-tile">
          <div class="value">${month.volume.toLocaleString()}</div>
          <span class="muted">Volume (${this.gainsState?.profile?.units === "metric" ? "kg" : "lb"})</span>
        </div>
        <div class="stat-tile">
          <div class="value">${month.sets}</div>
          <span class="muted">Sets</span>
        </div>
      </div>

      <h3>Most Improved</h3>
      <p class="muted">Projected one-rep max vs. before this month</p>
      ${month.most_improved.length === 0
        ? html`<p class="muted">No repeat lifts with a prior best yet this month.</p>`
        : html`<ul class="improved-list">
            ${month.most_improved.map(
              (e) => html`
                <li>
                  <span
                    >${e.exercise_name}<br /><span class="muted"
                      >${e.from_one_rep_max} &rarr; ${e.to_one_rep_max} lb 1RM</span
                    ></span
                  >
                  <span class="improved-percent">+${e.percent_improved}%</span>
                </li>
              `,
            )}
          </ul>`}

      <h3>Muscle Breakdown</h3>
      ${month.muscle_breakdown.length === 0
        ? html`<p class="muted">No sets logged yet this month.</p>`
        : html`<ul class="muscle-list">
            ${month.muscle_breakdown.map(
              (g) => html`
                <li class="muscle-bar-row">
                  <div class="row-top">
                    <span>${g.label}</span>
                    <span class="muted">${g.days} days &middot; ${g.sets} sets</span>
                  </div>
                  <div class="muscle-bar-track">
                    <div
                      class="muscle-bar-fill"
                      style="width: ${Math.round((g.sets / maxSets) * 100)}%"
                    ></div>
                  </div>
                </li>
              `,
            )}
          </ul>`}
    </ha-card>`;
  }

  private formatDuration(minutes: number): string {
    if (minutes < 60) return `${minutes}min`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}min`;
  }

  render() {
    if (!this.gainsState?.profile) {
      return html`<ha-card class="panel"><p class="muted">Loading&hellip;</p></ha-card>`;
    }
    return html`
      <h1>Progress</h1>
      ${this.error ? html`<p role="alert" class="error">${this.error}</p>` : ""}
      ${this.loading && !this.progress
        ? html`<ha-card class="panel"><p class="muted">Loading&hellip;</p></ha-card>`
        : html`${this.renderStrengthScore()}${this.renderActivity()}`}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "gains-progress-view": GainsProgressView;
  }
}
