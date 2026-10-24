import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import {
  familyApi,
  type CalendarInfo,
  type DinnerEntry,
  type FamilyExtras,
  type GroceryCategory,
} from "../family-api";
import type { MemberRosterEntry } from "../types";

/* The Meals tab - the Household panel (`ha-household`'s
 * household-panel.js), moved over as a Lit view with the same behavior:
 * - "This Week's Dinners" chalkboard: the next 7 days from the Dinners
 *   calendar, today highlighted, a Meal Prep tile when several days share
 *   one dish, and "Move to…" on each scheduled dinner.
 * - The meal-plan wizard: mode (Dinner Planning / Meal Prep) -> details ->
 *   review (accept/deny, regenerate denied without repeats) -> submit
 *   (schedule onto the calendar, then build the grocery list).
 * - "View Grocery List" reopens the last generated list any time.
 * Wizard state lives here only; closing it discards it, as before. Kids see
 * the board; planning, moving and settings are for parents. The family
 * calendar that used to sit under the board is the Calendar tab now. */

const MEAL_PREP_OPTION_COUNT = 5;
const DAY_MS = 86_400_000;

type SlotStatus = "pending" | "accepted" | "denied";
interface Slot {
  name: string;
  description: string;
  status: SlotStatus;
}
interface CheckCategory {
  category: string;
  items: Array<{ label: string; checked: boolean }>;
}
interface Wizard {
  step: "mode" | "params" | "review" | "grocery";
  mode: "dinner_planning" | "meal_prep";
  servings: number;
  days: number;
  preferences: string;
  slots: Slot[];
  seenNames: string[];
  grocery: CheckCategory[];
  loading: boolean;
  error: string;
}

function localDateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function checklist(categories: GroceryCategory[]): CheckCategory[] {
  return categories.map((c) => ({
    category: c.category,
    items: c.items.map((label) => ({ label, checked: false })),
  }));
}

@customElement("family-meals-view")
export class FamilyMealsView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) extras!: FamilyExtras;
  @property({ attribute: false }) me!: MemberRosterEntry;

  @state() private _week: DinnerEntry[] = [];
  @state() private _boardError = "";
  @state() private _moveError = "";
  @state() private _wizard: Wizard | null = null;
  @state() private _groceryView: CheckCategory[] | null = null;
  @state() private _settingsOpen = false;
  @state() private _calendars: CalendarInfo[] = [];
  @state() private _dinnersDraft = "";
  @state() private _settingsError = "";

  private _loadedFor: string | null | undefined = undefined;

  static styles = css`
    :host {
      --chalk-green: #1f3d2b;
      --chalk-green-dark: #16301f;
      --chalk-white: #f5f2e8;
      --chalk-gold: #d4af6a;
      display: block;
      color: var(--primary-text-color, #1c1c1c);
    }
    .board {
      max-width: 960px;
      margin: 0 auto;
      border-radius: 18px;
      overflow: hidden;
      background: radial-gradient(ellipse at top left, var(--chalk-green) 0%, var(--chalk-green-dark) 100%);
      color: var(--chalk-white);
      padding: 24px;
      font-family: Georgia, "Times New Roman", serif;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
    }
    .header { display: flex; align-items: baseline; justify-content: center; gap: 10px; margin-bottom: 18px; border-bottom: 1px solid rgba(212, 175, 106, 0.5); padding-bottom: 10px; position: relative; }
    .title { font-family: "Brush Script MT", "Segoe Script", cursive; font-size: 36px; letter-spacing: 0.5px; }
    .flourish { color: var(--chalk-gold); font-size: 18px; }
    .gear { position: absolute; right: 0; top: 4px; background: none; border: 0; color: var(--chalk-gold); cursor: pointer; padding: 6px; }
    .week { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 10px; }
    .day { background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(245, 242, 232, 0.15); border-radius: 8px; padding: 10px 8px; text-align: center; }
    .day.today { border-color: var(--chalk-gold); box-shadow: 0 0 0 1px var(--chalk-gold); background: rgba(212, 175, 106, 0.12); }
    .day-label { font-size: 12px; letter-spacing: 1px; text-transform: uppercase; color: var(--chalk-gold); }
    .day-date { font-size: 11px; opacity: 0.7; margin-bottom: 6px; }
    .dish { font-style: italic; font-size: 14px; }
    .dish.empty { opacity: 0.5; }
    .notes { font-size: 11px; opacity: 0.7; margin: 4px 0 0; }
    .meal-prep-tiles { margin-top: 14px; display: flex; flex-direction: column; gap: 10px; }
    .meal-prep-tile { border: 1px solid var(--chalk-gold); border-radius: 8px; padding: 12px 14px; background: rgba(212, 175, 106, 0.08); }
    .meal-prep-label { font-size: 11px; text-transform: uppercase; letter-spacing: 1px; color: var(--chalk-gold); }
    .meal-prep-dish { font-size: 18px; font-weight: bold; margin-top: 2px; }
    .meal-prep-notes { font-size: 12px; opacity: 0.8; margin: 4px 0 0; font-style: italic; }
    .meal-prep-when { font-size: 11px; opacity: 0.7; margin-top: 6px; }
    .footer { margin-top: 18px; text-align: center; display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
    .move-select { display: block; width: 100%; box-sizing: border-box; margin-top: 8px; font-family: inherit; font-size: 10px; background: rgba(255, 255, 255, 0.08); color: var(--chalk-white); border: 1px solid rgba(245, 242, 232, 0.25); border-radius: 4px; padding: 3px 4px; cursor: pointer; }
    .move-select option { color: #1c1c1c; }
    .board-note { text-align: center; margin: 12px 0 0; font-style: italic; opacity: 0.85; }
    .generate-btn, .primary, .secondary, .accept, .deny { font-family: inherit; border-radius: 20px; padding: 8px 18px; border: 1px solid var(--chalk-gold); cursor: pointer; font-size: 13px; min-height: 38px; }
    .generate-btn, .primary, .accept { background: var(--chalk-gold); color: var(--chalk-green-dark); font-weight: bold; }
    .secondary, .deny { background: transparent; color: var(--chalk-white); }
    .modal .secondary, .modal .deny { color: inherit; }
    button:disabled { opacity: 0.5; cursor: default; }
    .modal-overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55); display: flex; align-items: center; justify-content: center; z-index: 1000; }
    .modal { position: relative; background: #fff; color: #1c1c1c; border-radius: 14px; padding: 24px; width: min(520px, 90vw); max-height: 85vh; overflow-y: auto; font-family: Georgia, "Times New Roman", serif; }
    .close-x { position: absolute; top: 10px; right: 14px; background: none; border: none; font-size: 22px; cursor: pointer; color: inherit; }
    .modal h2 { margin-top: 0; font-family: "Brush Script MT", "Segoe Script", cursive; font-size: 28px; font-weight: 400; }
    .mode-choices { display: flex; gap: 12px; margin-bottom: 16px; }
    .mode-choice { flex: 1; display: flex; flex-direction: column; gap: 4px; padding: 14px; border-radius: 10px; border: 1px solid #ccc; background: none; cursor: pointer; text-align: left; font-family: inherit; color: inherit; }
    .mode-choice.selected { border-color: var(--chalk-gold); background: rgba(212, 175, 106, 0.12); }
    .mode-choice span { font-size: 12px; opacity: 0.75; }
    label { display: block; margin-bottom: 14px; font-size: 13px; }
    input, textarea, select.field { display: block; width: 100%; box-sizing: border-box; margin-top: 4px; padding: 8px; border-radius: 6px; border: 1px solid #ccc; font-family: inherit; font-size: 14px; }
    .modal-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; flex-wrap: wrap; }
    .review-hint { margin: 0 0 12px; font-size: 12px; opacity: 0.75; font-style: italic; }
    .meal-list { display: flex; flex-direction: column; gap: 10px; }
    .meal-card { border: 1px solid #ccc; border-radius: 10px; padding: 12px; }
    .meal-card h3 { margin: 0 0 4px; }
    .meal-card p { margin: 0; font-size: 13px; }
    .meal-card.accepted { border-color: #4a8f5c; background: rgba(74, 143, 92, 0.08); }
    .meal-card.denied { border-color: #b04a4a; background: rgba(176, 74, 74, 0.08); opacity: 0.7; }
    .meal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
    .meal-status { margin-top: 6px; font-size: 12px; font-weight: bold; }
    .grocery-category h3 { margin: 12px 0 4px; font-size: 15px; }
    .grocery-category ul { list-style: none; margin: 0; padding: 0; }
    .grocery-item { display: flex; gap: 8px; align-items: center; margin: 4px 0; font-size: 14px; }
    .grocery-item input { width: auto; margin: 0; }
    .grocery-item .checked { text-decoration: line-through; opacity: 0.55; }
    .error { color: #e57373; }
    .modal .error { color: #b3261e; }
    .loading { font-style: italic; opacity: 0.75; }
  `;

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has("extras")) {
      const calendar = this.extras?.calendarSettings.dinnersCalendar ?? null;
      if (calendar !== this._loadedFor) {
        this._loadedFor = calendar;
        void this._loadWeek();
      }
    }
  }

  private get _isParent(): boolean {
    return this.me?.role === "parent";
  }

  private async _loadWeek(): Promise<void> {
    if (!this.extras.calendarSettings.dinnersCalendar) {
      this._week = [];
      return;
    }
    try {
      const result = await familyApi.dinnerWeek();
      this._week = result.week;
      this._boardError = result.errors.join("; ");
    } catch (err) {
      this._boardError = (err as Error).message;
    }
  }

  // ------------------------------------------------------------ board

  private _days() {
    const byDate = new Map(this._week.map((e) => [e.date, e]));
    const today = new Date();
    return Array.from({ length: 7 }, (_, i) => {
      const date = new Date(today.getTime() + i * DAY_MS);
      const key = localDateKey(date);
      return { date, key, entry: byDate.get(key) ?? null, isToday: i === 0 };
    });
  }

  /** Several days with the same dish = one batch-prepped Meal Prep dish
   * (the calendar has no other record of which wizard mode made it). */
  private _mealPrepGroups(days: ReturnType<FamilyMealsView["_days"]>) {
    const groups = new Map<string, { dish: string; notes: string | null; days: typeof days }>();
    for (const day of days) {
      if (!day.entry?.dish) continue;
      const group = groups.get(day.entry.dish) ?? { dish: day.entry.dish, notes: day.entry.notes, days: [] };
      group.days.push(day);
      groups.set(day.entry.dish, group);
    }
    return [...groups.values()].filter((g) => g.days.length > 1);
  }

  private async _moveMeal(entry: DinnerEntry, newDate: string, select: HTMLSelectElement): Promise<void> {
    select.value = "";
    if (!newDate || !entry.uid) return;
    this._moveError = "";
    try {
      await familyApi.call(this.hass, "move_meal", {
        uid: entry.uid,
        name: entry.dish,
        description: entry.notes ?? "",
        new_date: newDate,
      });
      await this._loadWeek();
    } catch (err) {
      this._moveError = (err as Error).message || "Could not move that meal.";
    }
  }

  // ----------------------------------------------------------- wizard

  private _openWizard(): void {
    this._wizard = {
      step: "mode",
      mode: "dinner_planning",
      servings: 4,
      days: 7,
      preferences: "",
      slots: [],
      seenNames: [],
      grocery: [],
      loading: false,
      error: "",
    };
  }

  private _patch(patch: Partial<Wizard>): void {
    if (this._wizard) this._wizard = { ...this._wizard, ...patch };
  }

  private _deniedIndexes(): number[] {
    return (this._wizard?.slots ?? []).flatMap((s, i) => (s.status === "denied" ? [i] : []));
  }

  private async _generate(excludeNames: string[]): Promise<void> {
    const w = this._wizard;
    if (!w) return;
    this._patch({ loading: true, error: "" });
    const count = excludeNames.length === 0
      ? (w.mode === "meal_prep" ? MEAL_PREP_OPTION_COUNT : Math.max(1, w.days))
      : this._deniedIndexes().length;
    try {
      const response = await familyApi.call<{ meals?: Array<{ name: string; description: string }> }>(
        this.hass,
        "generate_meal_plan",
        {
          mode: w.mode,
          servings: Math.max(1, w.servings),
          days: Math.max(1, w.days),
          count,
          ...(w.preferences ? { preferences: w.preferences } : {}),
          exclude_meal_names: excludeNames,
        }
      );
      const meals = response.meals ?? [];
      const seenNames = [...w.seenNames, ...meals.map((m) => m.name)];
      let slots: Slot[];
      if (excludeNames.length === 0) {
        slots = meals.map((m) => ({ ...m, status: "pending" }));
      } else {
        slots = [...w.slots];
        this._deniedIndexes().forEach((slotIndex, i) => {
          if (meals[i]) slots[slotIndex] = { ...meals[i], status: "pending" };
        });
      }
      this._patch({ slots, seenNames, loading: false, step: "review" });
    } catch (err) {
      this._patch({ loading: false, error: (err as Error).message || "Something went wrong asking the AI for meals." });
    }
  }

  private _decide(index: number, status: SlotStatus): void {
    const w = this._wizard;
    if (!w) return;
    const slots = w.slots.map((s, i) => {
      if (i === index) return { ...s, status };
      // Meal Prep needs only one dish - accepting one dismisses the rest.
      if (status === "accepted" && w.mode === "meal_prep" && s.status !== "accepted") {
        return { ...s, status: "denied" as SlotStatus };
      }
      return s;
    });
    this._patch({ slots });
  }

  /** Dinner Planning: slot i is "today + i days". Meal Prep: the one
   * accepted dish on every day of the period. */
  private _scheduledMeals() {
    const w = this._wizard!;
    const dateAt = (i: number) => localDateKey(new Date(Date.now() + i * DAY_MS));
    if (w.mode === "meal_prep") {
      const dish = w.slots.find((s) => s.status === "accepted");
      if (!dish) return [];
      return Array.from({ length: Math.max(1, w.days) }, (_, i) => ({
        name: dish.name,
        description: dish.description || "",
        date: dateAt(i),
      }));
    }
    return w.slots.flatMap((s, i) =>
      s.status === "accepted" ? [{ name: s.name, description: s.description || "", date: dateAt(i) }] : []
    );
  }

  private async _submit(): Promise<void> {
    const w = this._wizard;
    if (!w) return;
    this._patch({ loading: true, error: "" });
    try {
      await familyApi.call(this.hass, "schedule_meals", { meals: this._scheduledMeals() });
      await this._loadWeek();
      const accepted = w.slots
        .filter((s) => s.status === "accepted")
        .map((s) => ({ name: s.name, description: s.description || "" }));
      const response = await familyApi.call<{ categories?: GroceryCategory[] }>(
        this.hass,
        "generate_grocery_list",
        { meals: accepted, servings: Math.max(1, w.servings) }
      );
      this._patch({ loading: false, step: "grocery", grocery: checklist(response.categories ?? []) });
    } catch (err) {
      this._patch({ loading: false, error: (err as Error).message || "Something went wrong finishing the meal plan." });
    }
  }

  // --------------------------------------------------------- settings

  private async _openSettings(): Promise<void> {
    this._dinnersDraft = this.extras.calendarSettings.dinnersCalendar ?? "";
    this._settingsError = "";
    this._settingsOpen = true;
    try {
      this._calendars = await familyApi.listCalendars();
    } catch (err) {
      this._settingsError = (err as Error).message;
    }
  }

  private async _saveSettings(): Promise<void> {
    try {
      await familyApi.call(this.hass, "update_calendar_settings", {
        dinners_calendar: this._dinnersDraft || null,
      });
      this._settingsOpen = false;
    } catch (err) {
      this._settingsError = (err as Error).message;
    }
  }

  // ------------------------------------------------------------ render

  private _checklist(categories: CheckCategory[], onToggle: (ci: number, ii: number) => void) {
    return categories.map(
      (cat, ci) => html`<div class="grocery-category">
        <h3>${cat.category}</h3>
        <ul>
          ${cat.items.map(
            (item, ii) => html`<li>
              <label class="grocery-item">
                <input type="checkbox" .checked=${item.checked} @change=${() => onToggle(ci, ii)} />
                <span class=${item.checked ? "checked" : ""}>${item.label}</span>
              </label>
            </li>`
          )}
        </ul>
      </div>`
    );
  }

  private _toggled(categories: CheckCategory[], ci: number, ii: number): CheckCategory[] {
    return categories.map((cat, c) =>
      c !== ci ? cat : { ...cat, items: cat.items.map((it, i) => (i === ii ? { ...it, checked: !it.checked } : it)) }
    );
  }

  private _wizardBody(w: Wizard) {
    const cancel = html`<button class="secondary" @click=${() => (this._wizard = null)}>Cancel</button>`;
    const error = w.error ? html`<p class="error">${w.error}</p>` : nothing;
    if (w.step === "mode") {
      return html`<h2>What are we planning?</h2>
        <div class="mode-choices">
          <button class="mode-choice ${w.mode === "dinner_planning" ? "selected" : ""}" @click=${() => this._patch({ mode: "dinner_planning" })}>
            <strong>Dinner Planning</strong><span>One different meal per day</span>
          </button>
          <button class="mode-choice ${w.mode === "meal_prep" ? "selected" : ""}" @click=${() => this._patch({ mode: "meal_prep" })}>
            <strong>Meal Prep</strong><span>One dish covering the whole period</span>
          </button>
        </div>
        <div class="modal-actions">${cancel}<button class="primary" @click=${() => this._patch({ step: "params" })}>Next</button></div>`;
    }
    if (w.step === "params") {
      return html`<h2>Details</h2>
        <label>Servings<input type="number" min="1" .value=${String(w.servings)} @input=${(e: Event) => this._patch({ servings: Number((e.target as HTMLInputElement).value) || 1 })} /></label>
        <label>Days<input type="number" min="1" .value=${String(w.days)} @input=${(e: Event) => this._patch({ days: Number((e.target as HTMLInputElement).value) || 1 })} /></label>
        <label>Preferences (optional)
          <textarea rows="3" placeholder="e.g. no seafood, kid-friendly, quick weeknight meals" .value=${w.preferences} @input=${(e: Event) => this._patch({ preferences: (e.target as HTMLTextAreaElement).value })}></textarea>
        </label>
        <div class="modal-actions">
          ${cancel}
          <button class="primary" ?disabled=${w.loading} @click=${() => this._generate([])}>${w.loading ? "Asking the chef..." : "Generate Meals"}</button>
        </div>
        ${error}`;
    }
    if (w.step === "review") {
      const allDecided = w.slots.every((s) => s.status !== "pending");
      const anyAccepted = w.slots.some((s) => s.status === "accepted");
      const anyDenied = w.slots.some((s) => s.status === "denied");
      const canSubmit = w.mode === "meal_prep" ? anyAccepted : allDecided && w.slots.every((s) => s.status === "accepted");
      const canRegenerate = w.mode === "meal_prep" ? !anyAccepted && allDecided && anyDenied : allDecided && anyDenied;
      return html`<h2>Review Meals</h2>
        ${w.mode === "meal_prep" ? html`<p class="review-hint">Pick your favorite - the rest will be dismissed automatically.</p>` : nothing}
        <div class="meal-list">
          ${w.slots.map(
            (slot, i) => html`<div class="meal-card ${slot.status}">
              <h3>${slot.name}</h3>
              <p>${slot.description}</p>
              ${slot.status === "pending"
                ? html`<div class="meal-actions">
                    <button class="deny" @click=${() => this._decide(i, "denied")}>Deny</button>
                    <button class="accept" @click=${() => this._decide(i, "accepted")}>Accept</button>
                  </div>`
                : html`<div class="meal-status">${slot.status === "accepted" ? "✓ Accepted" : "✗ Denied"}</div>`}
            </div>`
          )}
        </div>
        <div class="modal-actions">
          ${cancel}
          ${canRegenerate ? html`<button class="secondary" ?disabled=${w.loading} @click=${() => this._generate([...w.seenNames])}>Regenerate Denied</button>` : nothing}
          ${canSubmit ? html`<button class="primary" ?disabled=${w.loading} @click=${this._submit}>Submit</button>` : nothing}
        </div>
        ${w.loading ? html`<p class="loading">Asking the chef...</p>` : nothing}
        ${error}`;
    }
    return html`<h2>Grocery List</h2>
      <div>${this._checklist(w.grocery, (ci, ii) => this._patch({ grocery: this._toggled(w.grocery, ci, ii) }))}</div>
      <div class="modal-actions"><button class="primary" @click=${() => (this._wizard = null)}>Done</button></div>`;
  }

  private _modal(body: unknown, onClose: () => void) {
    return html`<div class="modal-overlay" @click=${(e: Event) => e.target === e.currentTarget && onClose()}>
      <div class="modal" role="dialog">
        <button class="close-x" aria-label="Close" @click=${onClose}>&times;</button>
        ${body}
      </div>
    </div>`;
  }

  render() {
    if (!this.extras) return nothing;
    const configured = Boolean(this.extras.calendarSettings.dinnersCalendar);
    const days = this._days();
    const dayName = new Intl.DateTimeFormat(undefined, { weekday: "short" });
    const dayNum = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
    const groups = this._mealPrepGroups(days);
    const hasGrocery = this.extras.groceryList.length > 0;

    return html`
      <div class="board">
        <div class="header">
          <span class="title">This Week&rsquo;s Dinners</span><span class="flourish">&#10022;</span>
          ${this._isParent ? html`<button class="gear" aria-label="Meals settings" @click=${this._openSettings}><ha-icon icon="mdi:cog"></ha-icon></button>` : nothing}
        </div>
        <div class="week">
          ${days.map(
            (day) => html`<div class="day ${day.isToday ? "today" : ""}">
              <div class="day-label">${dayName.format(day.date)}</div>
              <div class="day-date">${dayNum.format(day.date)}</div>
              <div class="dish ${day.entry ? "" : "empty"}">${day.entry ? day.entry.dish : "No dinner planned"}</div>
              ${day.entry?.notes ? html`<p class="notes">${day.entry.notes}</p>` : nothing}
              ${this._isParent && day.entry?.uid
                ? html`<select class="move-select" @change=${(e: Event) => this._moveMeal(day.entry!, (e.target as HTMLSelectElement).value, e.target as HTMLSelectElement)}>
                    <option value="">Move to…</option>
                    ${days.filter((d) => d.key !== day.key).map((d) => html`<option value=${d.key}>${dayName.format(d.date)} ${dayNum.format(d.date)}</option>`)}
                  </select>`
                : nothing}
            </div>`
          )}
        </div>
        ${groups.length
          ? html`<div class="meal-prep-tiles">
              ${groups.map(
                (g) => html`<div class="meal-prep-tile">
                  <div class="meal-prep-label">Meal Prep&nbsp;&mdash; ${g.days.length} days</div>
                  <div class="meal-prep-dish">${g.dish}</div>
                  ${g.notes ? html`<p class="meal-prep-notes">${g.notes}</p>` : nothing}
                  <div class="meal-prep-when">${g.days.map((d) => dayName.format(d.date)).join(", ")}</div>
                </div>`
              )}
            </div>`
          : nothing}
        ${!configured
          ? html`<p class="board-note">${this._isParent ? "Pick your Dinners calendar with the gear above to get started." : "A parent needs to pick the Dinners calendar first."}</p>`
          : nothing}
        ${this._boardError ? html`<p class="error board-note">${this._boardError}</p>` : nothing}
        ${this._moveError ? html`<p class="error board-note">${this._moveError}</p>` : nothing}
        <div class="footer">
          ${this._isParent && configured ? html`<button class="generate-btn" @click=${this._openWizard}>Generate Meal Plan</button>` : nothing}
          ${hasGrocery ? html`<button class="secondary" @click=${() => (this._groceryView = checklist(this.extras.groceryList))}>View Grocery List</button>` : nothing}
        </div>
      </div>
      ${this._wizard ? this._modal(this._wizardBody(this._wizard), () => (this._wizard = null)) : nothing}
      ${this._groceryView
        ? this._modal(
            html`<h2>Grocery List</h2>
              <div>${this._checklist(this._groceryView, (ci, ii) => (this._groceryView = this._toggled(this._groceryView!, ci, ii)))}</div>
              <div class="modal-actions"><button class="primary" @click=${() => (this._groceryView = null)}>Done</button></div>`,
            () => (this._groceryView = null)
          )
        : nothing}
      ${this._settingsOpen
        ? this._modal(
            html`<h2>Meals settings</h2>
              <label>Dinners calendar
                <select class="field" @change=${(e: Event) => (this._dinnersDraft = (e.target as HTMLSelectElement).value)}>
                  <option value="" ?selected=${!this._dinnersDraft}>None</option>
                  ${this._calendars.map((c) => html`<option value=${c.entity_id} ?selected=${c.entity_id === this._dinnersDraft}>${c.name}</option>`)}
                </select>
              </label>
              <p class="review-hint">Accepted meal plans are added here as all-day events. A dedicated Google Calendar (e.g. "Dinners") keeps them off the family calendar.</p>
              ${this._settingsError ? html`<p class="error">${this._settingsError}</p>` : nothing}
              <div class="modal-actions">
                <button class="secondary" @click=${() => (this._settingsOpen = false)}>Cancel</button>
                <button class="primary" @click=${this._saveSettings}>Save</button>
              </div>`,
            () => (this._settingsOpen = false)
          )
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "family-meals-view": FamilyMealsView;
  }
}
