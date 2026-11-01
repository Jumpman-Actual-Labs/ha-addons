import { LitElement, css, html } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { LiveSensorStatus, TirePosition, Vehicle } from "../types";
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

const TIRES: Array<[TirePosition, string]> = [
  ["fl", "Front left"],
  ["fr", "Front right"],
  ["rl", "Rear left"],
  ["rr", "Rear right"],
];

/** Saved vehicle values, including readings collected from linked HA sensors.
 * A configured sensor does not imply the retained value is currently fresh.
 * A fill-up the fuel sensor saw but nobody logged shows as a prompt; its
 * buttons fire `fill-log` / `fill-dismiss` (detail: the vehicle) for the
 * view to open the fuel form or dismiss it. */
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
    .fill-prompt { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 12px 14px; margin-bottom: 12px; border: 1px solid var(--garage-accent); border-radius: 12px; background: color-mix(in srgb, var(--garage-accent) 10%, transparent); font-size: .8rem; }
    .fill-prompt ha-icon { color: var(--garage-accent); --mdc-icon-size: 20px; }
    .fill-prompt span { flex: 1 1 180px; line-height: 1.5; }
    .fill-prompt strong { display: block; }
    .fill-prompt .buttons { display: flex; gap: 8px; }
    .extras { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 230px), 1fr)); gap: 12px; margin-top: 12px; }
    .extra { padding: 14px 16px; border: 1px solid var(--garage-border); border-radius: 12px; background: var(--garage-inset); min-width: 0; }
    .tires { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 14px; margin-top: 10px; font-size: .78rem; }
    .tires span { display: flex; justify-content: space-between; color: var(--garage-muted); }
    .tires strong { color: var(--garage-text); font-variant-numeric: tabular-nums; font-weight: 550; }
    .tires .bad strong { color: var(--garage-warning); }
    .alerts { margin: 10px 0 0; padding: 0; list-style: none; font-size: .74rem; color: var(--garage-warning); line-height: 1.6; }
    .codes { margin-top: 10px; font-size: .85rem; font-family: var(--garage-mono); overflow-wrap: anywhere; }
    .codes.clear { color: var(--garage-success); font-family: var(--garage-font); }
    .codes.light { color: var(--garage-warning); }
    @media (min-width: 950px) { :host([wide]) .readings { grid-template-columns: 1.25fr 1fr 1fr; } :host([wide]) .fuel { grid-column: auto; border-bottom: 0; border-right: 1px solid var(--garage-border); } }
    @media (max-width: 360px) { .reading { padding: 14px; } .value { font-size: 1.4rem; } }
  `];

  private _emit(name: string): void {
    this.dispatchEvent(new CustomEvent(name, { detail: this.vehicle, bubbles: true, composed: true }));
  }

  render() {
    const v = this.vehicle;
    if (!v) return html``;
    const fuel = v.currentFuelPct !== null && Number.isFinite(v.currentFuelPct)
      ? Math.min(1, Math.max(0, v.currentFuelPct)) : null;
    const low = fuel !== null && fuel <= this.lowFuelThreshold;
    const range = v.estimatedRangeMiles;
    const fuelSource = sourceLine(v.fuelLevelEntityId, v.liveSensors?.fuel);
    const odometerSource = sourceLine(v.odometerEntityId, v.liveSensors?.odometer);
    const fill = v.pendingFillUp;
    const lowTires = new Set(v.tireAlerts.filter((a) => a.kind !== "uneven").map((a) => a.key.slice(-2)));
    const hasTires = Object.keys(v.tireEntityIds).length > 0;
    return html`
      ${fill ? html`<div class="fill-prompt" role="status">
        <ha-icon aria-hidden="true" icon="mdi:gas-station"></ha-icon>
        <span><strong>Fill-up detected</strong>${fill.gallons_added != null ? `About ${fill.gallons_added} gal` : "Fuel went up"} around ${Math.round(fill.fill_odometer).toLocaleString()} mi. Log it to keep MPG and spending right.</span>
        <div class="buttons">
          <button class="secondary" @click=${() => this._emit("fill-dismiss")}>Dismiss</button>
          <button class="primary" @click=${() => this._emit("fill-log")}>Log it</button>
        </div>
      </div>` : ""}
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
      ${hasTires || v.troubleCodesEntityId ? html`<div class="extras">
        ${hasTires ? html`<div class="extra">
          <div class="label"><ha-icon aria-hidden="true" icon="mdi:tire"></ha-icon>Tire pressure${v.tireTargetPsi ? ` · target ${v.tireTargetPsi} psi` : ""}</div>
          <div class="tires">${TIRES.map(([position, label]) => html`<span class=${lowTires.has(position) ? "bad" : ""}>${label}<strong>${v.tirePressures[position] != null ? `${v.tirePressures[position]} psi` : "—"}</strong></span>`)}</div>
          ${v.tireAlerts.length ? html`<ul class="alerts">${v.tireAlerts.map((a) => html`<li>${a.message}</li>`)}</ul>` : ""}
        </div>` : ""}
        ${v.troubleCodesEntityId ? html`<div class="extra">
          <div class="label"><ha-icon aria-hidden="true" icon="mdi:engine-outline"></ha-icon>Trouble codes</div>
          ${v.troubleCodes.length
            ? html`<div class="codes ${v.checkEngineLight ? "light" : ""}">${v.troubleCodes.join("  ")}</div>
                <span class="source">${v.checkEngineLight ? "Check engine light is on" : "Stored or pending · light off"}</span>`
            : html`<div class="codes clear">All clear</div>`}
        </div>` : ""}
      </div>` : ""}
      <div class="economy"><span>Average economy</span><strong>${v.averageMpg !== null ? `${v.averageMpg.toFixed(1)} MPG` : "Not enough fuel history"}</strong></div>
    `;
  }
}

declare global { interface HTMLElementTagNameMap { "garage-vehicle-readings": GarageVehicleReadings; } }
