import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { garageApi } from "../ha-api";
import type { GarageState, WheelPosition } from "../types";
import { money, mileage, shortDate } from "../format";
import { glassCardStyle, formStyles, pageStyles } from "../styles";
import "../components/maintenance-dialog";
import "../components/log-all-maintenance-dialog";

const WHEEL_LABELS: Record<WheelPosition, string> = {
  front_left: "FL",
  front_right: "FR",
  rear_left: "RL",
  rear_right: "RR",
};

function wheelLabel(position: WheelPosition): string {
  return WHEEL_LABELS[position] ?? position;
}

@customElement("garage-maintenance-view")
export class GarageMaintenanceView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) garageState!: GarageState;

  @state() private _maintenanceDialogOpen = false;
  @state() private _logAllDialogOpen = false;
  @state() private _showTemplates = false;
  @state() private _newTemplateName = "";
  @state() private _newTemplateBasis = "mileage";
  @state() private _newTemplateMiles = "";
  @state() private _newTemplateMonths = "";

  static styles = [glassCardStyle, formStyles, pageStyles, css`
    section h2 { display: flex; justify-content: space-between; align-items: center; }
    ha-card { padding: 4px 22px; }
    .due-card { padding: 18px 22px; }
    .due-row { display: flex; align-items: center; gap: 14px; padding: 14px 0; border-bottom: 1px solid var(--garage-border); }
    .due-row:last-child { border: 0; }
    .due-info { flex: 1; min-width: 0; }
    .due-info strong { display: block; font-size: .85rem; font-weight: 550; }
    .due-info .sub { margin-top: 4px; }
    .record-info { display: flex; align-items: center; gap: 14px; }
    .record-info > div { min-width: 0; }
    .record-title { font-size: .85rem; font-weight: 550; }
    .template-add { padding: 22px; margin-top: 16px; }
    .template-add h3 { margin: 0; font-size: .9rem; }
    .template-add .actions { padding-top: 18px; margin-top: 18px; border-top: 1px solid var(--garage-border); }
    .summary-grid .value { font-size: 1.6rem; }
    @media (max-width: 600px) { ha-card { padding-left: 16px; padding-right: 16px; } .due-row { flex-wrap: wrap; } .due-row .pill { margin-left: 54px; } .record-info { align-items: flex-start; } }
  `];

  private async _addTemplate(): Promise<void> {
    if (!this._newTemplateName.trim()) return;
    await garageApi.addMaintenanceTemplate(this.hass, {
      name: this._newTemplateName.trim(),
      basis: this._newTemplateBasis,
      interval_miles: this._newTemplateMiles ? Number(this._newTemplateMiles) : null,
      interval_months: this._newTemplateMonths ? Number(this._newTemplateMonths) : null,
    });
    this._newTemplateName = "";
    this._newTemplateMiles = "";
    this._newTemplateMonths = "";
  }

  render() {
    const s = this.garageState;
    const dueVehicles = s.vehicles.filter((v) => v.maintenanceDueCount > 0 || v.maintenanceDueSoonCount > 0);
    const records = [...s.maintenanceRecords].sort((a, b) => b.date.localeCompare(a.date));
    const vehicle = (id: string) => s.vehicles.find((v) => v.vehicleId === id);

    return html`
      <div class="summary-grid">
        <ha-card><div class="kpi-top"><span class="label">Service due</span><ha-icon aria-hidden="true" icon="mdi:wrench-outline"></ha-icon></div><div class="value">${s.vehicles.reduce((n, v) => n + v.maintenanceDueCount, 0)}</div><div class="kpi-foot">Items needing service</div></ha-card>
        <ha-card><div class="kpi-top"><span class="label">Due soon</span><ha-icon aria-hidden="true" icon="mdi:calendar-clock-outline"></ha-icon></div><div class="value">${s.vehicles.reduce((n, v) => n + v.maintenanceDueSoonCount, 0)}</div><div class="kpi-foot">Upcoming service items</div></ha-card>
        <ha-card><div class="kpi-top"><span class="label">This month</span><ha-icon aria-hidden="true" icon="mdi:cash-multiple"></ha-icon></div><div class="value">${money(s.totalMonthlyMaintenanceSpend)}</div><div class="kpi-foot">Recorded maintenance spending</div></ha-card>
      </div>
      <section>
        <h2>
          Service schedule
          <span>
            <button
              class="link secondary-link"
              @click=${() => (this._logAllDialogOpen = true)}
            >
              Log All Maintenance
            </button>
            <button class="link" @click=${() => (this._maintenanceDialogOpen = true)}>
              Log Completed Maintenance
            </button>
          </span>
        </h2>
        <ha-card class="due-card">
          ${dueVehicles.length === 0
            ? html`<div class="empty"><ha-icon aria-hidden="true" icon="mdi:check-circle-outline"></ha-icon><strong>No service items due.</strong>Your recorded maintenance is up to date.</div>`
            : dueVehicles.map(
                (v) => html`
                  <div class="due-row">
                    <span class="icon-tile"><ha-icon aria-hidden="true" icon="mdi:wrench-outline"></ha-icon></span>
                    <div class="due-info"><strong>${v.nickname}</strong><div class="sub">${v.nextMaintenanceDue?.name ?? "Upcoming maintenance"} · ${v.maintenanceDueCount} due · ${v.maintenanceDueSoonCount} due soon</div></div>
                    <span class="pill ${v.maintenanceDueCount ? "bad" : "warn"}">${v.maintenanceDueCount ? "Service due" : "Due soon"}</span>
                  </div>
                `
              )}
        </ha-card>
      </section>

      <section>
        <h2>Service history <span class="pill">${records.length} records</span></h2>
        <ha-card>
          ${records.length === 0
            ? html`<div class="empty">No maintenance recorded yet.</div>`
            : records.map(
                (r) => html`
                  <div class="row">
                    <div>
                      <div class="record-title">${r.name}</div><div class="sub">${vehicle(r.vehicleId)?.nickname ?? "Unknown vehicle"}</div>
                      <div class="sub">
                        ${shortDate(r.date)} - ${mileage(r.odometer)} - ${r.performedBy}
                        ${r.shopName ? ` (${r.shopName})` : ""}
                        ${r.wheelPositions.length > 0
                          ? ` - Wheels: ${r.wheelPositions.map(wheelLabel).join(", ")}`
                          : ""}
                      </div>
                    </div>
                    <div style="display:flex; align-items:center; gap:10px;" class="mono">
                      <span>${money(r.cost)}</span>
                      <button aria-label="Delete"
                        class="icon"
                        @click=${() => garageApi.deleteMaintenanceRecord(this.hass, r.id)}
                      >
                        <ha-icon icon="mdi:delete"></ha-icon>
                      </button>
                    </div>
                  </div>
                `
              )}
        </ha-card>
      </section>

      <section>
        <h2>
          <span>Service templates <span class="pill">${s.maintenanceTemplates.length}</span></span>
          <button class="link secondary-link" @click=${() => (this._showTemplates = !this._showTemplates)}>
            ${this._showTemplates ? "Hide" : "Manage"}
          </button>
        </h2>
        ${this._showTemplates
          ? html`
              <ha-card>
                ${s.maintenanceTemplates.map(
                  (t) => html`
                    <div class="row">
                      <div>
                        ${t.name}
                        <div class="sub">
                          ${t.basis}
                          ${t.intervalMiles ? ` - every ${t.intervalMiles.toLocaleString()} mi` : ""}
                          ${t.intervalMonths ? ` - every ${t.intervalMonths} mo` : ""}
                        </div>
                      </div>
                      ${t.isCustom
                        ? html`
                            <button aria-label="Delete"
                              class="icon"
                              @click=${() => garageApi.deleteMaintenanceTemplate(this.hass, t.id)}
                            >
                              <ha-icon icon="mdi:delete"></ha-icon>
                            </button>
                          `
                        : ""}
                    </div>
                  `
                )}
              </ha-card>
              <ha-card class="template-add"><h3>Create a service template</h3><p class="sub">Set a repeat interval for a custom maintenance item.</p>
                <label for="new-template-name">New Template Name</label>
                <input id="new-template-name"
                  type="text"
                  .value=${this._newTemplateName}
                  @input=${(e: InputEvent) => (this._newTemplateName = (e.target as HTMLInputElement).value)}
                />
                <div class="form-row" style="border:none; padding-top:8px;">
                  <div style="flex:1">
                    <label for="basis">Basis</label>
                    <select id="basis"
                      .value=${this._newTemplateBasis}
                      @change=${(e: Event) => (this._newTemplateBasis = (e.target as HTMLSelectElement).value)}
                    >
                      <option value="mileage">Mileage</option>
                      <option value="time">Time</option>
                      <option value="both">Both</option>
                    </select>
                  </div>
                  <div style="flex:1">
                    <label for="interval-miles">Interval Miles</label>
                    <input id="interval-miles"
                      type="number"
                      .value=${this._newTemplateMiles}
                      @input=${(e: InputEvent) => (this._newTemplateMiles = (e.target as HTMLInputElement).value)}
                    />
                  </div>
                  <div style="flex:1">
                    <label for="interval-months">Interval Months</label>
                    <input id="interval-months"
                      type="number"
                      .value=${this._newTemplateMonths}
                      @input=${(e: InputEvent) => (this._newTemplateMonths = (e.target as HTMLInputElement).value)}
                    />
                  </div>
                </div>
                <div class="actions">
                  <button class="primary" @click=${this._addTemplate}>Add Template</button>
                </div>
              </ha-card>
            `
          : ""}
      </section>

      <garage-maintenance-dialog
        .hass=${this.hass}
        .open=${this._maintenanceDialogOpen}
        .vehicles=${s.vehicles}
        .templates=${s.maintenanceTemplates}
        @maintenance-dialog-closed=${() => (this._maintenanceDialogOpen = false)}
      ></garage-maintenance-dialog>

      <garage-log-all-maintenance-dialog
        .hass=${this.hass}
        .open=${this._logAllDialogOpen}
        .vehicles=${s.vehicles}
        .templates=${s.maintenanceTemplates}
        @log-all-maintenance-dialog-closed=${() => (this._logAllDialogOpen = false)}
      ></garage-log-all-maintenance-dialog>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "garage-maintenance-view": GarageMaintenanceView;
  }
}
