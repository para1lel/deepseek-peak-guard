// The calendar is the whole schedule now, so the tests read the plan the two
// installers write: which minutes, which weekdays, and how each OS spells them.

import assert from "node:assert/strict";
import test from "node:test";
import {
  boundaryInstants,
  boundaryMinutes,
  describeSchedule,
  shiftWeekdays,
  systemdCalendar,
  systemdWeekdays,
  taskPlan,
  windowsWeekdays,
} from "../lib/calendar.mjs";

const config = {
  timezone: "Asia/Shanghai",
  windows: ["09:00-12:00", "14:00-18:00"],
  weekdays: [1, 2, 3, 4, 5],
  holidays: [],
};

test("the runs are the four minutes the price changes", () => {
  assert.deepEqual(boundaryMinutes(config), [540, 720, 840, 1080]);
  assert.deepEqual(
    boundaryInstants(config).map((instant) => instant.hhmm),
    ["09:00", "12:00", "14:00", "18:00"],
  );
});

test("windows are read in any order and deduplicated", () => {
  const shuffled = { ...config, windows: ["14:00-18:00", "09:00-12:00", "09:00-18:00"] };
  assert.deepEqual(boundaryMinutes(shuffled), [540, 720, 840, 1080]);
});

test("systemd gets one OnCalendar line per run", () => {
  assert.deepEqual(systemdCalendar(config), [
    "OnCalendar=Mon..Fri 09:00:00",
    "OnCalendar=Mon..Fri 12:00:00",
    "OnCalendar=Mon..Fri 14:00:00",
    "OnCalendar=Mon..Fri 18:00:00",
  ]);
});

test("consecutive days become a range, other lists stay a list", () => {
  assert.equal(systemdWeekdays([1, 2, 3, 4, 5]), "Mon..Fri");
  assert.equal(systemdWeekdays([6, 7]), "Sat..Sun");
  assert.equal(systemdWeekdays([1, 3, 5]), "Mon,Wed,Fri");
  assert.equal(systemdWeekdays([7, 1, 2]), "Mon..Tue,Sun");
});

test("Task Scheduler gets the long day names", () => {
  assert.equal(windowsWeekdays([1, 2, 3, 4, 5]), "Monday,Tuesday,Wednesday,Thursday,Friday");
  assert.deepEqual(
    taskPlan(config).map((trigger) => `${trigger.at} ${trigger.days}`),
    [
      "09:00 Monday,Tuesday,Wednesday,Thursday,Friday",
      "12:00 Monday,Tuesday,Wednesday,Thursday,Friday",
      "14:00 Monday,Tuesday,Wednesday,Thursday,Friday",
      "18:00 Monday,Tuesday,Wednesday,Thursday,Friday",
    ],
  );
});

test("a window that ends at midnight runs at 00:00 the next day", () => {
  const overnight = { ...config, windows: ["22:00-24:00"], weekdays: [1, 2, 3, 4, 5] };
  const instants = boundaryInstants(overnight);
  assert.deepEqual(instants.map((instant) => instant.hhmm), ["22:00", "00:00"]);
  assert.deepEqual(instants[1].weekdays, [2, 3, 4, 5, 6]);
  assert.deepEqual(systemdCalendar(overnight), [
    "OnCalendar=Mon..Fri 22:00:00",
    "OnCalendar=Tue..Sat 00:00:00",
  ]);
  assert.deepEqual(
    taskPlan(overnight).map((trigger) => trigger.days),
    ["Monday,Tuesday,Wednesday,Thursday,Friday", "Tuesday,Wednesday,Thursday,Friday,Saturday"],
  );
});

test("shiftWeekdays wraps Sunday round to Monday", () => {
  assert.deepEqual(shiftWeekdays([1, 5, 7], 1), [1, 2, 6]);
  assert.deepEqual(shiftWeekdays([6, 7], 1), [1, 7]);
});

test("one line says when the guard runs", () => {
  assert.equal(describeSchedule(config), "Mon..Fri 09:00, 12:00, 14:00, 18:00 (Asia/Shanghai)");
});

test("a window that is not a window is refused, not scheduled", () => {
  assert.throws(() => boundaryMinutes({ windows: ["12:00-09:00"] }), /start before it ends/);
  assert.throws(() => boundaryMinutes({ windows: ["noon"] }), /looks like/);
});
