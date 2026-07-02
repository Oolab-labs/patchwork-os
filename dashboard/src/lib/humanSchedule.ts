/**
 * Turn a recipe schedule string into plain English for the non-technical
 * operator — "Every day at 7:00", "Every 15 minutes" — and, where the
 * cadence is derivable, the next fire time so the header can say
 * "next in 14h".
 *
 * Handles the common shapes only: Go-style `@every 30s` / `@daily` macros
 * and 5-field cron for the cases a normal recipe actually uses (daily at a
 * time, hourly, every-N-minutes, a weekday, day-of-month). Anything more
 * exotic falls back to the raw string (surfaced under expert details, never
 * in the plain view) with `humanized: false` so callers can tell.
 *
 * No cron library exists in the repo; this is intentionally small and
 * total — it never throws, worst case returns the raw string.
 */

export interface HumanSchedule {
  /** Plain-English cadence, or the raw string if we couldn't humanize. */
  text: string;
  /** True when `text` is a real translation (not the raw fallback). */
  humanized: boolean;
  /** Next fire time in epoch ms, when derivable from the cadence. */
  nextRunAt?: number;
  /** The input, verbatim — for the expert/details view. */
  raw: string;
}

const DOW = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const UNIT_MS: Record<string, number> = {
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

const UNIT_WORD: Record<string, string> = {
  s: "second",
  m: "minute",
  h: "hour",
  d: "day",
};

function plural(n: number, word: string): string {
  return n === 1 ? `1 ${word}` : `${n} ${word}s`;
}

function hhmm(h: number, m: number): string {
  return `${h}:${m.toString().padStart(2, "0")}`;
}

function ordinal(n: number): string {
  const rem10 = n % 10;
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  if (rem10 === 1) return `${n}st`;
  if (rem10 === 2) return `${n}nd`;
  if (rem10 === 3) return `${n}rd`;
  return `${n}th`;
}

/** Next occurrence of local time h:m at or after `from`. */
function nextDailyAt(h: number, m: number, from: Date): number {
  const d = new Date(from);
  d.setHours(h, m, 0, 0);
  if (d.getTime() <= from.getTime()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** Next occurrence of weekday `dow` at h:m at or after `from`. */
function nextWeekdayAt(dow: number, h: number, m: number, from: Date): number {
  const d = new Date(from);
  d.setHours(h, m, 0, 0);
  let add = (dow - d.getDay() + 7) % 7;
  if (add === 0 && d.getTime() <= from.getTime()) add = 7;
  d.setDate(d.getDate() + add);
  return d.getTime();
}

function macro(raw: string, s: string, now: Date): HumanSchedule | null {
  // @every <dur>  — Go/robfig style, e.g. "@every 30s", "@every 1h30m".
  const every = /^@every\s+(.+)$/i.exec(s);
  if (every) {
    const dur = every[1].trim();
    const parts = [...dur.matchAll(/(\d+)\s*([smhd])/gi)];
    if (parts.length) {
      let ms = 0;
      for (const p of parts) ms += Number(p[1]) * (UNIT_MS[p[2].toLowerCase()] ?? 0);
      // Single-unit cadences read cleanest ("Every 30 seconds").
      const text =
        parts.length === 1
          ? `Every ${plural(Number(parts[0][1]), UNIT_WORD[parts[0][2].toLowerCase()])}`
          : `Every ${dur}`;
      return {
        text,
        humanized: true,
        raw,
        nextRunAt: ms > 0 ? now.getTime() + ms : undefined,
      };
    }
  }
  const map: Record<string, { text: string; h: number; m: number; weekly?: boolean; monthly?: boolean; yearly?: boolean }> = {
    "@hourly": { text: "Every hour", h: -1, m: 0 },
    "@daily": { text: "Every day at midnight", h: 0, m: 0 },
    "@midnight": { text: "Every day at midnight", h: 0, m: 0 },
    "@weekly": { text: "Every Sunday at midnight", h: 0, m: 0, weekly: true },
    "@monthly": { text: "On the 1st of every month at midnight", h: 0, m: 0, monthly: true },
    "@yearly": { text: "Once a year at midnight on Jan 1", h: 0, m: 0, yearly: true },
    "@annually": { text: "Once a year at midnight on Jan 1", h: 0, m: 0, yearly: true },
  };
  const hit = map[s.toLowerCase()];
  if (hit) {
    let nextRunAt: number | undefined;
    if (hit.h === -1) {
      const d = new Date(now);
      d.setMinutes(0, 0, 0);
      d.setHours(d.getHours() + 1);
      nextRunAt = d.getTime();
    } else if (hit.weekly) {
      nextRunAt = nextWeekdayAt(0, hit.h, hit.m, now);
    } else if (!hit.monthly && !hit.yearly) {
      nextRunAt = nextDailyAt(hit.h, hit.m, now);
    }
    return { text: hit.text, humanized: true, raw, nextRunAt };
  }
  return null;
}

/**
 * Humanize a schedule string. `now` is injectable for testing; defaults to
 * the current time.
 */
export function humanizeSchedule(schedule: string | undefined | null, now: Date = new Date()): HumanSchedule {
  const raw = (schedule ?? "").trim();
  if (!raw) return { text: "No schedule — runs only when you start it", humanized: true, raw };

  if (raw.startsWith("@")) {
    const m = macro(raw, raw, now);
    if (m) return m;
    return { text: raw, humanized: false, raw };
  }

  const fields = raw.split(/\s+/);
  if (fields.length !== 5) return { text: raw, humanized: false, raw };
  const [min, hr, dom, mon, dow] = fields;

  // Every N minutes: "*/n * * * *"
  const stepMin = /^\*\/(\d+)$/.exec(min);
  if (stepMin && hr === "*" && dom === "*" && mon === "*" && dow === "*") {
    const n = Number(stepMin[1]);
    return {
      text: n === 1 ? "Every minute" : `Every ${n} minutes`,
      humanized: true,
      raw,
      nextRunAt: now.getTime() + n * 60_000,
    };
  }

  const isNum = (v: string) => /^\d+$/.test(v);

  // Hourly at minute M: "M * * * *"
  if (isNum(min) && hr === "*" && dom === "*" && mon === "*" && dow === "*") {
    const m = Number(min);
    const d = new Date(now);
    d.setMinutes(m, 0, 0);
    if (d.getTime() <= now.getTime()) d.setHours(d.getHours() + 1);
    const text = m === 0 ? "Every hour, on the hour" : `Every hour at :${m.toString().padStart(2, "0")}`;
    return { text, humanized: true, raw, nextRunAt: d.getTime() };
  }

  // Daily at H:M: "M H * * *"
  if (isNum(min) && isNum(hr) && dom === "*" && mon === "*" && dow === "*") {
    const h = Number(hr);
    const m = Number(min);
    return {
      text: `Every day at ${hhmm(h, m)}`,
      humanized: true,
      raw,
      nextRunAt: nextDailyAt(h, m, now),
    };
  }

  // Weekly on a weekday at H:M: "M H * * D"
  if (isNum(min) && isNum(hr) && dom === "*" && mon === "*" && isNum(dow)) {
    const h = Number(hr);
    const m = Number(min);
    const d = Number(dow) % 7;
    return {
      text: `Every ${DOW[d]} at ${hhmm(h, m)}`,
      humanized: true,
      raw,
      nextRunAt: nextWeekdayAt(d, h, m, now),
    };
  }

  // Monthly on day-of-month at H:M: "M H DOM * *"
  if (isNum(min) && isNum(hr) && isNum(dom) && mon === "*" && dow === "*") {
    const h = Number(hr);
    const m = Number(min);
    return {
      text: `On the ${ordinal(Number(dom))} of every month at ${hhmm(h, m)}`,
      humanized: true,
      raw,
    };
  }

  return { text: raw, humanized: false, raw };
}

/**
 * "next in 14h" style relative phrasing for a next-run time. Returns null
 * when there is no derivable next run. Coarse on purpose — the operator
 * wants a feel, not a countdown.
 */
export function describeNextRun(nextRunAt: number | undefined, now: Date = new Date()): string | null {
  if (nextRunAt == null || !Number.isFinite(nextRunAt)) return null;
  const ms = nextRunAt - now.getTime();
  if (ms <= 0) return "any moment now";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `next in ${plural(mins, "minute")}`;
  const hrs = Math.round(ms / 3_600_000);
  if (hrs < 48) return `next in ${plural(hrs, "hour")}`;
  const days = Math.round(ms / 86_400_000);
  return `next in ${plural(days, "day")}`;
}
