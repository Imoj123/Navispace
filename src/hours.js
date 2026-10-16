"use strict";

/**
 * When a library is open: weekdays between its plan's hours.opens and
 * hours.closes, in the library's own time zone, except South African
 * public holidays. Everything here works from the library's local clock,
 * never the server's (Render runs in UTC).
 *
 * Extra closed days (a university recess, an election day) can be added
 * with CLOSED_DAYS, a comma-separated list of YYYY-MM-DD dates.
 * ALWAYS_OPEN=1 ignores all of this, for testing out of hours.
 */
const TIME_ZONE = process.env.TIME_ZONE || "Africa/Johannesburg";
const DEFAULT_OPENS = "08:00";
const DEFAULT_CLOSES = "20:00";
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

const partsFormat = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23",
});

/** The library's local date and time at ms: weekday 0 is Monday. */
function localParts(ms) {
  const p = Object.fromEntries(partsFormat.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    year: Number(p.year),
    weekday: WEEKDAYS.indexOf(p.weekday),
    minutes: Number(p.hour) * 60 + Number(p.minute),
    hour: Number(p.hour),
  };
}

function toMinutes(hhmm, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : toMinutes(fallback);
}

const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** Easter Sunday (Gregorian), as [month, day]. */
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  return [Math.floor((h + l - 7 * m + 114) / 31), ((h + l - 7 * m + 114) % 31) + 1];
}

const holidayCache = new Map();
/** South Africa's public holidays for a year, as { "YYYY-MM-DD": name }. */
function publicHolidays(y) {
  if (holidayCache.has(y)) return holidayCache.get(y);
  const out = {};
  const fixed = [
    [1, 1, "New Year's Day"], [3, 21, "Human Rights Day"], [4, 27, "Freedom Day"],
    [5, 1, "Workers' Day"], [6, 16, "Youth Day"], [8, 9, "National Women's Day"],
    [9, 24, "Heritage Day"], [12, 16, "Day of Reconciliation"], [12, 25, "Christmas Day"],
    [12, 26, "Day of Goodwill"],
  ];
  for (const [m, d, name] of fixed) {
    out[iso(y, m, d)] = name;
    // A holiday on a Sunday is observed on the Monday.
    const day = new Date(Date.UTC(y, m - 1, d));
    if (day.getUTCDay() === 0) {
      const mon = new Date(day.getTime() + 24 * 60 * 60 * 1000);
      out[iso(mon.getUTCFullYear(), mon.getUTCMonth() + 1, mon.getUTCDate())] = name + " (observed)";
    }
  }
  const [em, ed] = easter(y);
  const sunday = Date.UTC(y, em - 1, ed);
  for (const [offset, name] of [[-2, "Good Friday"], [1, "Family Day"]]) {
    const day = new Date(sunday + offset * 24 * 60 * 60 * 1000);
    out[iso(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate())] = name;
  }
  holidayCache.set(y, out);
  return out;
}

function extraClosedDays() {
  return new Set(String(process.env.CLOSED_DAYS || "").split(",").map((s) => s.trim()).filter(Boolean));
}

/** Why the library is closed all day on this local date, or null. */
function closedDayReason(parts) {
  if (parts.weekday >= 5) return "Weekend";
  const holiday = publicHolidays(parts.year)[parts.date];
  if (holiday) return holiday;
  if (extraClosedDays().has(parts.date)) return "Closed today";
  return null;
}

/**
 * Whether the library is open at ms, and around it: { open, opens, closes,
 * closedFor, nextOpen }. nextOpen is "today", "tomorrow" or a weekday
 * name, for "opens Monday at 08:00".
 */
function openStatus(hours, ms = Date.now()) {
  const opens = (hours && hours.opens) || DEFAULT_OPENS;
  const closes = (hours && hours.closes) || DEFAULT_CLOSES;
  const p = localParts(ms);
  const closedFor = closedDayReason(p);
  const inHours = p.minutes >= toMinutes(opens) && p.minutes < toMinutes(closes, DEFAULT_CLOSES);
  const regularOpen = !closedFor && inHours;
  const open = process.env.ALWAYS_OPEN === "1" || regularOpen;

  let nextOpen = null;
  if (!open) {
    if (!closedFor && p.minutes < toMinutes(opens)) nextOpen = "today";
    else {
      for (let i = 1; i <= 14 && !nextOpen; i++) {
        const q = localParts(ms + i * 24 * 60 * 60 * 1000);
        if (!closedDayReason(q)) nextOpen = i === 1 ? "tomorrow" : ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"][q.weekday];
      }
    }
  }
  return { open, regularOpen, opens, closes, closedFor: open ? null : closedFor, nextOpen };
}

/**
 * When today's closing time was, in ms, if it has already passed today
 * (for ending sittings at closing time); otherwise null.
 */
function closedAtToday(hours, ms = Date.now()) {
  const p = localParts(ms);
  const close = toMinutes((hours && hours.closes) || DEFAULT_CLOSES, DEFAULT_CLOSES);
  if (closedDayReason(p) || p.minutes < close) return null;
  return ms - (p.minutes - close) * 60 * 1000 - (ms % 60000);
}

module.exports = { TIME_ZONE, localParts, toMinutes, publicHolidays, openStatus, closedAtToday };
