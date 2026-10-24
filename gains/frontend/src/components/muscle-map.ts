import { LitElement, css, html, svg } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { muscleCoverage, muscleLabels, type MuscleId } from "../muscles";

// Original simplified geometry authored for Gains. See docs/muscle-artwork.md.
const OUTLINE = "M90 47 Q86 50 79 51 L64 56 Q53 59 50 69 L41 107 37 135 28 161 26 178 Q25 186 31 186 L36 181 42 163 50 142 56 117 60 93 66 117 68 139 62 161 61 189 65 222 69 246 69 271 73 308 72 322 65 329 Q63 335 75 335 L86 331 88 316 90 286 89 263 94 235 98 199 100 178 102 199 106 235 111 263 110 286 112 316 114 331 125 335 Q137 335 135 329 L128 322 127 308 131 271 131 246 135 222 139 189 138 161 132 139 134 117 140 93 144 117 150 142 158 163 164 181 169 186 Q175 186 174 178 L172 161 163 135 159 107 150 69 Q147 59 136 56 L121 51 Q114 50 110 47 L110 39 90 39Z";
const REGIONS: { side: string; muscle: MuscleId; d: string }[] = [
  {
    "side": "front",
    "muscle": "anterior_deltoid",
    "d": "M64 59 Q74 57 78 63 L72 77 60 83 54 78 Q55 64 64 59Z"
  },
  {
    "side": "front",
    "muscle": "lateral_deltoid",
    "d": "M53 76 L59 84 55 96 50 103 47 97Z"
  },
  {
    "side": "front",
    "muscle": "pectoralis_major",
    "d": "M80 60 L98 63 98 86 Q90 95 77 90 L63 80 70 66Z"
  },
  {
    "side": "front",
    "muscle": "biceps_brachii",
    "d": "M59 86 L67 90 63 109 54 122 49 119 52 102Z"
  },
  {
    "side": "front",
    "muscle": "triceps_brachii",
    "d": "M47 100 L51 107 47 125 44 136 40 132Z"
  },
  {
    "side": "front",
    "muscle": "forearms",
    "d": "M49 126 L54 126 49 146 38 165 34 164 40 144Z"
  },
  {
    "side": "front",
    "muscle": "obliques",
    "d": "M69 96 L79 101 82 123 85 137 72 145 70 126Z"
  },
  {
    "side": "front",
    "muscle": "hip_adductors",
    "d": "M88 151 L97 166 94 192 89 211 81 178Z"
  },
  {
    "side": "front",
    "muscle": "quadriceps",
    "d": "M68 152 L79 149 85 177 88 202 81 229 72 229 67 212 65 184Z"
  },
  {
    "side": "front",
    "muscle": "quadriceps",
    "d": "M89 212 L92 199 88 233 82 239 81 230Z"
  },
  {
    "side": "front",
    "muscle": "calves",
    "d": "M72 249 L79 247 84 261 83 282 79 306 75 302 73 281Z"
  },
  {
    "side": "back",
    "muscle": "trapezius",
    "d": "M88 48 L98 55 98 92 84 80 74 64Z"
  },
  {
    "side": "back",
    "muscle": "rhomboids",
    "d": "M79 80 L96 95 96 110 84 98 76 88Z"
  },
  {
    "side": "back",
    "muscle": "posterior_deltoid",
    "d": "M67 60 L79 64 72 80 58 83 53 77 Q56 63 67 60Z"
  },
  {
    "side": "back",
    "muscle": "lateral_deltoid",
    "d": "M53 78 L58 85 54 99 48 105 46 96Z"
  },
  {
    "side": "back",
    "muscle": "triceps_brachii",
    "d": "M59 87 L68 89 62 114 53 124 48 119 52 103Z"
  },
  {
    "side": "back",
    "muscle": "latissimus_dorsi",
    "d": "M71 89 L82 94 97 112 92 136 84 143 74 122Z"
  },
  {
    "side": "back",
    "muscle": "erector_spinae",
    "d": "M96 116 L99 118 99 153 92 153 89 141Z"
  },
  {
    "side": "back",
    "muscle": "forearms",
    "d": "M47 127 L54 128 48 148 37 167 33 165 39 147Z"
  },
  {
    "side": "back",
    "muscle": "gluteals",
    "d": "M72 145 Q85 145 98 155 L98 178 Q85 190 66 176 L65 162Z"
  },
  {
    "side": "back",
    "muscle": "hamstrings",
    "d": "M67 181 L80 187 95 181 91 207 85 238 75 239 69 219Z"
  },
  {
    "side": "back",
    "muscle": "calves",
    "d": "M73 248 Q79 240 85 249 L88 268 83 289 79 310 76 297 72 273Z"
  },
  {
    "side": "front",
    "muscle": "rectus_abdominis",
    "d": "M84 97 L98 96 98 107 86 108Z"
  },
  {
    "side": "front",
    "muscle": "rectus_abdominis",
    "d": "M84 110 L98 109 98 120 86 121Z"
  },
  {
    "side": "front",
    "muscle": "rectus_abdominis",
    "d": "M84 123 L98 122 98 133 86 134Z"
  }
];
let nextId = 0;
@customElement("gains-muscle-map")
export class GainsMuscleMap extends LitElement {
  @property({ attribute: false }) exerciseIds: string[] = [];
  @property({ attribute: false }) muscleIds: MuscleId[] = [];
  @property({ type: Boolean }) compact = false;
  @property({ type: Boolean }) both = false;
  @state() private _view: "front" | "back" = "front";
  private _id = `gains-muscles-${nextId++}`;
  static styles = css`
    :host{display:block;min-width:0;color:var(--primary-text-color,#162238)}
    .map{background:var(--card-background-color,#fff);border:1px solid var(--divider-color,#dfe5ee);border-radius:18px;padding:16px;margin:12px 0}
    .controls{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;font-size:15px;font-weight:600}
    button{font:inherit;font-size:12px;min-height:44px;padding:8px 12px;border:0;background:transparent;color:inherit;border-radius:9px;cursor:pointer}
    button[aria-pressed="true"]{background:var(--gains-tint,#edf3ff);color:var(--primary-color,#245cdb)}
    svg{display:block;width:100%;height:260px;margin:10px auto}
    .pair{display:grid;grid-template-columns:1fr 1fr;gap:8px}.pair svg{height:205px}
    .side{text-align:center;font-size:12px;color:var(--secondary-text-color,#647287)}
    .legend{display:flex;justify-content:center;gap:12px;flex-wrap:wrap;font-size:11px;margin:14px 0;color:var(--secondary-text-color,#647287)}
    .legend span{display:inline-flex;align-items:center;gap:5px}.key{width:10px;height:10px;border-radius:2px;background:var(--gains-muscle,#366fe9)}
    .secondary{background:repeating-linear-gradient(45deg,var(--gains-muscle-secondary,#b5d0ff),var(--gains-muscle-secondary,#b5d0ff) 2px,var(--divider-color,#dfe5ee) 2px,var(--divider-color,#dfe5ee) 3px)}
    .neutral{background:var(--gains-muscle-neutral,#d9dfe8)}
    p{font-size:12px;line-height:1.6;margin:8px 0}.muted{color:var(--secondary-text-color,#647287)}
    .targets{border-top:1px solid var(--divider-color,#dfe5ee);padding-top:8px}
    .mini svg{height:var(--gains-compact-muscle-height,105px);width:var(--gains-compact-muscle-width,68px);margin:0}.mini{display:flex;justify-content:center;align-items:center;gap:2px}.mini.both svg{width:calc(var(--gains-compact-muscle-width,68px) / 2 + 8px)}
  `;
  private _targets() {
    if (this.muscleIds.length) {
      return { primary: this.muscleIds, secondary: [] as MuscleId[], mapped: 1, total: 1 };
    }
    return muscleCoverage(this.exerciseIds);
  }

  private _draw(side: string) {
    const targets = this._targets();
    const fill = (m: MuscleId) => targets.primary.includes(m) ? "var(--gains-muscle,#366fe9)" : targets.secondary.includes(m) ? `url(#${this._id}-${side})` : "var(--gains-muscle-neutral,#d9dfe8)";
    const region = (r: typeof REGIONS[number]) => svg`<path d=${r.d} fill=${fill(r.muscle)} stroke="var(--card-background-color,#fff)" stroke-width="1.5" stroke-linejoin="round"/>`;
    return svg`<svg viewBox="15 0 170 342" role="img" aria-hidden=${this.compact ? "true" : "false"} aria-label=${`${side} view. Primary: ${muscleLabels(targets.primary)}. Secondary: ${muscleLabels(targets.secondary)}`}>
      <defs><pattern id=${`${this._id}-${side}`} patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)"><rect width="5" height="5" fill="var(--gains-muscle-secondary,#b5d0ff)"/><path d="M0 0V5" stroke="var(--divider-color,#dfe5ee)" stroke-width=".65"/></pattern></defs>
      <path d=${OUTLINE} fill="var(--gains-muscle-neutral,#d9dfe8)"/>
      <path d="M87 12 Q87 2 100 2 Q113 2 113 12 L111 31 Q106 43 100 43 Q94 43 89 31Z" fill="var(--gains-muscle-neutral,#d9dfe8)"/>
      ${REGIONS.filter(r => r.side === side).map(r => svg`${region(r)}<g transform="translate(200 0) scale(-1 1)">${region(r)}</g>`)}
    </svg>`;
  }
  render() {
    const targets = this._targets();
    if (!targets.mapped) return this.compact ? html`` : html`<p class="muted">${targets.total ? "Muscle detail unavailable for these exercises." : "No exercises to map yet."}</p>`;
    if (this.compact) return this.both
      ? html`<div class="mini both">${this._draw("front")}${this._draw("back")}</div>`
      : html`<div class="mini">${this._draw("front")}</div>`;
    return html`<section class="map" aria-label="Muscle involvement">
      <div class="controls"><span>Muscles worked</span>${!this.both ? html`<div><button aria-pressed=${this._view === "front"} @click=${() => this._view = "front"}>Front</button><button aria-pressed=${this._view === "back"} @click=${() => this._view = "back"}>Back</button></div>` : ""}</div>
      ${this.both ? html`<div class="pair"><div>${this._draw("front")}<div class="side">Front</div></div><div>${this._draw("back")}<div class="side">Back</div></div></div>` : this._draw(this._view)}
      <div class="legend"><span><i class="key"></i>Primary</span><span><i class="key secondary"></i>Secondary</span><span><i class="key neutral"></i>Other</span></div>
      <div class="targets"><p><strong>Primary</strong> · ${muscleLabels(targets.primary)}</p>${targets.secondary.length ? html`<p><strong>Secondary</strong> · ${muscleLabels(targets.secondary)}</p>` : ""}</div>
      ${targets.mapped < targets.total ? html`<p class="muted">Mapped for ${targets.mapped} of ${targets.total} exercises.</p>` : ""}
      <p class="muted">General muscle involvement, not an activation or recovery score.</p>
    </section>`;
  }
}
