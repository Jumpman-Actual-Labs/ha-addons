import { LitElement, html, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { BuilderQuestion } from "../builder-questions";
import { formStyles } from "../styles";
@customElement("gains-builder-question")
export class GainsBuilderQuestion extends LitElement {
  @property({ attribute: false }) question!: BuilderQuestion;
  @property({ attribute: false }) value: unknown;
  @property() other = "";
  static styles = [
    formStyles,
    css`
      :host {
        display: block;
      }
      h2 {
        font-size: 25px;
        line-height: 1.2;
      }
      .options {
        display: grid;
        gap: 10px;
      }
      button {
        min-height: 54px;
        text-align: left;
      }
      button[aria-pressed="true"] {
        border: 2px solid var(--primary-color);
        background: var(--gains-tint);
      }
    `,
  ];
  private choose(value: unknown) {
    this.dispatchEvent(
      new CustomEvent("answer", {
        detail: { id: this.question.id, value },
        bubbles: true,
        composed: true,
      }),
    );
  }
  render() {
    const q = this.question;
    if (!q) return html``;
    return html`<h2>${q.title}</h2>
      ${
        q.input
          ? q.id === "custom_split_days"
            ? html`<p>Enter one focus per lifting day, separated by a vertical bar (|).</p>
                <textarea
                  aria-label=${q.title}
                  rows="3"
                  placeholder="Chest/Triceps | Back/Biceps | Legs | Chest/Biceps Isolation | Arms/Forearms/Grip"
                  .value=${String(this.value ?? "")}
                  @input=${(e: Event) => this.choose((e.target as HTMLTextAreaElement).value)}
                ></textarea>`
            : html`<input
              aria-label=${q.title}
              type=${q.input}
              .value=${String(this.value ?? "")}
              @input=${(e: Event) => this.choose((e.target as HTMLInputElement).value)}
            />`
          : html`<div class="options">
              ${q.options.map((o) => {
                const selected = Array.isArray(this.value)
                  ? this.value.includes(o.value)
                  : this.value === o.value;
                return html`<button
                  class="secondary"
                  aria-pressed=${selected}
                  @click=${() => this.choose(q.multiple ? (selected ? (this.value as unknown[]).filter((v) => v !== o.value) : [...(Array.isArray(this.value) ? this.value : []), o.value]) : o.value)}
                >
                  ${o.label}${selected ? " ✓" : ""}
                </button>`;
              })}
            </div>`
      }${this.value === "Other" ? html`<label>Your preference<input .value=${this.other} @input=${(e: Event) => this.dispatchEvent(new CustomEvent("answer", { detail: { id: q.id + "_other", value: (e.target as HTMLInputElement).value }, bubbles: true, composed: true }))} /></label>` : ""}`;
  }
}
