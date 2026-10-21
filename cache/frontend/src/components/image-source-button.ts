import { LitElement, css, html, render as renderToDom, type TemplateResult } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";

/** Rendered into a `document.body` portal, not this component's shadow
 * root - see `_syncPortal`'s doc comment for why. Duplicated (not shared
 * via `static styles`) because a portal container has no connection to
 * this element's shadow root and needs its own `<style>` tag. */
const PORTAL_MENU_CSS = `
  .menu {
    min-width: 300px;
    background: var(--card-background-color, #fff);
    border: 1px solid var(--divider-color, #e0e0e0);
    border-radius: 10px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
    padding: 6px;
  }
  .menu button {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    background: none;
    border: none;
    text-align: left;
    padding: 8px 10px;
    border-radius: 6px;
    cursor: pointer;
    color: var(--primary-text-color, #212121);
    font: inherit;
    font-size: 0.9rem;
  }
  .menu button:hover {
    background: var(--secondary-background-color, #f0f0f0);
  }
  .menu button[disabled] {
    opacity: 0.5;
    cursor: default;
  }
  .url-row {
    display: flex;
    gap: 6px;
    padding: 6px;
  }
  .url-row input {
    flex: 1;
    min-width: 160px;
    box-sizing: border-box;
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid var(--divider-color, #e0e0e0);
    background: var(--card-background-color, #fff);
    color: var(--primary-text-color, #212121);
    font-size: 0.9rem;
  }
  .url-row button {
    width: auto;
    flex-shrink: 0;
    background: var(--primary-color, #03a9f4);
    color: var(--text-primary-color, #fff);
    border: none;
    border-radius: 6px;
    padding: 0 14px;
    cursor: pointer;
    font-size: 0.9rem;
  }
`;

/**
 * A trigger button that opens a small menu offering three ways to supply an
 * image - Choose File, Paste from Clipboard, or an Image URL - used
 * everywhere the app accepts an image (firearm/inventory item photos, ammo
 * box scan, barcode scan). Emits `cache-image-selected` with
 * `detail: { files: File[] }` once a file is ready, or `cache-image-error`
 * with `detail: { message: string }` if a source fails - callers handle
 * both the same way they already handle a plain file input's change event,
 * just wired through events instead. `multiple` only applies to the file
 * picker and clipboard paste (an Image URL can only ever resolve to one
 * file); `capture` is passed straight through to the file input's
 * `capture` attribute for the mobile-camera hint some callers rely on.
 */
@customElement("cache-image-source-button")
export class CacheImageSourceButton extends LitElement {
  @property({ type: String }) label = "Add Image";
  @property({ type: String }) busyLabel = "";
  @property({ type: String }) icon = "mdi:image-plus";
  @property({ type: Boolean }) multiple = false;
  @property({ type: Boolean }) disabled = false;
  @property({ type: String }) capture: string | undefined = undefined;

  @state() private _menuOpen = false;
  @state() private _urlMode = false;
  @state() private _urlValue = "";
  @state() private _pending = false;
  @query("input[type=file]") private _fileInput!: HTMLInputElement;
  private _portal: HTMLDivElement | null = null;

  static styles = css`
    :host {
      display: inline-block;
      position: relative;
    }
    .trigger {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: none;
      border: none;
      color: var(--primary-color, #03a9f4);
      cursor: pointer;
      padding: 0;
      font: inherit;
    }
    .trigger[disabled] {
      opacity: 0.6;
      cursor: default;
    }
  `;

  connectedCallback(): void {
    super.connectedCallback();
    document.addEventListener("click", this._handleOutsideClick);
  }

  disconnectedCallback(): void {
    document.removeEventListener("click", this._handleOutsideClick);
    this._destroyPortal();
    super.disconnectedCallback();
  }

  updated(changed: Map<PropertyKey, unknown>): void {
    super.updated(changed);
    if (this._menuOpen) {
      this._syncPortal();
    } else {
      this._destroyPortal();
    }
  }

  private _handleOutsideClick = (e: MouseEvent): void => {
    if (!this._menuOpen) return;
    const path = e.composedPath();
    if (path.includes(this)) return;
    if (this._portal && path.includes(this._portal)) return;
    this._closeMenu();
  };

  /** The menu portals into `document.body` instead of rendering inside
   * this component's own shadow root, because every real call site embeds
   * this button inside some ancestor with `overflow` set (a scrollable
   * dialog surface, a card body, etc.) - an in-shadow-DOM absolutely
   * positioned menu gets clipped by whichever ancestor's overflow box it
   * lands inside. `cache-dialog`'s `.surface` makes this worse: its
   * `backdrop-filter` makes it a `position: fixed` containing block too,
   * so switching to `position: fixed` without portalling still gets
   * clipped by that same `overflow-y: auto` box. Escaping to
   * `document.body` sidesteps every ancestor's overflow/backdrop-filter/
   * stacking context entirely - a real bug this fixes: the photo grid's
   * "Add Photos" menu was invisible, clipped into a tiny scrollbar,
   * whenever the photo grid above it was short (see photo-manager-
   * section.ts, embedded directly inside Edit Firearm/Edit Item's own
   * cache-dialog - even more exposed to this than the original standalone
   * Manage Photos dialog this component was built for). Position is
   * computed fresh on every sync
   * (not just on open) but nothing re-closes the menu on scroll - an
   * earlier version of this did, meant only to stop a stale menu from
   * drifting away from a scrolled-past trigger, but it fired on ANY
   * scroll anywhere in the document (capture-phase on `window` sees
   * scroll events from nested scrollable ancestors too, and mobile
   * browsers scroll/resize the page when a text input gains focus to
   * clear the on-screen keyboard) - a real bug this caused: opening
   * "Image URL..." and then tapping its input immediately closed the
   * whole menu before you could type anything. */
  private _syncPortal(): void {
    if (!this._portal) {
      this._portal = document.createElement("div");
      this._portal.style.position = "fixed";
      this._portal.style.zIndex = "10000";
      document.body.appendChild(this._portal);
    }
    const rect = this.getBoundingClientRect();
    this._portal.style.top = `${rect.bottom + 6}px`;
    this._portal.style.left = `${rect.left}px`;
    // `host: this` is required here - LitElement's own render cycle passes
    // this automatically so `@click=${this._method}` (an unbound prototype
    // method, not an arrow function) resolves `this` to the component
    // inside the handler; calling the bare `render()` import ourselves for
    // the portal skips that unless told to do it explicitly, which
    // otherwise silently binds `this` to the clicked DOM element instead -
    // a real bug this hit: "Image URL..." looked like it did nothing.
    renderToDom(this._menuTemplate(), this._portal, { host: this });
  }

  private _destroyPortal(): void {
    if (!this._portal) return;
    this._portal.remove();
    this._portal = null;
  }

  private _closeMenu(): void {
    this._menuOpen = false;
    this._urlMode = false;
    this._urlValue = "";
  }

  private _emitFiles(files: File[]): void {
    this.dispatchEvent(
      new CustomEvent("cache-image-selected", { detail: { files }, bubbles: true, composed: true })
    );
  }

  private _emitError(message: string): void {
    this.dispatchEvent(
      new CustomEvent("cache-image-error", { detail: { message }, bubbles: true, composed: true })
    );
  }

  private _handleFileChange(e: Event): void {
    const input = e.target as HTMLInputElement;
    const files = input.files ? Array.from(input.files) : [];
    input.value = "";
    if (files.length > 0) this._emitFiles(files);
  }

  private async _pasteFromClipboard(): Promise<void> {
    this._closeMenu();
    if (!navigator.clipboard?.read) {
      // The Clipboard API is only defined at all in a secure context
      // (HTTPS, or localhost) - if Home Assistant is being served over
      // plain HTTP (common for local-network-only installs),
      // `navigator.clipboard` doesn't exist and there's no in-app
      // workaround for that, so say so rather than implying a retry
      // might work.
      this._emitError(
        window.isSecureContext
          ? "Clipboard access isn't supported in this browser - try Choose File instead."
          : "Clipboard access requires a secure (HTTPS) connection, and this page isn't loaded over HTTPS - try Choose File instead, or access Home Assistant over HTTPS."
      );
      return;
    }
    this._pending = true;
    try {
      const items = await navigator.clipboard.read();
      const files: File[] = [];
      for (const item of items) {
        const imageType = item.types.find((t) => t.startsWith("image/"));
        if (!imageType) continue;
        const blob = await item.getType(imageType);
        const ext = imageType.split("/")[1] || "png";
        files.push(new File([blob], `pasted-image.${ext}`, { type: imageType }));
        if (!this.multiple) break;
      }
      if (files.length === 0) {
        this._emitError("No image found on the clipboard - copy an image first, then try again.");
      } else {
        this._emitFiles(files);
      }
    } catch {
      this._emitError("Couldn't read the clipboard - your browser may need permission granted first.");
    } finally {
      this._pending = false;
    }
  }

  private _openUrlMode(): void {
    this._urlMode = true;
  }

  private async _fetchFromUrl(): Promise<void> {
    const url = this._urlValue.trim();
    if (!url) return;
    this._pending = true;
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Couldn't load that URL (${resp.status})`);
      const blob = await resp.blob();
      if (!blob.type.startsWith("image/")) {
        throw new Error("That URL doesn't point to an image");
      }
      const name = url.split("/").pop()?.split("?")[0] || "image";
      const ext = blob.type.split("/")[1] || "png";
      const filename = name.includes(".") ? name : `${name}.${ext}`;
      this._emitFiles([new File([blob], filename, { type: blob.type })]);
      this._closeMenu();
    } catch (err) {
      this._emitError(
        err instanceof Error
          ? `${err.message} - some sites block direct downloads; try saving the image and using Choose File instead.`
          : "Failed to load image from URL"
      );
    } finally {
      this._pending = false;
    }
  }

  private _menuTemplate(): TemplateResult {
    return html`
      <style>
        ${PORTAL_MENU_CSS}
      </style>
      <div class="menu">
        <button
          type="button"
          @click=${() => {
            this._closeMenu();
            this._fileInput.click();
          }}
        >
          <ha-icon icon="mdi:file-image-outline"></ha-icon> Choose File
        </button>
        <button type="button" ?disabled=${this._pending} @click=${this._pasteFromClipboard}>
          <ha-icon icon="mdi:content-paste"></ha-icon> Paste from Clipboard
        </button>
        ${this._urlMode
          ? html`
              <div class="url-row">
                <input
                  type="url"
                  placeholder="https://example.com/image.jpg"
                  .value=${this._urlValue}
                  @input=${(e: Event) => (this._urlValue = (e.target as HTMLInputElement).value)}
                  @keydown=${(e: KeyboardEvent) => {
                    if (e.key === "Enter") void this._fetchFromUrl();
                  }}
                />
                <button type="button" ?disabled=${this._pending} @click=${this._fetchFromUrl}>Go</button>
              </div>
            `
          : html`
              <button type="button" @click=${this._openUrlMode}>
                <ha-icon icon="mdi:link-variant"></ha-icon> Image URL...
              </button>
            `}
      </div>
    `;
  }

  render() {
    const busy = this.disabled;
    return html`
      <button
        class="trigger"
        type="button"
        ?disabled=${busy}
        @click=${() => (this._menuOpen = !this._menuOpen)}
      >
        <ha-icon icon=${this.icon}></ha-icon>
        ${busy && this.busyLabel ? this.busyLabel : this.label}
      </button>
      <input
        type="file"
        accept="image/*"
        ?multiple=${this.multiple}
        capture=${this.capture ?? ""}
        style="display:none"
        @change=${this._handleFileChange}
      />
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cache-image-source-button": CacheImageSourceButton;
  }
}
