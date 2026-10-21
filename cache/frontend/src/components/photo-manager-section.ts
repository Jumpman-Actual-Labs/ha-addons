import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { cacheApi } from "../ha-api";
import type { Photo } from "../types";
import { formStyles } from "../styles";
import "./image-source-button";

/** A live, network-backed photo grid (add/delete/set-primary) for an
 * EXISTING firearm or inventory item - embedded directly inside Edit
 * Firearm/Edit Item's own `cache-dialog`, not a dialog of its own. Used
 * to be `photo-manager-dialog.ts`, its own separate "Manage Photos"
 * button/dialog; folded into the edit form instead so photo management
 * has one home instead of two. Requires a real, already-persisted
 * `entityId` - a brand-new record being created in the Add form (no id
 * yet) uses a different, local-only staging flow instead (see firearms-
 * view.ts's `_addPhotoFiles`/`_addBuildImageFile`), since photos can only
 * be uploaded against a record that already exists. */
@customElement("photo-manager-section")
export class PhotoManagerSection extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ type: String }) entityType: "firearm" | "inventory_item" = "firearm";
  @property({ type: String }) entityId = "";
  @property({ attribute: false }) photos: Photo[] = [];

  @state() private _uploading = false;
  @state() private _error: string | null = null;

  static styles = [
    formStyles,
    css`
      .grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 10px;
      }
      .photo {
        position: relative;
        aspect-ratio: 1;
        border-radius: 10px;
        overflow: hidden;
        background: var(--secondary-background-color, #eee);
      }
      .photo img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      .photo .overlay {
        position: absolute;
        inset: auto 0 0 0;
        display: flex;
        justify-content: flex-end;
        gap: 2px;
        padding: 6px;
        background: linear-gradient(to top, rgba(0, 0, 0, 0.6), transparent);
      }
      .photo .overlay button {
        background: none;
        border: none;
        color: #fff;
        cursor: pointer;
      }
      .photo.primary {
        outline: 2px solid var(--primary-color, #03a9f4);
      }
      .processing-note {
        font-size: 0.8rem;
        color: var(--secondary-text-color, #727272);
        margin: 0 0 12px;
      }
    `,
  ];

  private async _handleFiles(files: File[]): Promise<void> {
    if (files.length === 0) return;
    this._uploading = true;
    this._error = null;
    try {
      for (const file of files) {
        await cacheApi.uploadPhoto(this.hass, this.entityType, this.entityId, file);
      }
    } catch (err) {
      this._error = err instanceof Error ? err.message : "Upload failed";
    } finally {
      this._uploading = false;
    }
  }

  render() {
    return html`
      ${this._error ? html`<div class="error-banner">${this._error}</div>` : ""}
      ${this._uploading
        ? html`<p class="processing-note">Removing background - this can take a few seconds per photo…</p>`
        : ""}
      ${this.photos.length === 0
        ? html`<p class="muted">No photos yet. Add some below.</p>`
        : html`
            <div class="grid">
              ${this.photos.map(
                (photo) => html`
                  <div class="photo ${photo.isPrimary ? "primary" : ""}">
                    <img src=${photo.url} alt=${photo.originalFilename ?? "Photo"} />
                    <div class="overlay">
                      ${this.entityType === "firearm"
                        ? html`
                            <button
                              @click=${() => cacheApi.setPrimaryPhoto(this.hass, photo.id)}
                              title=${photo.isPrimary ? "Primary photo" : "Set as primary"}
                            >
                              <ha-icon icon=${photo.isPrimary ? "mdi:star" : "mdi:star-outline"}></ha-icon>
                            </button>
                          `
                        : ""}
                      <button @click=${() => cacheApi.deletePhoto(this.hass, photo.id)} title="Delete">
                        <ha-icon icon="mdi:delete"></ha-icon>
                      </button>
                    </div>
                  </div>
                `
              )}
            </div>
          `}
      <cache-image-source-button
        label="Add Photos"
        .busyLabel=${"Removing background…"}
        icon="mdi:image-plus"
        multiple
        ?disabled=${this._uploading}
        @cache-image-selected=${(e: CustomEvent<{ files: File[] }>) => this._handleFiles(e.detail.files)}
        @cache-image-error=${(e: CustomEvent<{ message: string }>) => (this._error = e.detail.message)}
      ></cache-image-source-button>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "photo-manager-section": PhotoManagerSection;
  }
}
