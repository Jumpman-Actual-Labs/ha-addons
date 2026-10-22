import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { garageApi } from "../ha-api";
import type { GarageState } from "../types";
import { shortDate } from "../format";
import { glassCardStyle, pageStyles } from "../styles";
import "../components/document-upload-dialog";

@customElement("garage-documents-view")
export class GarageDocumentsView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) garageState!: GarageState;

  @property({ type: String }) vehicleId = "";
  @state() private _uploadDialogOpen = false;
  @state() private _vehicleFilter = "";

  static styles = [glassCardStyle, pageStyles, css`
    .filter { display: flex; align-items: center; gap: 12px; }
    .filter label { color: var(--garage-muted); font-size: .76rem; }
    .document-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr)); gap: 16px; }
    .document { padding: 22px; }
    .document-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 26px; }
    .document-top .icon-tile { width: 48px; height: 48px; border-radius: 12px; }
    .filename { display: block; font-size: .9rem; color: var(--garage-text); margin-bottom: 7px; }
    .filename:hover { color: var(--garage-accent); }
    .document footer { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--garage-border); display: flex; justify-content: space-between; align-items: center; color: var(--garage-muted); font-size: .68rem; }
    footer a { display: flex; align-items: center; gap: 5px; }
    @media (max-width: 600px) { .filter { width: 100%; } .filter select { flex: 1; } }
  `];

  render() {
    const s = this.garageState;
    const documents = s.documents.filter(
      (d) => !(this.vehicleId || this._vehicleFilter) || d.vehicleId === (this.vehicleId || this._vehicleFilter)
    );
    const vehicle = (id: string) => s.vehicles.find((v) => v.vehicleId === id);

    return html`
      <div class="header-row">
        ${this.vehicleId ? "" : html`<div class="filter"><label for="document-vehicle">Vehicle</label><select id="document-vehicle" aria-label="Filter by vehicle" .value=${this._vehicleFilter} @change=${(e: Event) => (this._vehicleFilter = (e.target as HTMLSelectElement).value)}>
          <option value="">All Vehicles</option>${s.vehicles.map(v => html`<option value=${v.vehicleId}>${v.nickname}</option>`)}
        </select></div>`}
        <button class="link" @click=${() => (this._uploadDialogOpen = true)}><ha-icon aria-hidden="true" icon="mdi:upload"></ha-icon>Upload Document</button>
      </div>
      <div class="section-head"><div><h2>Document vault</h2><p>Important records, organized by vehicle.</p></div><span class="pill">${documents.length} files</span></div>
      ${documents.length ? html`<div class="document-grid">${documents.map(d => html`
        <ha-card class="document">
          <div class="document-top"><span class="icon-tile"><ha-icon aria-hidden="true" icon=${d.category === "insurance" ? "mdi:shield-check-outline" : d.category === "registration" ? "mdi:card-account-details-outline" : d.category === "photo" ? "mdi:image-outline" : "mdi:file-document-outline"}></ha-icon></span><button class="icon danger" aria-label=${`Delete ${vehicle(d.vehicleId)?.nickname ?? "Unknown vehicle"}`} @click=${() => garageApi.deleteDocument(this.hass, d.id)}><ha-icon aria-hidden="true" icon="mdi:trash-can-outline"></ha-icon></button></div>
          <a class="filename" href=${d.path} target="_blank" rel="noopener">${vehicle(d.vehicleId)?.nickname ?? "Unknown vehicle"}</a>
          <div class="sub">${vehicle(d.vehicleId)?.year ?? ""} ${vehicle(d.vehicleId)?.make ?? ""} ${vehicle(d.vehicleId)?.model ?? ""}</div>
          <span class="pill" style="margin-top:12px">${d.category[0].toUpperCase() + d.category.slice(1)}</span>
          <footer><span>${shortDate(d.uploadedAt)}</span><a href=${d.path} target="_blank" rel="noopener" aria-label=${`Open ${d.category} for ${vehicle(d.vehicleId)?.nickname ?? "Unknown vehicle"} in a new tab`}>Open file<ha-icon aria-hidden="true" icon="mdi:arrow-top-right"></ha-icon></a></footer>
        </ha-card>`)}</div>` : html`<ha-card><div class="empty"><ha-icon aria-hidden="true" icon="mdi:folder-open-outline"></ha-icon><strong>Your records belong here.</strong>Upload registration, insurance, receipts and photos.</div></ha-card>`}
      <garage-document-upload-dialog
        .hass=${this.hass}
        .open=${this._uploadDialogOpen}
        .vehicles=${s.vehicles}
        .vehicleId=${this.vehicleId || this._vehicleFilter}
        @document-upload-dialog-closed=${() => (this._uploadDialogOpen = false)}
      ></garage-document-upload-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "garage-documents-view": GarageDocumentsView;
  }
}
