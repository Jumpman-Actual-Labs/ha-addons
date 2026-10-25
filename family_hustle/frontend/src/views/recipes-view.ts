import { LitElement, css, html, nothing } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { familyApi, type Recipe, type RecipeFields } from "../family-api";
import type { MemberRosterEntry } from "../types";
import { formStyles } from "../styles";
import { formatAmount, parseAmount, parseNumber } from "../utils/quantity";
import "../components/hustle-dialog";

/* The Meals tab's Recipes section: the family's recipe box.
 * - A searchable grid of recipe cards.
 * - A recipe's page: ingredients, steps, times, notes, plus "Cook" (a
 *   big-text, one-step-at-a-time view with an ingredient checklist that
 *   keeps the screen awake; tap any amount to type a new one and every
 *   ingredient rescales to match - see utils/quantity.ts), "Add to shopping list", and "Plan for" a night
 *   (schedules a dinner with the recipe's title - dinners find their recipe
 *   again by title).
 * - The editor (parents): every field, with "Fill with AI" at the bottom
 *   filling in only what's still blank, from the name and whatever's been
 *   written (which it never changes).
 * meals-view.ts opens recipes and new drafts here through openRecipe() and
 * newRecipe(), and listens for `meals-changed` after something is planned. */

interface Draft {
  id: string | null;
  title: string;
  description: string;
  servings: string;
  prep: string;
  cook: string;
  ingredients: string;
  steps: string;
  tags: string;
  sourceUrl: string;
  notes: string;
}

function blankDraft(title = "", description = ""): Draft {
  return {
    id: null,
    title,
    description,
    servings: "4",
    prep: "",
    cook: "",
    ingredients: "",
    steps: "",
    tags: "",
    sourceUrl: "",
    notes: "",
  };
}

function draftFrom(r: Recipe): Draft {
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    servings: r.servings ? String(r.servings) : "",
    prep: r.prepMinutes !== null ? String(r.prepMinutes) : "",
    cook: r.cookMinutes !== null ? String(r.cookMinutes) : "",
    ingredients: r.ingredients.join("\n"),
    steps: r.steps.join("\n"),
    tags: r.tags.join(", "),
    sourceUrl: r.sourceUrl,
    notes: r.notes,
  };
}

function toFields(d: Draft): RecipeFields {
  const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);
  const num = (text: string) => (text.trim() === "" ? null : Math.max(0, Math.round(Number(text) || 0)));
  return {
    title: d.title.trim(),
    description: d.description.trim(),
    servings: num(d.servings) || null,
    prep_minutes: num(d.prep),
    cook_minutes: num(d.cook),
    ingredients: lines(d.ingredients),
    steps: lines(d.steps),
    tags: d.tags.split(",").map((t) => t.trim()).filter(Boolean),
    source_url: d.sourceUrl.trim(),
    notes: d.notes.trim(),
  };
}

function minutes(total: number | null): string {
  if (!total) return "";
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h} hr${m ? ` ${m} min` : ""}` : `${m} min`;
}

function totalMinutes(r: Recipe): number | null {
  const total = (r.prepMinutes ?? 0) + (r.cookMinutes ?? 0);
  return total || null;
}

function localDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

@customElement("family-recipes-view")
export class FamilyRecipesView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) recipes: Recipe[] = [];
  @property({ attribute: false }) me!: MemberRosterEntry;
  /** A Dinners calendar is set, so "Plan for" can schedule. */
  @property({ type: Boolean }) canPlan = false;
  /** A shopping list is set, so ingredients can go to it. */
  @property({ type: Boolean }) canShop = false;

  @state() private _search = "";
  @state() private _openId: string | null = null;
  @state() private _draft: Draft | null = null;
  @state() private _cooking: {
    id: string;
    step: number;
    got: number[];
    showIngredients: boolean;
    /** Every amount is multiplied by this (1 = as written). */
    scale: number;
    /** The ingredient whose amount is being typed over, and the text. */
    editing: number | null;
    editText: string;
  } | null = null;
  @state() private _planDate = localDateKey(new Date());
  @state() private _planMeal: "lunch" | "dinner" = "dinner";
  @state() private _busy = false;
  @state() private _aiBusy = false;
  @state() private _fillStatus = "";
  @state() private _error = "";
  @state() private _status = "";

  private _wakeLock: { release(): Promise<void> } | null = null;

  static styles = [
    formStyles,
    css`
      :host { display: block; }
      .bar { display: flex; gap: 10px; align-items: center; margin-bottom: 14px; flex-wrap: wrap; }
      .bar input { flex: 1; min-width: 180px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 12px; }
      .card { text-align: left; border: 1px solid var(--divider-color); background: var(--card-background-color); color: inherit; border-radius: 16px; padding: 16px; cursor: pointer; display: flex; flex-direction: column; gap: 6px; font: inherit; min-height: 0; }
      .card:hover { border-color: var(--primary-color); }
      .card h3 { margin: 0; font-size: 1.05rem; }
      .card p { margin: 0; color: var(--secondary-text-color); font-size: .9rem; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      .meta { display: flex; gap: 12px; flex-wrap: wrap; color: var(--secondary-text-color); font-size: .85rem; align-items: center; --mdc-icon-size: 16px; }
      .meta span { display: inline-flex; align-items: center; gap: 4px; }
      .tags { display: flex; gap: 6px; flex-wrap: wrap; }
      .tag { background: var(--fh-surface-2); border-radius: 999px; padding: 2px 10px; font-size: .78rem; }
      .empty { text-align: center; color: var(--secondary-text-color); padding: 40px 16px; border: 1px dashed var(--divider-color); border-radius: 16px; }
      .empty ha-icon { --mdc-icon-size: 40px; display: block; margin: 0 auto 8px; }
      button.ghost { background: var(--card-background-color); color: inherit; border: 1px solid var(--divider-color); border-radius: 10px; padding: 10px 16px; cursor: pointer; }
      button.danger { background: var(--card-background-color); color: var(--fh-danger); border: 1px solid var(--fh-danger-line); border-radius: 10px; padding: 10px 16px; cursor: pointer; }
      .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px; flex-wrap: wrap; align-items: center; }
      .actions .left { margin-right: auto; }
      .err { color: var(--fh-danger); }
      .ok { color: var(--primary-color); }
      .row2 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 10px; }
      .ai { display: flex; gap: 10px; align-items: center; margin-top: 12px; padding: 12px; border-radius: 12px; background: var(--fh-surface-2); font-size: .9rem; }
      .ai span { flex: 1; }
      h4 { margin: 18px 0 6px; font-size: .95rem; }
      ul.ing { margin: 0; padding-left: 20px; line-height: 1.7; }
      ol.steps { margin: 0; padding-left: 22px; line-height: 1.6; }
      ol.steps li { margin-bottom: 8px; }
      .desc { color: var(--secondary-text-color); margin: 0 0 8px; }
      .plan { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--divider-color); }
      .plan select { width: auto; flex: 1; }
      .notes { white-space: pre-wrap; background: var(--fh-surface-3); border-radius: 10px; padding: 10px 12px; }
      a { color: var(--primary-color); }

      /* Cook mode: full screen, big type, one step at a time. */
      .cook { position: fixed; inset: 0; z-index: 1100; background: var(--primary-background-color); color: var(--primary-text-color); display: flex; flex-direction: column; }
      .cook header { display: flex; align-items: center; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--divider-color); }
      .cook header h2 { margin: 0; font-size: 1.15rem; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .cook .body { flex: 1; overflow-y: auto; padding: 24px clamp(18px, 6vw, 80px); display: flex; flex-direction: column; gap: 18px; }
      .cook .count { color: var(--secondary-text-color); font-weight: 650; letter-spacing: .04em; text-transform: uppercase; font-size: .85rem; }
      .cook .step { font-size: clamp(1.4rem, 3.4vw, 2.2rem); line-height: 1.4; font-weight: 550; }
      .cook .progress { height: 6px; background: var(--fh-surface-2); border-radius: 99px; overflow: hidden; }
      .cook .progress i { display: block; height: 100%; background: var(--primary-color); }
      .cook footer { display: flex; gap: 10px; padding: 14px 18px calc(14px + env(safe-area-inset-bottom)); border-top: 1px solid var(--divider-color); }
      .cook footer button { flex: 1; min-height: 56px; font-size: 1.1rem; border-radius: 14px; }
      .checklist { list-style: none; padding: 0; margin: 0; display: grid; gap: 4px; }
      .checklist label { display: flex; gap: 12px; align-items: center; margin: 0; padding: 10px 4px; font-size: 1.1rem; color: inherit; border-bottom: 1px solid var(--divider-color); cursor: pointer; }
      .checklist input { width: 22px; height: 22px; flex: none; }
      .checklist .got { text-decoration: line-through; color: var(--secondary-text-color); }
      .ing-row { display: flex; gap: 12px; align-items: center; padding: 8px 4px; font-size: 1.1rem; border-bottom: 1px solid var(--divider-color); }
      .ing-text { flex: 1; cursor: pointer; }
      .amount { min-height: 36px; min-width: 68px; padding: 4px 10px; border-radius: 10px; border: 1px dashed var(--divider-color); background: var(--fh-surface-2); color: inherit; font: inherit; font-weight: 700; cursor: pointer; white-space: nowrap; }
      .amount:hover { border-color: var(--primary-color); }
      .amount.scaled { border-style: solid; border-color: var(--primary-color); color: var(--primary-color); }
      .amount-input { width: 96px; flex: none; font-size: 1.05rem; font-weight: 700; padding: 6px 10px; }
      .scaler { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      .scaler .hint { width: 100%; color: var(--secondary-text-color); font-size: .9rem; }
      .chip { border: 1px solid var(--divider-color); background: var(--card-background-color); color: inherit; border-radius: 999px; padding: 4px 14px; min-height: 34px; font: inherit; cursor: pointer; }
      .chip.on { background: var(--primary-color); border-color: var(--primary-color); color: #fff; }
      @media (max-width: 600px) { .row2 { grid-template-columns: 1fr 1fr; } }
    `,
  ];

  disconnectedCallback(): void {
    super.disconnectedCallback();
    void this._releaseWake();
  }

  private get _isParent(): boolean {
    return this.me?.role === "parent";
  }

  /** Opens a recipe's page (from a dinner on the This week list). */
  openRecipe(id: string): void {
    this._openId = id;
    this._error = "";
    this._status = "";
  }

  /** Starts a new recipe, optionally named after a dinner, and has the AI
   * write it straight away when asked. */
  newRecipe(title = "", description = "", fillWithAi = false): void {
    this._openId = null;
    this._draft = blankDraft(title, description);
    this._error = "";
    this._fillStatus = "";
    if (fillWithAi && title) void this._fillWithAi();
  }

  private _filtered(): Recipe[] {
    const q = this._search.trim().toLowerCase();
    if (!q) return this.recipes;
    return this.recipes.filter((r) =>
      [r.title, r.description, ...r.tags, ...r.ingredients].some((t) => t.toLowerCase().includes(q))
    );
  }

  // ---------------------------------------------------------- editing

  /** The fields "Fill with AI" can fill, and what each is called. */
  private static readonly _FILLABLE: Array<[keyof Draft, string]> = [
    ["description", "description"],
    ["prep", "prep time"],
    ["cook", "cook time"],
    ["ingredients", "ingredients"],
    ["steps", "steps"],
    ["tags", "tags"],
  ];

  /** Fills only the blank fields. Everything already written goes to the AI
   * so what it adds fits (steps that use these ingredients), and stays
   * exactly as typed - including anything typed while the AI was working. */
  private async _fillWithAi(): Promise<void> {
    const d = this._draft;
    if (!d?.title.trim()) {
      this._error = "Give the recipe a name first.";
      return;
    }
    const blank = FamilyRecipesView._FILLABLE.filter(([key]) => !String(d[key]).trim());
    if (!blank.length) {
      this._fillStatus = "Nothing's blank - there's nothing left to fill.";
      return;
    }
    const fields = toFields(d);
    this._aiBusy = true;
    this._error = "";
    this._fillStatus = "";
    try {
      const r = await familyApi.call<{
        description?: string;
        prep_minutes?: number;
        cook_minutes?: number;
        ingredients?: string[];
        steps?: string[];
        tags?: string[];
      }>(this.hass, "generate_recipe", {
        title: fields.title,
        servings: fields.servings ?? 4,
        description: fields.description,
        ingredients: fields.ingredients,
        steps: fields.steps,
        tags: fields.tags,
        ...(fields.prep_minutes !== null ? { prep_minutes: fields.prep_minutes } : {}),
        ...(fields.cook_minutes !== null ? { cook_minutes: fields.cook_minutes } : {}),
      });
      if (!this._draft) return;
      const filled: Record<string, string> = {
        description: r.description ?? "",
        prep: r.prep_minutes ? String(r.prep_minutes) : "",
        cook: r.cook_minutes ? String(r.cook_minutes) : "",
        ingredients: (r.ingredients ?? []).join("\n"),
        steps: (r.steps ?? []).join("\n"),
        tags: (r.tags ?? []).join(", "),
      };
      const next = { ...this._draft };
      const done: string[] = [];
      for (const [key, label] of blank) {
        if (!String(next[key]).trim() && filled[key]) {
          (next as Record<keyof Draft, string | null>)[key] = filled[key];
          done.push(label);
        }
      }
      this._draft = next;
      this._fillStatus = done.length ? `Filled in ${done.join(", ")}.` : "The AI didn't have anything to add.";
    } catch (err) {
      this._error = (err as Error).message;
    } finally {
      this._aiBusy = false;
    }
  }

  private async _save(): Promise<void> {
    const d = this._draft;
    if (!d) return;
    const fields = toFields(d);
    if (!fields.title) {
      this._error = "Give the recipe a name.";
      return;
    }
    this._busy = true;
    this._error = "";
    try {
      if (d.id) {
        await familyApi.call(this.hass, "update_recipe", { recipe_id: d.id, ...fields });
        this._openId = d.id;
      } else {
        const result = await familyApi.call<{ recipe_id?: string }>(this.hass, "add_recipe", { ...fields });
        this._openId = result.recipe_id ?? null;
      }
      this._draft = null;
    } catch (err) {
      this._error = (err as Error).message;
    } finally {
      this._busy = false;
    }
  }

  private async _delete(recipe: Recipe): Promise<void> {
    if (!window.confirm(`Delete the "${recipe.title}" recipe? Dinners already planned stay on the calendar.`)) return;
    try {
      await familyApi.call(this.hass, "delete_recipe", { recipe_id: recipe.id });
      this._openId = null;
    } catch (err) {
      this._error = (err as Error).message;
    }
  }

  // ---------------------------------------------------------- actions

  private async _plan(recipe: Recipe): Promise<void> {
    this._error = "";
    this._status = "";
    try {
      await familyApi.call(this.hass, "schedule_meals", {
        meals: [{ name: recipe.title, description: recipe.description, date: this._planDate, meal: this._planMeal }],
      });
      const day = new Date(`${this._planDate}T12:00`).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
      this._status = `Planned for ${this._planMeal} on ${day}.`;
      this.dispatchEvent(new CustomEvent("meals-changed", { bubbles: true, composed: true }));
    } catch (err) {
      this._error = (err as Error).message;
    }
  }

  private async _shop(recipe: Recipe, items: string[]): Promise<void> {
    this._error = "";
    this._status = "";
    if (!items.length) {
      this._status = "Nothing to add.";
      return;
    }
    try {
      const result = await familyApi.call<{ added?: number }>(this.hass, "shopping_add_items", { items });
      const added = result.added ?? 0;
      this._status = added
        ? `Added ${added} item${added === 1 ? "" : "s"} from ${recipe.title} to the shopping list.`
        : "Already on the shopping list.";
    } catch (err) {
      this._error = (err as Error).message;
    }
  }

  private async _startCooking(recipe: Recipe): Promise<void> {
    this._cooking = {
      id: recipe.id,
      step: 0,
      got: [],
      showIngredients: recipe.steps.length === 0,
      scale: 1,
      editing: null,
      editText: "",
    };
    try {
      const wake = (navigator as Navigator & { wakeLock?: { request(type: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock;
      this._wakeLock = (await wake?.request("screen")) ?? null;
    } catch {
      this._wakeLock = null; // not supported or not allowed - cooking still works
    }
  }

  private async _releaseWake(): Promise<void> {
    try {
      await this._wakeLock?.release();
    } catch {
      // already released
    }
    this._wakeLock = null;
  }

  private _stopCooking(): void {
    this._cooking = null;
    void this._releaseWake();
  }

  // ----------------------------------------------------------- render

  private _meta(r: Recipe) {
    const total = totalMinutes(r);
    return html`<div class="meta">
      ${total ? html`<span><ha-icon icon="mdi:clock-outline"></ha-icon>${minutes(total)}</span>` : nothing}
      ${r.servings ? html`<span><ha-icon icon="mdi:account-group-outline"></ha-icon>Serves ${r.servings}</span>` : nothing}
      ${r.ingredients.length ? html`<span>${r.ingredients.length} ingredients</span>` : nothing}
    </div>`;
  }

  private _planOptions() {
    const today = new Date();
    return Array.from({ length: 14 }, (_, i) => {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
      const label = i === 0 ? "Today" : i === 1 ? "Tomorrow" : d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
      return html`<option value=${localDateKey(d)} ?selected=${localDateKey(d) === this._planDate}>${label}</option>`;
    });
  }

  private _detail() {
    const r = this.recipes.find((x) => x.id === this._openId);
    if (!r || this._draft) return nothing;
    return html`<hustle-dialog open .heading=${r.title} @hustle-dialog-closed=${() => (this._openId = null)}>
      ${r.description ? html`<p class="desc">${r.description}</p>` : nothing}
      ${this._meta(r)}
      ${r.prepMinutes || r.cookMinutes
        ? html`<div class="meta" style="margin-top:4px">
            ${r.prepMinutes ? html`<span>Prep ${minutes(r.prepMinutes)}</span>` : nothing}
            ${r.cookMinutes ? html`<span>Cook ${minutes(r.cookMinutes)}</span>` : nothing}
          </div>`
        : nothing}
      ${r.tags.length ? html`<div class="tags" style="margin-top:8px">${r.tags.map((t) => html`<span class="tag">${t}</span>`)}</div>` : nothing}
      <h4>Ingredients</h4>
      ${r.ingredients.length ? html`<ul class="ing">${r.ingredients.map((i) => html`<li>${i}</li>`)}</ul>` : html`<p class="desc">None listed yet.</p>`}
      <h4>Steps</h4>
      ${r.steps.length ? html`<ol class="steps">${r.steps.map((s) => html`<li>${s}</li>`)}</ol>` : html`<p class="desc">None listed yet.</p>`}
      ${r.notes ? html`<h4>Notes</h4><div class="notes">${r.notes}</div>` : nothing}
      ${r.sourceUrl ? html`<p><a href=${r.sourceUrl} target="_blank" rel="noopener noreferrer">Original recipe</a></p>` : nothing}
      ${this._isParent && this.canPlan
        ? html`<div class="plan">
            <span>Plan for</span>
            <select aria-label="Meal" @change=${(e: Event) => (this._planMeal = (e.target as HTMLSelectElement).value as "lunch" | "dinner")}>
              <option value="dinner" ?selected=${this._planMeal === "dinner"}>Dinner</option>
              <option value="lunch" ?selected=${this._planMeal === "lunch"}>Lunch</option>
            </select>
            <select aria-label="Day" @change=${(e: Event) => (this._planDate = (e.target as HTMLSelectElement).value)}>${this._planOptions()}</select>
            <button class="ghost" @click=${() => this._plan(r)}>Add to the week</button>
          </div>`
        : nothing}
      ${this._status ? html`<p class="ok">${this._status}</p>` : nothing}
      ${this._error ? html`<p class="err">${this._error}</p>` : nothing}
      <div class="actions">
        ${this._isParent
          ? html`<button class="danger left" @click=${() => this._delete(r)}>Delete</button>
              <button class="ghost" @click=${() => { this._draft = draftFrom(r); this._error = ""; this._fillStatus = ""; }}>Edit</button>`
          : nothing}
        ${this.canShop && r.ingredients.length
          ? html`<button class="ghost" @click=${() => this._shop(r, r.ingredients)}>Add to shopping list</button>`
          : nothing}
        <button class="primary" @click=${() => this._startCooking(r)}><ha-icon icon="mdi:chef-hat"></ha-icon> Cook</button>
      </div>
    </hustle-dialog>`;
  }

  private _editor() {
    const d = this._draft;
    if (!d) return nothing;
    const set = (patch: Partial<Draft>) => (this._draft = { ...this._draft!, ...patch });
    const field = (key: keyof Draft) => (e: Event) => set({ [key]: (e.target as HTMLInputElement).value } as Partial<Draft>);
    return html`<hustle-dialog open .heading=${d.id ? "Edit recipe" : "New recipe"} @hustle-dialog-closed=${() => (this._draft = null)}>
      <label>Name</label>
      <input .value=${d.title} placeholder="Grandma's lasagna" @input=${field("title")} />
      <label>Description</label>
      <input .value=${d.description} placeholder="One line about it" @input=${field("description")} />
      <div class="row2">
        <div><label>Serves</label><input type="number" min="1" .value=${d.servings} @input=${field("servings")} /></div>
        <div><label>Prep (min)</label><input type="number" min="0" .value=${d.prep} @input=${field("prep")} /></div>
        <div><label>Cook (min)</label><input type="number" min="0" .value=${d.cook} @input=${field("cook")} /></div>
      </div>
      <label>Ingredients (one per line)</label>
      <textarea rows="7" .value=${d.ingredients} placeholder=${"1 lb ground beef\n2 cups shredded cheese"} @input=${field("ingredients")}></textarea>
      <label>Steps (one per line)</label>
      <textarea rows="7" .value=${d.steps} placeholder=${"Brown the beef\nLayer the noodles"} @input=${field("steps")}></textarea>
      <label>Tags (comma separated)</label>
      <input .value=${d.tags} placeholder="Pasta, Make ahead" @input=${field("tags")} />
      <label>Link to the original</label>
      <input type="url" .value=${d.sourceUrl} placeholder="https://" @input=${field("sourceUrl")} />
      <label>Notes</label>
      <textarea rows="2" .value=${d.notes} @input=${field("notes")}></textarea>
      <div class="ai">
        <span>Fills in anything left blank from the name and what you've written. Nothing you've written is changed.</span>
        <button class="ghost" ?disabled=${this._aiBusy} @click=${this._fillWithAi}>${this._aiBusy ? "Filling…" : "Fill with AI"}</button>
      </div>
      ${this._fillStatus ? html`<p class="ok">${this._fillStatus}</p>` : nothing}
      ${this._error ? html`<p class="err">${this._error}</p>` : nothing}
      <div class="actions">
        <button class="ghost" @click=${() => (this._draft = null)}>Cancel</button>
        <button class="primary" ?disabled=${this._busy || this._aiBusy} @click=${this._save}>Save recipe</button>
      </div>
    </hustle-dialog>`;
  }

  /** One ingredient while cooking: a checkbox, its amount (scaled, and a
   * button - tap to type a new amount, which rescales every ingredient by
   * the same factor), and the rest of the line. */
  private _ingredientRow(
    c: NonNullable<FamilyRecipesView["_cooking"]>,
    line: string,
    i: number,
    toggleGot: (i: number) => void
  ) {
    const got = c.got.includes(i);
    const amount = parseAmount(line);
    const check = html`<input type="checkbox" .checked=${got} aria-label="Got ${line}" @change=${() => toggleGot(i)} />`;
    if (!amount) {
      return html`<li><label>${check}<span class=${got ? "got" : ""}>${line}</span></label></li>`;
    }
    const shown =
      formatAmount(amount.value * c.scale) +
      (amount.to !== null ? `${amount.sep}${formatAmount(amount.to * c.scale)}` : "");
    const apply = () => {
      const value = parseNumber(c.editText);
      this._cooking = value && value > 0
        ? { ...c, scale: value / amount.value, editing: null }
        : { ...c, editing: null };
    };
    return html`<li><div class="ing-row">
      ${check}
      ${c.editing === i
        ? html`<input
            class="amount-input"
            inputmode="decimal"
            aria-label="New amount"
            .value=${c.editText}
            @input=${(e: Event) => (this._cooking = { ...c, editText: (e.target as HTMLInputElement).value })}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter") apply();
              if (e.key === "Escape") this._cooking = { ...c, editing: null };
            }}
            @blur=${apply}
          />`
        : html`<button
            class="amount ${c.scale !== 1 ? "scaled" : ""}"
            title="Change this amount"
            @click=${() => {
              this._cooking = { ...c, editing: i, editText: formatAmount(amount.value * c.scale) };
              void this.updateComplete.then(() => {
                const input = this.renderRoot.querySelector<HTMLInputElement>(".amount-input");
                input?.focus();
                input?.select();
              });
            }}
          >${shown}</button>`}
      <span class="ing-text ${got ? "got" : ""}" @click=${() => toggleGot(i)}>${amount.rest}</span>
    </div></li>`;
  }

  private _cookView() {
    const c = this._cooking;
    const r = c ? this.recipes.find((x) => x.id === c.id) : undefined;
    if (!c || !r) return nothing;
    const steps = r.steps;
    const last = steps.length - 1;
    const toggleGot = (i: number) =>
      (this._cooking = { ...c, got: c.got.includes(i) ? c.got.filter((x) => x !== i) : [...c.got, i] });
    return html`<div class="cook" role="dialog" aria-label="Cooking ${r.title}">
      <header>
        <ha-icon icon="mdi:chef-hat"></ha-icon>
        <h2>${r.title}</h2>
        <button class="ghost" @click=${() => (this._cooking = { ...c, showIngredients: !c.showIngredients })}>
          ${c.showIngredients ? "Steps" : "Ingredients"}
        </button>
        <button class="ghost" aria-label="Stop cooking" @click=${this._stopCooking}><ha-icon icon="mdi:close"></ha-icon></button>
      </header>
      <div class="body">
        ${c.showIngredients || !steps.length
          ? html`<div class="count">
                Ingredients${r.servings ? ` · serves ${formatAmount(r.servings * c.scale)}` : ""}
                ${c.scale !== 1 ? html` · scaled ×${formatAmount(c.scale)}` : nothing}
              </div>
              <div class="scaler">
                <span class="hint">Tap an amount to change it - everything else follows.</span>
                ${[0.5, 1, 2].map(
                  (f) => html`<button class="chip ${c.scale === f ? "on" : ""}" @click=${() => (this._cooking = { ...c, scale: f, editing: null })}>${f === 1 ? "Original" : `${formatAmount(f)}×`}</button>`
                )}
              </div>
              <ul class="checklist">
                ${r.ingredients.map((ing, i) => this._ingredientRow(c, ing, i, toggleGot))}
              </ul>
              ${!r.ingredients.length ? html`<p class="desc">No ingredients listed.</p>` : nothing}`
          : html`<div class="count">Step ${c.step + 1} of ${steps.length}</div>
              <div class="progress"><i style="width:${((c.step + 1) / steps.length) * 100}%"></i></div>
              <div class="step">${steps[c.step]}</div>`}
      </div>
      ${steps.length && !c.showIngredients
        ? html`<footer>
            <button class="ghost" ?disabled=${c.step === 0} @click=${() => (this._cooking = { ...c, step: c.step - 1 })}>Back</button>
            ${c.step < last
              ? html`<button class="primary" @click=${() => (this._cooking = { ...c, step: c.step + 1 })}>Next step</button>`
              : html`<button class="primary" @click=${this._stopCooking}>Done</button>`}
          </footer>`
        : nothing}
    </div>`;
  }

  render() {
    const list = this._filtered();
    return html`
      <div class="bar">
        <input type="search" .value=${this._search} placeholder="Search recipes, ingredients or tags" @input=${(e: Event) => (this._search = (e.target as HTMLInputElement).value)} />
        ${this._isParent ? html`<button class="primary" @click=${() => this.newRecipe()}><ha-icon icon="mdi:plus"></ha-icon> New recipe</button>` : nothing}
      </div>
      ${this.recipes.length === 0
        ? html`<div class="empty">
            <ha-icon icon="mdi:book-open-variant"></ha-icon>
            No recipes yet.${this._isParent ? " Add your family's favorites with New recipe." : ""}
          </div>`
        : list.length === 0
          ? html`<div class="empty">No recipes match "${this._search}".</div>`
          : html`<div class="grid">
              ${list.map(
                (r) => html`<button class="card" @click=${() => this.openRecipe(r.id)}>
                  <h3>${r.title}</h3>
                  ${r.description ? html`<p>${r.description}</p>` : nothing}
                  ${this._meta(r)}
                  ${r.tags.length ? html`<div class="tags">${r.tags.map((t) => html`<span class="tag">${t}</span>`)}</div>` : nothing}
                </button>`
              )}
            </div>`}
      ${this._detail()} ${this._editor()} ${this._cookView()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "family-recipes-view": FamilyRecipesView;
  }
}
