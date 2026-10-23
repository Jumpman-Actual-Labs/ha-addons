import { LitElement, css, html, svg } from "lit";
import { customElement, property } from "lit/decorators.js";
import { ICONS } from "./icons";

/* Stand-ins for the two Home Assistant frontend elements the panel uses.
 * As a custom panel it ran inside HA's own frontend, where <ha-card> and
 * <ha-icon> are already registered; as an add-on it runs in an ingress
 * iframe with none of HA's elements loaded. These reproduce just the parts
 * the panel relies on - the same --ha-card-* custom properties styles.ts's
 * glass treatment sets, and mdi:<name> icon lookup - so no view needed to
 * change. */

@customElement("ha-card")
export class HaCard extends LitElement {
  static styles = css`
    :host {
      display: block;
      position: relative;
      box-sizing: border-box;
      background: var(--ha-card-background, var(--card-background-color, #16181b));
      border-radius: var(--ha-card-border-radius, 12px);
      border-width: var(--ha-card-border-width, 1px);
      border-style: solid;
      border-color: var(--ha-card-border-color, var(--divider-color, rgba(255, 255, 255, 0.1)));
      box-shadow: var(--ha-card-box-shadow, none);
      color: var(--primary-text-color);
    }
  `;

  render() {
    return html`<slot></slot>`;
  }
}

@customElement("ha-icon")
export class HaIcon extends LitElement {
  @property({ type: String }) icon = "";

  static styles = css`
    :host {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      vertical-align: middle;
      fill: currentColor;
      width: var(--mdc-icon-size, 24px);
      height: var(--mdc-icon-size, 24px);
    }
    svg {
      width: 100%;
      height: 100%;
      pointer-events: none;
    }
  `;

  render() {
    const path = ICONS[this.icon];
    if (!path) return html``;
    return html`<svg viewBox="0 0 24 24" aria-hidden="true">${svg`<path d=${path}></path>`}</svg>`;
  }
}
