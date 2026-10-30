import { LitElement, css, html, svg } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { Vehicle } from "../types";
import { mileage, pct } from "../format";
import { controlStyles } from "../styles";

export const vehicleSilhouette = () => svg`
  <svg viewBox="0 0 480 200" aria-hidden="true">
    <ellipse cx="240" cy="166" rx="184" ry="8" fill="currentColor" opacity=".07"/>
    <path d="M53 123 77 102 153 92 198 53 296 53 348 96 412 107 428 131 423 152 59 152Z" fill="currentColor" opacity=".1"/>
    <g fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round">
      <path d="M53 123 77 102 153 92 198 53 296 53 348 96 412 107 428 131 423 152 383 152 M331 152 156 152 M101 152 59 152 53 123Z"/>
      <path d="m170 94 36-32h78l42 34-156-2Z M246 62v34 M246 101v43 M169 102v42 M338 105l-3 35 M61 123l40-4 M391 117l28 7 M182 109h18 M267 109h18"/>
      <circle cx="128" cy="148" r="27" fill="var(--garage-inset, #15181b)"/><circle cx="128" cy="148" r="14"/>
      <circle cx="358" cy="148" r="27" fill="var(--garage-inset, #15181b)"/><circle cx="358" cy="148" r="14"/>
      <path d="M128 135v26 M115 148h26 M358 135v26 M345 148h26" opacity=".6"/>
    </g>
  </svg>
`;

@customElement("garage-vehicle-card")
export class GarageVehicleCard extends LitElement {
  @property({ attribute: false }) vehicle!: Vehicle;
  @property({ type: Boolean }) selectable = false;
  @property({ type: Boolean }) manage = false;
  @property({ type: Number }) lowFuelThreshold = .2;

  static styles = [controlStyles, css`
    :host { display: block; min-width: 0; }
    article.selectable { cursor: pointer; }
    article:focus-visible { outline: 2px solid var(--garage-accent); outline-offset: 3px; }
    article { border: 1px solid var(--garage-border); border-radius: 16px; overflow: hidden; background: var(--garage-surface); box-shadow: inset 0 1px 0 #ffffff06; }
    .showroom { position: relative; height: 190px; overflow: hidden; background: radial-gradient(ellipse at 50% 90%, #f6a45b15, transparent 65%), var(--garage-inset); border-bottom: 1px solid var(--garage-border); }
    .showroom::before { content: ""; position: absolute; left: 10%; right: 10%; bottom: 24px; border-bottom: 1px solid #f6a45b26; }
    .showroom svg { position: absolute; width: 94%; height: 100%; left: 3%; color: #9ba6af; padding: 18px 12px 0; }
    .showroom img { width: 100%; height: 100%; object-fit: cover; }
    .showroom .status { position: absolute; left: 16px; top: 16px; }
    .status { display: inline-flex; align-items: center; gap: 6px; border: 1px solid #f6a45b33; background: #15181bdf; color: var(--garage-accent); border-radius: 6px; padding: 4px 8px; text-transform: uppercase; letter-spacing: .07em; font-size: .58rem; font-weight: 650; }
    .status::before { content: ""; width: 4px; height: 4px; background: currentColor; border-radius: 50%; }
    .body { padding: 20px; }
    .identity { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .identity h3 { margin: 0 0 4px; font-size: 1.2rem; letter-spacing: -.035em; font-weight: 650; overflow-wrap: anywhere; }
    .model { color: var(--garage-muted); font-size: .74rem; }
    .health { width: 62px; height: 62px; position: relative; flex-shrink: 0; color: var(--garage-success); }
    .health.warn { color: var(--garage-warning); } .health.bad { color: var(--garage-danger); }
    .health svg { width: 100%; height: 100%; transform: rotate(-90deg); }
    .health circle { fill: none; stroke-width: 3; }
    .health .track { stroke: var(--garage-border); }
    .health .score { stroke: currentColor; stroke-linecap: round; }
    .health-label { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
    .health-label strong { font-family: var(--garage-mono); font-size: 1rem; line-height: 1.2; }
    .health-label small { font-size: .48rem; text-transform: uppercase; letter-spacing: .08em; color: var(--garage-muted); }
    .health { cursor: help; outline: none; border-radius: 50%; }
    .health:focus-visible { box-shadow: 0 0 0 2px var(--garage-accent); }
    .health-tip { position: absolute; top: calc(100% + 8px); right: 0; z-index: 2; width: 240px; padding: 12px 14px; border: 1px solid var(--garage-border); border-radius: 10px; background: var(--garage-raised); box-shadow: 0 10px 30px #0008; color: var(--garage-text); font-size: .7rem; line-height: 1.45; text-align: left; opacity: 0; visibility: hidden; transform: translateY(-4px); transition: opacity .12s, transform .12s, visibility .12s; pointer-events: none; }
    .health:hover .health-tip, .health:focus-visible .health-tip { opacity: 1; visibility: visible; transform: none; }
    .health-tip p { margin: 0 0 8px; color: var(--garage-muted); }
    .health-tip ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
    .health-tip li { display: flex; justify-content: space-between; gap: 12px; }
    .health-tip li strong { font-family: var(--garage-mono); font-weight: 500; color: var(--garage-danger); white-space: nowrap; }
    .health-tip .perfect { margin: 0; color: var(--garage-success); }
    .metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 20px 0; }
    .metrics span { display: block; color: var(--garage-muted); font-size: .57rem; text-transform: uppercase; letter-spacing: .07em; margin-bottom: 6px; }
    .metrics strong { display: block; font-family: var(--garage-mono); font-size: .83rem; font-weight: 500; overflow-wrap: anywhere; }
    .fuel-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-size: .7rem; color: var(--garage-muted); }
    .fuel-head span { display: flex; gap: 6px; align-items: center; }
    .fuel-head strong { font-family: var(--garage-mono); color: var(--garage-text); font-weight: 500; }
    progress { display: block; width: 100%; height: 5px; border: none; border-radius: 5px; overflow: hidden; appearance: none; accent-color: var(--garage-accent); background: var(--garage-raised); }
    progress::-webkit-progress-bar { background: var(--garage-raised); } progress::-webkit-progress-value { background: var(--garage-accent); border-radius: 5px; }
    progress::-moz-progress-bar { background: var(--garage-accent); }
    .alerts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 18px; }
    .alert { padding: 4px 7px; font-size: .62rem; border: 1px solid #edc27e30; border-radius: 5px; color: var(--garage-warning); background: #edc27e08; }
    footer { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 20px; border-top: 1px solid var(--garage-border); background: #15181b66; }
    .service { color: var(--garage-muted); font-size: .68rem; flex: 1; min-width: 0; }
    .service strong { display: block; color: var(--garage-text); font-size: .72rem; font-weight: 500; overflow-wrap: anywhere; }
    .footer-actions { display: flex; gap: 4px; }
    button.secondary { min-height: 38px; padding: 8px 12px; font-size: .73rem; }
    @media (max-width: 600px) { .showroom { height: 180px; } .body { padding: 18px; } footer { padding: 12px 18px; } }
  `];

  private _emit(action: string): void {
    this.dispatchEvent(new CustomEvent(action, { detail: this.vehicle, bubbles: true, composed: true }));
  }

  render() {
    const v = this.vehicle;
    if (!v) return html``;
    const score = Math.min(100, Math.max(0, v.healthScore));
    const fuel = v.currentFuelPct === null ? null : Math.min(1, Math.max(0, v.currentFuelPct));
    const alerts = [
      ...(v.maintenanceDueCount > 0 ? [`${v.maintenanceDueCount} service due`] : []),
      ...(v.maintenanceDueSoonCount > 0 ? [`${v.maintenanceDueSoonCount} due soon`] : []),
      ...(fuel !== null && fuel <= this.lowFuelThreshold ? ["Low fuel"] : []),
      ...(v.registrationExpires && new Date(v.registrationExpires) < new Date() ? ["Registration expired"] : []),
      ...(v.insuranceExpires && new Date(v.insuranceExpires) < new Date() ? ["Insurance expired"] : []),
    ];
    return html`
      <article class=${this.selectable ? "selectable" : ""} tabindex=${this.selectable ? "0" : "-1"}
        aria-label=${this.selectable ? "View " + v.nickname : v.nickname}
        @click=${(e: Event) => { if (this.selectable && !(e.target as HTMLElement).closest("button, .health")) this._emit("vehicle-select"); }}
        @keydown=${(e: KeyboardEvent) => { if (this.selectable && e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); this._emit("vehicle-select"); } }}>
        <div class="showroom">
          ${v.photoPath ? html`<img src=${v.photoPath} alt=${v.nickname} />` : vehicleSilhouette()}
          <span class="status">${v.status}</span>
        </div>
        <div class="body">
          <div class="identity">
            <div><h3>${v.nickname}</h3><div class="model">${v.year} ${v.make} ${v.model} ${v.trim}</div></div>
            <div class="health ${score < 50 ? "bad" : score < 80 ? "warn" : ""}" tabindex="0" aria-describedby="health-tip" aria-label=${`Health score ${score} out of 100`}>
              <svg viewBox="0 0 64 64" aria-hidden="true"><circle class="track" cx="32" cy="32" r="27"/><circle class="score" cx="32" cy="32" r="27" pathLength="100" stroke-dasharray=${`${score} 100`}/></svg>
              <div class="health-label" aria-hidden="true"><strong>${score}</strong><small>Health</small></div>
              <div class="health-tip" id="health-tip" role="tooltip">
                <p>Mechanical condition, starting at 100. Points come off for overdue or upcoming service and low fuel. Registration and insurance are reminders only.</p>
                ${v.healthDeductions.length
                  ? html`<ul>${v.healthDeductions.map(d => html`<li><span>${d.reason}</span><strong>−${d.points}</strong></li>`)}</ul>`
                  : html`<p class="perfect">Nothing is taking points off.</p>`}
              </div>
            </div>
          </div>
          <div class="metrics">
            <div><span>Odometer</span><strong>${mileage(v.currentMileage)}</strong></div>
            <div><span>Est. range</span><strong>${v.estimatedRangeMiles !== null ? mileage(v.estimatedRangeMiles) : "—"}</strong></div>
            <div><span>Avg. MPG</span><strong>${v.averageMpg?.toFixed(1) ?? "—"}</strong></div>
          </div>
          <div class="fuel-head"><span><ha-icon aria-hidden="true" icon="mdi:gas-station-outline"></ha-icon>Fuel level${v.fuelLevelEntityId ? " · live" : ""}</span><strong>${pct(fuel)}</strong></div>
          ${fuel !== null ? html`<progress aria-label="Fuel level" max="1" value=${fuel}></progress>` : html`<div class="model">No fuel reading recorded</div>`}
          ${alerts.length ? html`<div class="alerts">${alerts.map(a => html`<span class="alert">${a}</span>`)}</div>` : ""}
        </div>
        <footer>
          <div class="service">Next service<strong>${v.nextMaintenanceDue?.name ?? "No service due"}</strong></div>
          <div class="footer-actions">
            ${this.manage ? html`
              <button class="icon" aria-label=${`Edit ${v.nickname}`} @click=${() => this._emit("vehicle-edit")}><ha-icon aria-hidden="true" icon="mdi:pencil-outline"></ha-icon></button>
              <button class="icon danger" aria-label=${`Delete ${v.nickname}`} @click=${() => this._emit("vehicle-delete")}><ha-icon aria-hidden="true" icon="mdi:trash-can-outline"></ha-icon></button>
            ` : html`<button class="secondary" @click=${() => this._emit("vehicle-fuel")}><ha-icon aria-hidden="true" icon="mdi:plus"></ha-icon>Add Fuel</button>`}
          </div>
        </footer>
      </article>
    `;
  }
}
declare global { interface HTMLElementTagNameMap { "garage-vehicle-card": GarageVehicleCard; } }
