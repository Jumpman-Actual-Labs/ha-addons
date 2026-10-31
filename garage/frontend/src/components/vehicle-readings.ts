import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { LiveSensorStatus, Vehicle } from "../types";
import { pct } from "../format";
import { controlStyles } from "../styles";

/** The source line under a reading: where the value came from and, for a
 * linked sensor, what the last poll found - so a link that isn't working
 * says so instead of quietly showing the old saved value. */
function sourceLine(entityId: string, live: LiveSensorStatus | undefined) {
  if (!entityId) return { text: "Saved reading", cls: "" };
  if (!live) return { text: "Sensor linked · waiting for first read", cls: "linked" };
  const reading = live.state != null ? `${live.state}${live.unit ? ` ${live.unit}` : ""}` : "";
  if (live.status === "ok") return { text: `Live · sensor reads ${reading}`, cls: "linked" };
  if (live.status === "parked") {
    return { text: `Parked (sensor reads ${reading}) · updates while driving`, cls: "linked" };
  }
  if (live.status === "unavailable") return { text: "Sensor asleep · showing last reading", cls: "" };
  if (live.status === "missing") return { text: `${entityId} not found in Home Assistant`, cls: "problem" };
  return { text: "Couldn't read the sensor · check the add-on log", cls: "problem" };
}

/** Saved vehicle values, including readings collected from linked HA sensors.
 * A configured sensor does not imply the retained value is currently fresh. */
@customElement("garage-vehicle-readings")
export class GarageVehicleReadings extends LitElement {
  @property({ attribute: false }) vehicle!: Vehicle;
  @property({ type: Number }) lowFuelThreshold = .2;

  static styles = [controlStyles, css`
    :host { display: block; min-width: 0; }
    .readings { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); border: 1px solid var(--garage-border); border-radius: 12px; background: var(--garage-inset); overflow: hidden; }
    .reading { min-width: 0; padding: 18px; }
    .fuel { grid-column: 1 / -1; border-bottom: 1px solid var(--garage-border); }
    .range { border-left: 1px solid var(--garage-border); }
    .label { display: flex; align-items: center; gap: 7px; color: var(--garage-muted); font-size: .75rem; }
    .label ha-icon { --mdc-icon-size: 17px; }
    .fuel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .fuel-head .value { margin: 0; color: var(--garage-accent); font-size: 2.25rem; }
    .value { display: block; font-size: clamp(1.45rem, 2.2vw, 1.9rem); font-weight: 600; line-height: 1.2; letter-spacing: -.06em; font-variant-numeric: tabular-nums; margin: 9px 0 7px; overflow-wrap: anywhere; }
    .unit { font-size: .8rem; letter-spacing: 0; color: var(--garage-muted); font-weight: 400; }
    .source { display: block; color: var(--garage-muted); font-size: .75rem; line-height: 1.5; }
    .source.linked { color: var(--garage-accent); }
    .source.problem { color: var(--garage-warning); }
    progress { display: block; width: 100%; height: 10px; margin: 15px 0 0; border: none; border-radius: 5px; overflow: hidden; appearance: none; accent-color: var(--garage-accent); background: var(--garage-raised); }
    progress::-webkit-progress-bar { background: var(--garage-raised); }
    progress::-webkit-progress-value { background: var(--garage-accent); border-radius: 5px; }
    progress::-moz-progress-bar { background: var(--garage-accent); border-radius: 5px; }
    .fuel.low .value, .low .warning { color: var(--garage-warning); }
    .warning { font-size: .75rem; font-weight: 600; display: inline-flex; align-items: center; gap: 5px; margin-top: 5px; }
    .low progress { accent-color: var(--garage-warning); }
    .low progress::-webkit-progress-value { background: var(--garage-warning); }
    .low progress::-moz-progress-bar { background: var(--garage-warning); }
    .missing { display: block; font-size: .75rem; color: var(--garage-muted); margin-top: 12px; }
    .economy { padding: 12px 2px 0; font-size: .75rem; color: var(--garage-muted); display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
    .economy strong { color: var(--garage-text); font-weight: 500; font-variant-numeric: tabular-nums; }
    @media (min-width: 950px) { :host([wide]) .readings { grid-template-columns: 1.25fr 1fr 1fr; } :host([wide]) .fuel { grid-column: auto; border-bottom: 0; border-right: 1px solid var(--garage-border); } }
    @media (max-width: 360px) { .reading { padding: 14px; } .value { font-size: 1.4rem; } }
  `];

  render() {
    const v = this.vehicle;
    if (!v) return html``;
    const fuel = v.currentFuelPct !== null && Number.isFinite(v.currentFuelPct)
      ? Math.min(1, Math.max(0, v.currentFuelPct)) : null;
    const low = fuel !== null && fuel <= this.lowFuelThreshold;
    const range = v.estimatedRangeMiles;
    const fuelSource = sourceLine(v.fuelLevelEntityId, v.liveSensors?.fuel);
    const odometerSource = sourceLine(v.odometerEntityId, v.liveSensors?.odometer);
    return html`
      <div class="readings">
        <div class="reading fuel ${low ? "low" : ""}">
          <div class="fuel-head"><div><div class="label"><ha-icon aria-hidden="true" icon="mdi:gas-station-outline"></ha-icon>Fuel level</div>
            <span class="source ${fuelSource.cls}">${fuelSource.text}</span></div>
            <strong class="value">${pct(fuel)}</strong></div>
          ${fuel !== null ? html`<progress aria-label=${`${v.nickname} fuel level`} max="1" value=${fuel}></progress>` : html`<span class="missing">No fuel reading yet</span>`}
          ${low ? html`<span class="warning"><ha-icon aria-hidden="true" icon="mdi:alert-circle-outline"></ha-icon>Low fuel</span>` : ""}
        </div>
        <div class="reading odometer"><div class="label"><ha-icon aria-hidden="true" icon="mdi:counter"></ha-icon>Odometer</div>
          <strong class="value">${v.currentMileage.toLocaleString()} <span class="unit">mi</span></strong>
          <span class="source ${odometerSource.cls}">${odometerSource.text}</span></div>
        <div class="reading range"><div class="label"><ha-icon aria-hidden="true" icon="mdi:map-marker-distance"></ha-icon>Estimated range</div>
          <strong class="value">${range !== null ? html`${range.toLocaleString()} <span class="unit">mi</span>` : "—"}</strong>
          <span class="source">${range !== null ? "Based on fuel & economy" : "Range unavailable"}</span></div>
      </div>
      <div class="economy"><span>Average economy</span><strong>${v.averageMpg !== null ? `${v.averageMpg.toFixed(1)} MPG` : "Not enough fuel history"}</strong></div>
    `;
  }
}

declare global { interface HTMLElementTagNameMap { "garage-vehicle-readings": GarageVehicleReadings; } }
