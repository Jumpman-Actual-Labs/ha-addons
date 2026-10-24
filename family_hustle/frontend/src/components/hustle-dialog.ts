import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";

/**
 * Lightweight modal, styled with Home Assistant's CSS custom properties
 * rather than wrapping <ha-dialog>, so it doesn't depend on HA's internal
 * Material dialog slotting/API staying stable across versions.
 */
@customElement("hustle-dialog")
export class HustleDialog extends LitElement {
  @property({ type: String }) heading = "";
  @property({ type: Boolean, reflect: true }) open = false;

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
      background: rgba(0, 0, 0, 0.35);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    }
    .surface {
      position: relative;
      max-width: 480px;
      margin: 6vh auto 0;
      width: calc(100% - 32px);
      box-sizing: border-box;
      background: color-mix(in srgb, var(--card-background-color, #fff) 100%, transparent);
      color: var(--primary-text-color, #212121);
      border-radius: 20px;
      border: 1px solid color-mix(in srgb, var(--divider-color, #fff) 60%, transparent);
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.2);
      backdrop-filter: blur(24px) saturate(160%);
      -webkit-backdrop-filter: blur(24px) saturate(160%);
      padding: 20px 24px 24px;
      max-height: 86vh;
      overflow-y: auto;
    }
    h2 {
      margin: 0 0 16px;
      font-size: 1.25rem;
      font-weight: 500;
    }
  `;

  private _close(): void {
    this.open = false;
    this.dispatchEvent(new CustomEvent("hustle-dialog-closed"));
  }

  render() {
    if (!this.open) {
      return html``;
    }
    return html`
      <div class="scrim" @click=${this._close}></div>
      <div class="surface">
        ${this.heading ? html`<h2>${this.heading}</h2>` : ""}
        <slot></slot>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "hustle-dialog": HustleDialog;
  }
}

