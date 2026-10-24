const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Bare "YYYY-MM-DD" strings (due dates, paydays) get parsed by `new Date()`
 * as UTC midnight per spec - displaying that in local time shifts the date
 * back a day for anyone west of UTC (all of the US). Appending a local
 * midnight time avoids that; full ISO datetimes (with their own real time +
 * offset) are left alone since they're already correct. */
function parseDateForDisplay(value: string): Date {
  return DATE_ONLY_RE.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "";
  const date = parseDateForDisplay(value);
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function formatRelative(value: string | null | undefined): string {
  if (!value) return "";
  const diffMs = new Date(value).getTime() - Date.now();
  const diffMin = Math.round(diffMs / 60000);
  const abs = Math.abs(diffMin);
  if (abs < 1) return "just now";
  if (abs < 60) return diffMin > 0 ? `in ${abs}m` : `${abs}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (Math.abs(diffHr) < 24) return diffMin > 0 ? `in ${diffHr}h` : `${Math.abs(diffHr)}h ago`;
  const diffDay = Math.round(diffHr / 24);
  return diffMin > 0 ? `in ${diffDay}d` : `${Math.abs(diffDay)}d ago`;
}

export interface CountdownParts {
  expired: boolean;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

/** Breaks the remaining time until `deadlineIso` into components for a live
 * countdown. Never goes negative - callers should treat `expired: true` as
 * the stop condition. */
export function countdownParts(deadlineIso: string): CountdownParts {
  const remainingMs = new Date(deadlineIso).getTime() - Date.now();
  if (remainingMs <= 0) return { expired: true, days: 0, hours: 0, minutes: 0, seconds: 0 };

  const totalSeconds = Math.floor(remainingMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return { expired: false, days, hours, minutes, seconds };
}

export function formatCountdown(deadlineIso: string): string {
  const { expired, days, hours, minutes, seconds } = countdownParts(deadlineIso);
  if (expired) return "Expired";
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

/** Local calendar date, not UTC - `toISOString().slice(0, 10)` reports the
 * UTC date, which is a day ahead of local for anyone west of UTC (all of
 * the US) during their evening hours. */
export function today(): string {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const WEEKDAY_CODES = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00`).getTime();
  const db = new Date(`${b}T00:00:00`).getTime();
  return Math.round((db - da) / 86400000);
}

function weekdayCode(isoDate: string): string {
  const jsDay = new Date(`${isoDate}T00:00:00`).getDay(); // 0=Sun..6=Sat
  return WEEKDAY_CODES[(jsDay + 6) % 7]; // Mon=0..Sun=6
}

function dayOfMonth(isoDate: string): number {
  return Number(isoDate.slice(8, 10));
}

function lastDayOfMonth(isoDate: string): number {
  const [year, month] = isoDate.split("-").map(Number);
  return new Date(year, month, 0).getDate();
}

interface RecurrenceConfig {
  days_of_week?: string[];
  anchor_date?: string;
  day_of_month?: number;
}

function matchesRecurrence(
  recurrenceType: string,
  recurrenceConfig: RecurrenceConfig,
  isoDate: string
): boolean {
  switch (recurrenceType) {
    case "daily":
      return true;
    case "weekly":
      return new Set(recurrenceConfig.days_of_week ?? []).has(weekdayCode(isoDate));
    case "biweekly":
      return (
        !!recurrenceConfig.anchor_date &&
        isoDate >= recurrenceConfig.anchor_date &&
        daysBetween(recurrenceConfig.anchor_date, isoDate) % 14 === 0
      );
    case "monthly":
      return (
        !!recurrenceConfig.day_of_month &&
        dayOfMonth(isoDate) === Math.min(recurrenceConfig.day_of_month, lastDayOfMonth(isoDate))
      );
    case "quarterly": {
      if (!recurrenceConfig.anchor_date || isoDate < recurrenceConfig.anchor_date) return false;
      const [ay, am] = recurrenceConfig.anchor_date.split("-").map(Number);
      const [cy, cm] = isoDate.split("-").map(Number);
      const monthsSince = (cy - ay) * 12 + (cm - am);
      return (
        monthsSince % 3 === 0 &&
        dayOfMonth(isoDate) === Math.min(dayOfMonth(recurrenceConfig.anchor_date), lastDayOfMonth(isoDate))
      );
    }
    default:
      return false;
  }
}

/** Mirrors the backend's logic.py due_dates_for, but just walks forward to
 * find the single next date matching the chore's own recurrence config
 * (e.g. the next Wednesday for a weekly-on-Wednesday chore) instead of
 * defaulting to "today" - a one-time chore has no schedule to derive from,
 * so it falls back to `from` (today by default). */
export function nextOccurrenceDate(
  recurrenceType: string,
  recurrenceConfig: RecurrenceConfig,
  from: string = today()
): string {
  if (recurrenceType === "none") return from;
  let cursor = from;
  for (let i = 0; i < 366; i++) {
    if (matchesRecurrence(recurrenceType, recurrenceConfig, cursor)) return cursor;
    cursor = addDays(cursor, 1);
  }
  return from;
}

/** Mirrors the backend's logic.py effective_due_datetime/is_overdue - a
 * chore due "today" with no due_time is treated as due at 23:59, not
 * midnight, so it doesn't look overdue for the entire day it's actually due. */
export function isOverdue(dueDate: string, dueTime: string | null): boolean {
  const [hour, minute] = dueTime ? dueTime.split(":").map(Number) : [23, 59];
  const due = new Date(`${dueDate}T00:00:00`);
  due.setHours(hour, minute, 0, 0);
  return due.getTime() < Date.now();
}

/** Mirrors the backend's logic.py is_within_availability_window - the
 * window is time-of-day, applying on the assignment's own due date. Unset
 * bounds mean no restriction on that side. */
export function isWithinAvailabilityWindow(
  dueDate: string,
  availableFromTime: string | null,
  availableUntilTime: string | null
): boolean {
  const now = Date.now();
  if (availableFromTime) {
    const [hour, minute] = availableFromTime.split(":").map(Number);
    const start = new Date(`${dueDate}T00:00:00`);
    start.setHours(hour, minute, 0, 0);
    if (now < start.getTime()) return false;
  }
  if (availableUntilTime) {
    const [hour, minute] = availableUntilTime.split(":").map(Number);
    const end = new Date(`${dueDate}T00:00:00`);
    end.setHours(hour, minute, 0, 0);
    if (now > end.getTime()) return false;
  }
  return true;
}
