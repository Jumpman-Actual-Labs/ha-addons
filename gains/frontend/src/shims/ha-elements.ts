import { LitElement, css, html, svg } from "lit";
import { customElement, property, query } from "lit/decorators.js";
import { ICONS } from "./icons";

/* Stand-ins for the three Home Assistant frontend elements the panel uses.
 * As a custom panel it ran inside HA's own frontend, where <ha-card>,
 * <ha-icon> and <ha-dialog> are already registered; as an add-on it runs in
 * an ingress iframe with none of HA's elements loaded. These reproduce just
 * the parts the panel relies on - the --ha-card-* and --mdc-dialog-* custom
 * properties the views set, mdi:<name> icon lookup, and ha-dialog's
 * open/closed contract - so no view needed to change. */

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


/* HA's <ha-dialog> is an mwc-dialog. The views only use `.open`,
 * `hideActions` (they never use the action slots) and `@closed`, and size
 * dialogs with --mdc-dialog-min-width/--mdc-dialog-max-width. This keeps
 * that contract on a native <dialog>: modal, closed by the scrim or Escape,
 * firing `closed` whenever an open dialog closes - including when a view
 * sets `.open` back to false itself, as mwc-dialog does. Like HA's, it goes
 * edge to edge on phone-sized screens unless a view sets its own width. */
@customElement("ha-dialog")
export class HaDialog extends LitElement {
  @property({ type: Boolean, reflect: true }) open = false;
  @property({ type: Boolean }) hideActions = false;
  @property({ type: String }) heading = "";
  @query("dialog") private _dialog?: HTMLDialogElement;
  private _closeAction = "";

  static styles = css`
    :host {
      --_min-width: var(--mdc-dialog-min-width, 280px);
      --_max-width: var(--mdc-dialog-max-width, 560px);
      --_max-height: calc(100% - 32px);
      --_radius: 24px;
    }
    @media (max-width: 450px), (max-height: 500px) {
      :host {
        --_min-width: var(--mdc-dialog-min-width, 100vw);
        --_max-width: var(--mdc-dialog-max-width, 100vw);
        --_max-height: 100%;
        --_radius: 0;
      }
    }
    dialog {
      box-sizing: border-box;
      min-width: min(var(--_min-width), 100vw);
      max-width: min(var(--_max-width), 100vw);
      max-height: var(--_max-height);
      padding: var(--dialog-content-padding, 20px 24px);
      border: none;
      border-radius: var(--_radius);
      background: var(--mdc-theme-surface, var(--card-background-color, #fff));
      color: var(--mdc-theme-on-surface, var(--primary-text-color));
      box-shadow: 0 11px 15px -7px rgba(0, 0, 0, 0.2), 0 24px 38px 3px rgba(0, 0, 0, 0.14);
      overflow: auto;
      overscroll-behavior: contain;
    }
    dialog::backdrop {
      background: rgba(0, 0, 0, 0.32);
    }
    h2 {
      margin: 0 0 12px;
      font-size: 1.25rem;
      font-weight: 500;
    }
    .actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 16px;
    }
  `;

  render() {
    return html`<dialog
      aria-label=${this.heading}
      @cancel=${this._onCancel}
      @click=${this._onClick}
      @close=${this._onNativeClose}
    >
      ${this.heading ? html`<h2>${this.heading}</h2>` : ""}
      <slot></slot>
      ${this.hideActions
        ? ""
        : html`<div class="actions">
            <slot name="secondaryAction"></slot><slot name="primaryAction"></slot>
          </div>`}
    </dialog>`;
  }

  protected updated(changed: Map<string, unknown>): void {
    if (!changed.has("open") || !this._dialog) return;
    if (this.open && !this._dialog.open) {
      this._closeAction = "";
      this._dialog.showModal();
      this.dispatchEvent(new CustomEvent("opened"));
    } else if (!this.open && this._dialog.open) {
      this._dialog.close();
    }
  }

  private _close(action: string): void {
    this._closeAction = action;
    this.open = false;
  }

  private _onCancel(e: Event): void {
    // Escape: close through `open` so the closed event fires once.
    e.preventDefault();
    this._close("escape");
  }

  private _onClick(e: MouseEvent): void {
    // Clicks on the content land on its children; a click on the <dialog>
    // itself outside its box is the scrim.
    if (e.target !== this._dialog) return;
    const box = this._dialog.getBoundingClientRect();
    const inside =
      e.clientX >= box.left && e.clientX <= box.right && e.clientY >= box.top && e.clientY <= box.bottom;
    if (!inside) this._close("scrim");
  }

  private _onNativeClose(): void {
    if (this.open) this.open = false;
    this.dispatchEvent(new CustomEvent("closed", { detail: { action: this._closeAction } }));
  }
}
