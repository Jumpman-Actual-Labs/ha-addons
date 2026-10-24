import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";

/**
 * Lightweight modal, styled with Home Assistant's CSS custom properties
 * rather than wrapping <ha-dialog>, so it doesn't depend on HA's internal
 * Material dialog slotting/API staying stable across versions.
 */
@customElement("finance-dialog")
export class FinanceDialog extends LitElement {
  @property({ type: String }) heading = "";
  @property({ type: Boolean, reflect: true }) open = false;
  @property({ type: Boolean }) dismissible = true;

  static styles = css`
    :host {
      position: fixed;
      inset: 0;
      z-index: 1000;
      display: none;
    }
    :host([open]) {
      display: block;
    }
    .scrim {
      position: absolute;
      inset: 0;
      background: rgba(2, 8, 23, 0.6);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    }
    .surface {
      display: flex;
      flex-direction: column;
      position: relative;
      box-sizing: border-box;
      width: calc(100% - 24px);
      max-width: var(--finance-dialog-max-width, 520px);
      margin: 10vh auto 0;
      background: var(--card-background-color, #fff);
      color: var(--primary-text-color, #212121);
      border-radius: 14px;
      border: 1px solid color-mix(in srgb, var(--divider-color, #fff) 60%, transparent);
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.45);
      backdrop-filter: blur(24px) saturate(160%);
      -webkit-backdrop-filter: blur(24px) saturate(160%);
      padding: 0;
      max-height: 78vh;
      max-height: 78dvh;
      overflow: hidden;
    }
    .content { padding: 0 24px 24px; overflow-y: auto; min-height: 0; }
    .footer { flex-shrink: 0; }
    h2 {
      margin: 0;
      padding: 20px 24px 16px;
      flex-shrink: 0;
      font-size: 1.25rem;
      font-weight: 650;
      letter-spacing: -0.025em;
    }
  `;

  private _close(): void {
    if (!this.dismissible) return;
    this.open = false;
    this.dispatchEvent(new CustomEvent("finance-dialog-closed"));
  }

  render() {
    if (!this.open) {
      return html``;
    }
    return html`
      <div class="scrim" @click=${this._close}></div>
      <div class="surface" role="dialog" aria-modal="true" aria-label=${this.heading || "Stash dialog"}>
        ${this.heading ? html`<h2>${this.heading}</h2>` : ""}
        <div class="content"><slot></slot></div>
        <div class="footer"><slot name="footer"></slot></div>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "finance-dialog": FinanceDialog;
  }
}
