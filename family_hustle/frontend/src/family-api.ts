import type { HassEntity, HomeAssistant } from "./ha-api";

/* The add-on's Calendar, Meals and Shopping tabs talk to the backend through here -
 * ha-api.ts stays the chores layer it always was. Settings and the grocery
 * list arrive with the pushed states (like every Hustle sensor); calendar
 * events and the dinner board are fetched on demand, since Home Assistant's
 * calendars have no change signal for the backend to push from. Every URL
 * is relative (ingress serves the add-on under a per-session prefix). */

export interface CalendarSettings {
  familyCalendars: string[];
  defaultCalendar: string | null;
  dinnersCalendar: string | null;
  /** Dinners also show on the Calendar tab's all-day row. */
  showDinners: boolean;
  /** The Home Assistant to-do list behind the Shopping tab. */
  shoppingList: string | null;
}

export interface ShoppingItem {
  uid: string;
  summary: string;
  status: "needs_action" | "completed";
  description: string;
}

export interface TodoListInfo {
  entity_id: string;
  name: string;
}

export interface GroceryCategory {
  category: string;
  items: string[];
}

export interface Recipe {
  id: string;
  title: string;
  description: string;
  servings: number | null;
  prepMinutes: number | null;
  cookMinutes: number | null;
  ingredients: string[];
  steps: string[];
  tags: string[];
  sourceUrl: string;
  notes: string;
  updatedAt: string;
}

/** What the recipe editor sends (snake_case, as the backend takes it). */
export interface RecipeFields {
  title: string;
  description: string;
  servings: number | null;
  prep_minutes: number | null;
  cook_minutes: number | null;
  ingredients: string[];
  steps: string[];
  tags: string[];
  source_url: string;
  notes: string;
}

export interface ChoreProgress {
  done: number;
  total: number;
}

export interface FamilyExtras {
  calendarSettings: CalendarSettings;
  groceryList: GroceryCategory[];
  groceryGeneratedAt: string | null;
  /** member id -> today's chores done/total (the calendar header bars). */
  todayChoreProgress: Record<string, ChoreProgress>;
  /** The recipe box, sorted by title. */
  recipes: Recipe[];
}

export interface CalendarInfo {
  entity_id: string;
  name: string;
}

export interface FamilyEvent {
  entityId: string;
  calendarName: string;
  uid: string | null;
  recurrenceId: string | null;
  rrule: string | null;
  summary: string;
  description: string;
  location: string;
  /** "YYYY-MM-DD" when allDay, else an ISO datetime. */
  start: string;
  /** Exclusive for all-day events (iCalendar). */
  end: string;
  allDay: boolean;
  forMemberId: string | null;
  attendeeIds: string[];
}

export type Meal = "lunch" | "dinner";

export interface DinnerEntry {
  date: string;
  /** Lunches are titled "Lunch: <dish>" on the meals calendar. */
  meal?: Meal;
  dish: string;
  notes: string | null;
  is_today: boolean;
  uid: string | null;
  /** Part of a Meal Prep batch (marked when it was scheduled). */
  meal_prep?: boolean;
}

export interface DinnerWeek {
  calendar_entity: string | null;
  week: DinnerEntry[];
  errors: string[];
}

function byKey(hass: HomeAssistant, key: string): HassEntity | undefined {
  return Object.values(hass.states).find((e) => e.attributes.hustle_key === key);
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

export function parseFamilyExtras(hass: HomeAssistant): FamilyExtras {
  const settings = byKey(hass, "calendar_settings")?.attributes ?? {};
  const grocery = byKey(hass, "grocery_list")?.attributes ?? {};
  const progress = byKey(hass, "today_chore_progress")?.attributes.members ?? {};
  return {
    calendarSettings: {
      familyCalendars: strings(settings.family_calendars),
      defaultCalendar: (settings.default_calendar as string | null) ?? null,
      dinnersCalendar: (settings.dinners_calendar as string | null) ?? null,
      showDinners: settings.show_dinners !== false,
      shoppingList: (settings.shopping_list as string | null) ?? null,
    },
    groceryList: Array.isArray(grocery.categories)
      ? (grocery.categories as Array<Record<string, unknown>>).map((c) => ({
          category: String(c.category ?? ""),
          items: strings(c.items),
        }))
      : [],
    groceryGeneratedAt: (grocery.generated_at as string | null) ?? null,
    todayChoreProgress: progress as Record<string, ChoreProgress>,
    recipes: Array.isArray(byKey(hass, "recipes")?.attributes.recipes)
      ? (byKey(hass, "recipes")!.attributes.recipes as Array<Record<string, unknown>>).map(toRecipe)
      : [],
  };
}

function numOrNull(value: unknown): number | null {
  return value === null || value === undefined || value === "" ? null : Number(value);
}

function toRecipe(raw: Record<string, unknown>): Recipe {
  return {
    id: String(raw.id),
    title: String(raw.title ?? ""),
    description: String(raw.description ?? ""),
    servings: numOrNull(raw.servings),
    prepMinutes: numOrNull(raw.prep_minutes),
    cookMinutes: numOrNull(raw.cook_minutes),
    ingredients: strings(raw.ingredients),
    steps: strings(raw.steps),
    tags: strings(raw.tags),
    sourceUrl: String(raw.source_url ?? ""),
    notes: String(raw.notes ?? ""),
    updatedAt: String(raw.updated_at ?? ""),
  };
}

/** Dinners link to recipes by title - see the backend's recipes.py. */
export function recipeFor(recipes: Recipe[], dish: string | null | undefined): Recipe | undefined {
  const key = (dish ?? "").trim().toLowerCase();
  return key ? recipes.find((r) => r.title.trim().toLowerCase() === key) : undefined;
}

async function getJson<T>(path: string): Promise<T> {
  const resp = await fetch(path);
  let body: unknown = null;
  try {
    body = await resp.json();
  } catch {
    // Fall through to the status-based message below.
  }
  if (!resp.ok) {
    const error = (body as { error?: string } | null)?.error;
    throw new Error(error ?? `${path} failed (${resp.status})`);
  }
  return body as T;
}

function toEvent(raw: Record<string, unknown>): FamilyEvent {
  return {
    entityId: String(raw.entity_id),
    calendarName: String(raw.calendar_name ?? raw.entity_id),
    uid: (raw.uid as string | null) ?? null,
    recurrenceId: (raw.recurrence_id as string | null) ?? null,
    rrule: (raw.rrule as string | null) ?? null,
    summary: String(raw.summary ?? ""),
    description: String(raw.description ?? ""),
    location: String(raw.location ?? ""),
    start: String(raw.start),
    end: String(raw.end ?? raw.start),
    allDay: Boolean(raw.all_day),
    forMemberId: (raw.for_member_id as string | null) ?? null,
    attendeeIds: strings(raw.attendee_ids),
  };
}

export const familyApi = {
  listCalendars(): Promise<CalendarInfo[]> {
    return getJson<CalendarInfo[]>("api/calendar/calendars");
  },

  async events(
    start: string,
    end: string,
    entityIds: string[] = []
  ): Promise<{ events: FamilyEvent[]; errors: string[] }> {
    const params = new URLSearchParams({ start, end });
    entityIds.forEach((id) => params.append("entity_id", id));
    const body = await getJson<{ events: Array<Record<string, unknown>>; errors: string[] }>(
      `api/calendar/events?${params}`
    );
    return { events: body.events.map(toEvent), errors: body.errors ?? [] };
  },

  dinnerWeek(): Promise<DinnerWeek> {
    return getJson<DinnerWeek>("api/meals/week");
  },

  shoppingLists(): Promise<TodoListInfo[]> {
    return getJson<TodoListInfo[]>("api/shopping/lists");
  },

  shoppingItems(): Promise<{ entity_id: string; items: ShoppingItem[] }> {
    return getJson<{ entity_id: string; items: ShoppingItem[] }>("api/shopping/items");
  },

  async call<T = Record<string, unknown>>(
    hass: HomeAssistant,
    service: string,
    data: Record<string, unknown>
  ): Promise<T> {
    const result = (await hass.callService("hustle", service, data)) as {
      response?: unknown;
    } | null;
    return (result?.response ?? {}) as T;
  },
};
