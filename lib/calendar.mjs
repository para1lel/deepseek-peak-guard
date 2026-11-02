// Where the guard's runs sit on the calendar.
//
// The price clock is a weekly pattern, so the runs are too: the guard is put
// on the OS scheduler once, at the minutes the windows open and close, and it
// never moves itself afterwards. Nothing here reads a clock or talks to the OS,
// so the tests and `schedule-status` see the same plan the installers write.

import { parseWindows } from "./peak.mjs";

const MINUTES_PER_DAY = 1440;

/** Day names as systemd.time spells them; index 0 is ISO weekday 1 (Monday). */
const SYSTEMD_DAY = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Day names as Task Scheduler's -DaysOfWeek spells them. */
const WINDOWS_DAY = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function pad(number) {
  return String(number).padStart(2, "0");
}

function weekdaysOf(config) {
  const days = (Array.isArray(config?.weekdays) ? config.weekdays : []).map(Number);
  return [...new Set(days)].filter((day) => Number.isInteger(day) && day >= 1 && day <= 7).sort((a, b) => a - b);
}

/** boundaryMinutes is every minute of the day a peak window opens or closes. */
export function boundaryMinutes(config) {
  const minutes = new Set();
  for (const window of parseWindows(config.windows)) {
    minutes.add(window.start);
    minutes.add(window.end);
  }
  return [...minutes].sort((a, b) => a - b);
}

/** shiftWeekdays moves ISO weekdays forward, wrapping Sunday to Monday. */
export function shiftWeekdays(days, offset) {
  const shifted = new Set();
  for (const day of days) shifted.add(((day - 1 + offset) % 7) + 1);
  return [...shifted].sort((a, b) => a - b);
}

/**
 * boundaryInstants is the schedule as data: one entry per run, with the wall
 * clock it happens at and the weekdays it happens on. A window that ends at
 * 24:00 becomes 00:00 on the following weekday, which is why the weekdays are
 * shifted rather than clamped.
 */
export function boundaryInstants(config) {
  const days = weekdaysOf(config);
  return boundaryMinutes(config).map((minutes) => {
    const dayShift = Math.floor(minutes / MINUTES_PER_DAY);
    const clock = minutes - dayShift * MINUTES_PER_DAY;
    const hour = Math.floor(clock / 60);
    const minute = clock % 60;
    return {
      minutes,
      dayShift,
      hour,
      minute,
      hhmm: `${pad(hour)}:${pad(minute)}`,
      weekdays: dayShift ? shiftWeekdays(days, dayShift) : days,
    };
  });
}

/** systemdWeekdays compresses consecutive days into ranges: Mon..Fri, Mon,Wed,Fri. */
export function systemdWeekdays(days) {
  const sorted = [...new Set(days.map(Number))].sort((a, b) => a - b);
  const runs = [];
  for (const day of sorted) {
    const last = runs[runs.length - 1];
    if (last && day === last.end + 1) last.end = day;
    else runs.push({ start: day, end: day });
  }
  return runs
    .map((run) =>
      run.start === run.end ? SYSTEMD_DAY[run.start - 1] : `${SYSTEMD_DAY[run.start - 1]}..${SYSTEMD_DAY[run.end - 1]}`,
    )
    .join(",");
}

/** windowsWeekdays is the same list in the spelling Task Scheduler accepts. */
export function windowsWeekdays(days) {
  return [...new Set(days.map(Number))]
    .sort((a, b) => a - b)
    .map((day) => WINDOWS_DAY[day - 1])
    .join(",");
}

/** systemdCalendar is the `OnCalendar=` line per run, e.g. "Mon..Fri 09:00:00". */
export function systemdCalendar(config) {
  return boundaryInstants(config).map(
    (instant) => `OnCalendar=${systemdWeekdays(instant.weekdays)} ${instant.hhmm}:00`,
  );
}

/** taskPlan is the Windows side: one weekly trigger per run. */
export function taskPlan(config) {
  return boundaryInstants(config).map((instant) => ({
    at: instant.hhmm,
    weekdays: instant.weekdays,
    days: windowsWeekdays(instant.weekdays),
  }));
}

/** describeSchedule is the one line a person reads: when the guard runs. */
export function describeSchedule(config) {
  const days = weekdaysOf(config);
  const times = boundaryInstants(config)
    .map((instant) => instant.hhmm)
    .join(", ");
  return `${systemdWeekdays(days)} ${times} (${config.timezone})`;
}
