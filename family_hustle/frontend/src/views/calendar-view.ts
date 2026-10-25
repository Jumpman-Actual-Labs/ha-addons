import { LitElement, css, html, nothing, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { HomeAssistant } from "../ha-api";
import {
  familyApi,
  type CalendarInfo,
  type FamilyEvent,
  type FamilyExtras,
} from "../family-api";
import type { HustleState, MemberRosterEntry } from "../types";
import { formStyles } from "../styles";
import { PASTELS, UNTAGGED_COLOR, initials, memberColor } from "../utils/member-colors";
import "../components/hustle-dialog";

/* The Calendar tab, laid out like a Skylight Calendar: the family's name
 * and a clock up top, a strip of family members with today's chore
 * progress, then a day or week time-grid (or a month grid) of the family's
 * Google Calendar events, each colored by who it's for, with the initials
 * of who's attending. The Meals tab's dinners show on the all-day row.
 *
 * Parents add events with the + button (one-off, multi-day or repeating)
 * and tag or delete existing ones by tapping them; kids see the same
 * calendar read-only. Tapping a member in the strip shows only their
 * events. The ⚙ (calendars, dinners, family colors) is for admin parents
 * only - the backend refuses settings changes from anyone else too. */

const HOUR_PX = 56;
const DEFAULT_FIRST_HOUR = 7;
const DEFAULT_LAST_HOUR = 21;
const REFRESH_MS = 5 * 60_000;

type View = "day" | "week" | "month";
type Repeat = "none" | "keep" | "daily" | "weekdays" | "weekly" | "biweekly" | "monthly" | "yearly";

/** What the add dialog is changing, when it's editing rather than adding.
 * A repeating event is edited from one occurrence: just that day ("one"),
 * or that day and every later one ("following" - earlier ones stay put). */
interface EditTarget {
  entityId: string;
  uid: string;
  recurrenceId: string | null;
  rrule: string | null;
  scope: "one" | "following";
}
type RepeatEnd = "never" | "until" | "count";

const RRULE_DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];

interface Placed {
  event: FamilyEvent;
  top: number;
  height: number;
  lane: number;
  lanes: number;
}

interface Draft {
  summary: string;
  allDay: boolean;
  date: string;
  endDate: string;
  startTime: string;
  endTime: string;
  calendar: string;
  forMemberId: string;
  attendees: string[];
  location: string;
  description: string;
  repeat: Repeat;
  repeatDays: number[];
  repeatEnd: RepeatEnd;
  repeatUntil: string;
  repeatCount: number;
  editing: EditTarget | null;
}

function dateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addDays(d: Date, n: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Monday on or before `d` - Skylight's week starts Monday. */
function startOfWeek(d: Date): Date {
  const start = startOfDay(d);
  return addDays(start, -((start.getDay() + 6) % 7));
}

function eventStart(e: FamilyEvent): Date {
  return e.allDay ? parseKey(e.start) : new Date(e.start);
}

function eventEnd(e: FamilyEvent): Date {
  return e.allDay ? parseKey(e.end) : new Date(e.end);
}

/** Which day keys an event shows on: every day an all-day event spans
 * (end exclusive), or each day a timed event touches. */
function eventDays(e: FamilyEvent): string[] {
  const start = eventStart(e);
  let end = eventEnd(e);
  if (!e.allDay) end = new Date(end.getTime() - 1);
  const days: string[] = [];
  for (let d = startOfDay(start); ; d = addDays(d, 1)) {
    if (e.allDay ? d >= end : d > end) break;
    days.push(dateKey(d));
    if (days.length > 62) break;
  }
  return days.length ? days : [dateKey(start)];
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const shortDate = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const longDate = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });

function timeRange(e: FamilyEvent): string {
  const start = eventStart(e);
  const end = eventEnd(e);
  if (e.allDay) {
    const last = addDays(end, -1);
    return last > start ? `${shortDate.format(start)} – ${shortDate.format(last)}` : "All day";
  }
  if (dateKey(start) !== dateKey(new Date(end.getTime() - 1))) {
    return `${shortDate.format(start)} ${timeFmt.format(start)} – ${shortDate.format(end)} ${timeFmt.format(end)}`;
  }
  return `${timeFmt.format(start)} – ${timeFmt.format(end)}`;
}

/** "FREQ=WEEKLY;BYDAY=TU,TH" -> "Repeats weekly on Tue, Thu". Covers what
 * the panel itself creates; anything else still says it repeats. */
function describeRepeat(rule: string | null): string {
  if (!rule) return "Repeats";
  const parts = Object.fromEntries(rule.split(";").map((p) => p.split("=")));
  const every = Number(parts.INTERVAL ?? 1);
  const freq: Record<string, string> = { DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year" };
  const unit = freq[parts.FREQ] ?? "time";
  let text = every > 1 ? `Repeats every ${every} ${unit}s` : `Repeats every ${unit}`;
  if (parts.BYDAY) {
    const names = String(parts.BYDAY)
      .split(",")
      .map((d) => new Date(2026, 0, 4 + RRULE_DAYS.indexOf(d)).toLocaleDateString(undefined, { weekday: "short" }));
    text += ` on ${names.join(", ")}`;
  }
  if (parts.COUNT) text += `, ${parts.COUNT} times`;
  if (parts.UNTIL) {
    const u = String(parts.UNTIL);
    text += ` until ${shortDate.format(new Date(+u.slice(0, 4), +u.slice(4, 6) - 1, +u.slice(6, 8)))}`;
  }
  return text;
}

function tint(hex: string, alpha: number): string {
  return `color-mix(in srgb, ${hex} calc(${Math.round(alpha * 100)}% * var(--fh-tint-boost, 1)), var(--fh-tint-base, white))`;
}

@customElement("family-calendar-view")
export class FamilyCalendarView extends LitElement {
  @property({ attribute: false }) hass!: HomeAssistant;
  @property({ attribute: false }) hustleState!: HustleState;
  @property({ attribute: false }) extras!: FamilyExtras;
  @property({ attribute: false }) me!: MemberRosterEntry;

  @state() private _view: View = "week";
  @state() private _anchor = new Date();
  @state() private _now = new Date();
  @state() private _events: FamilyEvent[] = [];
  @state() private _errors: string[] = [];
  @state() private _loading = false;
  @state() private _filterMemberId = "";
  @state() private _selected: FamilyEvent | null = null;
  @state() private _tagFor = "";
  @state() private _tagAttendees: string[] = [];
  @state() private _adding = false;
  @state() private _draft: Draft = this._emptyDraft();
  @state() private _settingsOpen = false;
  @state() private _calendars: CalendarInfo[] = [];
  @state() private _settingsDraft = {
    family: [] as string[],
    defaultCalendar: "",
    showDinners: true,
  };
  @state() private _busy = false;
  @state() private _dialogError = "";
  /** Phone-sized: the iOS-Calendar-style month + day agenda instead of the
   * Skylight grids (see _phoneView). */
  @state() private _mobile = false;
  @state() private _pickedDay = startOfDay(new Date());

  private _loadedKey = "";
  private _clock?: number;
  private _refresh?: number;
  private _phoneQuery = window.matchMedia("(max-width: 760px)");
  private _onPhoneChange = (): void => {
    this._mobile = this._phoneQuery.matches;
  };
  private _touchX: number | null = null;

  static styles = [
    formStyles,
    css`
      :host {
        display: block;
        --sky-ink: var(--primary-text-color, #2f3a4a);
        --sky-muted: var(--secondary-text-color, #7b8796);
        --sky-line: var(--divider-color, #e6e9ee);
        --sky-card: var(--card-background-color, #fff);
        --sky-today: #e57368;
        --sky-fab: #7e57c2;
        --dinner-bg: #1f3d2b;
        --dinner-ink: #f5f2e8;
        --dinner-gold: #d4af6a;
        color: var(--sky-ink);
      }
      .top { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 14px; }
      .family { font-family: Georgia, "Times New Roman", serif; font-size: 1.7rem; font-weight: 600; letter-spacing: -.01em; margin: 0; }
      .clock { font-size: 1.25rem; color: var(--sky-muted); font-variant-numeric: tabular-nums; }
      .controls { margin-left: auto; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      .seg { display: inline-flex; border: 1px solid var(--sky-line); border-radius: 999px; overflow: hidden; background: var(--sky-card); }
      .seg button { border: 0; background: transparent; padding: 6px 14px; min-height: 36px; cursor: pointer; color: var(--sky-muted); }
      .seg button.on { background: var(--fh-surface-2, #eef1f6); color: var(--sky-ink); font-weight: 650; }
      .icon-btn { border: 1px solid var(--sky-line); background: var(--sky-card); color: inherit; border-radius: 999px; min-height: 36px; min-width: 36px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; padding: 0 10px; gap: 4px; }
      .range { font-weight: 650; min-width: 9ch; }

      .members { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; padding: 4px 2px 12px; }
      .member { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 8px 12px; border-radius: 14px; border: 1px solid var(--sky-line); background: var(--sky-card); color: inherit; cursor: pointer; text-align: left; }
      .member.on { border-color: var(--c); box-shadow: 0 0 0 2px color-mix(in srgb, var(--c) 45%, transparent); }
      .member.dim { opacity: .45; }
      .dot { width: 30px; height: 30px; flex: none; border-radius: 50%; display: grid; place-items: center; background: var(--c); color: #fff; font-weight: 700; font-size: .85rem; }
      .member-body { flex: 1; min-width: 0; }
      .member-name { display: flex; justify-content: space-between; font-weight: 650; font-size: .92rem; gap: 8px; }
      .member-name small { color: var(--sky-muted); font-weight: 500; }
      .bar { height: 6px; border-radius: 99px; background: var(--fh-surface-2, #edf0f4); margin-top: 6px; overflow: hidden; }
      .bar > i { display: block; height: 100%; background: var(--c); border-radius: 99px; }

      .notice { padding: 14px 16px; border-radius: 14px; background: var(--fh-warn-bg, #fff7e8); color: var(--fh-warn-ink, #7a5212); margin-bottom: 12px; }
      .notice.error { background: var(--fh-error-bg, #fdecea); color: var(--fh-error-ink, #8a2a20); }

      .board { background: var(--sky-card); border: 1px solid var(--sky-line); border-radius: 18px; overflow: hidden; }
      .week-head, .allday-row, .grid { display: grid; grid-template-columns: 56px repeat(var(--days), minmax(0, 1fr)); }
      .week-head { position: sticky; top: 0; z-index: 5; background: var(--sky-card); border-bottom: 1px solid var(--sky-line); }
      .week-head > div { padding: 10px 8px; border-left: 1px solid var(--sky-line); font-weight: 650; display: flex; align-items: center; gap: 6px; }
      .week-head > div.clickable { cursor: pointer; }
      .week-head > div:first-child, .allday-row > div:first-child { border-left: 0; }
      .daynum { display: inline-grid; place-items: center; min-width: 26px; height: 26px; border-radius: 50%; font-size: .85rem; }
      .today .daynum { background: var(--sky-today); color: #fff; }
      .allday-row { border-bottom: 1px solid var(--sky-line); }
      .allday-row > div { border-left: 1px solid var(--sky-line); padding: 4px; display: flex; flex-direction: column; gap: 3px; min-height: 28px; min-width: 0; }
      .allday-label { font-size: .7rem; color: var(--sky-muted); justify-content: center; align-items: center; }
      .scroll { max-height: calc(100vh - 250px); min-height: 420px; overflow-y: auto; }
      .grid { position: relative; }
      .hours { position: relative; }
      .hours span { position: absolute; right: 8px; transform: translateY(-50%); font-size: .7rem; color: var(--sky-muted); white-space: nowrap; }
      .col { position: relative; border-left: 1px solid var(--sky-line); background-image: linear-gradient(var(--sky-line) 1px, transparent 1px); background-size: 100% ${HOUR_PX}px; }
      .col.today { background-color: var(--fh-today-col, #fbfcfe); }
      .now { position: absolute; left: 0; right: 0; height: 2px; background: var(--sky-today); z-index: 3; }
      .now::before { content: ""; position: absolute; left: -5px; top: -4px; width: 10px; height: 10px; border-radius: 50%; background: var(--sky-today); }

      .ev { position: absolute; border-radius: 10px; padding: 5px 7px; overflow: hidden; cursor: pointer; border: 0; text-align: left; font: inherit; color: var(--fh-event-ink, #2f3a4a); background: var(--bg); box-shadow: inset 3px 0 0 var(--c); display: flex; flex-direction: column; gap: 1px; min-height: 0; }
      .ev:hover { filter: brightness(.97); }
      .ev .t { font-weight: 650; font-size: .8rem; line-height: 1.2; padding-right: var(--bp, 0); }
      .ev.short .t { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ev .w { font-size: .7rem; color: var(--fh-event-ink, #5b6676); opacity: .75; }
      .ev .badges { position: absolute; top: 4px; right: 4px; margin: 0; flex-wrap: nowrap; }
      .badges { display: flex; gap: 2px; flex-wrap: wrap; margin-top: auto; justify-content: flex-end; }
      .badge { width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; font-size: .6rem; font-weight: 700; color: #fff; background: var(--c); border: 1.5px solid var(--sky-card); }
      .chip { border: 0; border-radius: 8px; padding: 3px 7px; font: inherit; font-size: .75rem; font-weight: 600; text-align: left; cursor: pointer; background: var(--bg); box-shadow: inset 3px 0 0 var(--c); color: var(--fh-event-ink, #2f3a4a); display: flex; gap: 4px; align-items: center; min-height: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
      .chip .badges { margin: 0 0 0 auto; flex-wrap: nowrap; }
            .chip.dinner { background: var(--dinner-bg); color: var(--dinner-ink); box-shadow: inset 3px 0 0 var(--dinner-gold); font-family: Georgia, "Times New Roman", serif; font-style: italic; --mdc-icon-size: 14px; }
      .chip.dinner ha-icon { color: var(--dinner-gold); flex: none; }
      .chip .rep { --mdc-icon-size: 12px; opacity: .6; flex: none; }

      .month { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); }
      .month .dow { padding: 8px; font-size: .75rem; color: var(--sky-muted); font-weight: 650; border-bottom: 1px solid var(--sky-line); }
      .cell { min-height: 108px; border-left: 1px solid var(--sky-line); border-bottom: 1px solid var(--sky-line); padding: 4px; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
      .cell:nth-child(7n + 1) { border-left: 0; }
      .cell.other { background: var(--fh-surface-3, #fafbfc); color: var(--sky-muted); }
      .cell .daynum { align-self: flex-start; cursor: pointer; }
      .cell .more { font-size: .7rem; color: var(--sky-muted); padding-left: 4px; }

      .fab { position: fixed; right: 28px; bottom: 28px; width: 58px; height: 58px; border-radius: 50%; border: 0; background: var(--sky-fab); color: #fff; box-shadow: 0 8px 24px rgba(126, 87, 194, .4); cursor: pointer; display: grid; place-items: center; z-index: 20; --mdc-icon-size: 30px; }

      .detail-time { color: var(--sky-muted); margin: 0 0 6px; }
      .detail-meta { display: flex; gap: 6px; align-items: center; color: var(--sky-muted); font-size: .9rem; margin: 2px 0; }
      .desc { white-space: pre-wrap; margin: 10px 0; font-size: .92rem; }
      .people { display: flex; flex-wrap: wrap; gap: 8px; }
      .person { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px 6px 6px; border-radius: 999px; border: 1px solid var(--sky-line); cursor: pointer; background: var(--sky-card); min-height: 40px; margin: 0; color: inherit; font-size: .95rem; }
      .person.on { border-color: var(--c); background: color-mix(in srgb, var(--c) 22%, var(--fh-tint-base, white)); }
      .person .dot { width: 26px; height: 26px; font-size: .75rem; }
      .person input { display: none; }
      .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      .check { display: flex; align-items: center; gap: 8px; margin: 12px 0 4px; color: inherit; font-size: .95rem; }
      .check input { width: auto; }
      .weekdays { display: flex; gap: 6px; margin-top: 8px; }
      .weekdays button { width: 38px; height: 38px; min-height: 0; border-radius: 50%; border: 1px solid var(--sky-line); background: var(--sky-card); cursor: pointer; font-weight: 650; padding: 0; }
      .weekdays button.on { background: var(--sky-fab); border-color: var(--sky-fab); color: #fff; }
      .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px; flex-wrap: wrap; }
      .actions .left { margin-right: auto; }
      button.danger { background: var(--sky-card); color: var(--fh-danger, #b3261e); border: 1px solid var(--fh-danger-line, #f0c4bf); border-radius: 10px; padding: 10px 16px; cursor: pointer; }
      button.ghost { background: var(--sky-card); color: inherit; border: 1px solid var(--sky-line); border-radius: 10px; padding: 10px 16px; cursor: pointer; }
      .err { color: var(--fh-danger, #b3261e); margin-top: 10px; }
      h3.section { margin: 20px 0 6px; font-size: .95rem; }
      .cal-list { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
      .cal-list label { display: flex; gap: 10px; align-items: center; margin: 0; padding: 8px 4px; color: inherit; font-size: .95rem; }
      .cal-list input { width: auto; }
      .color-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid var(--sky-line); flex-wrap: wrap; }
      .color-row:last-child { border-bottom: 0; }
      .color-row .who { display: flex; align-items: center; gap: 8px; min-width: 110px; font-weight: 600; }
      .swatches { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
      .swatch { width: 26px; height: 26px; min-height: 0; border-radius: 50%; border: 2px solid transparent; background: var(--c); cursor: pointer; padding: 0; }
      .swatch.on { border-color: var(--sky-ink); box-shadow: 0 0 0 2px var(--sky-card) inset; }
      .swatches input[type="color"] { width: 32px; height: 28px; padding: 0; border: 0; background: none; cursor: pointer; }

      @media (max-width: 760px) {
        .week-head, .allday-row, .grid { grid-template-columns: 40px repeat(var(--days), minmax(0, 1fr)); }
        .week-head > div { flex-direction: column; gap: 0; padding: 6px 2px; font-size: .75rem; }
        :host([view="week"]) .ev { padding: 3px 4px; }
        :host([view="week"]) .ev .w, :host([view="week"]) .ev .badges { display: none; }
        .cell { min-height: 72px; }
        .members { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .fab { right: 18px; bottom: 84px; }
      }

      /* ---- phone: month + agenda, like the iOS Calendar app ---- */
      .p-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
      .p-year { border: 0; background: var(--fh-surface-2, #eef1f6); color: inherit; border-radius: 999px; padding: 6px 16px; min-height: 36px; display: inline-flex; align-items: center; gap: 2px; font: inherit; font-size: 1rem; cursor: pointer; }
      .p-actions { margin-left: auto; display: inline-flex; background: var(--fh-surface-2, #eef1f6); border-radius: 999px; padding: 2px; }
      .p-actions button { border: 0; background: none; color: inherit; min-height: 40px; min-width: 44px; display: grid; place-items: center; cursor: pointer; border-radius: 999px; }
      .p-month { font-size: 2.1rem; font-weight: 750; letter-spacing: -.02em; margin: 8px 0 10px; }
      .p-people { display: flex; gap: 6px; overflow-x: auto; padding: 0 0 10px; scrollbar-width: none; }
      .p-people::-webkit-scrollbar { display: none; }
      .p-person { flex: none; display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--sky-line); background: var(--sky-card); color: inherit; border-radius: 999px; padding: 3px 10px 3px 3px; min-height: 0; font: inherit; font-size: .85rem; cursor: pointer; }
      .p-person .dot { width: 24px; height: 24px; font-size: .7rem; }
      .p-person.on { border-color: var(--c); background: color-mix(in srgb, var(--c) 22%, var(--fh-tint-base, white)); }
      .p-person.dim { opacity: .45; }
      .p-dow, .p-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); text-align: center; }
      .p-dow { font-size: .72rem; font-weight: 650; color: var(--sky-muted); border-bottom: 1px solid var(--sky-line); padding-bottom: 6px; }
      .p-grid { touch-action: pan-y; }
      .p-day { border: 0; border-bottom: 1px solid var(--sky-line); background: none; color: inherit; font: inherit; min-height: 64px; padding: 8px 0 6px; display: flex; flex-direction: column; align-items: center; gap: 5px; cursor: pointer; }
      .p-day.blank { cursor: default; }
      .p-num { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 50%; font-size: 1.15rem; font-weight: 600; }
      .p-day.weekend .p-num { color: var(--sky-muted); }
      .p-day.today .p-num { color: var(--sky-today); }
      .p-day.picked .p-num { background: var(--sky-ink); color: var(--sky-card); }
      .p-day.picked.today .p-num { background: var(--sky-today); color: #fff; }
      .p-bar { display: flex; height: 6px; width: 26px; border-radius: 99px; overflow: hidden; gap: 1px; }
      .p-bar i { flex: 1; background: var(--c); }
      .p-agenda { margin-top: 6px; padding-bottom: 76px; /* clear of the + button */ }
      .p-agenda h2 { font-size: .85rem; color: var(--sky-muted); font-weight: 650; margin: 10px 2px 4px; text-transform: uppercase; letter-spacing: .04em; }
      .p-item { display: flex; gap: 12px; align-items: stretch; width: 100%; border: 0; border-bottom: 1px solid var(--sky-line); background: none; color: inherit; font: inherit; text-align: left; padding: 12px 2px; cursor: pointer; min-height: 0; }
      .p-item .stripe { width: 5px; flex: none; border-radius: 99px; background: var(--c); }
      .p-item .main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
      .p-item .title { font-size: 1.1rem; font-weight: 650; display: flex; align-items: center; gap: 6px; }
      .p-item .title ha-icon { --mdc-icon-size: 16px; color: var(--sky-muted); }
      .p-item .meta { font-size: .9rem; color: var(--sky-muted); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; --mdc-icon-size: 16px; }
      .p-item .meta .badges { margin: 0; gap: 4px; }
      .p-item .meta .badge { width: 22px; height: 22px; font-size: .68rem; border: 0; }
      .p-item .times { flex: none; text-align: right; font-size: 1rem; font-variant-numeric: tabular-nums; display: flex; flex-direction: column; gap: 2px; }
      .p-item .times span + span { color: var(--sky-muted); }
      .p-item.dinner .title { font-family: Georgia, "Times New Roman", serif; font-style: italic; }
      .p-empty { color: var(--sky-muted); padding: 18px 2px; }
    `,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    this._onPhoneChange();
    this._phoneQuery.addEventListener("change", this._onPhoneChange);
    this._clock = window.setInterval(() => (this._now = new Date()), 30_000);
    this._refresh = window.setInterval(() => this._load(true), REFRESH_MS);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this._phoneQuery.removeEventListener("change", this._onPhoneChange);
    window.clearInterval(this._clock);
    window.clearInterval(this._refresh);
  }

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has("_view")) this.setAttribute("view", this._view);
    if (
      changed.has("extras") ||
      changed.has("_view") ||
      changed.has("_anchor") ||
      changed.has("_mobile")
    ) {
      void this._load(false);
    }
  }

  // ------------------------------------------------------------- data

  private get _isParent(): boolean {
    return this.me?.role === "parent";
  }

  private get _isAdmin(): boolean {
    return this._isParent && this.me?.permissionLevel === "admin";
  }

  private get _members(): MemberRosterEntry[] {
    return this.hustleState.memberRoster.filter((m) => m.active);
  }

  /** The calendars read for the grid: the family ones, plus the dinners
   * calendar when dinners are shown and it isn't already a family one. */
  private _sources(): { all: string[]; dinners: string | null } {
    const s = this.extras.calendarSettings;
    const family = s.familyCalendars;
    const dinners =
      s.showDinners && s.dinnersCalendar && !family.includes(s.dinnersCalendar)
        ? s.dinnersCalendar
        : null;
    return { all: dinners ? [...family, dinners] : family, dinners };
  }

  private _range(): { start: Date; end: Date; days: Date[] } {
    if (this._mobile) {
      // Just the month's own days - the phone grid leaves the rest blank.
      const start = new Date(this._anchor.getFullYear(), this._anchor.getMonth(), 1);
      const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
      const days = Array.from({ length: Math.round((+end - +start) / 86_400_000) }, (_, i) => addDays(start, i));
      return { start, end, days };
    }
    if (this._view === "day") {
      const start = startOfDay(this._anchor);
      return { start, end: addDays(start, 1), days: [start] };
    }
    if (this._view === "week") {
      const start = startOfWeek(this._anchor);
      const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
      return { start, end: addDays(start, 7), days };
    }
    const first = new Date(this._anchor.getFullYear(), this._anchor.getMonth(), 1);
    const start = startOfWeek(first);
    const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
    return { start, end: addDays(start, 42), days };
  }

  private async _load(force: boolean): Promise<void> {
    if (!this.extras) return;
    const sources = this._sources().all;
    const { start, end } = this._range();
    const key = `${dateKey(start)}|${dateKey(end)}|${sources.join(",")}`;
    if (!force && key === this._loadedKey) return;
    this._loadedKey = key;
    if (!sources.length) {
      this._events = [];
      this._errors = [];
      return;
    }
    this._loading = true;
    try {
      const result = await familyApi.events(dateKey(start), dateKey(end), sources);
      if (key !== this._loadedKey) return; // a newer range is loading
      this._events = result.events;
      this._errors = result.errors;
    } catch (err) {
      this._errors = [(err as Error).message];
    } finally {
      this._loading = false;
    }
  }

  /** Lunches share the meals calendar, titled "Lunch: <dish>" (meals.py). */
  private _isLunch(e: FamilyEvent): boolean {
    return e.summary.startsWith("Lunch: ");
  }

  private _mealIcon(e: FamilyEvent): string {
    return this._isLunch(e) ? "mdi:food-takeout-box-outline" : "mdi:silverware-fork-knife";
  }

  private _mealHeading(e: FamilyEvent): string {
    return this._isLunch(e) ? e.summary : `Dinner: ${e.summary}`;
  }

  private _isDinner(e: FamilyEvent): boolean {
    return e.entityId === this._sources().dinners;
  }

  /** Member filter: dinners are everyone's, so they always stay. */
  private _visible(events: FamilyEvent[]): FamilyEvent[] {
    if (!this._filterMemberId) return events;
    return events.filter(
      (e) =>
        this._isDinner(e) ||
        e.forMemberId === this._filterMemberId ||
        e.attendeeIds.includes(this._filterMemberId)
    );
  }

  private _color(e: FamilyEvent): string {
    return e.forMemberId ? memberColor(this.hustleState.memberRoster, e.forMemberId) : UNTAGGED_COLOR;
  }

  private _name(memberId: string): string {
    return this.hustleState.memberRoster.find((m) => m.id === memberId)?.haDisplayName ?? "";
  }

  // ------------------------------------------------------- navigation

  private _step(delta: number): void {
    const a = this._anchor;
    if (this._mobile) {
      // A new month on the phone picks its 1st - or today, back on this month.
      const month = new Date(a.getFullYear(), a.getMonth() + delta, 1);
      const today = startOfDay(new Date());
      const sameMonth = month.getFullYear() === today.getFullYear() && month.getMonth() === today.getMonth();
      this._anchor = month;
      this._pickedDay = sameMonth ? today : month;
      return;
    }
    if (this._view === "day") this._anchor = addDays(a, delta);
    else if (this._view === "week") this._anchor = addDays(a, delta * 7);
    else this._anchor = new Date(a.getFullYear(), a.getMonth() + delta, 1);
  }

  private _openDay(day: Date): void {
    this._anchor = day;
    this._view = "day";
  }

  private _rangeLabel(): string {
    if (this._view === "day") return longDate.format(this._anchor);
    if (this._view === "month") {
      return this._anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    }
    const { start } = this._range();
    return `${shortDate.format(start)} – ${shortDate.format(addDays(start, 6))}`;
  }

  // ----------------------------------------------------------- dialogs

  private _openEvent(e: FamilyEvent): void {
    this._selected = e;
    this._tagFor = e.forMemberId ?? "";
    this._tagAttendees = [...e.attendeeIds];
    this._dialogError = "";
  }

  private _toggle<T>(list: T[], id: T): T[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  }

  private async _run(action: () => Promise<unknown>, after: () => void): Promise<void> {
    this._busy = true;
    this._dialogError = "";
    try {
      await action();
      after();
      await this._load(true);
    } catch (err) {
      this._dialogError = (err as Error).message;
    } finally {
      this._busy = false;
    }
  }

  private _saveTags(): void {
    const e = this._selected;
    if (!e?.uid) return;
    void this._run(
      () =>
        familyApi.call(this.hass, "tag_event", {
          entity_id: e.entityId,
          uid: e.uid,
          for_member_id: this._tagFor || null,
          attendee_ids: this._tagAttendees,
        }),
      () => (this._selected = null)
    );
  }

  /** `series` deletes every occurrence of a repeating event; otherwise
   * only the one tapped. */
  private _deleteEvent(series: boolean): void {
    const e = this._selected;
    if (!e?.uid) return;
    const what = series ? `every occurrence of "${e.summary}"` : `"${e.summary}"${e.recurrenceId ? " on this day" : ""}`;
    if (!window.confirm(`Delete ${what} from ${e.calendarName}? This also removes it from Google Calendar.`)) return;
    void this._run(
      () =>
        familyApi.call(this.hass, "delete_event", {
          entity_id: e.entityId,
          uid: e.uid,
          ...(!series && e.recurrenceId ? { recurrence_id: e.recurrenceId } : {}),
        }),
      () => (this._selected = null)
    );
  }

  private _emptyDraft(day: Date = new Date()): Draft {
    const key = dateKey(day);
    return {
      summary: "",
      allDay: false,
      date: key,
      endDate: key,
      startTime: "09:00",
      endTime: "10:00",
      calendar: "",
      forMemberId: "",
      attendees: [],
      location: "",
      description: "",
      repeat: "none",
      repeatDays: [day.getDay()],
      repeatEnd: "never",
      repeatUntil: dateKey(addDays(day, 90)),
      repeatCount: 10,
      editing: null,
    };
  }

  /** The add dialog, filled in from an existing event to change it. */
  private _openEdit(e: FamilyEvent): void {
    const start = eventStart(e);
    const end = eventEnd(e);
    const lastDay = e.allDay ? addDays(end, -1) : new Date(end.getTime() - 1);
    const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const draft = this._emptyDraft(start);
    this._draft = {
      ...draft,
      summary: e.summary,
      allDay: e.allDay,
      date: dateKey(start),
      endDate: dateKey(lastDay < start ? start : lastDay),
      startTime: e.allDay ? draft.startTime : hhmm(start),
      endTime: e.allDay ? draft.endTime : hhmm(end),
      calendar: e.entityId,
      forMemberId: e.forMemberId ?? "",
      attendees: [...e.attendeeIds],
      location: e.location,
      description: e.description,
      repeat: e.rrule ? "keep" : "none",
      editing: {
        entityId: e.entityId,
        uid: e.uid!,
        recurrenceId: e.recurrenceId,
        rrule: e.rrule,
        scope: "one",
      },
    };
    this._selected = null;
    this._dialogError = "";
    this._adding = true;
  }

  private _openAdd(day?: Date): void {
    const draft = this._emptyDraft(day ?? (this._view === "day" ? this._anchor : new Date()));
    draft.calendar =
      this.extras.calendarSettings.defaultCalendar ?? this.extras.calendarSettings.familyCalendars[0] ?? "";
    this._draft = draft;
    this._dialogError = "";
    this._adding = true;
  }

  /** The draft's repeat choices as an iCalendar RRULE, or null. */
  private _rrule(d: Draft): string | null {
    if (d.repeat === "none") return null;
    if (d.repeat === "keep") return d.editing?.rrule ?? null;
    const parts: string[] = [];
    switch (d.repeat) {
      case "daily":
        parts.push("FREQ=DAILY");
        break;
      case "weekdays":
        parts.push("FREQ=WEEKLY", "BYDAY=MO,TU,WE,TH,FR");
        break;
      case "weekly":
      case "biweekly": {
        parts.push("FREQ=WEEKLY");
        if (d.repeat === "biweekly") parts.push("INTERVAL=2");
        const days = d.repeatDays.length ? d.repeatDays : [parseKey(d.date).getDay()];
        parts.push(`BYDAY=${[...days].sort().map((i) => RRULE_DAYS[i]).join(",")}`);
        break;
      }
      case "monthly":
        parts.push("FREQ=MONTHLY");
        break;
      case "yearly":
        parts.push("FREQ=YEARLY");
        break;
    }
    if (d.repeatEnd === "count") parts.push(`COUNT=${Math.max(1, d.repeatCount)}`);
    if (d.repeatEnd === "until") {
      const compact = d.repeatUntil.replace(/-/g, "");
      if (d.allDay) {
        parts.push(`UNTIL=${compact}`);
      } else {
        // Timed events need UNTIL in UTC: the end of that local day.
        const end = new Date(`${d.repeatUntil}T23:59:59`);
        parts.push(`UNTIL=${end.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "")}`);
      }
    }
    return parts.join(";");
  }

  private _saveNew(): void {
    const d = this._draft;
    if (!d.summary.trim()) {
      this._dialogError = "Give the event a name.";
      return;
    }
    let startDate = d.date;
    let endDate = d.endDate < d.date ? d.date : d.endDate;
    // A weekly repeat starts on its first chosen weekday - otherwise
    // Google also shows the start date itself as an extra occurrence.
    const days =
      d.repeat === "weekdays" ? [1, 2, 3, 4, 5]
      : d.repeat === "weekly" || d.repeat === "biweekly" ? d.repeatDays
      : [];
    if (days.length) {
      const first = parseKey(startDate);
      let shift = 0;
      while (!days.includes(addDays(first, shift).getDay())) shift += 1;
      startDate = dateKey(addDays(first, shift));
      endDate = dateKey(addDays(parseKey(endDate), shift));
    }
    const data: Record<string, unknown> = {
      summary: d.summary.trim(),
      all_day: d.allDay,
      attendee_ids: d.attendees,
      description: d.description,
      location: d.location,
    };
    if (d.calendar) data.entity_id = d.calendar;
    if (d.forMemberId) data.for_member_id = d.forMemberId;
    const target = d.editing;
    const oneDay = Boolean(target?.recurrenceId) && target?.scope === "one";
    const rule = oneDay ? null : this._rrule(d);
    if (rule) data.rrule = rule;
    if (target) {
      data.entity_id = target.entityId;
      data.uid = target.uid;
      if (target.recurrenceId) {
        data.recurrence_id = target.recurrenceId;
        if (target.scope === "following") data.recurrence_range = "THISANDFUTURE";
      }
    }
    if (d.allDay) {
      data.start = startDate;
      // The dialog's end date is inclusive; the calendar's is exclusive.
      data.end = dateKey(addDays(parseKey(endDate), 1));
    } else {
      const start = new Date(`${startDate}T${d.startTime}`);
      const end = new Date(`${endDate}T${d.endTime}`);
      if (end <= start) {
        this._dialogError = "The event has to end after it starts.";
        return;
      }
      data.start = start.toISOString();
      data.end = end.toISOString();
    }
    void this._run(
      () => familyApi.call(this.hass, target ? "update_event" : "create_event", data),
      () => (this._adding = false)
    );
  }

  private async _openSettings(): Promise<void> {
    const s = this.extras.calendarSettings;
    this._settingsDraft = {
      family: [...s.familyCalendars],
      defaultCalendar: s.defaultCalendar ?? "",
      showDinners: s.showDinners,
    };
    this._dialogError = "";
    this._settingsOpen = true;
    try {
      this._calendars = await familyApi.listCalendars();
    } catch (err) {
      this._dialogError = (err as Error).message;
    }
  }

  private _saveSettings(): void {
    const draft = this._settingsDraft;
    const defaultCalendar =
      draft.defaultCalendar && draft.family.includes(draft.defaultCalendar)
        ? draft.defaultCalendar
        : draft.family[0] ?? null;
    void this._run(
      () =>
        familyApi.call(this.hass, "update_calendar_settings", {
          family_calendars: draft.family,
          default_calendar: defaultCalendar,
          show_dinners: draft.showDinners,
        }),
      () => (this._settingsOpen = false)
    );
  }

  /** Saved straight away, like Skylight's profile colors. "" goes back to
   * the automatic pastel. */
  private async _setColor(member: MemberRosterEntry, color: string): Promise<void> {
    this._dialogError = "";
    try {
      await familyApi.call(this.hass, "update_member", { member_id: member.id, avatar_color: color });
    } catch (err) {
      this._dialogError = (err as Error).message;
    }
  }

  // ------------------------------------------------------------ render

  private _badges(e: FamilyEvent, max = 3) {
    if (!e.attendeeIds.length) return nothing;
    return html`<span class="badges">
      ${e.attendeeIds.slice(0, max).map(
        (id) => html`<span class="badge" style="--c:${memberColor(this.hustleState.memberRoster, id)}" title=${this._name(id)}>${initials(this._name(id))}</span>`
      )}
    </span>`;
  }

  private _chip(e: FamilyEvent) {
    if (this._isDinner(e)) {
      return html`<button class="chip dinner" @click=${() => this._openEvent(e)} title=${this._mealHeading(e)}>
        <ha-icon icon=${this._mealIcon(e)}></ha-icon>${e.summary}
      </button>`;
    }
    const c = this._color(e);
    const repeats = Boolean(e.rrule || e.recurrenceId);
    return html`<button class="chip" style="--c:${c};--bg:${tint(c, 0.32)}" @click=${() => this._openEvent(e)} title=${`${e.summary} · ${timeRange(e)}`}>
      ${e.allDay ? "" : html`<span>${timeFmt.format(eventStart(e))}</span>`} ${e.summary}
      ${repeats ? html`<ha-icon class="rep" icon="mdi:repeat"></ha-icon>` : nothing}
      ${this._badges(e)}
    </button>`;
  }

  private _memberStrip() {
    const progress = this.extras.todayChoreProgress;
    return html`<div class="members">
      ${this._members.map((m) => {
        const c = memberColor(this.hustleState.memberRoster, m.id);
        const p = progress[m.id] ?? { done: 0, total: 0 };
        const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
        const on = this._filterMemberId === m.id;
        return html`<button
          class="member ${on ? "on" : ""} ${this._filterMemberId && !on ? "dim" : ""}"
          style="--c:${c}"
          aria-pressed=${on ? "true" : "false"}
          @click=${() => (this._filterMemberId = on ? "" : m.id)}
        >
          <span class="dot">${initials(m.haDisplayName)}</span>
          <span class="member-body">
            <span class="member-name">${m.haDisplayName}<small>${p.total ? `${p.done}/${p.total}` : "—"}</small></span>
            <span class="bar"><i style="width:${pct}%"></i></span>
          </span>
        </button>`;
      })}
    </div>`;
  }

  private _hourBounds(timed: FamilyEvent[]): [number, number] {
    let first = DEFAULT_FIRST_HOUR;
    let last = DEFAULT_LAST_HOUR;
    for (const e of timed) {
      const days = eventDays(e);
      if (days.length > 1) return [0, 24]; // spans midnight - show the whole day
      first = Math.min(first, eventStart(e).getHours());
      const end = eventEnd(e);
      last = Math.max(last, end.getHours() + (end.getMinutes() ? 1 : 0));
    }
    return [Math.max(0, first), Math.min(24, Math.max(last, first + 1))];
  }

  /** Side-by-side lanes for overlapping events within one day column. */
  private _place(day: Date, events: FamilyEvent[], firstHour: number, lastHour: number): Placed[] {
    const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), firstHour).getTime();
    const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate(), lastHour).getTime();
    const items = events
      .map((event) => {
        const s = Math.max(eventStart(event).getTime(), dayStart);
        const e = Math.min(Math.max(eventEnd(event).getTime(), s + 15 * 60_000), dayEnd);
        return { event, s, e };
      })
      .filter((i) => i.e > i.s)
      .sort((a, b) => a.s - b.s || b.e - a.e);

    const placed: Placed[] = [];
    let cluster: Placed[] = [];
    let laneEnds: number[] = [];
    let clusterEnd = 0;
    const flush = () => {
      cluster.forEach((p) => (p.lanes = laneEnds.length));
      cluster = [];
      laneEnds = [];
    };
    for (const item of items) {
      if (cluster.length && item.s >= clusterEnd) flush();
      let lane = laneEnds.findIndex((end) => end <= item.s);
      if (lane === -1) {
        lane = laneEnds.length;
        laneEnds.push(item.e);
      } else {
        laneEnds[lane] = item.e;
      }
      clusterEnd = Math.max(clusterEnd, item.e);
      const p: Placed = {
        event: item.event,
        top: ((item.s - dayStart) / 3_600_000) * HOUR_PX,
        height: Math.max(((item.e - item.s) / 3_600_000) * HOUR_PX - 2, 22),
        lane,
        lanes: 1,
      };
      cluster.push(p);
      placed.push(p);
    }
    flush();
    return placed;
  }

  /** The time-grid for the Day view (one column) and Week view (seven). */
  private _gridView(events: FamilyEvent[]) {
    const { days } = this._range();
    const single = days.length === 1;
    const todayKey = dateKey(this._now);
    const allDay = events
      .filter((e) => e.allDay)
      .sort((a, b) => Number(this._isDinner(b)) - Number(this._isDinner(a)));
    const timed = events.filter((e) => !e.allDay);
    const [firstHour, lastHour] = this._hourBounds(timed);
    const hours = Array.from({ length: lastHour - firstHour }, (_, i) => firstHour + i);
    const height = hours.length * HOUR_PX;
    const nowTop =
      ((this._now.getHours() + this._now.getMinutes() / 60 - firstHour) / (lastHour - firstHour)) * height;
    const maxBadges = (lanes: number) => (single ? 6 : lanes > 1 ? 1 : 3);

    return html`<div class="board" style="--days:${days.length}"><div class="scroll">
      <div class="week-head">
        <div></div>
        ${days.map(
          (d) => html`<div
            class="${dateKey(d) === todayKey ? "today" : ""} ${single ? "" : "clickable"}"
            title=${single ? "" : "Open this day"}
            @click=${() => !single && this._openDay(d)}
          >
            <span>${d.toLocaleDateString(undefined, { weekday: single ? "long" : "short" })}</span>
            <span class="daynum">${d.getDate()}</span>
          </div>`
        )}
      </div>
      <div class="allday-row">
        <div class="allday-label">all-day</div>
        ${days.map((d) => {
          const key = dateKey(d);
          return html`<div>${allDay.filter((e) => eventDays(e).includes(key)).map((e) => this._chip(e))}</div>`;
        })}
      </div>
        <div class="grid" style="height:${height}px">
          <div class="hours">
            ${hours.map(
              (h, i) => html`<span style="top:${i * HOUR_PX}px">${i === 0 ? "" : new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: "numeric" })}</span>`
            )}
          </div>
          ${days.map((d) => {
            const key = dateKey(d);
            const isToday = key === todayKey;
            const dayEvents = timed.filter((e) => eventDays(e).includes(key));
            return html`<div
              class="col ${isToday ? "today" : ""}"
              @dblclick=${() => this._isParent && this._openAdd(d)}
            >
              ${isToday && nowTop >= 0 && nowTop <= height ? html`<div class="now" style="top:${nowTop}px"></div>` : nothing}
              ${this._place(d, dayEvents, firstHour, lastHour).map((p) => {
                const c = this._color(p.event);
                const width = 100 / p.lanes;
                const badges = maxBadges(p.lanes);
                const badgeRoom = Math.min(p.event.attendeeIds.length, badges) * 20;
                const repeats = Boolean(p.event.rrule || p.event.recurrenceId);
                return html`<button
                  class="ev ${p.height < 40 ? "short" : ""}"
                  style="top:${p.top}px;height:${p.height}px;left:calc(${p.lane * width}% + 3px);width:calc(${width}% - 6px);--c:${c};--bg:${tint(c, 0.32)};--bp:${badgeRoom}px"
                  title=${`${p.event.summary} · ${timeRange(p.event)}`}
                  @click=${() => this._openEvent(p.event)}
                >
                  <span class="t">${p.event.summary}</span>
                  ${p.height > 34
                    ? html`<span class="w">${timeRange(p.event)}${repeats ? " · repeats" : ""}${single && p.event.location ? ` · ${p.event.location}` : ""}</span>`
                    : nothing}
                  ${this._badges(p.event, badges)}
                </button>`;
              })}
            </div>`;
          })}
        </div>
    </div></div>`;
  }

  private _monthView(events: FamilyEvent[]) {
    const { days } = this._range();
    const month = this._anchor.getMonth();
    const todayKey = dateKey(this._now);
    const byDay = new Map<string, FamilyEvent[]>();
    for (const e of events) {
      for (const key of eventDays(e)) byDay.set(key, [...(byDay.get(key) ?? []), e]);
    }
    const order = (a: FamilyEvent, b: FamilyEvent) =>
      Number(this._isDinner(b)) - Number(this._isDinner(a)) ||
      Number(b.allDay) - Number(a.allDay) ||
      a.start.localeCompare(b.start);
    return html`<div class="board">
      <div class="month">
        ${days.slice(0, 7).map((d) => html`<div class="dow">${d.toLocaleDateString(undefined, { weekday: "short" })}</div>`)}
        ${days.map((d) => {
          const key = dateKey(d);
          const list = (byDay.get(key) ?? []).sort(order);
          return html`<div class="cell ${d.getMonth() !== month ? "other" : ""} ${key === todayKey ? "today" : ""}" @dblclick=${() => this._isParent && this._openAdd(d)}>
            <span class="daynum" title="Open this day" @click=${() => this._openDay(d)}>${d.getDate()}</span>
            ${list.slice(0, 3).map((e) => this._chip(e))}
            ${list.length > 3 ? html`<span class="more">+${list.length - 3} more</span>` : nothing}
          </div>`;
        })}
      </div>
    </div>`;
  }

  private _people(selected: string[], onToggle: (id: string) => void) {
    return html`<div class="people">
      ${this._members.map((m) => {
        const on = selected.includes(m.id);
        return html`<label class="person ${on ? "on" : ""}" style="--c:${memberColor(this.hustleState.memberRoster, m.id)}">
          <input type="checkbox" .checked=${on} ?disabled=${!this._isParent} @change=${() => onToggle(m.id)} />
          <span class="dot">${initials(m.haDisplayName)}</span>${m.haDisplayName}
        </label>`;
      })}
    </div>`;
  }

  private _forSelect(value: string, onChange: (v: string) => void) {
    return html`<select .value=${value} ?disabled=${!this._isParent} @change=${(e: Event) => onChange((e.target as HTMLSelectElement).value)}>
      <option value="" ?selected=${!value}>Whole family</option>
      ${this._members.map((m) => html`<option value=${m.id} ?selected=${m.id === value}>${m.haDisplayName}</option>`)}
    </select>`;
  }

  private _eventDialog() {
    const e = this._selected;
    if (!e) return nothing;
    const dinner = this._isDinner(e);
    const repeats = Boolean(e.rrule || e.recurrenceId);
    const day = longDate.format(eventStart(e));
    const when = e.allDay && timeRange(e) === "All day" ? day : `${day} · ${timeRange(e)}`;
    return html`<hustle-dialog open .heading=${dinner ? this._mealHeading(e) : e.summary} @hustle-dialog-closed=${() => (this._selected = null)}>
      <p class="detail-time">${when}</p>
      <div class="detail-meta"><ha-icon icon="mdi:calendar"></ha-icon>${e.calendarName}</div>
      ${repeats ? html`<div class="detail-meta"><ha-icon icon="mdi:repeat"></ha-icon>${describeRepeat(e.rrule)}</div>` : nothing}
      ${e.location ? html`<div class="detail-meta"><ha-icon icon="mdi:map-marker"></ha-icon>${e.location}</div>` : nothing}
      ${e.description ? html`<p class="desc">${e.description}</p>` : nothing}
      ${dinner
        ? html`<p class="detail-meta">Planned on the Meals tab.</p>`
        : e.uid
          ? html`
              <label>Who it's for</label>
              ${this._forSelect(this._tagFor, (v) => (this._tagFor = v))}
              <label>Who's attending</label>
              ${this._people(this._tagAttendees, (id) => (this._tagAttendees = this._toggle(this._tagAttendees, id)))}
              ${repeats ? html`<p class="detail-meta">Tags apply to every occurrence.</p>` : nothing}
            `
          : html`<p class="detail-meta">This calendar doesn't give its events ids, so they can't be tagged.</p>`}
      ${this._dialogError ? html`<p class="err">${this._dialogError}</p>` : nothing}
      <div class="actions">
        ${this._isParent && e.uid && !dinner
          ? repeats
            ? html`<button class="danger left" ?disabled=${this._busy} @click=${() => this._deleteEvent(false)}>Delete this one</button>
                <button class="danger" ?disabled=${this._busy} @click=${() => this._deleteEvent(true)}>Delete all</button>`
            : html`<button class="danger left" ?disabled=${this._busy} @click=${() => this._deleteEvent(false)}>Delete</button>`
          : nothing}
        ${this._isParent && e.uid && !dinner ? html`<button class="ghost" @click=${() => this._openEdit(e)}>Edit</button>` : nothing}
        <button class="ghost" @click=${() => (this._selected = null)}>Close</button>
        ${this._isParent && e.uid && !dinner ? html`<button class="primary" ?disabled=${this._busy} @click=${this._saveTags}>Save</button>` : nothing}
      </div>
    </hustle-dialog>`;
  }

  private _repeatFields(d: Draft, set: (patch: Partial<Draft>) => void) {
    const weekly = d.repeat === "weekly" || d.repeat === "biweekly";
    return html`
      <label>Repeat</label>
      <select @change=${(e: Event) => set({ repeat: (e.target as HTMLSelectElement).value as Repeat })}>
        ${(
          [
            ...(d.editing?.rrule ? [["keep", describeRepeat(d.editing.rrule)] as [Repeat, string]] : []),
            ["none", "Does not repeat"],
            ["daily", "Every day"],
            ["weekdays", "Every weekday (Mon–Fri)"],
            ["weekly", "Every week"],
            ["biweekly", "Every 2 weeks"],
            ["monthly", "Every month"],
            ["yearly", "Every year"],
          ] as Array<[Repeat, string]>
        ).map(([value, label]) => html`<option value=${value} ?selected=${d.repeat === value}>${label}</option>`)}
      </select>
      ${weekly
        ? html`<div class="weekdays" role="group" aria-label="Repeat on">
            ${DAY_LETTERS.map(
              (letter, i) => html`<button
                class=${d.repeatDays.includes(i) ? "on" : ""}
                aria-pressed=${d.repeatDays.includes(i) ? "true" : "false"}
                title=${new Date(2026, 0, 4 + i).toLocaleDateString(undefined, { weekday: "long" })}
                @click=${() => set({ repeatDays: this._toggle(d.repeatDays, i) })}
              >${letter}</button>`
            )}
          </div>`
        : nothing}
      ${d.repeat !== "none"
        ? html`<div class="row2">
            <div>
              <label>Stop repeating</label>
              <select @change=${(e: Event) => set({ repeatEnd: (e.target as HTMLSelectElement).value as RepeatEnd })}>
                <option value="never" ?selected=${d.repeatEnd === "never"}>Never</option>
                <option value="until" ?selected=${d.repeatEnd === "until"}>On a date</option>
                <option value="count" ?selected=${d.repeatEnd === "count"}>After a number of times</option>
              </select>
            </div>
            <div>
              ${d.repeatEnd === "until"
                ? html`<label>Last day</label><input type="date" .value=${d.repeatUntil} @input=${(e: Event) => set({ repeatUntil: (e.target as HTMLInputElement).value })} />`
                : d.repeatEnd === "count"
                  ? html`<label>Times</label><input type="number" min="1" .value=${String(d.repeatCount)} @input=${(e: Event) => set({ repeatCount: Number((e.target as HTMLInputElement).value) || 1 })} />`
                  : nothing}
            </div>
          </div>`
        : nothing}
    `;
  }

  private _addDialog() {
    if (!this._adding) return nothing;
    const d = this._draft;
    const set = (patch: Partial<Draft>) => (this._draft = { ...this._draft, ...patch });
    const input = (key: keyof Draft) => (ev: Event) => set({ [key]: (ev.target as HTMLInputElement).value } as Partial<Draft>);
    const family = this.extras.calendarSettings.familyCalendars;
    const target = d.editing;
    const series = Boolean(target?.recurrenceId);
    const oneDay = series && target?.scope === "one";
    return html`<hustle-dialog open heading=${target ? "Edit event" : "New event"} @hustle-dialog-closed=${() => (this._adding = false)}>
      ${series
        ? html`<label>Change</label>
            <select @change=${(ev: Event) => set({ editing: { ...target!, scope: (ev.target as HTMLSelectElement).value as EditTarget["scope"] } })}>
              <option value="one" ?selected=${target!.scope === "one"}>Only this day</option>
              <option value="following" ?selected=${target!.scope === "following"}>This day and every one after</option>
            </select>`
        : nothing}
      <label>Title</label>
      <input .value=${d.summary} @input=${input("summary")} placeholder="Soccer practice" />
      <label class="check"><input type="checkbox" .checked=${d.allDay} @change=${(ev: Event) => set({ allDay: (ev.target as HTMLInputElement).checked })} />All day</label>
      ${d.allDay
        ? html`<div class="row2">
            <div><label>From</label><input type="date" .value=${d.date} @input=${(ev: Event) => {
              const date = (ev.target as HTMLInputElement).value;
              set({ date, endDate: d.endDate < date ? date : d.endDate });
            }} /></div>
            <div><label>Through</label><input type="date" .value=${d.endDate} min=${d.date} @input=${input("endDate")} /></div>
          </div>`
        : html`<div class="row2">
              <div><label>Starts</label><input type="date" .value=${d.date} @input=${(ev: Event) => {
                const date = (ev.target as HTMLInputElement).value;
                set({ date, endDate: d.endDate < date ? date : d.endDate });
              }} /></div>
              <div><label>&nbsp;</label><input type="time" .value=${d.startTime} @input=${input("startTime")} /></div>
            </div>
            <div class="row2">
              <div><label>Ends</label><input type="date" .value=${d.endDate} min=${d.date} @input=${input("endDate")} /></div>
              <div><label>&nbsp;</label><input type="time" .value=${d.endTime} @input=${input("endTime")} /></div>
            </div>`}
      ${oneDay ? nothing : this._repeatFields(d, set)}
      ${family.length > 1 && !target
        ? html`<label>Calendar</label>
            <select @change=${input("calendar")}>
              ${family.map((id) => html`<option value=${id} ?selected=${id === d.calendar}>${id}</option>`)}
            </select>`
        : nothing}
      <label>Who it's for</label>
      ${this._forSelect(d.forMemberId, (v) => set({ forMemberId: v }))}
      <label>Who's attending</label>
      ${this._people(d.attendees, (id) => set({ attendees: this._toggle(d.attendees, id) }))}
      <label>Location</label>
      <input .value=${d.location} @input=${input("location")} />
      <label>Notes</label>
      <textarea rows="2" .value=${d.description} @input=${input("description")}></textarea>
      ${this._dialogError ? html`<p class="err">${this._dialogError}</p>` : nothing}
      <div class="actions">
        <button class="ghost" @click=${() => (this._adding = false)}>Cancel</button>
        <button class="primary" ?disabled=${this._busy} @click=${this._saveNew}>${target ? "Save changes" : "Add to calendar"}</button>
      </div>
    </hustle-dialog>`;
  }

  private _colorRows() {
    return this._members.map((m) => {
      const current = memberColor(this.hustleState.memberRoster, m.id);
      return html`<div class="color-row">
        <span class="who"><span class="dot" style="--c:${current}">${initials(m.haDisplayName)}</span>${m.haDisplayName}</span>
        <span class="swatches">
          ${PASTELS.map(
            (c) => html`<button class="swatch ${current.toLowerCase() === c ? "on" : ""}" style="--c:${c}" aria-label="Use ${c}" @click=${() => this._setColor(m, c)}></button>`
          )}
          <input type="color" .value=${current} title="Any color" @change=${(e: Event) => this._setColor(m, (e.target as HTMLInputElement).value)} />
        </span>
      </div>`;
    });
  }

  private _settingsDialog() {
    if (!this._settingsOpen) return nothing;
    const draft = this._settingsDraft;
    const dinners = this.extras.calendarSettings.dinnersCalendar;
    return html`<hustle-dialog open heading="Calendar settings" @hustle-dialog-closed=${() => (this._settingsOpen = false)}>
      <h3 class="section">Calendars</h3>
      <p class="detail-meta">Pick which Home Assistant calendars show here. Your Google Calendar appears once Home Assistant's Google Calendar integration is set up.</p>
      <div class="cal-list">
        ${this._calendars.length === 0 && !this._dialogError ? html`<span class="detail-meta">Loading calendars…</span>` : nothing}
        ${this._calendars.map(
          (c) => html`<label>
            <input type="checkbox" .checked=${draft.family.includes(c.entity_id)} @change=${() =>
              (this._settingsDraft = { ...draft, family: this._toggle(draft.family, c.entity_id) })} />
            ${c.name}${c.entity_id === dinners ? html` <small class="detail-meta">(dinners)</small>` : nothing}
          </label>`
        )}
      </div>
      ${draft.family.length > 1
        ? html`<label>New events go to</label>
            <select @change=${(e: Event) => (this._settingsDraft = { ...draft, defaultCalendar: (e.target as HTMLSelectElement).value })}>
              ${draft.family.map(
                (id) => html`<option value=${id} ?selected=${id === draft.defaultCalendar}>${this._calendars.find((c) => c.entity_id === id)?.name ?? id}</option>`
              )}
            </select>`
        : nothing}
      <label class="check">
        <input type="checkbox" .checked=${draft.showDinners} ?disabled=${!dinners} @change=${(e: Event) =>
          (this._settingsDraft = { ...draft, showDinners: (e.target as HTMLInputElement).checked })} />
        Show dinners from the Meals tab
      </label>
      ${!dinners ? html`<p class="detail-meta">Pick a Dinners calendar on the Meals tab first.</p>` : nothing}
      <h3 class="section">Family colors</h3>
      <p class="detail-meta">Each person's color, used for their events and everywhere else. Changes save straight away.</p>
      ${this._colorRows()}
      ${this._dialogError ? html`<p class="err">${this._dialogError}</p>` : nothing}
      <div class="actions">
        <button class="ghost" @click=${() => (this._settingsOpen = false)}>Cancel</button>
        <button class="primary" ?disabled=${this._busy} @click=${this._saveSettings}>Save</button>
      </div>
    </hustle-dialog>`;
  }

  /** Colors for a day's bar under its date: one per family member with
   * events that day (who it's for and who's attending), plus grey for
   * untagged ones. Dinners don't count - nearly every day has one. */
  private _dayColors(events: FamilyEvent[]): string[] {
    const ids: string[] = [];
    let untagged = false;
    for (const e of events) {
      if (this._isDinner(e)) continue;
      const who = [e.forMemberId, ...e.attendeeIds].filter((id): id is string => Boolean(id));
      if (!who.length) untagged = true;
      for (const id of who) if (!ids.includes(id)) ids.push(id);
    }
    const colors = ids.map((id) => memberColor(this.hustleState.memberRoster, id));
    if (untagged) colors.push(UNTAGGED_COLOR);
    return colors.slice(0, 4);
  }

  private _agendaItem(e: FamilyEvent) {
    const dinner = this._isDinner(e);
    const color = dinner ? "var(--dinner-gold)" : this._color(e);
    const repeats = Boolean(e.rrule || e.recurrenceId);
    const times = e.allDay
      ? html`<span>all-day</span>`
      : html`<span>${timeFmt.format(eventStart(e))}</span><span>${timeFmt.format(eventEnd(e))}</span>`;
    return html`<button class="p-item ${dinner ? "dinner" : ""}" style="--c:${color}" @click=${() => this._openEvent(e)}>
      <span class="stripe"></span>
      <span class="main">
        <span class="title">${dinner ? html`<ha-icon icon=${this._mealIcon(e)}></ha-icon>` : nothing}${e.summary}${repeats ? html`<ha-icon icon="mdi:repeat"></ha-icon>` : nothing}</span>
        ${e.location || e.attendeeIds.length || eventDays(e).length > 1
          ? html`<span class="meta">
              ${e.location ? html`<ha-icon icon="mdi:map-marker"></ha-icon>${e.location}` : nothing}
              ${eventDays(e).length > 1 ? html`<span>${timeRange(e)}</span>` : nothing}
              ${this._badges(e, 6)}
            </span>`
          : nothing}
      </span>
      <span class="times">${times}</span>
    </button>`;
  }

  /** Phones get the iOS Calendar look: a big month name, a compact grid of
   * dates each with a bar of who has events that day, and the picked day's
   * events listed underneath. Swipe the grid sideways for the next or
   * previous month. */
  private _phoneView(events: FamilyEvent[]) {
    const { start, days } = this._range();
    const todayKey = dateKey(this._now);
    const pickedKey = dateKey(this._pickedDay);
    const byDay = new Map<string, FamilyEvent[]>();
    for (const e of events) {
      for (const key of eventDays(e)) byDay.set(key, [...(byDay.get(key) ?? []), e]);
    }
    const lead = (start.getDay() + 6) % 7; // Monday-first, like the rest of the app
    const dow = Array.from({ length: 7 }, (_, i) =>
      addDays(startOfWeek(start), i).toLocaleDateString(undefined, { weekday: "narrow" })
    );
    const picked = (byDay.get(pickedKey) ?? []).sort(
      (a, b) =>
        Number(this._isDinner(b)) - Number(this._isDinner(a)) ||
        Number(b.allDay) - Number(a.allDay) ||
        a.start.localeCompare(b.start)
    );
    const thisYear = start.getFullYear() === this._now.getFullYear();
    const swipe = {
      start: (e: TouchEvent) => (this._touchX = e.touches[0]?.clientX ?? null),
      end: (e: TouchEvent) => {
        const x = e.changedTouches[0]?.clientX;
        if (this._touchX !== null && x !== undefined && Math.abs(x - this._touchX) > 60) {
          this._step(x < this._touchX ? 1 : -1);
        }
        this._touchX = null;
      },
    };
    return html`
      <div class="p-head">
        <button class="p-year" @click=${() => {
          this._anchor = new Date();
          this._pickedDay = startOfDay(new Date());
        }}>Today</button>
        <span class="p-actions">
          <button aria-label="Previous month" @click=${() => this._step(-1)}><ha-icon icon="mdi:chevron-left"></ha-icon></button>
          <button aria-label="Next month" @click=${() => this._step(1)}><ha-icon icon="mdi:chevron-right"></ha-icon></button>
          ${this._isAdmin ? html`<button aria-label="Calendar settings" @click=${this._openSettings}><ha-icon icon="mdi:cog"></ha-icon></button>` : nothing}
        </span>
      </div>
      <div class="p-month">${start.toLocaleDateString(undefined, thisYear ? { month: "long" } : { month: "long", year: "numeric" })}${this._loading ? " …" : ""}</div>
      <div class="p-people">
        ${this._members.map((m) => {
          const on = this._filterMemberId === m.id;
          return html`<button class="p-person ${on ? "on" : ""} ${this._filterMemberId && !on ? "dim" : ""}"
            style="--c:${memberColor(this.hustleState.memberRoster, m.id)}"
            aria-pressed=${on ? "true" : "false"}
            @click=${() => (this._filterMemberId = on ? "" : m.id)}>
            <span class="dot">${initials(m.haDisplayName)}</span>${m.haDisplayName}
          </button>`;
        })}
      </div>
      <div class="p-dow">${dow.map((d) => html`<span>${d}</span>`)}</div>
      <div class="p-grid" @touchstart=${swipe.start} @touchend=${swipe.end}>
        ${Array.from({ length: lead }, () => html`<span class="p-day blank"></span>`)}
        ${days.map((d) => {
          const key = dateKey(d);
          const colors = this._dayColors(byDay.get(key) ?? []);
          const weekend = d.getDay() === 0 || d.getDay() === 6;
          return html`<button
            class="p-day ${weekend ? "weekend" : ""} ${key === todayKey ? "today" : ""} ${key === pickedKey ? "picked" : ""}"
            aria-label=${longDate.format(d)}
            aria-pressed=${key === pickedKey ? "true" : "false"}
            @click=${() => (this._pickedDay = d)}
            @dblclick=${() => this._isParent && this._openAdd(d)}
          >
            <span class="p-num">${d.getDate()}</span>
            ${colors.length ? html`<span class="p-bar">${colors.map((c) => html`<i style="--c:${c}"></i>`)}</span>` : html`<span class="p-bar"></span>`}
          </button>`;
        })}
      </div>
      <div class="p-agenda">
        <h2>${longDate.format(this._pickedDay)}</h2>
        ${picked.length ? picked.map((e) => this._agendaItem(e)) : html`<p class="p-empty">No events</p>`}
      </div>
    `;
  }

  render() {
    if (!this.extras || !this.hustleState) return nothing;
    const configured = this._sources().all.length > 0;
    const events = this._visible(this._events);
    const notices = html`
      ${!configured
        ? html`<div class="notice">
            ${this._isAdmin
              ? html`No calendars picked yet. Tap the <ha-icon icon="mdi:cog"></ha-icon> to choose your family's Google Calendar.`
              : html`An admin parent needs to pick the family calendar first.`}
          </div>`
        : nothing}
      ${this._errors.map((e) => html`<div class="notice error">Couldn't read ${e}</div>`)}
    `;
    const fab =
      this._isParent && this.extras.calendarSettings.familyCalendars.length
        ? html`<button class="fab" aria-label="Add event" @click=${() => this._openAdd(this._mobile ? this._pickedDay : undefined)}><ha-icon icon="mdi:plus"></ha-icon></button>`
        : nothing;
    if (this._mobile) {
      return html`${notices}${this._phoneView(events)}${fab}
        ${this._eventDialog()} ${this._addDialog()} ${this._settingsDialog()}`;
    }
    const view = (v: View, label: string) =>
      html`<button class=${this._view === v ? "on" : ""} @click=${() => (this._view = v)}>${label}</button>`;
    return html`
      <div class="top">
        <h1 class="family">${this.hustleState.householdName || "Our Family"}</h1>
        <span class="clock">${timeFmt.format(this._now)}</span>
        <div class="controls">
          <div class="seg" role="group" aria-label="Calendar view">
            ${view("day", "Day")}${view("week", "Week")}${view("month", "Month")}
          </div>
          <button class="icon-btn" aria-label="Previous" @click=${() => this._step(-1)}><ha-icon icon="mdi:chevron-left"></ha-icon></button>
          <button class="icon-btn" @click=${() => (this._anchor = new Date())}>Today</button>
          <button class="icon-btn" aria-label="Next" @click=${() => this._step(1)}><ha-icon icon="mdi:chevron-right"></ha-icon></button>
          <span class="range">${this._rangeLabel()}${this._loading ? " …" : ""}</span>
          ${this._isAdmin ? html`<button class="icon-btn" aria-label="Calendar settings" @click=${this._openSettings}><ha-icon icon="mdi:cog"></ha-icon></button>` : nothing}
        </div>
      </div>
      ${this._memberStrip()}
      ${notices}
      ${this._view === "month" ? this._monthView(events) : this._gridView(events)}
      ${fab}
      ${this._eventDialog()} ${this._addDialog()} ${this._settingsDialog()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "family-calendar-view": FamilyCalendarView;
  }
}
