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
import { UNTAGGED_COLOR, initials, memberColor } from "../utils/member-colors";
import "../components/hustle-dialog";

/* The Calendar tab, laid out like a Skylight Calendar: the family's name
 * and a clock up top, a strip of family members with today's chore
 * progress, then a week time-grid (or a month grid) of the family's Google
 * Calendar events, each colored by who it's for, with the initials of who's
 * attending. Parents add events with the + button and tag existing ones by
 * tapping them; kids see the same calendar read-only. Tapping a member in
 * the strip shows only their events. */

const HOUR_PX = 56;
const DEFAULT_FIRST_HOUR = 7;
const DEFAULT_LAST_HOUR = 21;
const REFRESH_MS = 5 * 60_000;

type View = "week" | "month";

interface Placed {
  event: FamilyEvent;
  top: number;
  height: number;
  lane: number;
  lanes: number;
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

/** Monday on or before `d` - Skylight's week starts Monday. */
function startOfWeek(d: Date): Date {
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
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
  for (let d = new Date(start.getFullYear(), start.getMonth(), start.getDate()); ; d = addDays(d, 1)) {
    if (e.allDay ? d >= end : d > end) break;
    days.push(dateKey(d));
    if (days.length > 62) break;
  }
  return days.length ? days : [dateKey(start)];
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function timeRange(e: FamilyEvent): string {
  if (e.allDay) return "All day";
  return `${timeFmt.format(eventStart(e))} – ${timeFmt.format(eventEnd(e))}`;
}

function tint(hex: string, alpha: number): string {
  return `color-mix(in srgb, ${hex} ${Math.round(alpha * 100)}%, white)`;
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
  @state() private _draft = this._emptyDraft();
  @state() private _settingsOpen = false;
  @state() private _calendars: CalendarInfo[] = [];
  @state() private _settingsDraft = { family: [] as string[], defaultCalendar: "" };
  @state() private _busy = false;
  @state() private _dialogError = "";

  private _loadedKey = "";
  private _clock?: number;
  private _refresh?: number;

  static styles = [
    formStyles,
    css`
      :host {
        display: block;
        --sky-ink: #2f3a4a;
        --sky-muted: #7b8796;
        --sky-line: #e6e9ee;
        --sky-today: #e57368;
        --sky-fab: #7e57c2;
        color: var(--sky-ink);
      }
      .top { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 14px; }
      .family { font-family: Georgia, "Times New Roman", serif; font-size: 1.7rem; font-weight: 600; letter-spacing: -.01em; margin: 0; }
      .clock { font-size: 1.25rem; color: var(--sky-muted); font-variant-numeric: tabular-nums; }
      .controls { margin-left: auto; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      .seg { display: inline-flex; border: 1px solid var(--sky-line); border-radius: 999px; overflow: hidden; background: #fff; }
      .seg button { border: 0; background: transparent; padding: 6px 14px; min-height: 36px; cursor: pointer; color: var(--sky-muted); }
      .seg button.on { background: #eef1f6; color: var(--sky-ink); font-weight: 650; }
      .icon-btn { border: 1px solid var(--sky-line); background: #fff; border-radius: 999px; min-height: 36px; min-width: 36px; display: inline-flex; align-items: center; justify-content: center; cursor: pointer; padding: 0 10px; gap: 4px; }
      .range { font-weight: 650; min-width: 9ch; }

      .members { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; padding: 4px 2px 12px; }
      .member { display: flex; align-items: center; gap: 10px; min-width: 0; padding: 8px 12px; border-radius: 14px; border: 1px solid var(--sky-line); background: #fff; cursor: pointer; text-align: left; }
      .member.on { border-color: var(--c); box-shadow: 0 0 0 2px color-mix(in srgb, var(--c) 45%, transparent); }
      .member.dim { opacity: .45; }
      .dot { width: 30px; height: 30px; flex: none; border-radius: 50%; display: grid; place-items: center; background: var(--c); color: #fff; font-weight: 700; font-size: .85rem; }
      .member-body { flex: 1; min-width: 0; }
      .member-name { display: flex; justify-content: space-between; font-weight: 650; font-size: .92rem; gap: 8px; }
      .member-name small { color: var(--sky-muted); font-weight: 500; }
      .bar { height: 6px; border-radius: 99px; background: #edf0f4; margin-top: 6px; overflow: hidden; }
      .bar > i { display: block; height: 100%; background: var(--c); border-radius: 99px; }

      .notice { padding: 14px 16px; border-radius: 14px; background: #fff7e8; color: #7a5212; margin-bottom: 12px; }
      .notice.error { background: #fdecea; color: #8a2a20; }

      .board { background: #fff; border: 1px solid var(--sky-line); border-radius: 18px; overflow: hidden; }
      .week-head, .allday-row { display: grid; grid-template-columns: 56px repeat(7, minmax(0, 1fr)); }
      .week-head { position: sticky; top: 0; z-index: 5; background: #fff; border-bottom: 1px solid var(--sky-line); }
      .week-head > div { padding: 10px 8px; border-left: 1px solid var(--sky-line); font-weight: 650; display: flex; align-items: center; gap: 6px; }
      .week-head > div:first-child, .allday-row > div:first-child { border-left: 0; }
      .daynum { display: inline-grid; place-items: center; min-width: 26px; height: 26px; border-radius: 50%; font-size: .85rem; }
      .today .daynum { background: var(--sky-today); color: #fff; }
      .allday-row { border-bottom: 1px solid var(--sky-line); }
      .allday-row > div { border-left: 1px solid var(--sky-line); padding: 4px; display: flex; flex-direction: column; gap: 3px; min-height: 28px; }
      .allday-label { font-size: .7rem; color: var(--sky-muted); justify-content: center; align-items: center; }
      .scroll { max-height: calc(100vh - 250px); min-height: 420px; overflow-y: auto; }
      .grid { display: grid; grid-template-columns: 56px repeat(7, minmax(0, 1fr)); position: relative; }
      .hours { position: relative; }
      .hours span { position: absolute; right: 8px; transform: translateY(-50%); font-size: .7rem; color: var(--sky-muted); white-space: nowrap; }
      .col { position: relative; border-left: 1px solid var(--sky-line); background-image: linear-gradient(var(--sky-line) 1px, transparent 1px); background-size: 100% ${HOUR_PX}px; }
      .col.today { background-color: #fbfcfe; }
      .now { position: absolute; left: 0; right: 0; height: 2px; background: var(--sky-today); z-index: 3; }
      .now::before { content: ""; position: absolute; left: -5px; top: -4px; width: 10px; height: 10px; border-radius: 50%; background: var(--sky-today); }

      .ev { position: absolute; border-radius: 10px; padding: 5px 7px; overflow: hidden; cursor: pointer; border: 0; text-align: left; font: inherit; color: var(--sky-ink); background: var(--bg); box-shadow: inset 3px 0 0 var(--c); display: flex; flex-direction: column; gap: 1px; min-height: 0; }
      .ev:hover { filter: brightness(.97); }
      .ev .t { font-weight: 650; font-size: .8rem; line-height: 1.2; padding-right: var(--bp, 0); }
      .ev.short .t { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ev .badges { position: absolute; top: 4px; right: 4px; margin: 0; flex-wrap: nowrap; }
      .ev .w { font-size: .7rem; color: #5b6676; }
      .badges { display: flex; gap: 2px; flex-wrap: wrap; margin-top: auto; justify-content: flex-end; }
      .badge { width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; font-size: .6rem; font-weight: 700; color: #fff; background: var(--c); border: 1.5px solid #fff; }
      .chip { border: 0; border-radius: 8px; padding: 3px 7px; font: inherit; font-size: .75rem; font-weight: 600; text-align: left; cursor: pointer; background: var(--bg); box-shadow: inset 3px 0 0 var(--c); color: var(--sky-ink); display: flex; gap: 4px; align-items: center; min-height: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
      .chip .badges { margin: 0 0 0 auto; flex-wrap: nowrap; }

      .month { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); }
      .month .dow { padding: 8px; font-size: .75rem; color: var(--sky-muted); font-weight: 650; border-bottom: 1px solid var(--sky-line); }
      .cell { min-height: 108px; border-left: 1px solid var(--sky-line); border-bottom: 1px solid var(--sky-line); padding: 4px; display: flex; flex-direction: column; gap: 3px; }
      .cell:nth-child(7n + 1) { border-left: 0; }
      .cell.other { background: #fafbfc; color: var(--sky-muted); }
      .cell .daynum { align-self: flex-start; }
      .cell .more { font-size: .7rem; color: var(--sky-muted); padding-left: 4px; }

      .fab { position: fixed; right: 28px; bottom: 28px; width: 58px; height: 58px; border-radius: 50%; border: 0; background: var(--sky-fab); color: #fff; box-shadow: 0 8px 24px rgba(126, 87, 194, .4); cursor: pointer; display: grid; place-items: center; z-index: 20; --mdc-icon-size: 30px; }

      .detail-time { color: var(--sky-muted); margin: 0 0 6px; }
      .detail-meta { display: flex; gap: 6px; align-items: center; color: var(--sky-muted); font-size: .9rem; margin: 2px 0; }
      .desc { white-space: pre-wrap; margin: 10px 0; font-size: .92rem; }
      .people { display: flex; flex-wrap: wrap; gap: 8px; }
      .person { display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px 6px 6px; border-radius: 999px; border: 1px solid var(--sky-line); cursor: pointer; background: #fff; min-height: 40px; }
      .person.on { border-color: var(--c); background: color-mix(in srgb, var(--c) 18%, white); }
      .person .dot { width: 26px; height: 26px; font-size: .75rem; }
      .person input { display: none; }
      .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
      .check { display: flex; align-items: center; gap: 8px; margin: 12px 0 4px; color: inherit; font-size: .95rem; }
      .check input { width: auto; }
      .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 18px; flex-wrap: wrap; }
      .actions .left { margin-right: auto; }
      button.danger { background: #fff; color: #b3261e; border: 1px solid #f0c4bf; border-radius: 10px; padding: 10px 16px; cursor: pointer; }
      button.ghost { background: #fff; border: 1px solid var(--sky-line); border-radius: 10px; padding: 10px 16px; cursor: pointer; }
      .err { color: #b3261e; margin-top: 10px; }
      .cal-list { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
      .cal-list label { display: flex; gap: 10px; align-items: center; margin: 0; padding: 8px 4px; color: inherit; font-size: .95rem; }
      .cal-list input { width: auto; }

      @media (max-width: 760px) {
        .week-head, .allday-row, .grid { grid-template-columns: 40px repeat(7, minmax(0, 1fr)); }
        .week-head > div { flex-direction: column; gap: 0; padding: 6px 2px; font-size: .75rem; }
        .ev { padding: 3px 4px; }
        .ev .w, .badges { display: none; }
        .cell { min-height: 72px; }
        .members { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .fab { right: 18px; bottom: 84px; }
      }
    `,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    this._clock = window.setInterval(() => (this._now = new Date()), 30_000);
    this._refresh = window.setInterval(() => this._load(true), REFRESH_MS);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    window.clearInterval(this._clock);
    window.clearInterval(this._refresh);
  }

  protected willUpdate(changed: PropertyValues): void {
    if (changed.has("extras") || changed.has("_view") || changed.has("_anchor")) {
      void this._load(false);
    }
  }

  // ------------------------------------------------------------- data

  private get _isParent(): boolean {
    return this.me?.role === "parent";
  }

  private get _members(): MemberRosterEntry[] {
    return this.hustleState.memberRoster.filter((m) => m.active);
  }

  private _range(): { start: Date; end: Date; days: Date[] } {
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
    const calendars = this.extras?.calendarSettings.familyCalendars ?? [];
    const { start, end } = this._range();
    const key = `${dateKey(start)}|${dateKey(end)}|${calendars.join(",")}`;
    if (!force && key === this._loadedKey) return;
    this._loadedKey = key;
    if (!calendars.length) {
      this._events = [];
      this._errors = [];
      return;
    }
    this._loading = true;
    try {
      const result = await familyApi.events(dateKey(start), dateKey(end));
      if (key !== this._loadedKey) return; // a newer range is loading
      this._events = result.events;
      this._errors = result.errors;
    } catch (err) {
      this._errors = [(err as Error).message];
    } finally {
      this._loading = false;
    }
  }

  private _visible(events: FamilyEvent[]): FamilyEvent[] {
    if (!this._filterMemberId) return events;
    return events.filter(
      (e) => e.forMemberId === this._filterMemberId || e.attendeeIds.includes(this._filterMemberId)
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
    this._anchor =
      this._view === "week" ? addDays(a, delta * 7) : new Date(a.getFullYear(), a.getMonth() + delta, 1);
  }

  private _rangeLabel(): string {
    if (this._view === "month") {
      return this._anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    }
    const { start } = this._range();
    const end = addDays(start, 6);
    const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    return `${fmt(start)} – ${fmt(end)}`;
  }

  // ----------------------------------------------------------- dialogs

  private _openEvent(e: FamilyEvent): void {
    this._selected = e;
    this._tagFor = e.forMemberId ?? "";
    this._tagAttendees = [...e.attendeeIds];
    this._dialogError = "";
  }

  private _toggle(list: string[], id: string): string[] {
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

  private _deleteEvent(): void {
    const e = this._selected;
    if (!e?.uid) return;
    const what = e.recurrenceId ? "this occurrence of" : "";
    if (!window.confirm(`Delete ${what} "${e.summary}" from ${e.calendarName}? This also removes it from Google Calendar.`)) return;
    void this._run(
      () =>
        familyApi.call(this.hass, "delete_event", {
          entity_id: e.entityId,
          uid: e.uid,
          ...(e.recurrenceId ? { recurrence_id: e.recurrenceId } : {}),
        }),
      () => (this._selected = null)
    );
  }

  private _emptyDraft() {
    const today = dateKey(new Date());
    return {
      summary: "",
      allDay: false,
      date: today,
      endDate: today,
      startTime: "09:00",
      endTime: "10:00",
      calendar: "",
      forMemberId: "",
      attendees: [] as string[],
      location: "",
      description: "",
    };
  }

  private _openAdd(day?: Date): void {
    const draft = this._emptyDraft();
    if (day) {
      draft.date = dateKey(day);
      draft.endDate = draft.date;
    }
    draft.calendar =
      this.extras.calendarSettings.defaultCalendar ?? this.extras.calendarSettings.familyCalendars[0] ?? "";
    this._draft = draft;
    this._dialogError = "";
    this._adding = true;
  }

  private _saveNew(): void {
    const d = this._draft;
    if (!d.summary.trim()) {
      this._dialogError = "Give the event a name.";
      return;
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
    if (d.allDay) {
      data.start = d.date;
      // The dialog's end date is inclusive; the calendar's is exclusive.
      data.end = dateKey(addDays(parseKey(d.endDate < d.date ? d.date : d.endDate), 1));
    } else {
      data.start = new Date(`${d.date}T${d.startTime}`).toISOString();
      data.end = new Date(`${d.date}T${d.endTime}`).toISOString();
    }
    void this._run(
      () => familyApi.call(this.hass, "create_event", data),
      () => (this._adding = false)
    );
  }

  private async _openSettings(): Promise<void> {
    const s = this.extras.calendarSettings;
    this._settingsDraft = { family: [...s.familyCalendars], defaultCalendar: s.defaultCalendar ?? "" };
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
        }),
      () => (this._settingsOpen = false)
    );
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
    const c = this._color(e);
    return html`<button class="chip" style="--c:${c};--bg:${tint(c, 0.32)}" @click=${() => this._openEvent(e)} title=${`${e.summary} · ${timeRange(e)}`}>
      ${e.allDay ? "" : html`<span>${timeFmt.format(eventStart(e))}</span>`} ${e.summary} ${this._badges(e)}
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
    let cluster: typeof placed = [];
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

  private _weekView(events: FamilyEvent[]) {
    const { days } = this._range();
    const todayKey = dateKey(this._now);
    const allDay = events.filter((e) => e.allDay);
    const timed = events.filter((e) => !e.allDay);
    const [firstHour, lastHour] = this._hourBounds(timed);
    const hours = Array.from({ length: lastHour - firstHour }, (_, i) => firstHour + i);
    const height = hours.length * HOUR_PX;
    const nowTop =
      ((this._now.getHours() + this._now.getMinutes() / 60 - firstHour) / (lastHour - firstHour)) * height;

    return html`<div class="board"><div class="scroll">
      <div class="week-head">
        <div></div>
        ${days.map(
          (d) => html`<div class=${dateKey(d) === todayKey ? "today" : ""}>
            <span>${d.toLocaleDateString(undefined, { weekday: "short" })}</span>
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
                // Side-by-side lanes are narrow - one badge there.
                const maxBadges = p.lanes > 1 ? 1 : 3;
                const badgeRoom = Math.min(p.event.attendeeIds.length, maxBadges) * 20;
                return html`<button
                  class="ev ${p.height < 40 ? "short" : ""}"
                  style="top:${p.top}px;height:${p.height}px;left:calc(${p.lane * width}% + 3px);width:calc(${width}% - 6px);--c:${c};--bg:${tint(c, 0.32)};--bp:${badgeRoom}px"
                  title=${`${p.event.summary} · ${timeRange(p.event)}`}
                  @click=${() => this._openEvent(p.event)}
                >
                  <span class="t">${p.event.summary}</span>
                  ${p.height > 34 ? html`<span class="w">${timeRange(p.event)}</span>` : nothing}
                  ${this._badges(p.event, maxBadges)}
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
    return html`<div class="board">
      <div class="month">
        ${days.slice(0, 7).map((d) => html`<div class="dow">${d.toLocaleDateString(undefined, { weekday: "short" })}</div>`)}
        ${days.map((d) => {
          const key = dateKey(d);
          const list = (byDay.get(key) ?? []).sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start));
          return html`<div class="cell ${d.getMonth() !== month ? "other" : ""} ${key === todayKey ? "today" : ""}" @dblclick=${() => this._isParent && this._openAdd(d)}>
            <span class="daynum">${d.getDate()}</span>
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
    const when = e.allDay
      ? eventStart(e).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })
      : `${eventStart(e).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })} · ${timeRange(e)}`;
    return html`<hustle-dialog open .heading=${e.summary} @hustle-dialog-closed=${() => (this._selected = null)}>
      <p class="detail-time">${when}</p>
      <div class="detail-meta"><ha-icon icon="mdi:calendar"></ha-icon>${e.calendarName}${e.rrule || e.recurrenceId ? " · repeats" : ""}</div>
      ${e.location ? html`<div class="detail-meta"><ha-icon icon="mdi:map-marker"></ha-icon>${e.location}</div>` : nothing}
      ${e.description ? html`<p class="desc">${e.description}</p>` : nothing}
      ${e.uid
        ? html`
            <label>Who it's for</label>
            ${this._forSelect(this._tagFor, (v) => (this._tagFor = v))}
            <label>Who's attending</label>
            ${this._people(this._tagAttendees, (id) => (this._tagAttendees = this._toggle(this._tagAttendees, id)))}
            ${e.rrule || e.recurrenceId ? html`<p class="detail-meta">Tags apply to every occurrence.</p>` : nothing}
          `
        : html`<p class="detail-meta">This calendar doesn't give its events ids, so they can't be tagged.</p>`}
      ${this._dialogError ? html`<p class="err">${this._dialogError}</p>` : nothing}
      <div class="actions">
        ${this._isParent && e.uid ? html`<button class="danger left" ?disabled=${this._busy} @click=${this._deleteEvent}>Delete</button>` : nothing}
        <button class="ghost" @click=${() => (this._selected = null)}>Close</button>
        ${this._isParent && e.uid ? html`<button class="primary" ?disabled=${this._busy} @click=${this._saveTags}>Save</button>` : nothing}
      </div>
    </hustle-dialog>`;
  }

  private _addDialog() {
    if (!this._adding) return nothing;
    const d = this._draft;
    const set = (patch: Partial<typeof d>) => (this._draft = { ...this._draft, ...patch });
    const input = (key: keyof typeof d) => (ev: Event) => set({ [key]: (ev.target as HTMLInputElement).value });
    const family = this.extras.calendarSettings.familyCalendars;
    return html`<hustle-dialog open heading="New event" @hustle-dialog-closed=${() => (this._adding = false)}>
      <label>Title</label>
      <input .value=${d.summary} @input=${input("summary")} placeholder="Soccer practice" />
      <label class="check"><input type="checkbox" .checked=${d.allDay} @change=${(ev: Event) => set({ allDay: (ev.target as HTMLInputElement).checked })} />All day</label>
      ${d.allDay
        ? html`<div class="row2">
            <div><label>From</label><input type="date" .value=${d.date} @input=${input("date")} /></div>
            <div><label>Through</label><input type="date" .value=${d.endDate} @input=${input("endDate")} /></div>
          </div>`
        : html`<label>Date</label><input type="date" .value=${d.date} @input=${input("date")} />
            <div class="row2">
              <div><label>Starts</label><input type="time" .value=${d.startTime} @input=${input("startTime")} /></div>
              <div><label>Ends</label><input type="time" .value=${d.endTime} @input=${input("endTime")} /></div>
            </div>`}
      ${family.length > 1
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
        <button class="primary" ?disabled=${this._busy} @click=${this._saveNew}>Add to calendar</button>
      </div>
    </hustle-dialog>`;
  }

  private _settingsDialog() {
    if (!this._settingsOpen) return nothing;
    const draft = this._settingsDraft;
    const dinners = this.extras.calendarSettings.dinnersCalendar;
    return html`<hustle-dialog open heading="Calendars" @hustle-dialog-closed=${() => (this._settingsOpen = false)}>
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
      ${this._dialogError ? html`<p class="err">${this._dialogError}</p>` : nothing}
      <div class="actions">
        <button class="ghost" @click=${() => (this._settingsOpen = false)}>Cancel</button>
        <button class="primary" ?disabled=${this._busy} @click=${this._saveSettings}>Save</button>
      </div>
    </hustle-dialog>`;
  }

  render() {
    if (!this.extras || !this.hustleState) return nothing;
    const configured = this.extras.calendarSettings.familyCalendars.length > 0;
    const events = this._visible(this._events);
    return html`
      <div class="top">
        <h1 class="family">${this.hustleState.householdName || "Our Family"}</h1>
        <span class="clock">${timeFmt.format(this._now)}</span>
        <div class="controls">
          <div class="seg" role="group" aria-label="Calendar view">
            <button class=${this._view === "week" ? "on" : ""} @click=${() => (this._view = "week")}>Week</button>
            <button class=${this._view === "month" ? "on" : ""} @click=${() => (this._view = "month")}>Month</button>
          </div>
          <button class="icon-btn" aria-label="Previous" @click=${() => this._step(-1)}><ha-icon icon="mdi:chevron-left"></ha-icon></button>
          <button class="icon-btn" @click=${() => (this._anchor = new Date())}>Today</button>
          <button class="icon-btn" aria-label="Next" @click=${() => this._step(1)}><ha-icon icon="mdi:chevron-right"></ha-icon></button>
          <span class="range">${this._rangeLabel()}${this._loading ? " …" : ""}</span>
          ${this._isParent ? html`<button class="icon-btn" aria-label="Calendar settings" @click=${this._openSettings}><ha-icon icon="mdi:cog"></ha-icon></button>` : nothing}
        </div>
      </div>
      ${this._memberStrip()}
      ${!configured
        ? html`<div class="notice">
            ${this._isParent
              ? html`No calendars picked yet. Tap the <ha-icon icon="mdi:cog"></ha-icon> to choose your family's Google Calendar.`
              : html`A parent needs to pick the family calendar first.`}
          </div>`
        : nothing}
      ${this._errors.map((e) => html`<div class="notice error">Couldn't read ${e}</div>`)}
      ${this._view === "week" ? this._weekView(events) : this._monthView(events)}
      ${this._isParent && configured
        ? html`<button class="fab" aria-label="Add event" @click=${() => this._openAdd()}><ha-icon icon="mdi:plus"></ha-icon></button>`
        : nothing}
      ${this._eventDialog()} ${this._addDialog()} ${this._settingsDialog()}
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "family-calendar-view": FamilyCalendarView;
  }
}
