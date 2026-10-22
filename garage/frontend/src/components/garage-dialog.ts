import { LitElement, css, html } from "lit";
import { customElement, property, query } from "lit/decorators.js";

/** Native modal semantics provide focus containment, Escape, and focus return. */
@customElement("garage-dialog")
export class GarageDialog extends LitElement {
  @property({ type: String }) heading = "";
  @property({ type: String }) description = "";
  @property({ type: String }) icon = "mdi:garage-variant";
  @property({ type: Boolean }) wide = false;
  @property({ type: Boolean, reflect: true }) open = false;
  @query("dialog") private _dialog!: HTMLDialogElement;

  static styles = css`
    :host { display: contents; }
    * { box-sizing: border-box; }
    dialog {
      width: min(620px, calc(100% - 32px)); max-height: calc(100dvh - 48px);
      padding: 0; border: 1px solid #555c63; border-radius: 18px;
      background: var(--garage-surface, #1b1e21); color: var(--garage-text, #f0f0ed);
      box-shadow: 0 32px 100px #00000090; overflow: hidden;
      font-family: var(--garage-font); color-scheme: dark;
    }
    dialog.wide { width: min(740px, calc(100% - 32px)); }
    dialog[open] { display: flex; flex-direction: column; }
    dialog::backdrop { background: #090a0bbc; backdrop-filter: blur(6px); }
    header {
      display: flex; align-items: center; gap: 14px; flex-shrink: 0;
      padding: 22px 24px; border-bottom: 1px solid var(--garage-border, #3b4046);
      background: linear-gradient(110deg, #f6a45b08, transparent), var(--garage-inset, #15181b);
    }
    .mark { display: grid; place-items: center; flex-shrink: 0; width: 42px; height: 42px; border: 1px solid #f6a45b33; background: #f6a45b0b; color: var(--garage-accent, #f6a45b); border-radius: 10px; }
    .heading { flex: 1; min-width: 0; }
    .eyebrow { color: var(--garage-accent, #f6a45b); font-size: .55rem; text-transform: uppercase; letter-spacing: .14em; font-weight: 600; margin-bottom: 5px; }
    h2 { margin: 0; font-size: 1.2rem; line-height: 1.3; font-weight: 600; letter-spacing: -.03em; }
    .content { padding: 24px; overflow-y: auto; overscroll-behavior: contain; min-height: 0; }
    .description { margin: 0 0 8px; color: var(--garage-muted, #aaaeb2); font-size: .8rem; line-height: 1.7; }
    .footer { padding: 18px 24px; flex-shrink: 0; border-top: 1px solid var(--garage-border, #3b4046); background: var(--garage-inset, #15181b); }
    .close {
      display: grid; place-items: center; width: 44px; height: 44px; flex-shrink: 0; padding: 0;
      border: 1px solid transparent; border-radius: 9px; background: transparent;
      color: var(--garage-muted, #aaaeb2); cursor: pointer;
    }
    .close:hover { background: var(--garage-raised, #272b2f); border-color: var(--garage-border); }
    .close:focus-visible { outline: 2px solid var(--garage-accent, #f6a45b); outline-offset: 2px; }
    ha-icon { --mdc-icon-size: 21px; }
    @media (max-width: 600px) {
      dialog, dialog.wide { width: calc(100% - 16px); max-height: calc(100dvh - 16px); border-radius: 14px; }
      header { padding: 16px; gap: 10px; }
      h2 { font-size: 1.05rem; }
      .content { padding: 20px 16px; }
      .footer { padding: 16px; }
    }
  `;

  updated(): void {
    if (this.open && !this._dialog.open) this._dialog.showModal();
    if (!this.open && this._dialog.open) this._dialog.close();
  }

  private _close(): void {
    this.open = false;
    this.dispatchEvent(new CustomEvent("garage-dialog-closed"));
  }

  private _backdropClick(event: MouseEvent): void {
    if (event.target !== this._dialog) return;
    const rect = this._dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right ||
        event.clientY < rect.top || event.clientY > rect.bottom) this._close();
  }

  render() {
    return html`
      <dialog class=${this.wide ? "wide" : ""} aria-labelledby="dialog-heading"
        @cancel=${(event: Event) => { event.preventDefault(); this._close(); }}
        @click=${this._backdropClick}>
        <header>
          <span class="mark"><ha-icon aria-hidden="true" icon=${this.icon}></ha-icon></span>
          <div class="heading"><div class="eyebrow">Garage workspace</div><h2 id="dialog-heading">${this.heading || "Garage"}</h2></div>
          <button class="close" type="button" aria-label="Close dialog" @click=${this._close}>
            <ha-icon aria-hidden="true" icon="mdi:close"></ha-icon>
          </button>
        </header>
        <div class="content">${this.description ? html`<p class="description">${this.description}</p>` : ""}<slot></slot></div>
        <div class="footer"><slot name="footer"></slot></div>
      </dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap { "garage-dialog": GarageDialog; }
}

