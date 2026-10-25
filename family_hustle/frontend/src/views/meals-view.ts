import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, query, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import {
  familyApi,
  recipeFor,
  type CalendarInfo,
  type DinnerEntry,
  type FamilyExtras,
  type GroceryCategory,
} from "../family-api";
import type { MemberRosterEntry } from "../types";
import { formStyles } from "../styles";
import "../components/hustle-dialog";
import "./recipes-view";
import type { FamilyRecipesView } from "./recipes-view";

/* The Meals tab, in two sections:
 * - This week: the next seven dinners as a list (they're also on the
 *   Calendar tab now, so this is the place to plan them rather than
 *   another calendar). Each night can get a dinner - typed, or picked from
 *   the recipe box - and a planned one can move, be removed, or open its
 *   recipe (matched by title). The AI meal planner (Household's wizard:
 *   mode -> details -> review with accept/deny/regenerate -> schedule +
 *   grocery list) lives here, and the last grocery list sits underneath
 *   with "Add to shopping list".
 * - Recipes: the recipe box (recipes-view.ts).
 * Kids see both; planning and editing are for parents, the ⚙ (which
 * calendar holds dinners) for admin parents. */

const MEAL_PREP_OPTION_COUNT = 5;
const DAY_MS = 86_400_000;
const SECTION_KEY = "family-hustle-meals-section";

type Section = "week" | "recipes";
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
interface Day {
  date: Date;
  key: string;
  entry: DinnerEntry | null;
  isToday: boolean;
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

function savedSection(): Section {
  try {
    return window.localStorage.getItem(SECTION_KEY) === "recipes" ? "recipes" : "week";
  } catch {
    return "week";
  }
}

@customElement("family-meals-view")
export class FamilyMealsView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) extras!: FamilyExtras;
  @property({ attribute: false }) me!: MemberRosterEntry;

  @state() private _section: Section = savedSection();
  @state() private _week: DinnerEntry[] = [];
  @state() private _loadingWeek = false;
  @state() private _error = "";
  @state() private _wizard: Wizard | null = null;
  @state() private _grocery: CheckCategory[] = [];
  @state() private _groceryStatus = "";
  @state() private _adding: { date: string; name: string; recipeId: string } | null = null;
  @state() private _settingsOpen = false;
  @state() private _calendars: CalendarInfo[] = [];
  @state() private _dinnersDraft = "";

  @query("family-recipes-view") private _recipesView?: FamilyRecipesView;

  private _loadedFor: string | null | undefined = undefined;
  private _groceryFrom: string | null | undefined = undefined;

  static styles = [
    formStyles,
    css`
      :host { display: block; max-width: 960px; margin: 0 auto; color: var(--primary-text-color); }
      .head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
      h1 { font-family: Georgia, "Times New Roman", serif; font-weight: 600; font-size: 1.7rem; margin: 0; }
      .seg { display: inline-flex; border: 1px solid var(--divider-color); border-radius: 999px; overflow: hidden; background: var(--card-background-color); }
      .seg button { border: 0; background: transparent; padding: 6px 16px; min-height: 36px; cursor: pointer; color: var(--secondary-text-color); font: inherit; }
      .seg button.on { background: var(--fh-surface-2); color: var(--primary-text-color); font-weight: 650; }
      .gear { margin-left: auto; border: 1px solid var(--divider-color); background: var(--card-background-color); color: inherit; border-radius: 999px; min-height: 36px; min-width: 36px; display: grid; place-items: center; cursor: pointer; }
      .card { background: var(--card-background-color); border: 1px solid var(--divider-color); border-radius: 18px; overflow: hidden; margin-bottom: 16px; }
      .card-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--divider-color); flex-wrap: wrap; }
      .card-head h2 { margin: 0; font-size: 1.05rem; flex: 1; }
      .card-head .sub { color: var(--secondary-text-color); font-size: .85rem; }
      .notice { padding: 14px 16px; border-radius: 14px; background: var(--fh-warn-bg); color: var(--fh-warn-ink); margin-bottom: 14px; }
      .notice.error { background: var(--fh-error-bg); color: var(--fh-error-ink); }

      .day { display: flex; gap: 14px; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--divider-color); min-height: 64px; box-sizing: border-box; }
      .day:last-child { border-bottom: 0; }
      .date { width: 48px; flex: none; text-align: center; line-height: 1.1; }
      .date .dow { font-size: .72rem; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--secondary-text-color); }
      .date .num { font-size: 1.35rem; font-weight: 700; }
      .day.today .date .dow, .day.today .date .num { color: #e57368; }
      .dish { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
      .dish .name { font-size: 1.05rem; font-weight: 650; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .dish .notes { color: var(--secondary-text-color); font-size: .88rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dish .none { color: var(--secondary-text-color); font-style: italic; }
      .card.prep .card-head { border-bottom: 0; padding-bottom: 4px; --mdc-icon-size: 22px; }
      .card.prep .card-head ha-icon { color: #d4af6a; }
      .prep-body { margin: 0; padding: 0 16px 14px 48px; line-height: 1.5; }
      .pill { font-size: .72rem; font-weight: 650; padding: 2px 8px; border-radius: 999px; background: color-mix(in srgb, #d4af6a 30%, var(--fh-tint-base)); color: inherit; }
      .day-actions { display: flex; gap: 6px; align-items: center; flex: none; }
      .day-actions select { width: auto; padding: 6px 8px; font-size: .85rem; }
      .link { border: 1px solid var(--divider-color); background: var(--card-background-color); color: inherit; border-radius: 999px; padding: 6px 12px; min-height: 36px; font: inherit; font-size: .88rem; cursor: pointer; display: inline-flex; align-items: center; gap: 6px; --mdc-icon-size: 18px; }
      .link.add { color: var(--primary-color); border-style: dashed; }
      .icon { border: 0; background: none; color: var(--secondary-text-color); min-height: 36px; min-width: 36px; cursor: pointer; --mdc-icon-size: 20px; }
      .icon:hover { color: var(--fh-danger); }

      .grocery { padding: 6px 16px 14px; columns: 2 220px; column-gap: 24px; }
      .grocery-category { break-inside: avoid; }
      .grocery-category h3 { margin: 12px 0 4px; font-size: .9rem; color: var(--secondary-text-color); text-transform: uppercase; letter-spacing: .04em; }
      .grocery-category ul { list-style: none; margin: 0; padding: 0; }
      .grocery-item { display: flex; gap: 10px; align-items: center; margin: 0; padding: 6px 0; font-size: .95rem; color: inherit; cursor: pointer; }
      .grocery-item input { width: auto; margin: 0; }
      .grocery-item .checked { text-decoration: line-through; color: var(--secondary-text-color); }
      .hint { color: var(--secondary-text-color); font-size: .88rem; margin: 0; }
      .ok { color: var(--primary-color); font-size: .9rem; }
      .err { color: var(--fh-danger); }
      button.ghost { background: var(--card-background-color); color: inherit; border: 1px solid var(--divider-color); border-radius: 10px; padding: 10px 16px; cursor: pointer; }
      .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px; flex-wrap: wrap; }

      /* AI planner */
      .mode-choices { display: flex; gap: 12px; margin-bottom: 8px; }
      .mode-choice { flex: 1; display: flex; flex-direction: column; gap: 4px; padding: 14px; border-radius: 12px; border: 1px solid var(--divider-color); background: none; cursor: pointer; text-align: left; font: inherit; color: inherit; }
      .mode-choice.selected { border-color: var(--primary-color); background: color-mix(in srgb, var(--primary-color) 12%, var(--fh-tint-base)); }
      .mode-choice span { font-size: .85rem; color: var(--secondary-text-color); }
      .meal-list { display: flex; flex-direction: column; gap: 10px; }
      .meal-card { border: 1px solid var(--divider-color); border-radius: 12px; padding: 12px; }
      .meal-card h3 { margin: 0 0 4px; font-size: 1rem; }
      .meal-card p { margin: 0; font-size: .9rem; color: var(--secondary-text-color); }
      .meal-card.accepted { border-color: #4a8f5c; background: color-mix(in srgb, #4a8f5c 12%, var(--fh-tint-base)); }
      .meal-card.denied { border-color: #b04a4a; opacity: 0.6; }
      .meal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
      .meal-status { margin-top: 6px; font-size: .85rem; font-weight: 650; }
      .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }

      @media (max-width: 600px) {
        .day { flex-wrap: wrap; gap: 10px; padding: 12px; }
        .day:not(.empty) .day-actions { width: 100%; justify-content: flex-end; padding-left: 62px; box-sizing: border-box; }
        .day.empty { flex-wrap: nowrap; }
        .grocery { columns: 1; }
      }
    `,
  ];

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has("extras") && this.extras) {
      const calendar = this.extras.calendarSettings.dinnersCalendar;
      if (calendar !== this._loadedFor) {
        this._loadedFor = calendar;
        void this._loadWeek();
      }
      // Keep checkmarks until a new list arrives.
      if (this.extras.groceryGeneratedAt !== this._groceryFrom) {
        this._groceryFrom = this.extras.groceryGeneratedAt;
        this._grocery = checklist(this.extras.groceryList);
      }
    }
  }

  private get _isParent(): boolean {
    return this.me?.role === "parent";
  }

  private get _isAdmin(): boolean {
    return this._isParent && this.me?.permissionLevel === "admin";
  }

  private _setSection(section: Section): void {
    this._section = section;
    try {
      window.localStorage.setItem(SECTION_KEY, section);
    } catch {
      // not remembered - harmless
    }
  }

  private async _loadWeek(): Promise<void> {
    if (!this.extras.calendarSettings.dinnersCalendar) {
      this._week = [];
      return;
    }
    this._loadingWeek = true;
    try {
      const result = await familyApi.dinnerWeek();
      this._week = result.week;
      this._error = result.errors.join("; ");
    } catch (err) {
      this._error = (err as Error).message;
    } finally {
      this._loadingWeek = false;
    }
  }

  private async _do(service: string, data: Record<string, unknown>): Promise<boolean> {
    this._error = "";
    try {
      await familyApi.call(this.hass, service, data);
      await this._loadWeek();
      return true;
    } catch (err) {
      this._error = (err as Error).message;
      return false;
    }
  }

  // ------------------------------------------------------- this week

  private _days(): Day[] {
    const byDate = new Map(this._week.map((e) => [e.date, e]));
    const today = new Date();
    return Array.from({ length: 7 }, (_, i) => {
      const date = new Date(today.getTime() + i * DAY_MS);
      const key = localDateKey(date);
      return { date, key, entry: byDate.get(key) ?? null, isToday: i === 0 };
    });
  }

  /** Day key -> length of its run of consecutive days with the same dish.
   * 3+ in a row reads as a Meal Prep batch (the calendar has no other record
   * of which planner mode made it); two nights of the same dinner is just
   * a repeat. */
  private _prepRuns(days: Day[]): Map<string, number> {
    const runs = new Map<string, number>();
    let i = 0;
    while (i < days.length) {
      const dish = days[i].entry?.dish;
      let j = i + 1;
      while (dish && j < days.length && days[j].entry?.dish === dish) j += 1;
      for (let k = i; k < j; k += 1) runs.set(days[k].key, dish ? j - i : 0);
      i = j;
    }
    return runs;
  }

  private _openRecipe(id: string): void {
    this._setSection("recipes");
    void this.updateComplete.then(() => this._recipesView?.openRecipe(id));
  }

  private _writeRecipe(entry: DinnerEntry): void {
    this._setSection("recipes");
    void this.updateComplete.then(() => this._recipesView?.newRecipe(entry.dish, entry.notes ?? "", true));
  }

  private async _saveDinner(): Promise<void> {
    const a = this._adding;
    if (!a) return;
    const recipe = this.extras.recipes.find((r) => r.id === a.recipeId);
    const name = recipe?.title ?? a.name.trim();
    if (!name) {
      this._error = "Pick a recipe or type what's for dinner.";
      return;
    }
    if (await this._do("schedule_meals", { meals: [{ name, description: recipe?.description ?? "", date: a.date }] })) {
      this._adding = null;
    }
  }

  private _dayRow(day: Day, days: Day[], runs: Map<string, number>) {
    const entry = day.entry;
    const recipe = recipeFor(this.extras.recipes, entry?.dish);
    const label = day.isToday ? "Today" : day.date.toLocaleDateString(undefined, { weekday: "short" });
    const run = runs.get(day.key) ?? 0;
    const prepDays = entry?.meal_prep ? Math.max(run, 1) : run >= 3 ? run : 0;
    return html`<div class="day ${day.isToday ? "today" : ""} ${entry ? "" : "empty"}">
      <div class="date"><div class="dow">${label}</div><div class="num">${day.date.getDate()}</div></div>
      <div class="dish">
        ${entry
          ? html`<span class="name">${entry.dish}${prepDays ? html`<span class="pill">Meal prep</span>` : nothing}</span>
              ${entry.notes ? html`<span class="notes">${entry.notes}</span>` : nothing}`
          : html`<span class="none">Nothing planned</span>`}
      </div>
      <div class="day-actions">
        ${entry && recipe
          ? html`<button class="link" @click=${() => this._openRecipe(recipe.id)}><ha-icon icon="mdi:book-open-variant"></ha-icon>Recipe</button>`
          : entry && this._isParent
            ? html`<button class="link" title="Have the AI write a recipe for this" @click=${() => this._writeRecipe(entry)}><ha-icon icon="mdi:auto-fix"></ha-icon>Get recipe</button>`
            : nothing}
        ${entry && this._isParent && entry.uid
          ? html`<select aria-label="Move ${entry.dish}" @change=${(e: Event) => {
                const select = e.target as HTMLSelectElement;
                const to = select.value;
                select.value = "";
                if (to) void this._do("move_meal", { uid: entry.uid, name: entry.dish, description: entry.notes ?? "", new_date: to, meal_prep: Boolean(entry.meal_prep) });
              }}>
                <option value="">Move…</option>
                ${days.filter((d) => d.key !== day.key).map((d) => html`<option value=${d.key}>${d.isToday ? "Today" : d.date.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}</option>`)}
              </select>
              <button class="icon" aria-label="Remove ${entry.dish}" @click=${() => {
                if (window.confirm(`Take "${entry.dish}" off ${day.isToday ? "today" : label}?`)) void this._do("remove_meal", { uid: entry.uid });
              }}><ha-icon icon="mdi:close"></ha-icon></button>`
          : nothing}
        ${!entry && this._isParent && this.extras.calendarSettings.dinnersCalendar
          ? html`<button class="link add" @click=${() => { this._error = ""; this._adding = { date: day.key, name: "", recipeId: "" }; }}><ha-icon icon="mdi:plus"></ha-icon>Add dinner</button>`
          : nothing}
      </div>
    </div>`;
  }

  /** One card per Meal Prep batch this week: the dish, which nights it
   * covers, and its recipe. A batch is the dinners marked as meal prep when
   * they were scheduled (plus, for ones planned before that marking
   * existed, 3+ nights in a row of the same dish). */
  private _mealPrepCards(days: Day[], runs: Map<string, number>) {
    const batches = new Map<string, { dish: string; notes: string | null; days: Day[] }>();
    for (const day of days) {
      const entry = day.entry;
      if (!entry || !(entry.meal_prep || (runs.get(day.key) ?? 0) >= 3)) continue;
      const batch = batches.get(entry.dish) ?? { dish: entry.dish, notes: entry.notes, days: [] };
      batch.days.push(day);
      batches.set(entry.dish, batch);
    }
    if (!batches.size) return nothing;
    return [...batches.values()].map((b) => {
      const recipe = recipeFor(this.extras.recipes, b.dish);
      const nights = b.days
        .map((d) => (d.isToday ? "Today" : d.date.toLocaleDateString(undefined, { weekday: "short" })))
        .join(", ");
      return html`<div class="card prep">
        <div class="card-head">
          <ha-icon icon="mdi:pot-steam-outline"></ha-icon>
          <h2>Meal prep: ${b.dish}</h2>
          ${recipe
            ? html`<button class="link" @click=${() => this._openRecipe(recipe.id)}><ha-icon icon="mdi:book-open-variant"></ha-icon>Recipe</button>`
            : this._isParent
              ? html`<button class="link" @click=${() => this._writeRecipe(b.days[0].entry!)}><ha-icon icon="mdi:auto-fix"></ha-icon>Get recipe</button>`
              : nothing}
        </div>
        <p class="prep-body">
          ${b.notes ? html`${b.notes}<br />` : nothing}
          <span class="hint">${b.days.length} ${b.days.length === 1 ? "night" : "nights"}: ${nights}</span>
        </p>
      </div>`;
    });
  }

  private _weekSection() {
    const configured = Boolean(this.extras.calendarSettings.dinnersCalendar);
    const days = this._days();
    const runs = this._prepRuns(days);
    return html`
      ${!configured
        ? html`<div class="notice">${this._isAdmin ? "Pick the calendar that holds your dinners with the ⚙ above to start planning." : "An admin parent needs to pick the Dinners calendar first."}</div>`
        : nothing}
      ${this._error && !this._adding ? html`<div class="notice error">${this._error}</div>` : nothing}
      ${this._mealPrepCards(days, runs)}
      <div class="card">
        <div class="card-head">
          <h2>This week's dinners</h2>
          <span class="sub">${this._loadingWeek ? "Loading…" : "Also on the Calendar tab"}</span>
          ${this._isParent && configured
            ? html`<button class="ghost" @click=${() => this._openWizard("meal_prep")}><ha-icon icon="mdi:pot-steam-outline"></ha-icon> Meal prep</button>
                <button class="primary" @click=${() => this._openWizard("dinner_planning")}><ha-icon icon="mdi:auto-fix"></ha-icon> Plan with AI</button>`
            : nothing}
        </div>
        ${days.map((d) => this._dayRow(d, days, runs))}
      </div>
      ${this._groceryCard()}
    `;
  }

  // --------------------------------------------------------- grocery

  private async _sendToShopping(categories: CheckCategory[]): Promise<void> {
    const items = categories.flatMap((c) => c.items.filter((i) => !i.checked).map((i) => i.label));
    if (!items.length) {
      this._groceryStatus = "Everything's checked off - nothing to add.";
      return;
    }
    this._groceryStatus = "Adding…";
    try {
      const result = await familyApi.call<{ added?: number }>(this.hass, "shopping_add_items", { items });
      const added = result.added ?? 0;
      this._groceryStatus = added
        ? `Added ${added} item${added === 1 ? "" : "s"} to the shopping list.`
        : "Already on the shopping list.";
    } catch (err) {
      this._groceryStatus = (err as Error).message;
    }
  }

  private _checklist(categories: CheckCategory[], onToggle: (ci: number, ii: number) => void) {
    return categories.map(
      (cat, ci) => html`<div class="grocery-category">
        <h3>${cat.category}</h3>
        <ul>
          ${cat.items.map(
            (item, ii) => html`<li><label class="grocery-item">
              <input type="checkbox" .checked=${item.checked} @change=${() => onToggle(ci, ii)} />
              <span class=${item.checked ? "checked" : ""}>${item.label}</span>
            </label></li>`
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

  private _groceryCard() {
    if (!this._grocery.length) return nothing;
    const when = this.extras.groceryGeneratedAt
      ? new Date(this.extras.groceryGeneratedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })
      : "";
    return html`<div class="card">
      <div class="card-head">
        <h2>Grocery list</h2>
        <span class="sub">From the meal plan${when ? ` on ${when}` : ""}. Check off what you already have.</span>
        ${this.extras.calendarSettings.shoppingList
          ? html`<button class="ghost" @click=${() => this._sendToShopping(this._grocery)}><ha-icon icon="mdi:cart-plus"></ha-icon> Add to shopping list</button>`
          : nothing}
      </div>
      ${this._groceryStatus && !this._wizard ? html`<p class="ok" style="padding: 10px 16px 0">${this._groceryStatus}</p>` : nothing}
      <div class="grocery">${this._checklist(this._grocery, (ci, ii) => (this._grocery = this._toggled(this._grocery, ci, ii)))}</div>
    </div>`;
  }

  // ---------------------------------------------------------- planner

  /** Plan with AI asks which kind of plan first; Meal prep skips straight to
   * its details. */
  private _openWizard(mode: Wizard["mode"] = "dinner_planning"): void {
    this._groceryStatus = "";
    this._wizard = {
      step: mode === "meal_prep" ? "params" : "mode",
      mode,
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
    const count =
      excludeNames.length === 0
        ? w.mode === "meal_prep"
          ? MEAL_PREP_OPTION_COUNT
          : Math.max(1, w.days)
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
        meal_prep: true,
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

  private _wizardBody(w: Wizard) {
    const cancel = html`<button class="ghost" @click=${() => (this._wizard = null)}>Cancel</button>`;
    const error = w.error ? html`<p class="err">${w.error}</p>` : nothing;
    if (w.step === "mode") {
      return html`<div class="mode-choices">
          <button class="mode-choice ${w.mode === "dinner_planning" ? "selected" : ""}" @click=${() => this._patch({ mode: "dinner_planning" })}>
            <strong>Dinner Planning</strong><span>A different dinner each day</span>
          </button>
          <button class="mode-choice ${w.mode === "meal_prep" ? "selected" : ""}" @click=${() => this._patch({ mode: "meal_prep" })}>
            <strong>Meal Prep</strong><span>One batch dish for the whole stretch</span>
          </button>
        </div>
        <div class="actions">${cancel}<button class="primary" @click=${() => this._patch({ step: "params" })}>Next</button></div>`;
    }
    if (w.step === "params") {
      return html`<div class="row2">
          <div><label>Servings</label><input type="number" min="1" .value=${String(w.servings)} @input=${(e: Event) => this._patch({ servings: Number((e.target as HTMLInputElement).value) || 1 })} /></div>
          <div><label>Days</label><input type="number" min="1" .value=${String(w.days)} @input=${(e: Event) => this._patch({ days: Number((e.target as HTMLInputElement).value) || 1 })} /></div>
        </div>
        <label>Preferences (optional)</label>
        <textarea rows="3" placeholder="e.g. no seafood, kid-friendly, quick weeknight meals" .value=${w.preferences} @input=${(e: Event) => this._patch({ preferences: (e.target as HTMLTextAreaElement).value })}></textarea>
        ${error}
        <div class="actions">
          ${cancel}
          <button class="primary" ?disabled=${w.loading} @click=${() => this._generate([])}>${w.loading ? "Asking the chef…" : "Suggest dinners"}</button>
        </div>`;
    }
    if (w.step === "review") {
      const allDecided = w.slots.every((s) => s.status !== "pending");
      const anyAccepted = w.slots.some((s) => s.status === "accepted");
      const anyDenied = w.slots.some((s) => s.status === "denied");
      const canSubmit = w.mode === "meal_prep" ? anyAccepted : allDecided && w.slots.every((s) => s.status === "accepted");
      const canRegenerate = w.mode === "meal_prep" ? !anyAccepted && allDecided && anyDenied : allDecided && anyDenied;
      return html`<p class="hint">${w.mode === "meal_prep" ? "Pick your favorite - the rest are dismissed automatically." : "Accept the ones you like; deny the rest to get new ideas."}</p>
        <div class="meal-list" style="margin-top:10px">
          ${w.slots.map(
            (slot, i) => html`<div class="meal-card ${slot.status}">
              <h3>${w.mode === "dinner_planning" ? html`<small class="hint">${new Date(Date.now() + i * DAY_MS).toLocaleDateString(undefined, { weekday: "short" })} · </small>` : nothing}${slot.name}</h3>
              <p>${slot.description}</p>
              ${slot.status === "pending"
                ? html`<div class="meal-actions">
                    <button class="ghost" @click=${() => this._decide(i, "denied")}>Deny</button>
                    <button class="primary" @click=${() => this._decide(i, "accepted")}>Accept</button>
                  </div>`
                : html`<div class="meal-status">${slot.status === "accepted" ? "✓ Accepted" : "✗ Denied"}</div>`}
            </div>`
          )}
        </div>
        ${w.loading ? html`<p class="hint">Asking the chef…</p>` : nothing}
        ${error}
        <div class="actions">
          ${cancel}
          ${canRegenerate ? html`<button class="ghost" ?disabled=${w.loading} @click=${() => this._generate([...w.seenNames])}>Regenerate denied</button>` : nothing}
          ${canSubmit ? html`<button class="primary" ?disabled=${w.loading} @click=${this._submit}>Add to dinners</button>` : nothing}
        </div>`;
    }
    return html`<p class="hint">Added to your dinners. Check off what you already have, then send the rest to the shopping list.</p>
      <div class="grocery" style="padding:0">${this._checklist(w.grocery, (ci, ii) => this._patch({ grocery: this._toggled(w.grocery, ci, ii) }))}</div>
      ${this._groceryStatus ? html`<p class="ok">${this._groceryStatus}</p>` : nothing}
      <div class="actions">
        ${this.extras.calendarSettings.shoppingList
          ? html`<button class="ghost" @click=${() => this._sendToShopping(w.grocery)}>Add to shopping list</button>`
          : nothing}
        <button class="primary" @click=${() => { this._grocery = w.grocery; this._groceryStatus = ""; this._wizard = null; }}>Done</button>
      </div>`;
  }

  private _wizardTitle(w: Wizard): string {
    return {
      mode: "Plan dinners with AI",
      params: w.mode === "meal_prep" ? "Meal prep with AI" : "Details",
      review: "Review dinners",
      grocery: "Grocery list",
    }[w.step];
  }

  // --------------------------------------------------------- settings

  private async _openSettings(): Promise<void> {
    this._dinnersDraft = this.extras.calendarSettings.dinnersCalendar ?? "";
    this._settingsOpen = true;
    try {
      this._calendars = await familyApi.listCalendars();
    } catch (err) {
      this._error = (err as Error).message;
    }
  }

  private async _saveSettings(): Promise<void> {
    this._settingsOpen = false;
    try {
      await familyApi.call(this.hass, "update_calendar_settings", { dinners_calendar: this._dinnersDraft || null });
    } catch (err) {
      this._error = (err as Error).message;
    }
  }

  // ------------------------------------------------------------ render

  private _addDialog() {
    const a = this._adding;
    if (!a) return nothing;
    const day = new Date(`${a.date}T12:00`).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
    return html`<hustle-dialog open heading="Dinner for ${day}" @hustle-dialog-closed=${() => (this._adding = null)}>
      ${this.extras.recipes.length
        ? html`<label>From the recipe box</label>
            <select @change=${(e: Event) => (this._adding = { ...a, recipeId: (e.target as HTMLSelectElement).value })}>
              <option value="">Choose a recipe…</option>
              ${this.extras.recipes.map((r) => html`<option value=${r.id} ?selected=${r.id === a.recipeId}>${r.title}</option>`)}
            </select>
            <label>Or just type it</label>`
        : html`<label>What's for dinner?</label>`}
      <input .value=${a.name} ?disabled=${Boolean(a.recipeId)} placeholder="Leftovers night" @input=${(e: Event) => (this._adding = { ...a, name: (e.target as HTMLInputElement).value })} />
      ${this._error ? html`<p class="err">${this._error}</p>` : nothing}
      <div class="actions">
        <button class="ghost" @click=${() => (this._adding = null)}>Cancel</button>
        <button class="primary" @click=${this._saveDinner}>Add dinner</button>
      </div>
    </hustle-dialog>`;
  }

  render() {
    if (!this.extras) return nothing;
    return html`
      <div class="head">
        <h1>Meals</h1>
        <div class="seg" role="tablist" aria-label="Meals sections">
          <button role="tab" class=${this._section === "week" ? "on" : ""} aria-selected=${this._section === "week" ? "true" : "false"} @click=${() => this._setSection("week")}>This week</button>
          <button role="tab" class=${this._section === "recipes" ? "on" : ""} aria-selected=${this._section === "recipes" ? "true" : "false"} @click=${() => this._setSection("recipes")}>Recipes</button>
        </div>
        ${this._isAdmin ? html`<button class="gear" aria-label="Meals settings" @click=${this._openSettings}><ha-icon icon="mdi:cog"></ha-icon></button>` : nothing}
      </div>
      ${this._section === "week"
        ? this._weekSection()
        : html`<family-recipes-view
            .hass=${this.hass}
            .recipes=${this.extras.recipes}
            .me=${this.me}
            ?canPlan=${Boolean(this.extras.calendarSettings.dinnersCalendar)}
            ?canShop=${Boolean(this.extras.calendarSettings.shoppingList)}
            @meals-changed=${() => this._loadWeek()}
          ></family-recipes-view>`}
      ${this._wizard
        ? html`<hustle-dialog open .heading=${this._wizardTitle(this._wizard)} @hustle-dialog-closed=${() => (this._wizard = null)}>
            ${this._wizardBody(this._wizard)}
          </hustle-dialog>`
        : nothing}
      ${this._addDialog()}
      ${this._settingsOpen
        ? html`<hustle-dialog open heading="Meals settings" @hustle-dialog-closed=${() => (this._settingsOpen = false)}>
            <label>Dinners calendar</label>
            <select @change=${(e: Event) => (this._dinnersDraft = (e.target as HTMLSelectElement).value)}>
              <option value="" ?selected=${!this._dinnersDraft}>None</option>
              ${this._calendars.map((c) => html`<option value=${c.entity_id} ?selected=${c.entity_id === this._dinnersDraft}>${c.name}</option>`)}
            </select>
            <p class="hint" style="margin-top:8px">Dinners are all-day events on this calendar. A separate Google Calendar (e.g. "Dinners") keeps them tidy on the Calendar tab.</p>
            <div class="actions">
              <button class="ghost" @click=${() => (this._settingsOpen = false)}>Cancel</button>
              <button class="primary" @click=${this._saveSettings}>Save</button>
            </div>
          </hustle-dialog>`
        : nothing}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "family-meals-view": FamilyMealsView;
  }
}
