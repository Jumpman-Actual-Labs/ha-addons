import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import { familyApi, type FamilyExtras, type ShoppingItem, type TodoListInfo } from "../family-api";
import type { MemberRosterEntry } from "../types";
import { formStyles } from "../styles";
import "../components/hustle-dialog";

/* The Shopping tab: Home Assistant's own to-do list (todo.shopping_list
 * unless a parent picks another), so it's the same list as the HA app and
 * Assist ("add milk to the shopping list"). Anyone in the family can add,
 * check off, rename and remove items; picking the list is for parents.
 * Re-read every 30s while open, since items also change from outside. */

const REFRESH_MS = 30_000;

@customElement("family-shopping-view")
export class FamilyShoppingView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) extras!: FamilyExtras;
  @property({ attribute: false }) me!: MemberRosterEntry;

  @state() private _items: ShoppingItem[] = [];
  @state() private _loaded = false;
  @state() private _error = "";
  @state() private _draft = "";
  @state() private _editingUid = "";
  @state() private _editText = "";
  @state() private _showDone = false;
  @state() private _settingsOpen = false;
  @state() private _lists: TodoListInfo[] = [];
  @state() private _listDraft = "";
  @state() private _listName = "";

  private _loadedFor: string | null | undefined = undefined;
  private _timer?: number;

  static styles = [
    formStyles,
    css`
      :host { display: block; max-width: 720px; margin: 0 auto; color: #2f3a4a; }
      .head { display: flex; align-items: baseline; gap: 12px; margin-bottom: 14px; }
      h1 { font-family: Georgia, "Times New Roman", serif; font-weight: 600; font-size: 1.7rem; margin: 0; }
      .sub { color: #7b8796; font-size: .9rem; }
      .gear { margin-left: auto; border: 1px solid #e6e9ee; background: #fff; border-radius: 999px; min-height: 36px; min-width: 36px; display: grid; place-items: center; cursor: pointer; }
      .card { background: #fff; border: 1px solid #e6e9ee; border-radius: 18px; overflow: hidden; }
      form.add { display: flex; gap: 8px; padding: 14px; border-bottom: 1px solid #eef0f3; }
      form.add input { flex: 1; }
      form.add button { flex: none; }
      ul { list-style: none; margin: 0; padding: 0; }
      li { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-bottom: 1px solid #f1f3f6; min-height: 52px; box-sizing: border-box; }
      li:last-child { border-bottom: 0; }
      .check { flex: none; width: 28px; height: 28px; min-height: 0; border-radius: 50%; border: 2px solid #c5ccd6; background: #fff; cursor: pointer; display: grid; place-items: center; padding: 0; color: #fff; --mdc-icon-size: 18px; }
      .check.on { background: #7fc8c0; border-color: #7fc8c0; }
      .label { flex: 1; min-width: 0; font-size: 1.05rem; cursor: text; background: none; border: 0; text-align: left; padding: 4px 0; min-height: 0; }
      .done .label { text-decoration: line-through; color: #9aa4b1; }
      .remove { flex: none; border: 0; background: none; color: #b4bcc7; cursor: pointer; min-height: 36px; min-width: 36px; --mdc-icon-size: 20px; }
      .remove:hover { color: #b3261e; }
      li input { flex: 1; }
      .empty { padding: 28px 16px; text-align: center; color: #7b8796; }
      .done-head { display: flex; align-items: center; justify-content: space-between; padding: 8px 14px; background: #fafbfc; border-top: 1px solid #eef0f3; color: #7b8796; font-size: .9rem; }
      .done-head button { border: 0; background: none; color: inherit; cursor: pointer; font: inherit; min-height: 36px; }
      .done-head .clear { color: #b3261e; }
      .notice { padding: 14px 16px; border-radius: 14px; background: #fdecea; color: #8a2a20; margin-bottom: 12px; }
      .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px; }
      button.ghost { background: #fff; border: 1px solid #e6e9ee; border-radius: 10px; padding: 10px 16px; cursor: pointer; }
      .hint { color: #7b8796; font-size: .9rem; }
    `,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    this._timer = window.setInterval(() => void this._load(), REFRESH_MS);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearInterval(this._timer);
  }

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has("extras")) {
      const list = this.extras?.calendarSettings.shoppingList ?? null;
      if (list !== this._loadedFor) {
        this._loadedFor = list;
        void this._load();
        void this._loadListName(list);
      }
    }
  }

  private get _isParent(): boolean {
    return this.me?.role === "parent";
  }

  private async _load(): Promise<void> {
    if (!this.extras?.calendarSettings.shoppingList) {
      this._items = [];
      this._loaded = true;
      return;
    }
    try {
      this._items = (await familyApi.shoppingItems()).items;
      this._error = "";
    } catch (err) {
      this._error = (err as Error).message;
    } finally {
      this._loaded = true;
    }
  }

  private async _loadListName(entityId: string | null): Promise<void> {
    if (!entityId) return;
    try {
      this._listName = (await familyApi.shoppingLists()).find((l) => l.entity_id === entityId)?.name ?? "";
    } catch {
      this._listName = "";
    }
  }

  private async _do(service: string, data: Record<string, unknown>): Promise<void> {
    try {
      await familyApi.call(this.hass, service, data);
      this._error = "";
    } catch (err) {
      this._error = (err as Error).message;
    }
    await this._load();
  }

  private _add(e: Event): void {
    e.preventDefault();
    const text = this._draft.trim();
    if (!text) return;
    this._draft = "";
    // Show it straight away; the reload replaces it with the real item.
    this._items = [...this._items, { uid: `pending-${Date.now()}`, summary: text, status: "needs_action", description: "" }];
    void this._do("shopping_add_items", { items: [text] });
  }

  private _toggle(item: ShoppingItem): void {
    const status = item.status === "completed" ? "needs_action" : "completed";
    this._items = this._items.map((i) => (i.uid === item.uid ? { ...i, status } : i));
    void this._do("shopping_update_item", { uid: item.uid, status });
  }

  private _remove(item: ShoppingItem): void {
    this._items = this._items.filter((i) => i.uid !== item.uid);
    void this._do("shopping_remove_items", { uids: [item.uid] });
  }

  private _startEdit(item: ShoppingItem): void {
    this._editingUid = item.uid;
    this._editText = item.summary;
    void this.updateComplete.then(() => this.renderRoot.querySelector<HTMLInputElement>("li input")?.focus());
  }

  private _saveEdit(item: ShoppingItem): void {
    const text = this._editText.trim();
    this._editingUid = "";
    if (!text || text === item.summary) return;
    this._items = this._items.map((i) => (i.uid === item.uid ? { ...i, summary: text } : i));
    void this._do("shopping_update_item", { uid: item.uid, rename: text });
  }

  private _clearDone(): void {
    this._items = this._items.filter((i) => i.status !== "completed");
    void this._do("shopping_clear_completed", {});
  }

  private async _openSettings(): Promise<void> {
    this._listDraft = this.extras.calendarSettings.shoppingList ?? "";
    this._settingsOpen = true;
    try {
      this._lists = await familyApi.shoppingLists();
    } catch (err) {
      this._error = (err as Error).message;
    }
  }

  private async _saveSettings(): Promise<void> {
    this._settingsOpen = false;
    await this._do("update_calendar_settings", { shopping_list: this._listDraft || null });
  }

  private _row(item: ShoppingItem) {
    const done = item.status === "completed";
    const pending = item.uid.startsWith("pending-");
    return html`<li class=${done ? "done" : ""}>
      <button class="check ${done ? "on" : ""}" aria-label=${done ? "Not got it" : "Got it"} ?disabled=${pending} @click=${() => this._toggle(item)}>
        ${done ? html`<ha-icon icon="mdi:check"></ha-icon>` : nothing}
      </button>
      ${this._editingUid === item.uid
        ? html`<input
            .value=${this._editText}
            @input=${(e: Event) => (this._editText = (e.target as HTMLInputElement).value)}
            @keydown=${(e: KeyboardEvent) => {
              if (e.key === "Enter") this._saveEdit(item);
              if (e.key === "Escape") this._editingUid = "";
            }}
            @blur=${() => this._saveEdit(item)}
          />`
        : html`<button class="label" ?disabled=${pending} @click=${() => this._startEdit(item)}>${item.summary}</button>`}
      <button class="remove" aria-label="Remove ${item.summary}" ?disabled=${pending} @click=${() => this._remove(item)}>
        <ha-icon icon="mdi:close"></ha-icon>
      </button>
    </li>`;
  }

  render() {
    if (!this.extras) return nothing;
    const configured = Boolean(this.extras.calendarSettings.shoppingList);
    const open = this._items.filter((i) => i.status !== "completed");
    const done = this._items.filter((i) => i.status === "completed");
    return html`
      <div class="head">
        <h1>Shopping List</h1>
        ${this._listName && this._listName !== "Shopping List" ? html`<span class="sub">${this._listName}</span>` : nothing}
        ${this._isParent
          ? html`<button class="gear" aria-label="Shopping settings" @click=${this._openSettings}><ha-icon icon="mdi:cog"></ha-icon></button>`
          : nothing}
      </div>
      ${this._error ? html`<div class="notice">${this._error}</div>` : nothing}
      ${!configured
        ? html`<div class="card"><p class="empty">${this._isParent ? "Pick a to-do list with the gear above." : "A parent needs to pick the shopping list first."}</p></div>`
        : html`<div class="card">
            <form class="add" @submit=${this._add}>
              <input .value=${this._draft} placeholder="Add an item" aria-label="Add an item" @input=${(e: Event) => (this._draft = (e.target as HTMLInputElement).value)} />
              <button class="primary" type="submit">Add</button>
            </form>
            ${!this._loaded
              ? html`<p class="empty">Loading…</p>`
              : open.length === 0
                ? html`<p class="empty">Nothing on the list.</p>`
                : html`<ul>${open.map((i) => this._row(i))}</ul>`}
            ${done.length
              ? html`<div class="done-head">
                    <button @click=${() => (this._showDone = !this._showDone)}>${this._showDone ? "▾" : "▸"} Got it (${done.length})</button>
                    <button class="clear" @click=${this._clearDone}>Clear</button>
                  </div>
                  ${this._showDone ? html`<ul>${done.map((i) => this._row(i))}</ul>` : nothing}`
              : nothing}
          </div>`}
      ${this._settingsOpen
        ? html`<hustle-dialog open heading="Shopping list" @hustle-dialog-closed=${() => (this._settingsOpen = false)}>
            <p class="hint">Any Home Assistant to-do list works. Home Assistant's own Shopping List is the one Assist adds to.</p>
            <label>List</label>
            <select @change=${(e: Event) => (this._listDraft = (e.target as HTMLSelectElement).value)}>
              ${this._lists.length === 0 ? html`<option value="">Loading…</option>` : nothing}
              ${this._lists.map((l) => html`<option value=${l.entity_id} ?selected=${l.entity_id === this._listDraft}>${l.name}</option>`)}
            </select>
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
    "family-shopping-view": FamilyShoppingView;
  }
}
