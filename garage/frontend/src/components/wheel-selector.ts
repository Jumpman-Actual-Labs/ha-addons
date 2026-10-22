import { LitElement, css, html, svg } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { Drivetrain, WheelPosition } from "../types";

const ALL_POSITIONS: WheelPosition[] = [
  "front_left",
  "front_right",
  "rear_left",
  "rear_right",
];

const WHEEL_LAYOUT: Record<WheelPosition, { x: number; y: number }> = {
  front_left: { x: 8, y: 20 },
  front_right: { x: 110, y: 20 },
  rear_left: { x: 8, y: 160 },
  rear_right: { x: 110, y: 160 },
};

/**
 * Top-down car diagram for picking which wheels a maintenance action
 * touched (tire replacement/rotation, brakes, etc). Wheels connected to the
 * drivetrain get a tread marking so the diagram doubles as an at-a-glance
 * drivetrain indicator; selection (for "which tires did I replace") is
 * independent of that and works on all four wheels regardless of drivetrain.
 */
@customElement("garage-wheel-selector")
export class GarageWheelSelector extends LitElement {
  @property({ type: Array }) selected: WheelPosition[] = [];
  @property({ type: String }) drivetrain: Drivetrain = "fwd";

  static styles = css`
    :host {
      display: block;
    }
    .wrap {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
    }
    .wheel {
      cursor: pointer;
    }
    .wheel:focus-visible { outline: 2px solid var(--primary-color, #f6a45b); outline-offset: 3px; }
    .select-all {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.85rem;
      color: var(--secondary-text-color);
    }
    .select-all input {
      width: auto;
    }
  `;

  private _isDriven(pos: WheelPosition): boolean {
    const front = pos === "front_left" || pos === "front_right";
    if (this.drivetrain === "awd" || this.drivetrain === "4wd") return true;
    if (this.drivetrain === "fwd") return front;
    if (this.drivetrain === "rwd") return !front;
    return false;
  }

  private _toggle(pos: WheelPosition): void {
    const next = this.selected.includes(pos)
      ? this.selected.filter((p) => p !== pos)
      : [...this.selected, pos];
    this._emit(next);
  }

  private _toggleAll(checked: boolean): void {
    this._emit(checked ? [...ALL_POSITIONS] : []);
  }

  private _emit(next: WheelPosition[]): void {
    this.selected = next;
    this.dispatchEvent(new CustomEvent("wheels-changed", { detail: next }));
  }

  private _renderWheel(pos: WheelPosition) {
    const { x, y } = WHEEL_LAYOUT[pos];
    const isSelected = this.selected.includes(pos);
    const isDriven = this._isDriven(pos);
    const fill = isSelected
      ? "var(--primary-color, #f6a45b)"
      : "var(--secondary-background-color, #444)";
    return svg`
      <g class="wheel" role="button" tabindex="0"
        aria-label=${pos.replace(/_/g, " ")}
        aria-pressed=${isSelected}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); this._toggle(pos); }
        }}
        @click=${() => this._toggle(pos)}>
        <rect
          x=${x} y=${y} width="22" height="40" rx="6"
          fill=${fill}
          stroke="var(--divider-color, #888)"
          stroke-width="1.5"
        />
        ${isDriven
          ? svg`<rect
              x=${x + 4} y=${y + 7} width="14" height="26" rx="3"
              fill="none"
              stroke=${isSelected ? "var(--text-primary-color, #fff)" : "var(--primary-color, #f6a45b)"}
              stroke-width="1.5"
              stroke-dasharray="3 2"
            />`
          : ""}
      </g>
    `;
  }

  render() {
    const allSelected = ALL_POSITIONS.every((p) => this.selected.includes(p));
    return html`
      <div class="wrap">
        <svg viewBox="0 0 140 220" width="120" height="188">
          <rect
            x="30" y="16" width="80" height="188" rx="28"
            fill="none"
            stroke="var(--divider-color, #888)"
            stroke-width="2"
          />
          <circle
            cx="70" cy="110" r="16"
            fill="none"
            stroke="var(--divider-color, #888)"
            stroke-width="1.5"
          />
          ${ALL_POSITIONS.map((p) => this._renderWheel(p))}
        </svg>
        <label class="select-all">
          <input
            type="checkbox"
            .checked=${allSelected}
            @change=${(e: Event) => this._toggleAll((e.target as HTMLInputElement).checked)}
          />
          Select All
        </label>
      </div>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "garage-wheel-selector": GarageWheelSelector;
  }
}

