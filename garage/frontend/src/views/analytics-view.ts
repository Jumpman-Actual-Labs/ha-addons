import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import type { GarageState, Vehicle } from "../types";
import { money } from "../format";
import { glassCardStyle, pageStyles } from "../styles";
import { paletteColor } from "../colors";

@customElement("garage-analytics-view")
export class GarageAnalyticsView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) garageState!: GarageState;

  static styles = [glassCardStyle, pageStyles, css`
    .chart-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px; margin-bottom: 28px; align-items: start; }
    .chart { padding: 22px; }
    .chart .panel-head { margin-bottom: 28px; }
    .chart .panel-head ha-icon { color: var(--garage-accent); }
    .comparison-grid ha-card { padding: 22px; }
    .vehicle-head { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; }
    .vehicle-head strong { font-size: .95rem; font-weight: 550; }
    .vehicle-head small { display: block; color: var(--garage-muted); font-size: .72rem; margin-top: 3px; }
    .method { margin-top: 18px; color: var(--garage-muted); font-size: .73rem; }
    @media (max-width: 1000px) { .chart-grid { grid-template-columns: 1fr; } }
  `];

  private _renderBarChart(rows: { label: string; value: number }[], format: (n: number) => string, fixedMax?: number) {
    const max = fixedMax ?? Math.max(1, ...rows.map((r) => r.value));
    return html`
      ${rows.map(
        (r, i) => html`
          <div class="bar-row">
            <div class="bar-label">${r.label}</div>
            <div class="bar-track">
              <div
                class="bar-fill"
                style="width:${(r.value / max) * 100}%; background:${paletteColor(i)};"
              ></div>
            </div>
            <div class="bar-value">${format(r.value)}</div>
          </div>
        `
      )}
    `;
  }

  render() {
    const s = this.garageState;
    if (s.vehicles.length === 0) {
      return html`<ha-card><div class="empty"><ha-icon aria-hidden="true" icon="mdi:chart-box-outline"></ha-icon><strong>A clearer picture of your running costs.</strong>Add a vehicle and record fuel or service to start your analysis.</div></ha-card>`;
    }

    const fuelCostRows = s.vehicles.map((v) => ({ label: v.nickname, value: v.lifetimeFuelCost }));
    const maintenanceCostRows = s.vehicles.map((v) => ({
      label: v.nickname,
      value: v.lifetimeMaintenanceCost,
    }));
    const mpgRows = s.vehicles
      .filter((v) => v.averageMpg !== null)
      .map((v) => ({ label: v.nickname, value: v.averageMpg as number }));

    const lifetimeTotal = s.vehicles.reduce(
      (sum, v) => sum + v.lifetimeFuelCost + v.lifetimeMaintenanceCost,
      0
    );

    return html`
      <div class="summary-grid">
        <ha-card><div class="kpi-top"><span class="label">Lifetime operating cost</span><ha-icon aria-hidden="true" icon="mdi:chart-donut"></ha-icon></div><div class="value">${money(lifetimeTotal)}</div><div class="kpi-foot">Fuel and maintenance combined</div></ha-card>
        <ha-card><div class="kpi-top"><span class="label">Lifetime fuel</span><ha-icon aria-hidden="true" icon="mdi:gas-station-outline"></ha-icon></div><div class="value">${money(fuelCostRows.reduce((n, r) => n + r.value, 0))}</div><div class="kpi-foot">All recorded fill-ups</div></ha-card>
        <ha-card><div class="kpi-top"><span class="label">Lifetime service</span><ha-icon aria-hidden="true" icon="mdi:wrench-outline"></ha-icon></div><div class="value">${money(maintenanceCostRows.reduce((n, r) => n + r.value, 0))}</div><div class="kpi-foot">All recorded maintenance</div></ha-card>
      </div>
      <div class="chart-grid">
        <ha-card class="chart"><div class="panel-head"><div><h2>Fuel cost by vehicle</h2><p>Lifetime spending · USD</p></div><ha-icon aria-hidden="true" icon="mdi:gas-station-outline"></ha-icon></div>${this._renderBarChart(fuelCostRows, money)}</ha-card>
        <ha-card class="chart"><div class="panel-head"><div><h2>Maintenance cost by vehicle</h2><p>Lifetime spending · USD</p></div><ha-icon aria-hidden="true" icon="mdi:wrench-outline"></ha-icon></div>${this._renderBarChart(maintenanceCostRows, money)}</ha-card>
        <ha-card class="chart"><div class="panel-head"><div><h2>Fuel economy</h2><p>Average miles per gallon</p></div><ha-icon aria-hidden="true" icon="mdi:speedometer"></ha-icon></div>${mpgRows.length ? this._renderBarChart(mpgRows, n => n.toFixed(1)) : html`<div class="sub">Record enough fill-ups to calculate fuel economy.</div>`}</ha-card>
        <ha-card class="chart"><div class="panel-head"><div><h2>Vehicle health</h2><p>Current health score · out of 100</p></div><ha-icon aria-hidden="true" icon="mdi:heart-pulse"></ha-icon></div>${this._renderBarChart(s.vehicles.map(v => ({ label: v.nickname, value: v.healthScore })), n => n.toString(), 100)}</ha-card>
      </div>
      <section>
        <div class="section-head"><div><h2>Vehicle comparison</h2><p>The numbers behind every vehicle.</p></div><span class="pill">${s.vehicles.length} vehicles</span></div>
        <div class="comparison-grid">${s.vehicles.map((v: Vehicle) => html`
          <ha-card>
            <div class="vehicle-head"><span class="icon-tile"><ha-icon aria-hidden="true" icon="mdi:car-outline"></ha-icon></span><div><strong>${v.nickname}</strong><small>${v.year} ${v.make} ${v.model}</small></div></div>
            <div class="stat"><span>Cost / odometer mile</span><span>${v.currentMileage > 0 ? money((v.lifetimeFuelCost + v.lifetimeMaintenanceCost) / v.currentMileage) : "—"}</span></div>
            <div class="stat"><span>Average MPG</span><span>${v.averageMpg?.toFixed(1) ?? "—"}</span></div>
            <div class="stat"><span>Average price / gallon</span><span>${v.averagePricePerGallon !== null ? money(v.averagePricePerGallon) : "—"}</span></div>
            <div class="stat"><span>Health score</span><span>${v.healthScore} / 100</span></div>
          </ha-card>`)}</div>
        <p class="method">Cost per odometer mile uses recorded fuel and maintenance costs divided by the current odometer. It does not represent the cost of miles driven during your ownership.</p>
      </section>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "garage-analytics-view": GarageAnalyticsView;
  }
}
