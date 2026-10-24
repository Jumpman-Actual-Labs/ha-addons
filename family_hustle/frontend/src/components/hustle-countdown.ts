import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { countdownParts } from "../utils/time";

/** Client-side ticking countdown - no server push needed, it just
 * recomputes from the `deadline` property (an ISO timestamp) every second. */
@customElement("hustle-countdown")
export class HustleCountdown extends LitElement {
  @property({ type: String }) deadline = "";

  @state() private _text = "";

  private _interval: ReturnType<typeof setInterval> | null = null;

  static styles = css`
    :host {
      font-weight: 600;
      color: var(--primary-color, #03a9f4);
    }
    :host([expired]) {
      color: var(--error-color, #c62828);
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    this._tick();
    this._interval = setInterval(() => this._tick(), 1000);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this._interval) clearInterval(this._interval);
  }

  updated(changed: Map<string, unknown>): void {
    if (changed.has("deadline")) this._tick();
  }

  private _tick(): void {
    if (!this.deadline) {
      this._text = "";
      return;
    }
    const parts = countdownParts(this.deadline);
    if (parts.expired) {
      this._text = "Expired";
      this.toggleAttribute("expired", true);
      if (this._interval) {
        clearInterval(this._interval);
        this._interval = null;
      }
      return;
    }
    const pad = (n: number) => String(n).padStart(2, "0");
    this._text =
      parts.days > 0
        ? `${parts.days}d ${pad(parts.hours)}h ${pad(parts.minutes)}m`
        : `${pad(parts.hours)}h ${pad(parts.minutes)}m ${pad(parts.seconds)}s`;
  }

  render() {
    return html`${this._text}`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "hustle-countdown": HustleCountdown;
  }
}
