// A tick is a decision, not a schedule. These tests give it a clock and a fake
// providers.json, and count the magpie calls: one at most, none when the
// switch already agrees with the price clock.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// state.json lives beside magpie's config; point it at a scratch directory
// before anything reads it.
process.env.DEEPSEEK_PEAK_GUARD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dspg-guard-"));

const { tick } = await import("../lib/guard.mjs");
const { loadState } = await import("../lib/config.mjs");

const config = {
  provider: "deepseek",
  timezone: "Asia/Shanghai",
  windows: ["09:00-12:00", "14:00-18:00"],
  weekdays: [1, 2, 3, 4, 5],
  holidays: [],
  dryRun: false,
  respectManualOff: false,
  magpie: "",
};

const at = (text) => new Date(`2026-11-02T${text}:00+08:00`);

/** fakeIO is a providers.json with one switch, plus a log of the flips. */
function fakeIO({ off = false, found = true } = {}) {
  const provider = { id: "deepseek", found, off: found ? off : null, file: "/tmp/providers.json" };
  const calls = [];
  return {
    calls,
    readState: () => provider,
    switch: async (id, on) => {
      calls.push({ id, on });
      provider.off = !on;
      return "";
    },
  };
}

test("peak pricing switched off a provider that was on", async () => {
  const io = fakeIO({ off: false });
  const report = await tick({ config, now: at("09:00"), io, save: false });
  assert.equal(report.action, "off");
  assert.equal(report.before, "on");
  assert.equal(report.after, "off");
  assert.equal(report.verified, true);
  assert.deepEqual(io.calls, [{ id: "deepseek", on: false }]);
});

test("a provider already off in a peak window is left alone", async () => {
  const io = fakeIO({ off: true });
  const report = await tick({ config, now: at("10:00"), io, save: false });
  assert.equal(report.action, "none");
  assert.match(report.reason, /already off/);
  assert.deepEqual(io.calls, []);
});

test("the end of a peak window switches the provider back on", async () => {
  const io = fakeIO({ off: true });
  const report = await tick({ config, now: at("12:00"), io, save: false });
  assert.equal(report.action, "on");
  assert.deepEqual(io.calls, [{ id: "deepseek", on: true }]);
});

test("outside peak hours a provider already on is left alone", async () => {
  const io = fakeIO({ off: false });
  const report = await tick({ config, now: at("08:59"), io, save: false });
  assert.equal(report.action, "none");
  assert.equal(report.peak, false);
  assert.deepEqual(io.calls, []);
});

test("a holiday switches nothing, even on a weekday", async () => {
  const io = fakeIO({ off: false });
  const holiday = { ...config, holidays: ["2026-11-04"] };
  const report = await tick({ config: holiday, now: new Date("2026-11-04T09:00:00+08:00"), io, save: false });
  assert.equal(report.peak, false);
  assert.equal(report.action, "none");
  assert.deepEqual(io.calls, []);
});

test("a dry run reports the flip and calls nothing", async () => {
  const io = fakeIO({ off: false });
  const report = await tick({ config: { ...config, dryRun: true }, now: at("09:30"), io, save: false });
  assert.equal(report.action, "would-off");
  assert.equal(report.after, null);
  assert.deepEqual(io.calls, []);
});

test("respectManualOff leaves a hand-switched provider off", async () => {
  const io = fakeIO({ off: true });
  const report = await tick({ config: { ...config, respectManualOff: true }, now: at("13:00"), io, save: false });
  assert.equal(report.action, "none");
  assert.match(report.reason, /switched off by hand/);
  assert.deepEqual(io.calls, []);
});

test("an unknown provider is an error, not a guess", async () => {
  const io = fakeIO({ found: false });
  const report = await tick({ config: { ...config, provider: "nope" }, now: at("09:30"), io, save: false });
  assert.equal(report.action, "error");
  assert.match(report.reason, /no provider|providers\.json/);
  assert.deepEqual(io.calls, []);
});

test("a magpie that refuses the switch is reported, not retried", async () => {
  const io = {
    readState: () => ({ id: "deepseek", found: true, off: false, file: "/tmp/providers.json" }),
    switch: async () => {
      throw new Error("gateway said no");
    },
  };
  const report = await tick({ config, now: at("09:30"), io, save: false });
  assert.equal(report.action, "error");
  assert.match(report.reason, /gateway said no/);
});

test("a switch magpie did not take is not claimed as done", async () => {
  const provider = { id: "deepseek", found: true, off: false, file: "/tmp/providers.json" };
  const io = { readState: () => provider, switch: async () => "" };
  const report = await tick({ config, now: at("09:30"), io, save: false });
  assert.equal(report.action, "off");
  assert.equal(report.verified, false);
  assert.equal(report.after, "on");
});

test("a real tick records the switch in state.json", async () => {
  const io = fakeIO({ off: false });
  await tick({ config, now: at("09:05"), io });
  const state = loadState();
  assert.equal(state.switchedOff, true);
  assert.equal(state.lastAction, "off");
  assert.ok(state.history.length >= 1);
});
