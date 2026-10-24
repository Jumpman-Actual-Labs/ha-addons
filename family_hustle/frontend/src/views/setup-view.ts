import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { familyApi } from "../family-api";
import { formStyles } from "../styles";

/* First run, in place of the integration's "Add Integration" wizard: names
 * the household, sets payday, and makes whoever fills it in (a Home
 * Assistant admin) the first parent. Everything else - more parents, kids,
 * chores, calendars - is set up from inside the app afterwards. Not shown
 * when the import brought an existing household with its parents. */

const WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
const WEEKDAY_NAMES = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

@customElement("family-setup-view")
export class FamilySetupView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ type: String }) householdName = "";

  @state() private _name = "";
  @state() private _displayName = "";
  @state() private _recurrence = "weekly";
  @state() private _dayOfWeek = "FRI";
  @state() private _dayOfMonth = 1;
  @state() private _busy = false;
  @state() private _error = "";

  static styles = [
    formStyles,
    css`
      :host { display: block; max-width: 520px; margin: 6vh auto; padding: 0 16px; }
      .card { background: #fff; border: 1px solid #e6e9ee; border-radius: 22px; padding: 28px; }
      h1 { font-family: Georgia, "Times New Roman", serif; font-weight: 600; }
      p { color: #6b7685; margin: 0 0 8px; }
      .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      .actions { margin-top: 22px; display: flex; justify-content: flex-end; }
      .err { color: #b3261e; }
    `,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    this._name = this.householdName || "";
    this._displayName = this.hass.user?.name ?? "";
  }

  private async _submit(): Promise<void> {
    if (!this._name.trim() || !this._displayName.trim()) {
      this._error = "Fill in the family name and your name.";
      return;
    }
    this._busy = true;
    this._error = "";
    const paydayRule =
      this._recurrence === "monthly"
        ? { type: "monthly", day_of_month: this._dayOfMonth }
        : { type: this._recurrence, day_of_week: this._dayOfWeek };
    try {
      await familyApi.call(this.hass, "setup_family", {
        name: this._name.trim(),
        display_name: this._displayName.trim(),
        recurrence: this._recurrence,
        payday_rule: paydayRule,
      });
    } catch (err) {
      this._error = (err as Error).message;
    } finally {
      this._busy = false;
    }
  }

  render() {
    const value = (e: Event) => (e.target as HTMLInputElement).value;
    return html`<div class="card">
      <h1>Welcome to Family Hustle</h1>
      <p>Your family calendar, chores and meals in one place. You'll be the first parent - add everyone else from Chores › Settings afterwards.</p>
      <label>Family name</label>
      <input .value=${this._name} placeholder="The Millers" @input=${(e: Event) => (this._name = value(e))} />
      <label>Your name</label>
      <input .value=${this._displayName} @input=${(e: Event) => (this._displayName = value(e))} />
      <div class="row2">
        <div>
          <label>Payday</label>
          <select @change=${(e: Event) => (this._recurrence = value(e))}>
            <option value="weekly" ?selected=${this._recurrence === "weekly"}>Weekly</option>
            <option value="biweekly" ?selected=${this._recurrence === "biweekly"}>Every 2 weeks</option>
            <option value="monthly" ?selected=${this._recurrence === "monthly"}>Monthly</option>
          </select>
        </div>
        <div>
          ${this._recurrence === "monthly"
            ? html`<label>Day of month</label>
                <input type="number" min="1" max="28" .value=${String(this._dayOfMonth)} @input=${(e: Event) => (this._dayOfMonth = Number(value(e)) || 1)} />`
            : html`<label>On</label>
                <select @change=${(e: Event) => (this._dayOfWeek = value(e))}>
                  ${WEEKDAYS.map((d, i) => html`<option value=${d} ?selected=${d === this._dayOfWeek}>${WEEKDAY_NAMES[i]}</option>`)}
                </select>`}
        </div>
      </div>
      ${this._error ? html`<p class="err">${this._error}</p>` : nothing}
      <div class="actions">
        <button class="primary" ?disabled=${this._busy} @click=${this._submit}>Get started</button>
      </div>
    </div>`;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "family-setup-view": FamilySetupView;
  }
}
