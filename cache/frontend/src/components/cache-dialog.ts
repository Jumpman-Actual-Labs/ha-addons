import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";

/**
 * Lightweight modal, styled with Home Assistant's CSS custom properties
 * rather than wrapping <ha-dialog>, so it doesn't depend on HA's internal
 * Material dialog slotting/API staying stable across versions.
 */
@customElement("cache-dialog")
export class CacheDialog extends LitElement {
  @property({ type: String }) heading = "";
  @property({ type: Boolean, reflect: true }) open = false;
  @property({ type: String }) width = "480px";

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
      background: rgba(4, 4, 5, 0.7);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    }
    /* Same restrained glass shadow recipe as glassCardStyle's ha-card
       (styles.ts) - inset top highlight + inset bottom vignette for a
       sense of real glass thickness, a tight contact shadow, and a soft
       ambient shadow that reads as the dialog sitting slightly above the
       scrim - scaled up for this surface's larger footprint, kept
       low-alpha like every other glass surface rather than a dramatic
       floating effect. */
    .surface {
      position: relative;
      max-width: var(--dialog-width, 480px);
      margin: 6vh auto 0;
      background: color-mix(in srgb, var(--card-background-color, #16181b) 62%, transparent);
      color: var(--primary-text-color, #f2f4f6);
      border-radius: 14px;
      border: 1px solid var(--divider-color, rgba(255, 255, 255, 0.1));
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.07), inset 0 -18px 28px -22px rgba(0, 0, 0, 0.26),
        0 4px 14px rgba(0, 0, 0, 0.24), 0 26px 54px -16px rgba(0, 0, 0, 0.44);
      backdrop-filter: blur(28px) saturate(120%);
      -webkit-backdrop-filter: blur(28px) saturate(120%);
      padding: 20px 24px 24px;
      max-height: 86vh;
      overflow-y: auto;
    }
    h2 {
      margin: 0 0 16px;
      font-size: 1.05rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--primary-color, #f2f4f6);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .close-btn {
      background: none;
      border: none;
      cursor: pointer;
      color: var(--secondary-text-color, #a0a0a6);
      display: flex;
    }
    .close-btn:hover {
      color: var(--primary-color, #f2f4f6);
    }
  `;

  private _close(): void {
    this.open = false;
    this.dispatchEvent(new CustomEvent("cache-dialog-closed"));
  }

  render() {
    if (!this.open) {
      return html``;
    }
    return html`
      <div class="scrim" @click=${this._close}></div>
      <div class="surface" style="--dialog-width:${this.width}">
        ${this.heading
          ? html`<h2>
              <span>${this.heading}</span>
              <button class="close-btn" @click=${this._close} aria-label="Close">
                <ha-icon icon="mdi:close"></ha-icon>
              </button>
            </h2>`
          : ""}
        <slot></slot>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cache-dialog": CacheDialog;
  }
}
