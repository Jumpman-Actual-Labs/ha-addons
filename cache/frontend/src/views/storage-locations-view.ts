import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { cacheApi } from "../ha-api";
import type { CacheState, StorageLocation } from "../types";
import { glassCardStyle, formStyles } from "../styles";
import "../components/cache-dialog";

@customElement("cache-storage-locations-view")
export class CacheStorageLocationsView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) cacheState!: CacheState;

  @state() private _formOpen = false;
  @state() private _editing: StorageLocation | null = null;
  @state() private _name = "";
  @state() private _description = "";
  @state() private _error: string | null = null;
  @state() private _deleteTarget: StorageLocation | null = null;
  @state() private _viewTarget: StorageLocation | null = null;

  static styles = [
    glassCardStyle,
    formStyles,
    css`
      ha-card.location {
        padding: 16px;
        cursor: pointer;
      }
      .location-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 8px;
      }
      .location-name {
        font-weight: 600;
        font-size: 1.05rem;
      }
      .location-actions {
        display: flex;
        gap: 4px;
      }
      .location-actions button {
        background: none;
        border: none;
        cursor: pointer;
        color: var(--secondary-text-color, #727272);
      }
      .contents-row {
        display: flex;
        align-items: center;
        gap: 10px;
        padding: 8px 0;
        border-bottom: 1px solid var(--divider-color, #e0e0e0);
        cursor: pointer;
      }
      .contents-row:last-child {
        border-bottom: none;
      }
      .contents-row ha-icon {
        color: var(--secondary-text-color, #727272);
      }
    `,
  ];

  private _openAdd(): void {
    this._editing = null;
    this._name = "";
    this._description = "";
    this._error = null;
    this._formOpen = true;
  }

  private _openEdit(loc: StorageLocation): void {
    this._editing = loc;
    this._name = loc.name;
    this._description = loc.description ?? "";
    this._error = null;
    this._formOpen = true;
  }

  private async _save(): Promise<void> {
    this._error = null;
    try {
      if (this._editing) {
        await cacheApi.updateStorageLocation(this.hass, this._editing.id, {
          name: this._name,
          description: this._description || "",
        });
      } else {
        await cacheApi.addStorageLocation(this.hass, this._name, this._description || undefined);
      }
      this._formOpen = false;
    } catch (err) {
      this._error = err instanceof Error ? err.message : "Failed to save location";
    }
  }

  private async _confirmDelete(): Promise<void> {
    if (!this._deleteTarget) return;
    await cacheApi.deleteStorageLocation(this.hass, this._deleteTarget.id);
    this._deleteTarget = null;
  }

  private _openFirearm(firearmId: string): void {
    this._viewTarget = null;
    this.dispatchEvent(
      new CustomEvent("cache-open-firearm", { detail: { firearmId }, bubbles: true, composed: true })
    );
  }

  private _viewItem(itemId: string): void {
    this._viewTarget = null;
    this.dispatchEvent(
      new CustomEvent("cache-view-item", { detail: { itemId }, bubbles: true, composed: true })
    );
  }

  render() {
    const locations = this.cacheState.storageLocations;
    return html`
      <div class="toolbar">
        <h1 style="margin:0;font-size:1.4rem;font-weight:600">Storage Locations</h1>
        <button class="primary" @click=${this._openAdd}>+ Add Location</button>
      </div>

      ${locations.length === 0
        ? html`<div class="empty">
            No storage locations yet. Create locations like "Main Safe" or "Range Bag" to track
            where your firearms and gear live.
          </div>`
        : html`
            <div class="grid">
              ${locations.map(
                (loc) => html`
                  <ha-card class="location" @click=${() => (this._viewTarget = loc)}>
                    <div class="location-header">
                      <div>
                        <div class="location-name">${loc.name}</div>
                        ${loc.description ? html`<div class="small muted">${loc.description}</div>` : ""}
                        <div class="small muted">
                          ${loc.firearmCount} firearm${loc.firearmCount === 1 ? "" : "s"} ·
                          ${loc.itemCount} item${loc.itemCount === 1 ? "" : "s"}
                        </div>
                      </div>
                      <div class="location-actions">
                        <button @click=${(e: Event) => { e.stopPropagation(); this._openEdit(loc); }} aria-label="Edit">
                          <ha-icon icon="mdi:pencil"></ha-icon>
                        </button>
                        <button @click=${(e: Event) => { e.stopPropagation(); this._deleteTarget = loc; }} aria-label="Delete">
                          <ha-icon icon="mdi:delete"></ha-icon>
                        </button>
                      </div>
                    </div>
                  </ha-card>
                `
              )}
            </div>
          `}

      <cache-dialog
        .open=${!!this._viewTarget}
        .heading=${this._viewTarget?.name ?? ""}
        width="480px"
        @cache-dialog-closed=${() => (this._viewTarget = null)}
      >
        ${this._viewTarget
          ? (() => {
              const firearmsHere = this.cacheState.firearms.filter(
                (f) => f.storageLocationId === this._viewTarget!.id
              );
              const itemsHere = this.cacheState.inventoryItems.filter(
                (i) => i.storageLocationId === this._viewTarget!.id && !i.installedFirearmId
              );
              return html`
                <p class="small muted" style="margin-top:0">
                  Installed parts travel with their firearm and aren't listed separately here.
                </p>
                <p class="small muted" style="text-transform:uppercase;letter-spacing:0.5px">
                  Firearms (${firearmsHere.length})
                </p>
                ${firearmsHere.length === 0
                  ? html`<p class="muted small">None.</p>`
                  : firearmsHere.map(
                      (f) => html`
                        <div class="contents-row" @click=${() => this._openFirearm(f.id)}>
                          <ha-icon icon="mdi:target"></ha-icon>
                          <div>
                            <div style="font-weight:500">${f.customName}</div>
                            <div class="small muted">${f.firearmType}${f.caliber ? ` · ${f.caliber}` : ""}</div>
                          </div>
                        </div>
                      `
                    )}
                <p class="small muted" style="text-transform:uppercase;letter-spacing:0.5px;margin-top:16px">
                  Items (${itemsHere.length})
                </p>
                ${itemsHere.length === 0
                  ? html`<p class="muted small">None.</p>`
                  : itemsHere.map(
                      (i) => html`
                        <div class="contents-row" @click=${() => this._viewItem(i.id)}>
                          <ha-icon icon="mdi:cube-outline"></ha-icon>
                          <div>
                            <div style="font-weight:500">${i.customName}</div>
                            <div class="small muted">${i.partType ?? i.category}</div>
                          </div>
                        </div>
                      `
                    )}
              `;
            })()
          : ""}
        <div class="actions">
          <button class="secondary" @click=${() => (this._viewTarget = null)}>Close</button>
        </div>
      </cache-dialog>

      <cache-dialog
        .open=${this._formOpen}
        .heading=${this._editing ? "Edit Location" : "Add Storage Location"}
        width="420px"
        @cache-dialog-closed=${() => (this._formOpen = false)}
      >
        ${this._error ? html`<div class="error-banner">${this._error}</div>` : ""}
        <label>Name</label>
        <input .value=${this._name} @input=${(e: Event) => (this._name = (e.target as HTMLInputElement).value)} />
        <label>Description</label>
        <textarea
          .value=${this._description}
          @input=${(e: Event) => (this._description = (e.target as HTMLTextAreaElement).value)}
        ></textarea>
        <div class="actions">
          <button class="secondary" @click=${() => (this._formOpen = false)}>Cancel</button>
          <button class="primary" ?disabled=${!this._name} @click=${this._save}>Save</button>
        </div>
      </cache-dialog>

      <cache-dialog
        .open=${!!this._deleteTarget}
        heading="Delete Storage Location"
        width="380px"
        @cache-dialog-closed=${() => (this._deleteTarget = null)}
      >
        <p>
          Delete "${this._deleteTarget?.name}"? Firearms and items stored here will become
          unassigned.
        </p>
        <div class="actions">
          <button class="secondary" @click=${() => (this._deleteTarget = null)}>Cancel</button>
          <button class="secondary danger" @click=${this._confirmDelete}>Delete</button>
        </div>
      </cache-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "cache-storage-locations-view": CacheStorageLocationsView;
  }
}
