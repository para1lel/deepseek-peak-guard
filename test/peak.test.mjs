// The clock is the whole rule, so these tests walk the boundaries a person
// would ask about: the minute a window opens, the lunch break, the evening,
// the weekend, and a holiday that falls on a weekday.

import assert from "node:assert/strict";
import test from "node:test";
import { isPeak, nextChange, parseWindow, parseWindows, zonedParts, describe } from "../lib/peak.mjs";

const config = {
  timezone: "Asia/Shanghai",
  windows: ["09:00-12:00", "14:00-18:00"],
  weekdays: [1, 2, 3, 4, 5],
  holidays: ["2026-11-04"],
};

// 2026-11-02 is a Monday; every hour below is Shanghai time.
const at = (text) => new Date(`2026-11-02T${text}:00+08:00`);
const day = (text) => new Date(`${text}+08:00`);

test("a window opens on its first minute", () => {
  assert.equal(isPeak(at("08:59"), config), false);
  assert.equal(isPeak(at("09:00"), config), true);
});

test("a window closes on its last minute", () => {
  assert.equal(isPeak(at("11:59"), config), true);
  assert.equal(isPeak(at("12:00"), config), false);
});

test("the lunch break is off-peak", () => {
  assert.equal(isPeak(at("12:30"), config), false);
  assert.equal(isPeak(at("13:59"), config), false);
  assert.equal(isPeak(at("14:00"), config), true);
});

test("the evening is off-peak", () => {
  assert.equal(isPeak(at("17:59"), config), true);
  assert.equal(isPeak(at("18:00"), config), false);
  assert.equal(isPeak(at("23:30"), config), false);
});

test("a weekend is off-peak all day", () => {
  assert.equal(isPeak(day("2026-11-07T10:00:00"), config), false);
  assert.equal(isPeak(day("2026-11-08T15:00:00"), config), false);
});

test("a holiday on a weekday is off-peak all day", () => {
  assert.equal(isPeak(day("2026-11-04T10:00:00"), config), false); // Wednesday, but a holiday
  assert.equal(isPeak(day("2026-11-04T15:00:00"), config), false);
});

test("the next change is the nearest boundary", () => {
  const morning = nextChange(at("08:00"), config);
  assert.equal(morning.peak, true);
  assert.equal(morning.minutes, 60);
  assert.equal(morning.at.toISOString(), "2026-11-02T01:00:00.000Z");

  const lunch = nextChange(at("11:30"), config);
  assert.equal(lunch.peak, false);
  assert.equal(lunch.minutes, 30);

  const evening = nextChange(at("17:30"), config);
  assert.equal(evening.peak, false);
  assert.equal(evening.minutes, 30);
});

test("Friday evening's next change is Monday morning", () => {
  const friday = day("2026-11-06T18:00:00");
  const next = nextChange(friday, config);
  assert.equal(next.peak, true);
  assert.equal(next.at.toISOString(), "2026-11-09T01:00:00.000Z");
  assert.equal(next.minutes, 2 * 24 * 60 + 15 * 60);
});

test("a window has to be a window", () => {
  assert.deepEqual(parseWindow("9:00-12:00"), { text: "09:00-12:00", start: 540, end: 720 });
  assert.throws(() => parseWindow("12:00-09:00"), /start before it ends/);
  assert.throws(() => parseWindow("nine to noon"), /looks like/);
  assert.equal(parseWindows(["14:00-18:00", "09:00-12:00"])[0].start, 540);
});

test("the local clock is read in the configured timezone", () => {
  const parts = zonedParts(new Date("2026-11-02T01:30:00Z"), "Asia/Shanghai");
  assert.equal(parts.date, "2026-11-02");
  assert.equal(parts.time, "09:30");
  assert.equal(parts.weekday, 1);
});

test("describe names the moment and what comes next", () => {
  const report = describe(at("08:30"), config);
  assert.equal(report.peak, false);
  assert.equal(report.local, "2026-11-02 08:30");
  assert.equal(report.next.peak, true);
  assert.equal(report.next.inMinutes, 30);
});
