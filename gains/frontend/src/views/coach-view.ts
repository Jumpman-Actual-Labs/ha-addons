import { LitElement, html, css } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { gainsApi, type HomeAssistant } from "../ha-api";
import type { GainsState, AICoachMessage } from "../types";
import type { TrainingProgram } from "../training-types";
import { formStyles, glassCardStyle } from "../styles";
import { BUILD_KINDS, RUNS_ENABLED } from "../features";
@customElement("gains-coach-view")
export class GainsCoachView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) gainsState!: GainsState;
  @property({ attribute: false }) programs: TrainingProgram[] = [];
  @state() private message = "";
  @state() private sending = false;
  @state() private error = "";
  static styles = [
    glassCardStyle,
    formStyles,
    css`
      :host {
        display: block;
        max-width: 680px;
      }
      .quick {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
        margin: 20px 0;
      }
      .quick button {
        min-height: 56px;
      }
      ha-card {
        display: block;
        padding: 16px;
      }
      .messages {
        max-height: 55vh;
        overflow: auto;
        display: flex;
        flex-direction: column;
        gap: 14px;
      }
      .bubble {
        white-space: pre-wrap;
        background: var(--secondary-background-color);
        border-radius: 14px;
        padding: 12px;
        max-width: 88%;
      }
      .user {
        align-self: flex-end;
        background: var(--primary-color);
        color: var(--text-primary-color);
      }
      .composer {
        display: flex;
        gap: 8px;
        margin-top: 16px;
      }
      .composer input {
        min-width: 0;
        flex: 1;
      }
      .error {
        color: var(--error-color, #c33);
      }
      .proposal {
        padding: 10px 0;
      }
    `,
  ];
  private event(name: string, detail: unknown = {}) {
    this.dispatchEvent(
      new CustomEvent(name, { detail, bubbles: true, composed: true }),
    );
  }
  private async send() {
    if (this.sending || !this.message.trim()) return;
    this.sending = true;
    this.error = "";
    try {
      await gainsApi.aiChat(this.hass, this.message.trim());
      this.message = "";
    } catch (e) {
      this.error = String(e);
    } finally {
      this.sending = false;
      await this.updateComplete;
      const messages = this.shadowRoot?.querySelector(".messages");
      messages?.scrollTo(0, messages.scrollHeight);
    }
  }
  private renderMessage(m: AICoachMessage) {
    return html`<div class="bubble ${m.role}">${m.content}</div>
      ${m.actions?.map((a) => html`<button class="secondary" @click=${() => this.event("open-builder", { kind: a.builder, prefill: a.prefill })}>Continue building ${a.builder}</button>`)}${m.proposedWorkouts.map((w) => html`<div class="proposal"><button class="secondary" @click=${() => this.event("review-proposal", { kind: "workout", payload: { name: w.name, exercises: w.exercises.map((e) => ({ exercise_id: e.exerciseId, sets: e.sets.map((s) => ({ reps: s.reps ?? 8, weight: s.weight ?? 0 })) })) } })}>Review ${w.name}</button></div>`)}${(RUNS_ENABLED ? m.proposedRuns : []).map((r) => html`<div class="proposal"><button class="secondary" @click=${() => this.event("review-proposal", { kind: "run", payload: { name: r.name, run_type: r.runType, target_distance: r.targetDistance, target_duration_minutes: r.targetDurationMinutes, segments: r.segments ?? [] } })}>Review ${r.name}</button></div>`)}`;
  }
  render() {
    const p = this.gainsState?.profile;
    if (!p) return html`<p>Loading Geoffrey…</p>`;
    return html`<h1>Ask Geoffrey</h1>
      <p class="muted">Training for ${p.displayName}</p>
      ${this.programs
        .filter((program) => program.status === "active")
        .map(
          (program) =>
            html` <ha-card
              ><strong>${program.name}</strong>
              <p>
                Week ${program.current_week ?? 1} · Ongoing ·
                ${program.completed_sessions ?? 0} sessions completed
              </p>
              <button
                class="secondary"
                @click=${() => this.event("gains-switch-tab", { tab: "training" })}
              >
                View program
              </button>
            </ha-card>`,
        )}
      <div class="quick">
        ${BUILD_KINDS.map((kind) => html`<button class="primary" @click=${() => this.event("open-builder", { kind })}>Build ${kind}</button>`)}<button
          class="secondary"
          @click=${() => this.event("enter-coach-mode")}
        >
          Coach Mode
        </button>
      </div>
      <ha-card
        ><h2>Ask Geoffrey</h2>
        <div class="messages" aria-live="polite">
          ${p.aiConversation.length ? p.aiConversation.map((m) => this.renderMessage(m)) : html`<p>Ask a training question, discuss your progress, or tell Geoffrey what you want to build.</p>`}${this.sending ? html`<p>Geoffrey is thinking…</p>` : ""}
        </div>
        ${this.error ? html`<p class="error" role="alert">${this.error}</p>` : ""}
        <div class="composer">
          <input
            aria-label="Message Geoffrey"
            placeholder="Message Geoffrey…"
            .value=${this.message}
            @input=${(e: Event) => (this.message = (e.target as HTMLInputElement).value)}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter") void this.send();
            }}
          /><button
            class="primary"
            ?disabled=${this.sending || !this.message.trim()}
            @click=${this.send}
          >
            Send
          </button>
        </div></ha-card
      >`;
  }
}
