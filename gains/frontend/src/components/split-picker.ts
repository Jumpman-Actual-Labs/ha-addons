import { LitElement, css, html } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { PROGRAM_SPLITS } from "../program-builder";
import { formStyles } from "../styles";

const DETAILS: Record<string, string> = {
  "Full Body": "Train your upper and lower body in each lifting session. The same full-body position repeats, with exercises chosen around your history, recovery and equipment.",
  "Upper / Lower": "Alternate upper-body and lower-body sessions. Upper covers chest, back, shoulders and arms; lower focuses on legs and hips.",
  "Push / Pull / Legs": "Separate pressing muscles, pulling muscles and lower-body work. Push focuses on chest, shoulders and triceps; pull on back and biceps; legs on the lower body.",
  "Upper / Lower / Push / Pull": "Start with broad upper- and lower-body sessions, then separate pushing and pulling sessions. This is a four-position rotation; it does not contain a second dedicated leg position.",
  "Arnold Split": "Rotate through chest/back, shoulders/arms and legs. Each position groups related muscle targets into a dedicated session.",
  "Body-Part Split": "Give chest, back, shoulders, legs and arms their own positions in a five-part rotation. Choose a custom split if you want a different order or combination.",
  PHUL: "Power Hypertrophy Upper Lower. Start with power-focused upper and lower sessions, followed by hypertrophy-focused upper and lower sessions. All four positions stay in the rotation even on a three-day schedule.",
  PHAT: "Power Hypertrophy Adaptive Training. Two power-focused positions lead into three hypertrophy-focused positions: back/shoulders, legs and chest/arms.",
  "Hybrid PPL + Upper/Lower": "Combine push, pull and legs with additional upper- and lower-body positions. This five-position rotation mixes focused sessions with broader muscle coverage.",
  "Strength-Focused": "Gains uses a three-position full-body, upper-body and lower-body rotation for this option. Your goal, exercise history and equipment guide the prescriptions. Running and HIIT counts are configured separately.",
  "Powerlifting Hybrid": "Gains' five-position rotation: chest/triceps, back/biceps, legs, chest/biceps isolation, then arms/forearms/grip. It is a muscle-focused hybrid, rather than a competition-specific squat/bench/deadlift template.",
  "Geoffrey Decide": "Use Gains' frequency-based default: full body for one or two lifting sessions per week, push/pull/legs for three, and upper/lower for four or more. You can still customize session preferences before generating.",
  "Custom Split": "Write one muscle focus for each weekly lifting session and arrange the order yourself. Each row can have its own duration, intensity and exercise rules. Examples include Chest/Triceps, Back/Biceps, Legs and Core.",
};
const OPTIONS = [...Object.keys(PROGRAM_SPLITS), "Geoffrey Decide", "Custom Split"];

@customElement("gains-split-picker")
export class GainsSplitPicker extends LitElement {
  @property() value = "Full Body";
  @property({ type: Number }) liftingDays = 3;
  @property({ type: Boolean }) disabled = false;
  @state() private open = false;
  @state() private preview = "";
  private outside = (event: Event) => {
    if (!event.composedPath().includes(this)) this.open = false;
  };
  connectedCallback() { super.connectedCallback(); document.addEventListener("pointerdown", this.outside); }
  disconnectedCallback() { document.removeEventListener("pointerdown", this.outside); super.disconnectedCallback(); }
  static styles = [formStyles, css`
    :host { display: block; margin-top: 12px; }
    .label { color: var(--secondary-text-color); font-size: 13px; margin-bottom: 5px; }
    .trigger { width: 100%; min-height: 48px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; border: 1px solid var(--divider-color); border-radius: 12px; background: var(--card-background-color); color: var(--primary-text-color); font: inherit; cursor: pointer; text-align: left; }
    .trigger[aria-expanded="true"] { border-color: var(--primary-color); }
    .trigger:disabled { opacity: .5; cursor: default; }
    .picker { border: 1px solid var(--divider-color); border-radius: 16px; overflow: hidden; margin-top: 8px; background: var(--card-background-color); display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
    .options { max-height: 340px; overflow-y: auto; padding: 6px; }
    .option { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 44px; border: 0; border-radius: 9px; padding: 10px; font: inherit; font-size: 13px; color: var(--primary-text-color); background: transparent; cursor: pointer; text-align: left; }
    .option:hover, .option:focus, .option.previewed { background: var(--gains-tint); color: var(--primary-color); }
    .option[aria-selected="true"] { font-weight: 750; }
    .detail { padding: 18px; min-width: 0; background: var(--primary-background-color); border-left: 1px solid var(--divider-color); }
    h3 { font-size: 16px; margin: 0 0 10px; }
    p { font-size: 13px; line-height: 1.6; margin: 0 0 12px; }
    ol { padding-left: 20px; font-size: 12px; line-height: 1.7; margin: 10px 0; }
    .selected-detail { font-size: 13px; padding: 12px 0 0; color: var(--secondary-text-color); }
    .hint { font-size: 11px; color: var(--secondary-text-color); margin-top: 8px; }
    @media (max-width: 520px) { .picker { grid-template-columns: 1fr; } .detail { border-left: 0; border-top: 1px solid var(--divider-color); padding: 14px; } .options { max-height: 225px; } }
  `];
  private cycle(name: string): string[] {
    if (name === "Geoffrey Decide") return this.liftingDays <= 2 ? PROGRAM_SPLITS["Full Body"] : this.liftingDays === 3 ? PROGRAM_SPLITS["Push / Pull / Legs"] : PROGRAM_SPLITS["Upper / Lower"];
    return PROGRAM_SPLITS[name] ?? [];
  }
  private async focusOption(index: number) {
    this.open = true;
    this.preview = OPTIONS[index];
    await this.updateComplete;
    this.renderRoot.querySelectorAll<HTMLButtonElement>(".option")[index]?.focus();
  }
  private close(restoreFocus = false) {
    this.open = false;
    if (restoreFocus) this.renderRoot.querySelector<HTMLButtonElement>(".trigger")?.focus();
  }
  private focusOut(event: FocusEvent) {
    if (!this.renderRoot.contains(event.relatedTarget as Node | null)) this.close();
  }
  private choose(name: string) {
    if (this.disabled) return;
    this.close(true);
    this.dispatchEvent(new CustomEvent("split-change", { detail: name, bubbles: true, composed: true }));
  }
  private key(event: KeyboardEvent, index?: number) {
    if (this.disabled) return;
    const current = index ?? Math.max(0, OPTIONS.indexOf(this.value));
    let next: number | undefined;
    if (event.key === "Escape") { event.preventDefault(); this.close(true); return; }
    if (event.key === "ArrowDown") next = index === undefined ? current : (current + 1) % OPTIONS.length;
    if (event.key === "ArrowUp") next = index === undefined ? current : (current + OPTIONS.length - 1) % OPTIONS.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = OPTIONS.length - 1;
    if (next !== undefined) { event.preventDefault(); void this.focusOption(next); }
  }
  render() {
    const name = this.open ? this.preview || this.value : this.value;
    const cycle = this.cycle(name);
    return html`<div class="label">Lifting split</div><button class="trigger" aria-label="Lifting split" aria-haspopup="listbox" aria-expanded=${this.open} aria-controls="split-options" ?disabled=${this.disabled}
      @focusout=${this.focusOut} @keydown=${(e:KeyboardEvent) => this.key(e)} @click=${() => { this.preview = this.value; this.open = !this.open; }}>${this.value}<span aria-hidden="true">${this.open ? "▴" : "▾"}</span></button>
      ${this.open ? html`<div class="picker" @focusout=${this.focusOut}>
        <div class="options" id="split-options" role="listbox" aria-label="Lifting split options">${OPTIONS.map((option,i) => html`<button class="option ${name===option ? "previewed" : ""}" role="option" aria-selected=${this.value===option} aria-describedby="split-detail" tabindex=${name===option ? 0 : -1}
          @pointerenter=${() => this.preview=option} @focus=${() => this.preview=option} @keydown=${(e:KeyboardEvent) => this.key(e,i)} @click=${() => this.choose(option)}>${option}${this.value===option ? html`<span aria-hidden="true">✓</span>` : ""}</button>`)}</div>
        <aside class="detail" id="split-detail" aria-live="polite" aria-atomic="true"><h3>${name}</h3><p>${DETAILS[name] ?? "Choose a supported split to see its details."}</p>${cycle.length ? html`<strong class="small">Session order</strong><ol>${cycle.map(focus => html`<li>${focus}</li>`)}</ol><p class="hint">${cycle.length} rotation positions · ${this.liftingDays} lifting sessions per week. Your sequencing preference controls how the rotation advances.</p>` : ""}</aside>
      </div><p class="hint">Hover or use ↑ / ↓ to preview. Click or press Enter to select. Escape closes without changing your split.</p>` : html`<p class="selected-detail">${DETAILS[this.value] ?? "Choose a supported split to see its details."}</p>`}`;
  }
}
