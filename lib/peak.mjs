// When DeepSeek charges its peak rate. The rule is a clock in one timezone
// ("09:00-12:00" and "14:00-18:00" in Asia/Shanghai by default), on chosen
// weekdays, on days that are not holidays. Everything here is a pure function
// of a Date and the config, so the tests can walk whole weeks without a clock.

const formatters = new Map();

function formatter(timeZone) {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, found);
  }
  return found;
}

/** zonedParts is the wall clock of `date` in `timeZone`. */
export function zonedParts(date, timeZone) {
  const parts = formatter(timeZone).formatToParts(date);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = get("hour");
  const minute = get("minute");
  // 0000-01-01 was a Saturday; ISO weekdays run 1 (Monday) … 7 (Sunday).
  const weekday = ((new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7) + 1;
  return {
    year,
    month,
    day,
    hour,
    minute,
    weekday,
    date: `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    time: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
    minutes: hour * 60 + minute,
  };
}

/** parseWindow turns "09:00-12:00" into the minutes of the day it covers. */
export function parseWindow(text) {
  const match = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(String(text ?? ""));
  if (!match) throw new Error(`a window looks like 09:00-12:00, not "${text}"`);
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  if (start < 0 || end > 24 * 60 || start >= end) {
    throw new Error(`a window must start before it ends, inside one day: "${text}"`);
  }
  return { text: `${match[1].padStart(2, "0")}:${match[2]}-${match[3].padStart(2, "0")}:${match[4]}`, start, end };
}

export function parseWindows(windows) {
  return (Array.isArray(windows) ? windows : []).map(parseWindow).sort((a, b) => a.start - b.start);
}

/**
 * isPeak says whether `date` falls in a peak window: a chosen weekday, not a
 * holiday, and inside one of the windows.
 */
export function isPeak(date, config) {
  const parts = zonedParts(date, config.timezone);
  if (!config.weekdays.includes(parts.weekday)) return false;
  if (config.holidays.includes(parts.date)) return false;
  return parseWindows(config.windows).some((window) => parts.minutes >= window.start && parts.minutes < window.end);
}

/**
 * nextChange is when the answer flips: the first minute, scanning forward, at
 * which isPeak disagrees with now. Windows sit on minute boundaries, so a
 * minute of resolution loses nothing.
 */
export function nextChange(now, config, horizonMinutes = 8 * 24 * 60) {
  const start = new Date(Math.ceil(now.getTime() / 60_000) * 60_000);
  const current = isPeak(start, config);
  for (let step = 1; step <= horizonMinutes; step += 1) {
    const at = new Date(start.getTime() + step * 60_000);
    if (isPeak(at, config) !== current) {
      return { at, peak: !current, minutes: step, from: start };
    }
  }
  return null;
}

/** describe says what the clock means right now, for a status line. */
export function describe(now, config) {
  const parts = zonedParts(now, config.timezone);
  const next = nextChange(now, config);
  return {
    now: now.toISOString(),
    local: `${parts.date} ${parts.time}`,
    timezone: config.timezone,
    weekday: parts.weekday,
    holiday: config.holidays.includes(parts.date),
    peak: isPeak(now, config),
    windows: config.windows,
    next: next ? { at: next.at.toISOString(), peak: next.peak, inMinutes: next.minutes } : null,
  };
}
