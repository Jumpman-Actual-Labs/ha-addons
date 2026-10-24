import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { serviceErrorMessage } from "../ha-api";
import type { GainsState } from "../types";
import { EXERCISE_LIBRARY } from "../types";
import { recoveryPercent } from "../recovery";
import { MUSCLE_DICTIONARY, type MuscleId } from "../muscles";
import type {
  ProgramSession,
  TrainingProgram,
  TrainingSnapshot,
} from "../training-types";
import { glassCardStyle, formStyles } from "../styles";
import { muscleCoverage, muscleLabels } from "../muscles";
import "../components/muscle-map";
export type NavigableTab = "workouts" | "runs" | "coach" | "equipment";
@customElement("gains-today-view")
export class GainsTodayView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) gainsState!: GainsState;
  @property({ attribute: false }) snapshot?: TrainingSnapshot;
  @state() private busy = false;
  @state() private slide = 0;
  @state() private error = "";
  static styles = [
    glassCardStyle,
    formStyles,
    css`
      :host { display: block; min-width: 0; }
      .layout > div { min-width: 0; }
      h1 {
        font-size: 32px;
        line-height: 1.12;
        letter-spacing: -1px;
        margin: 10px 0;
      }
      h2 {
        font-size: 24px;
        margin: 12px 0 8px;
      }
      .eyebrow {
        font-size: 12px;
        letter-spacing: 1.4px;
        text-transform: uppercase;
        color: var(--secondary-text-color);
      }
      .layout {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 24px;
        max-width: 1000px;
      }
      .panel {
        box-sizing: border-box;
        min-width: 0;
        padding: 22px;
        display: block;
      }
      .hero {
        margin-top: 24px;
      }
      .focus {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 75px;
        gap: 10px;
        align-items: center;
        margin: 12px 0 20px;
      }
      .focus p {
        line-height: 1.6;
      }
      .primary {
        width: 100%;
        min-height: 50px;
      }
      .section {
        margin-top: 24px;
      }
      .row {
        display: flex;
        gap: 12px;
        justify-content: space-between;
        align-items: center;
      }
      .week {
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        gap: 6px;
        margin: 18px 0;
      }
      .day {
        text-align: center;
        color: var(--secondary-text-color);
        font-size: 12px;
      }
      .day span {
        display: grid;
        place-items: center;
        height: 40px;
        border-radius: 12px;
        margin-top: 8px;
        background: var(--card-background-color);
      }
      .day.today span {
        color: var(--text-primary-color);
        background: var(--primary-color);
      }
      .program-strip {
        margin: 16px 0 0;
        display: flex;
        gap: 12px;
        overflow-x: auto;
        scroll-snap-type: x mandatory;
        scroll-padding-left: 0;
        padding: 0;
        scrollbar-width: none;
      }
      .program-strip::-webkit-scrollbar {
        display: none;
      }
      .program-card {
        position: relative;
        box-sizing: border-box;
        flex: 0 0 100%;
        min-width: 0;
        scroll-snap-stop: always;
        overflow-wrap: anywhere;
        min-height: 250px;
        scroll-snap-align: start;
        border: 1px solid var(--divider-color);
        border-radius: 20px;
        background: var(--secondary-background-color);
        padding: 18px;
        display: flex;
        flex-direction: column;
      }
      .program-card .focus {
        grid-template-columns: minmax(0, 1fr) 86px;
        margin: 6px 0 12px;
      }
      .program-card h3 {
        font-size: 22px;
        margin: 7px 0;
      }
      .program-card gains-muscle-map {
        width: 86px;
      }
      .program-card ha-icon {
        --mdc-icon-size: 62px;
        color: var(--primary-color);
        justify-self: end;
        margin: 12px;
      }
      .program-card button {
        margin-top: auto;
      }
      .program-card .preview {
        position: absolute; inset: 0; z-index: 1;
        width: 100%; height: 100%; margin: 0; padding: 0;
        border: 0; border-radius: inherit; background: transparent;
        cursor: pointer;
      }
      .program-card .preview:focus-visible { outline: 2px solid var(--primary-color); outline-offset: -3px; }
      .program-card .primary, .program-card .regenerate { position: relative; z-index: 2; }
      .program-card .regenerate { margin-top: 10px; min-height: 44px; width: 100%; }
      .swipe-hint {
        font-size: 12px;
        margin: 0;
      }
      .carousel-controls { display: flex; align-items: center; justify-content: center; gap: 16px; margin-top: 12px; }
      .carousel-controls button { min-width: 44px; min-height: 44px; }
      .carousel-controls span { font-size: 12px; color: var(--secondary-text-color); }
      .error {
        color: var(--error-color, #db4437);
      }
      @media (min-width: 800px) {
        .layout {
          grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
        }
      }
      .page-heading { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 26px; }
      .page-heading h1 { font-size: clamp(30px, 4vw, 42px); margin: 8px 0; letter-spacing: -1.4px; }
      .page-heading p { margin: 0; }
      .eyebrow { font-size: 11px; font-weight: 650; letter-spacing: 1.4px; }
      .gym-chip { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; }
      .gym-chip ha-icon { --mdc-icon-size: 18px; flex-shrink: 0; }
      .layout { gap: 28px; }
      .hero { margin-top: 0; }
      .hero h2 { font-size: 22px; }
      .hero > .badge { color: var(--primary-color); background: var(--gains-tint); }
      .program-card { min-height: 350px; background: var(--primary-background-color); padding: 24px; border-radius: 18px; }
      .program-card .focus { grid-template-columns: minmax(0, 1fr) 100px; }
      .program-card .primary { margin-top: 0; }
      .program-card h3 { font-size: 30px; line-height: 1.1; letter-spacing: -.9px; }
      .program-card .focus p { margin: 8px 0; font-size: 13px; }
      .program-card gains-muscle-map { width: 100px; --gains-compact-muscle-width: 86px; --gains-compact-muscle-height: 120px; }
      .session-preview { margin: 20px 0 0; padding: 0; list-style: none; display: grid; gap: 9px; font-size: 13px; }
      .session-preview li { display: flex; gap: 9px; align-items: center; }
      .session-preview ha-icon { --mdc-icon-size: 16px; color: var(--secondary-text-color); }
      .section { margin: 0 0 22px; padding: 22px; border: 1px solid var(--divider-color); border-radius: 22px; background: var(--card-background-color); }
      .section h2 { font-size: 18px; margin: 0; font-weight: 700; }
      .section > .panel { padding: 0; border: 0; --ha-card-border-width: 0; }
      .section h3 { font-size: 18px; }
      .week-total { font-size: 24px; font-weight: 750; color: var(--primary-color); }
      .week-total small { font-size: 11px; font-weight: 500; color: var(--secondary-text-color); }
      .day span { background: var(--secondary-background-color); border-radius: 50%; width: 34px; height: 34px; margin: 8px auto; position: relative; }
      .day.today span { color: var(--text-primary-color); background: var(--primary-color); font-weight: 750; }
      .day.trained span::after { content: ""; position: absolute; bottom: -7px; width: 4px; height: 4px; border-radius: 50%; background: var(--gains-success); }
      .recovery-list { display: grid; gap: 14px; margin: 20px 0; }
      .recovery-item .row { font-size: 12px; margin-bottom: 5px; }
      .recovery-item strong { color: var(--gains-success); font-size: 12px; }
      progress { display: block; width: 100%; height: 5px; border: 0; border-radius: 99px; overflow: hidden; background: var(--secondary-background-color); accent-color: var(--gains-success); }
      progress::-webkit-progress-bar { background: var(--secondary-background-color); }
      progress::-webkit-progress-value { background: var(--gains-success); border-radius: 99px; }
      progress::-moz-progress-bar { background: var(--gains-success); }
      .resume-banner { display: flex; align-items: center; justify-content: space-between; gap: 12px; background: var(--gains-tint); border: 1px solid var(--primary-color); padding: 16px 20px; margin-bottom: 22px; border-radius: 18px; }
      .resume-banner strong { display: block; margin-top: 4px; }
      .carousel-controls .secondary { padding: 5px 14px; font-size: 20px; }
      @media (min-width: 800px) { .layout { grid-template-columns: minmax(0, 1.2fr) minmax(0, .8fr); } }
      @media (max-width: 520px) {
        .page-heading { display: block; margin-bottom: 22px; }
        .gym-chip { margin-top: 16px; font-size: 12px; min-height: 40px; }
        .panel, .section { padding: 18px; }
        .program-card { padding: 18px; }
        .program-card h3 { font-size: 26px; }
        .program-card .focus { grid-template-columns: minmax(0, 1fr) 80px; }
        .program-card gains-muscle-map { width: 80px; --gains-compact-muscle-width: 72px; }
        .resume-banner { padding: 14px; }
        .resume-banner .primary { width: auto; }
        .week { gap: 3px; }
      }
    `,
  ];
  private _goTo(tab: NavigableTab, workoutId?: string) {
    this.dispatchEvent(
      new CustomEvent("gains-switch-tab", {
        detail: { tab, workoutId },
        bubbles: true,
        composed: true,
      }),
    );
  }
  private moveSlide(direction: number) {
    const strip = this.shadowRoot?.querySelector<HTMLElement>(".program-strip");
    if (!strip) return;
    const cards = strip.querySelectorAll<HTMLElement>(".program-card");
    const index = Math.max(0, Math.min(cards.length - 1, this.slide + direction));
    const step = strip.clientWidth + 12;
    strip.scrollTo({ left: index * step, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
  private trackSlide(event: Event) {
    const strip = event.currentTarget as HTMLElement;
    this.slide = Math.round(strip.scrollLeft / (strip.clientWidth + 12));
  }
  private sessionExercises(session: ProgramSession): string[] {
    const p = session.prescription as { exercises?: { exercise_id: string }[] };
    return p.exercises?.map((e) => e.exercise_id) ?? [];
  }
  private dateLabel(value?: string): string {
    return value
      ? new Date(`${value}T12:00:00`).toLocaleDateString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
        })
      : "Upcoming";
  }
  private async regenerateSession(program: TrainingProgram, session: ProgramSession) {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    try {
      await new Promise<void>((resolve, reject) => this.dispatchEvent(
        new CustomEvent("regenerate-program-session", {
          bubbles: true, composed: true,
          detail: { programId: program.id, sessionId: session.id, resolve, reject },
        }),
      ));
    } catch (error) {
      this.error = serviceErrorMessage(error);
    } finally {
      this.busy = false;
    }
  }
  private async startSession(
    program: TrainingProgram,
    session: ProgramSession,
    startNow = true,
  ) {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    try {
      await new Promise<void>((resolve, reject) => this.dispatchEvent(
        new CustomEvent("open-program-session", {
          bubbles: true, composed: true,
          detail: { programId: program.id, sessionId: session.id, startNow, resolve, reject },
        }),
      ));
    } catch (error) {
      this.error = serviceErrorMessage(error);
    } finally {
      this.busy = false;
    }
  }
  render() {
    const profile = this.gainsState.profile;
    if (!profile) return html`<p class="muted">Loading your training…</p>`;
    const next =
      this.gainsState.workouts.find((w) => w.status === "active") ??
      this.gainsState.workouts.find((w) => w.status === "planned");
    const nextRun = this.gainsState.runs.find((r) => r.status === "planned");
    const program = this.snapshot?.programs.find((p) => p.status === "active");
    const upcoming = program?.upcoming_sessions ?? [];
    const now = new Date();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    const finished = [
      ...this.gainsState.workouts,
      ...this.gainsState.runs,
    ].filter(
      (w) =>
        w.status === "completed" &&
        w.completedAt &&
        new Date(w.completedAt) >= start &&
        new Date(w.completedAt) <= now,
    );
    const recovery = Object.keys(this.gainsState.muscleRecovery?.muscles ?? {})
      .filter((id): id is MuscleId => id in MUSCLE_DICTIONARY)
      .map(id => ({ id, percent: recoveryPercent(this.gainsState.muscleRecovery, id, now.getTime()) }))
      .filter((entry): entry is { id: MuscleId; percent: number } => entry.percent !== undefined)
      .sort((a, b) => a.percent - b.percent);
    const gym = this.gainsState.gymProfiles.find(g => g.id === profile.gymProfileId);
    return html`${this.error ? html`<p class="error" role="alert">${this.error}</p>` : ""}
      <div class="page-heading">
        <div><div class="eyebrow">${now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</div>
          <h1>Let's get stronger.</h1><p class="muted">Your next session, ${profile.displayName}.</p></div>
        ${this.snapshot?.mode === "coach" ? html`<span class="muted small">${gym?.name ?? "Gym not selected"}</span>` : html`<button class="gym-chip secondary" @click=${() => this._goTo("equipment")}><ha-icon icon="mdi:map-marker-outline"></ha-icon>${gym?.name ?? "Choose your gym"}</button>`}
      </div>
      ${next?.status === "active" ? html`<div class="resume-banner"><div><span class="eyebrow">Workout in progress</span><strong>${next.name}</strong></div><button class="primary" @click=${() => this._goTo("workouts", next.id)}>Resume</button></div>` : ""}
      <div class="layout">
        <div>
          ${
        upcoming.length && program
          ? html`<ha-card class="panel hero"
              ><span class="badge">${program.name}</span>
              <h2>Up next</h2>
              <p class="muted swipe-hint">
                Your plan. Ready when you are.
              </p>
              <div class="program-strip" @scroll=${this.trackSlide}>
                ${upcoming.map((session, index) => {
                  const ids = this.sessionExercises(session);
                  return html`<article class="program-card">
                    <button class="preview" aria-label=${`View ${session.name} details`} ?disabled=${this.busy} @click=${() => this.startSession(program, session, false)}></button>
                    <span class="eyebrow"
                      >${index === 0 ? "Next workout" : this.dateLabel(session.scheduled_date)}</span
                    >
                    <div class="focus">
                      <div>
                        <h3>${session.name}</h3>
                        <p class="muted">
                          ${this.dateLabel(session.scheduled_date)} · Week
                          ${session.week_number ?? program.current_week ?? 1}
                        </p>
                        <p>
                          ${session.type === "run" ? "Run" : `${ids.length} exercises`}
                        </p>
                      </div>
                      ${session.type === "run" ? html`<ha-icon icon="mdi:run"></ha-icon>` : html`<gains-muscle-map compact .exerciseIds=${ids}></gains-muscle-map>`}
                    </div>

                    <button
                      class="primary"
                      ?disabled=${this.busy}
                      @click=${() => this.startSession(program, session)}
                    >
                      ${session.actual_status === "active" ? "Resume" : "Start now"}
                    </button>
                    ${session.type === "workout" && (!session.actual_status || session.actual_status === "planned") ? html`<button class="secondary regenerate" ?disabled=${this.busy} @click=${() => this.regenerateSession(program, session)}>${this.busy ? "Updating…" : "↻ Regenerate workout"}</button>` : ""}
                    ${ids.length ? html`<ul class="session-preview" aria-label="Exercise preview">${ids.slice(0, 3).map(id => html`<li><ha-icon icon="mdi:dumbbell"></ha-icon><span>${EXERCISE_LIBRARY.find(exercise => exercise.id === id)?.name ?? id}</span></li>`)}${ids.length > 3 ? html`<li class="muted">+ ${ids.length - 3} more exercises</li>` : ""}</ul>` : ""}
                  </article>`;
                })}
              </div>
              <div class="carousel-controls" aria-label="Workout navigation">
                <button class="secondary" aria-label="Previous workout" ?disabled=${this.slide <= 0} @click=${() => this.moveSlide(-1)}>‹</button>
                <span aria-live="polite">${Math.min(this.slide + 1, upcoming.length)} of ${upcoming.length}</span>
                <button class="secondary" aria-label="Next workout" ?disabled=${this.slide >= upcoming.length - 1} @click=${() => this.moveSlide(1)}>›</button>
              </div></ha-card
            >`
          : next
            ? html`<ha-card class="panel hero"
                ><span class="badge"
                  >${next.status === "active" ? "In progress" : "Next workout"}</span
                >
                <div class="focus">
                  <div>
                    <h2>${next.name}</h2>
                    <p class="muted">
                      ${next.exercises.length} exercises ·
                      ${next.exercises.reduce((n, e) => n + e.sets.length, 0)}
                      sets
                    </p>
                    <p>
                      ${muscleLabels(muscleCoverage(next.exercises.map((e) => e.exerciseId)).primary)}
                    </p>
                  </div>
                  <gains-muscle-map
                    compact
                    .exerciseIds=${next.exercises.map((e) => e.exerciseId)}
                  ></gains-muscle-map>
                </div>
                <button
                  class="primary"
                  @click=${() => this._goTo("workouts", next.id)}
                >
                  ${next.status === "active" ? "Resume workout" : "View workout"}
                </button></ha-card
              >`
            : html`<ha-card class="panel hero"
                ><h2>Your first session starts here.</h2>
                <p class="muted">
                  Build a workout with your exercises, or ask Geoffrey for a
                  plan.
                </p>
                <button class="primary" @click=${() => this._goTo("workouts")}>
                  Build a workout
                </button>
                <div class="actions">
                  <button class="secondary" @click=${() => this._goTo("coach")}>
                    Ask Geoffrey
                  </button>
                </div></ha-card
              >`
      }
          ${!profile.gymProfileId && this.snapshot?.mode !== "coach" ? html`<p class="muted">Gym not selected. <button class="secondary" @click=${() => this._goTo("equipment")}>Set up your gym</button></p>` : ""}
        </div>
        <div>
          <section class="section">
            <div class="row"><h2>Your week</h2><span class="week-total">${finished.length}<small> completed</small></span></div>
            <div class="week">
              ${Array.from({ length: 7 }, (_, i) => {
      const date = new Date(start);
      date.setDate(date.getDate() + i);
      return html`<div
        class="day ${date.toDateString() === now.toDateString() ? "today" : ""} ${finished.some(w => new Date(w.completedAt!).toDateString() === date.toDateString()) ? "trained" : ""}"
        aria-label=${`${date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}${finished.some(w => new Date(w.completedAt!).toDateString() === date.toDateString()) ? ", training completed" : ""}`}
      >
        ${date.toLocaleDateString(undefined, { weekday: "narrow" })}<span
          >${date.getDate()}</span
        >
      </div>`;
    })}
            </div>
            <p class="muted">
              <strong>${finished.length} sessions</strong> completed this week.
            </p>
          </section>
          <section class="section recovery-panel" aria-label="Muscle recovery">
            <div class="row"><h2>Muscle recovery</h2><ha-icon icon="mdi:human-handsup"></ha-icon></div>
            <p class="muted small">Estimated from your logged sets.</p>
            ${recovery.length ? html`<div class="recovery-list">${recovery.slice(0, 5).map(({id, percent}) => html`<div class="recovery-item"><div class="row"><span>${MUSCLE_DICTIONARY[id].label}</span><strong>${percent}%</strong></div><progress max="100" value=${percent} aria-label=${`${MUSCLE_DICTIONARY[id].label} recovery`}></progress></div>`)}</div><p class="muted small">Showing the least recovered muscles.</p>` : html`<p class="muted">Recovery will appear when your training data is available.</p>`}
          </section>
          <section class="section">
            <div class="row">
              <h2>In your run plan</h2>
              <button class="secondary" @click=${() => this._goTo("runs")}>
                Runs
              </button>
            </div>
            <ha-card class="panel"
              ><h3>${nextRun?.name ?? "Room for a run"}</h3>
              <p class="muted">
                ${nextRun ? `${nextRun.runType}${nextRun.targetDistance !== null ? ` · ${nextRun.targetDistance} ${profile.units === "metric" ? "km" : "mi"} target` : ""}` : "Plan or log a run when you're ready."}
              </p></ha-card
            >
          </section>
          <div class="row section">
            <div>
              <h3>Need a different plan?</h3>
              <p class="muted">Talk it through with your coach.</p>
            </div>
            <button class="secondary" @click=${() => this._goTo("coach")}>
              Ask Geoffrey
            </button>
          </div>
        </div>
      </div>`;
  }
}
declare global {
  interface HTMLElementTagNameMap {
    "gains-today-view": GainsTodayView;
  }
}

