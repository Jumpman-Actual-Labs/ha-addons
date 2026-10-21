import { LitElement, css, html } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { cacheApi } from "../ha-api";
import type { DocumentEntry } from "../types";
import { DOCUMENT_TYPES } from "../types";
import { formStyles } from "../styles";
import { formatDate } from "../utils/format";
import "./cache-dialog";

@customElement("document-manager-dialog")
export class DocumentManagerDialog extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ type: Boolean }) open = false;
  @property({ type: String }) firearmId = "";
  @property({ attribute: false }) documents: DocumentEntry[] = [];

  @state() private _docType = "Manual";
  @state() private _uploading = false;
  @state() private _error: string | null = null;
  @query("input[type=file]") private _fileInput!: HTMLInputElement;

  static styles = [
    formStyles,
    css`
      ul {
        list-style: none;
        margin: 0;
        padding: 0;
      }
      li {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 10px 0;
        border-bottom: 1px solid var(--divider-color, #e0e0e0);
      }
      li:last-child {
        border-bottom: none;
      }
      li a {
        color: var(--primary-text-color, #212121);
        text-decoration: none;
        font-weight: 500;
      }
      li a:hover {
        text-decoration: underline;
      }
      .delete-btn {
        background: none;
        border: none;
        cursor: pointer;
        color: var(--secondary-text-color, #727272);
      }
      select {
        width: auto;
      }
    `,
  ];

  private async _handleFile(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    this._uploading = true;
    this._error = null;
    try {
      await cacheApi.uploadDocument(this.hass, this.firearmId, this._docType, files[0]);
    } catch (err) {
      this._error = err instanceof Error ? err.message : "Upload failed";
    } finally {
      this._uploading = false;
      if (this._fileInput) this._fileInput.value = "";
    }
  }

  private _close(): void {
    this.dispatchEvent(new CustomEvent("cache-dialog-closed"));
  }

  render() {
    return html`
      <cache-dialog .open=${this.open} heading="Manage Documents" width="480px" @cache-dialog-closed=${this._close}>
        ${this._error ? html`<div class="error-banner">${this._error}</div>` : ""}
        ${this.documents.length === 0
          ? html`<p class="muted">
              No documents yet. Upload manuals, receipts, warranty info, or tax stamp PDFs below.
            </p>`
          : html`
              <ul>
                ${this.documents.map(
                  (doc) => html`
                    <li>
                      <div>
                        <a href=${doc.url} target="_blank" rel="noreferrer">${doc.originalFilename ?? doc.filename}</a>
                        <div class="small muted">${doc.documentType} · Uploaded ${formatDate(doc.uploadedAt)}</div>
                      </div>
                      <button class="delete-btn" @click=${() => cacheApi.deleteDocument(this.hass, doc.id)}>
                        <ha-icon icon="mdi:delete"></ha-icon>
                      </button>
                    </li>
                  `
                )}
              </ul>
            `}
        <div class="actions" style="justify-content:space-between;align-items:center">
          <div style="display:flex;gap:8px;align-items:center">
            <select .value=${this._docType} @change=${(e: Event) => (this._docType = (e.target as HTMLSelectElement).value)}>
              ${DOCUMENT_TYPES.map((t) => html`<option value=${t} ?selected=${t === this._docType}>${t}</option>`)}
            </select>
            <label class="link" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer">
              <ha-icon icon="mdi:file-upload"></ha-icon> ${this._uploading ? "Uploading..." : "Upload"}
              <input
                type="file"
                style="display:none"
                ?disabled=${this._uploading}
                @change=${(e: Event) => this._handleFile((e.target as HTMLInputElement).files)}
              />
            </label>
          </div>
          <button class="secondary" @click=${this._close}>Done</button>
        </div>
      </cache-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "document-manager-dialog": DocumentManagerDialog;
  }
}
