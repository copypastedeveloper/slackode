/**
 * Parse human-friendly schedule phrases into cron expressions, so nobody has
 * to know cron to create a job. Deterministic on purpose — no LLM involved.
 *
 * Supported forms (case-insensitive):
 *   "every day at 9am" / "daily at 9:30pm"
 *   "every weekday at 9am" / "weekdays at 9"
 *   "every friday at 8am" / "fridays at 8:30am" / "every mon and thu at 9am"
 *   "every weekend at 10am"
 *   "every hour" / "every 2 hours" / "every 30 minutes"
 *   "at noon" / "at midnight" (daily)
 * Raw cron expressions pass through untouched.
 */

import { Cron } from "croner";

export interface ParsedSchedule {
  cron: string;
  description: string;
}

/** Compute the next fire time (unixepoch seconds) for a cron expression, or null when it never fires again. */
export function nextCronRun(expression: string, timezone: string, from?: Date): number | null {
  const next = new Cron(expression, { timezone }).nextRun(from ?? new Date());
  return next ? Math.floor(next.getTime() / 1000) : null;
}

/** Validate a cron expression + timezone pair; returns an error message or undefined. */
export function validateCron(expression: string, timezone: string): string | undefined {
  try {
    const next = new Cron(expression, { timezone }).nextRun();
    if (!next) return "That cron expression never fires.";
    return undefined;
  } catch (err) {
    return `Invalid cron expression or timezone: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Reject schedules that fire more often than `minMinutes` apart. Samples the
 * next several fire times and checks the smallest consecutive gap, so it
 * handles irregular expressions (e.g. "0,10 * * * *"), not just step syntax.
 */
export function validateMinInterval(expression: string, timezone: string, minMinutes: number): string | undefined {
  try {
    const runs = new Cron(expression, { timezone }).nextRuns(6);
    for (let i = 1; i < runs.length; i++) {
      const gapMinutes = (runs[i].getTime() - runs[i - 1].getTime()) / 60_000;
      if (gapMinutes < minMinutes) {
        return `That schedule fires every ${Math.round(gapMinutes)} minutes — the minimum interval is ${minMinutes} minutes.`;
      }
    }
    return undefined;
  } catch {
    return undefined; // validateCron reports parse errors; don't double-report.
  }
}

const DAYS: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "9am" | "9:30pm" | "17:00" | "9" | "noon" | "midnight" -> {hour, minute} */
function parseTime(raw: string): { hour: number; minute: number } | undefined {
  const t = raw.trim().toLowerCase();
  if (t === "noon") return { hour: 12, minute: 0 };
  if (t === "midnight") return { hour: 0, minute: 0 };
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return undefined;
  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3];
  if (minute > 59) return undefined;
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23) return undefined;
  return { hour, minute };
}

function fmtTime(hour: number, minute: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  const mer = hour < 12 ? "am" : "pm";
  return minute === 0 ? `${h12}${mer}` : `${h12}:${String(minute).padStart(2, "0")}${mer}`;
}

/** Looks like a raw cron expression (5 whitespace-separated fields). */
export function looksLikeCron(text: string): boolean {
  return text.trim().split(/\s+/).length === 5 && /^[\d*,/\-\s]+$/.test(text.trim());
}

export function parseSchedulePhrase(input: string): ParsedSchedule | undefined {
  const text = input.trim().toLowerCase().replace(/\s+/g, " ");

  // "every 30 minutes" / "every 2 hours" / "every hour" / "every minute"
  let m = text.match(/^every (?:(\d+) )?(minute|hour)s?$/);
  if (m) {
    const n = m[1] ? Number(m[1]) : 1;
    if (n < 1) return undefined;
    if (m[2] === "minute") {
      return { cron: n === 1 ? "* * * * *" : `*/${n} * * * *`, description: n === 1 ? "every minute" : `every ${n} minutes` };
    }
    return { cron: n === 1 ? "0 * * * *" : `0 */${n} * * *`, description: n === 1 ? "every hour" : `every ${n} hours` };
  }

  // Optional leading day-part, then "at <time>":
  //   "[every] day|weekday|weekend|<days...> at <time>"  |  "at <time>" (daily)
  m = text.match(/^(?:every |on )?(.*?)\s*at (noon|midnight|\d{1,2}(?::\d{2})?\s*(?:am|pm)?)$/);
  if (!m) return undefined;
  const dayPart = m[1].trim();
  const time = parseTime(m[2]);
  if (!time) return undefined;
  const { hour, minute } = time;
  const timeDesc = fmtTime(hour, minute);

  if (dayPart === "" || dayPart === "day" || dayPart === "daily") {
    return { cron: `${minute} ${hour} * * *`, description: `every day at ${timeDesc}` };
  }
  if (dayPart === "weekday" || dayPart === "weekdays") {
    return { cron: `${minute} ${hour} * * 1-5`, description: `weekdays at ${timeDesc}` };
  }
  if (dayPart === "weekend" || dayPart === "weekends") {
    return { cron: `${minute} ${hour} * * 0,6`, description: `weekends at ${timeDesc}` };
  }

  // One or more day names: "friday", "fridays", "mon and thu", "tuesday, thursday"
  const dayTokens = dayPart.split(/(?:,|\band\b|&)+/).map((s) => s.trim()).filter(Boolean);
  const dayNums: number[] = [];
  for (const token of dayTokens) {
    const num = DAYS[token.replace(/s$/, "")] ?? DAYS[token];
    if (num === undefined) return undefined;
    if (!dayNums.includes(num)) dayNums.push(num);
  }
  if (dayNums.length === 0) return undefined;
  dayNums.sort((a, b) => a - b);
  return {
    cron: `${minute} ${hour} * * ${dayNums.join(",")}`,
    description: `every ${dayNums.map((n) => DAY_NAMES[n]).join(", ")} at ${timeDesc}`,
  };
}
