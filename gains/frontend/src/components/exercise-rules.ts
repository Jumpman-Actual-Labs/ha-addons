import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import { EXERCISE_LIBRARY } from "../types";
import type { BuilderAnswers } from "../training-types";
import { EXERCISE_RULES, type ExerciseRule } from "../program-builder";
import { formStyles } from "../styles";

const LABELS: Record<ExerciseRule, string> = {
  required_exercises: "Must include", preferred_exercises: "Prefer when possible", excluded_exercises: "Leave out",
};
@customElement("gains-exercise-rules")
export class GainsExerciseRules extends LitElement {
  @property({ attribute: false }) rules: BuilderAnswers = {};
  @property() scope = "Default";
  @property({ type: Boolean }) disabled = false;
  static styles = [formStyles, css`
    :host { display: block; }
    .rules { display: grid; gap: 16px; }
    label { margin-top: 0; }
    ul { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
    li { display: inline-flex; align-items: center; gap: 4px; background: var(--secondary-background-color); border-radius: 12px; padding: 4px 6px 4px 10px; font-size: 12px; }
    li button { border: 0; background: transparent; color: inherit; min-height: 36px; min-width: 36px; cursor: pointer; font-size: 20px; }
  `];
  private changeRule(field: ExerciseRule, ids: string[]) {
    this.dispatchEvent(new CustomEvent("rules-change", {detail:{...this.rules, [field]:ids}, bubbles:true, composed:true}));
  }
  render() {
    return html`<div class="rules">${EXERCISE_RULES.map(field => {
      const ids = Array.isArray(this.rules[field]) ? this.rules[field] as string[] : [];
      return html`<div><label>${LABELS[field]}<select aria-label=${`${this.scope}: ${LABELS[field]}`} ?disabled=${this.disabled} .value=${""} @change=${(event: Event) => {
        const select = event.target as HTMLSelectElement;
        if (select.value) this.changeRule(field, [...new Set([...ids, select.value])]);
        select.value = "";
      }}><option value="">Add an exercise…</option>${EXERCISE_LIBRARY.filter(e => !ids.includes(e.id)).map(e => html`<option value=${e.id}>${e.name}</option>`)}</select></label>
        <ul>${ids.map(id => html`<li>${EXERCISE_LIBRARY.find(e => e.id === id)?.name ?? id}<button aria-label=${`Remove ${id} from ${this.scope} ${LABELS[field]}`} ?disabled=${this.disabled} @click=${() => this.changeRule(field, ids.filter(i => i !== id))}>×</button></li>`)}</ul></div>`;
    })}</div>`;
  }
}

