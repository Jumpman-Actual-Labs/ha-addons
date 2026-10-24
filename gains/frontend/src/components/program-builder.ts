import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { builderQuestions } from "../builder-questions";
import type { BuilderAnswers } from "../training-types";

import { WEEKDAYS, programDefaults, programIssues, preferenceSlots, moveCustomSession, type SessionPreferences } from "../program-builder";
import { formStyles } from "../styles";
import "./split-picker";
import "./builder-question";

const STAGES = ["Plan", "Sessions", "Preferences"];
@customElement("gains-program-builder")
export class GainsProgramBuilder extends LitElement {
  @property({ attribute: false }) answers: BuilderAnswers = {};
  @property({ type: Number }) stage = 0;
  @property({ type: Boolean }) busy = false;
  @property() athlete = "";
  @property() gym = "No gym selected";
  @property() sequencingPolicy: "calendar" | "completion" = "completion";
  static styles = [formStyles, css`
    :host { display: block; }
    h2 { font-size: 24px; margin: 0 0 8px; }
    h3 { font-size: 16px; margin: 0; }
    .intro { margin: 6px 0 22px; }
    nav { display: grid; grid-template-columns: repeat(4, 1fr); gap: 4px; margin: 24px 0; border-bottom: 1px solid var(--divider-color); }
    nav button { border: 0; background: none; color: var(--secondary-text-color); border-bottom: 3px solid transparent; padding: 10px 2px; font: inherit; font-size: 12px; cursor: pointer; }
    nav button[aria-current="step"] { color: var(--primary-color); border-color: var(--primary-color); font-weight: 750; }
    .number { display: block; font-size: 17px; margin-bottom: 3px; }
    .block { padding: 20px; border: 1px solid var(--divider-color); border-radius: 18px; margin: 16px 0; background: var(--primary-background-color); }
    .days { display: grid; grid-template-columns: repeat(7, 1fr); gap: 5px; margin-top: 12px; }
    .days button { min-width: 0; min-height: 46px; padding: 4px; font: inherit; font-size: 12px; background: var(--card-background-color); color: inherit; border: 1px solid var(--divider-color); border-radius: 12px; cursor: pointer; }
    .days button[aria-pressed="true"] { background: var(--gains-tint); color: var(--primary-color); border-color: var(--primary-color); font-weight: 700; }
    .session-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
    .reorder { display: flex; gap: 4px; }
    .reorder button { min-width: 44px; padding: 5px; }
    .session-index { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: var(--primary-color); margin: 0 0 4px; }
    .toggle-row { display: flex; align-items: center; gap: 10px; margin: 18px 0 10px; }
    .toggle-row input { width: auto; }
    .issues { border-left: 3px solid var(--error-color); color: var(--error-color); padding: 8px 12px; font-size: 13px; margin: 16px 0; }
    .issues p { margin: 6px 0; }
    .summary { display: grid; grid-template-columns: 1fr auto; gap: 12px; margin: 18px 0; font-size: 14px; }
    .summary dt { color: var(--secondary-text-color); }
    .summary dd { margin: 0; text-align: right; overflow-wrap: anywhere; }
    ol { padding-left: 22px; }
    li { padding: 7px 0; }
    .footer { display: flex; justify-content: space-between; gap: 10px; margin-top: 24px; }
    details { margin: 18px 0; }
    summary { cursor: pointer; min-height: 44px; font-size: 14px; font-weight: 650; }
    .pill { display: inline-block; border-radius: 999px; padding: 5px 10px; background: var(--gains-tint); color: var(--primary-color); font-size: 12px; margin: 0 6px 6px 0; }
    @media (max-width: 520px) { .block { padding: 14px; } .field-row { grid-template-columns: 1fr; } .footer .primary { flex: 1; } }
  `];
  private get value() { return programDefaults(this.answers, 45, this.sequencingPolicy); }
  private change(patch: BuilderAnswers) {
    if (this.busy) return;
    this.dispatchEvent(new CustomEvent("program-answers", {detail:{...this.value,...patch}, bubbles:true, composed:true}));
  }
  private go(stage: number) {
    if (this.busy) return;
    this.dispatchEvent(new CustomEvent("program-stage", {detail:stage, bubbles:true, composed:true}));
  }
  private updateSession(index: number, patch: BuilderAnswers) {
    const prefs = { ...(this.value.session_preferences as SessionPreferences ?? {}) };
    prefs[String(index + 1)] = patch;
    this.change({session_preferences:prefs});
  }
  private select(label: string, key: string, options: (string | number)[], empty?: string) {
    return html`<label>${label}<select aria-label=${label} .value=${String(this.value[key] ?? "")} @change=${(e:Event) => this.change({[key]:(e.target as HTMLSelectElement).value,[key+"_other"]:undefined})}>${empty ? html`<option value="">${empty}</option>` : ""}${!options.map(String).includes(String(this.value[key])) && this.value[key] ? html`<option selected value=${String(this.value[key])}>${String(this.value[key])}</option>` : ""}${options.map(o => html`<option value=${String(o)} ?selected=${String(this.value[key])===String(o)}>${o}</option>`)}</select></label>`;
  }
  private plan() {
    const a = this.value;
    return html`<h2>Build your training week</h2><p class="muted intro">Set a sustainable schedule. Your program continues until you pause or remove it.</p>
      <div class="field-row">${this.select("Main goal", "goal", ["Get Stronger","Build Muscle","Improve Endurance","Hybrid / Athletic Performance","General Fitness","Other"])}${this.select("Training for", "training_for", ["Nothing Specific","Race/Event","Sport","Fitness Test"])}</div>
      ${!["Get Stronger","Build Muscle","Improve Endurance","Hybrid / Athletic Performance","General Fitness"].includes(String(a.goal)) ? html`<label>Your training goal<input aria-label="Custom training goal" .value=${a.goal === "Other" ? "" : String(a.goal ?? "")} @input=${(e:Event) => this.change({goal:(e.target as HTMLInputElement).value})}></label>` : ""}
      ${builderQuestions("program", a).filter(q => ["race_distance","event_date","goal_time","sport"].includes(q.id)).map(q => html`<gains-builder-question .question=${q} .value=${a[q.id]} .other=${String(a[q.id+"_other"] ?? "")} @answer=${(e:CustomEvent<{id:string;value:unknown}>) => this.change({[e.detail.id]:e.detail.value})}></gains-builder-question>`)}
      <div class="block"><h3>Sessions per week</h3><div class="field-row">${this.select("Lifting sessions", "lifting_days", [0,1,2,3,4,5,6,7])}${this.select("Running sessions", "running_days", [0,1,2,3,4,5,6,7])}${this.select("HIIT sessions", "hiit", [0,1,2,3,4,5,6,7])}</div><p class="muted small">${Number(a.lifting_days)+Number(a.running_days)+Number(a.hiit)} sessions · one session per selected day.</p></div>
      <div class="block"><h3>Available days</h3><div class="days">${WEEKDAYS.map(day => html`<button aria-label=${day} aria-pressed=${(a.days as string[]).includes(day)} @click=${() => this.change({days:(a.days as string[]).includes(day) ? (a.days as string[]).filter(d => d !== day) : [...a.days as string[], day]})}>${day.slice(0,3)}</button>`)}</div></div>
      <label>Start date (optional)<input aria-label="Program start date" type="date" .value=${String(a.start_date ?? "")} @input=${(e:Event) => this.change({start_date:(e.target as HTMLInputElement).value || undefined})}></label>`;
  }
  private sessions() {
    const a = this.value;
    const custom = a.split === "Custom Split";
    const slots = preferenceSlots(a);
    return html`<h2>Shape your lifting sessions</h2><p class="muted intro">Rules follow each position in your split, even when the rotation spans multiple weeks.</p>
      ${!Number(a.lifting_days) ? html`<p>No lifting sessions selected. Your running and HIIT schedule will be built from your plan.</p>` : html`
      <gains-split-picker .value=${String(a.split)} .liftingDays=${Number(a.lifting_days)} .disabled=${this.busy} @split-change=${(e:CustomEvent<string>) => this.change({split:e.detail,split_other:undefined})}></gains-split-picker>
      <p class="muted small">${slots.length} positions in this rotation · ${a.lifting_days} lifting sessions per week. Repeated positions use the same session preferences.</p>
      ${custom ? html`<p class="muted small">Use muscle and movement focuses such as Chest/Triceps, Back/Biceps, Legs, Core or Power Upper. One row per lifting session.</p>` : html`<button class="secondary" @click=${() => {
        const cycle = preferenceSlots(a);
        const names = Array.from({length:Number(a.lifting_days)}, (_,i) => cycle[i%cycle.length] ?? "Full Body");
        this.change({split:"Custom Split", custom_split_days:names.join(" | ")});
      }}>Create a custom weekly split</button>`}
      ${slots.map((name,i) => {
        const p = (a.session_preferences as SessionPreferences ?? {})[String(i+1)] ?? {};
        return html`<article class="block"><div class="session-head"><div><p class="session-index">Split position ${i+1}</p><h3>${name || "Choose a focus"}</h3></div>${custom ? html`<div class="reorder"><button class="secondary" aria-label=${`Move session ${i+1} up`} ?disabled=${i===0} @click=${() => this.change(moveCustomSession(a,i,i-1))}>↑</button><button class="secondary" aria-label=${`Move session ${i+1} down`} ?disabled=${i===slots.length-1} @click=${() => this.change(moveCustomSession(a,i,i+1))}>↓</button></div>` : ""}</div>
          ${custom ? html`<label>Muscle focus<input aria-label=${`Session ${i+1} focus`} maxlength="60" .value=${name} @input=${(e:Event) => {const names=[...slots];names[i]=(e.target as HTMLInputElement).value;this.change({custom_split_days:names.join(" | ")});}}></label>` : ""}
          <div class="field-row"><label>Minutes (optional)<input type="number" min="5" max="180" placeholder="Use default" aria-label=${`Session ${i+1} minutes`} .value=${String(p.duration ?? "")} @input=${(e:Event) => {const next={...p};const value=(e.target as HTMLInputElement).value;if(value)next.duration=Number(value);else delete next.duration;this.updateSession(i,next);}}></label><label>Intensity<select aria-label=${`Session ${i+1} intensity`} .value=${String(p.intensity ?? "")} @change=${(e:Event) => {const next={...p};const value=(e.target as HTMLSelectElement).value;if(value)next.intensity=value;else delete next.intensity;this.updateSession(i,next);}}><option value="">Use default</option>${["Light","Moderate","Hard","Max Effort"].map(v => html`<option ?selected=${p.intensity===v}>${v}</option>`)}</select></label></div>
          <p class="muted small">Gains chooses the exercises, sets and weights automatically. Swap an exercise on the workout before or during your session.</p>
        </article>`;
      })}`}`;
  }
  private preferences() {
    const a = this.value;
    return html`<h2>Set your training preferences</h2><p class="muted intro">Gains fills every workout using your history, recovery, split and ${this.gym}. You do not need to choose exercises.</p>
      <div class="field-row"><label>Default lifting minutes<input type="number" min="5" max="180" aria-label="Default lifting minutes" .value=${String(a.duration)} @input=${(e:Event) => this.change({duration:Number((e.target as HTMLInputElement).value)})}></label>${this.select("Default intensity","intensity",["Light","Moderate","Hard","Max Effort"])}</div>
      ${this.select("Additional cardio guidance","cardio",["Minimal","Moderate","High","Geoffrey Decide"])}<p class="muted small">Extra context for Geoffrey. This does not add sessions beyond your weekly counts.</p>
      ${this.select("Exercise variety","variety",["Consistency","Balanced","Variety"])}<p class="muted small">Consistency keeps familiar exercises. Balanced rotates accessories. Variety allows more accessory changes while keeping the main lifts stable.</p>
      <label>Advance the split<select aria-label="Advance the split" .value=${String(a.sequencing_policy)} @change=${(e:Event) => this.change({sequencing_policy:(e.target as HTMLSelectElement).value})}><option value="calendar" ?selected=${a.sequencing_policy==="calendar"}>Follow scheduled days</option><option value="completion" ?selected=${a.sequencing_policy==="completion"}>After completed or skipped sessions</option></select></label>
      <p class="muted small">${a.sequencing_policy === "completion" ? "Completing or explicitly skipping a lifting session advances the rotation. Opening a workout does not." : "The rotation follows your scheduled weeks, including missed sessions."}</p>
      <label>Lighter weeks<select aria-label="Lighter weeks" .value=${String(a.deload_every)} @change=${(e:Event) => this.change({deload_every:Number((e.target as HTMLSelectElement).value)})}>${[0,4,6,8].map(n => html`<option value=${n} ?selected=${Number(a.deload_every)===n}>${n ? `Every ${n} weeks` : "No scheduled lighter weeks"}</option>`)}</select></label>
      <p class="muted small">Exercises, sets and weights are filled in for you. Any exercise preferences already supplied in your request are kept. You can make swaps on the workout itself.</p>
      <details><summary>Additional guidance for Geoffrey</summary><label>Notes<textarea aria-label="Additional program guidance" rows="3" .value=${String(a.instructions ?? "")} @input=${(e:Event) => this.change({instructions:(e.target as HTMLTextAreaElement).value})}></textarea></label><p class="muted small">Use the structured controls for constraints that must be enforced. Notes provide extra context.</p></details>`;
  }
  render() {
    const stage = Math.min(2, Math.max(0,this.stage));
    const issues = programIssues(this.value);
    const visible = stage === 2 ? issues : issues.filter(i => i.stage === stage);
    return html`<nav aria-label="Program builder steps">${STAGES.map((name,i) => html`<button ?disabled=${this.busy} aria-current=${stage===i ? "step" : "false"} @click=${() => this.go(i)}><span class="number">${i+1}</span>${name}</button>`)}</nav>
      <fieldset ?disabled=${this.busy}>${[() => this.plan(), () => this.sessions(), () => this.preferences()][stage]()}</fieldset>
      ${visible.length ? html`<div class="issues" role="alert">${visible.map(i => html`<p>${i.message}</p>`)}</div>` : ""}
      <div class="footer"><button class="secondary" ?disabled=${stage===0 || this.busy} @click=${() => this.go(stage-1)}>Back</button><button class="primary" ?disabled=${this.busy || (stage===2 ? issues.length>0 : visible.length>0)} @click=${() => stage===2 ? this.dispatchEvent(new CustomEvent("generate-program",{bubbles:true,composed:true})) : this.go(stage+1)}>${this.busy ? "Creating your program…" : stage===2 ? "Create program" : "Continue"}</button></div>`;
  }
}
