// Where the guard keeps its settings and what it remembers between ticks. It
// sits beside magpie's own settings, in ~/.config/magpie/deepseek-peak-guard,
// so it travels with magpie's config folder on every machine.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_CONFIG = {
  // The provider the guard switches. `magpie providers` shows it by this id.
  provider: "deepseek",
  // DeepSeek publishes its peak hours in UTC (01:00-04:00 and 06:00-10:00,
  // Monday to Friday, Chinese public holidays excluded). In Asia/Shanghai that
  // is the same clock twice a weekday: 09:00-12:00 and 14:00-18:00.
  timezone: "Asia/Shanghai",
  windows: ["09:00-12:00", "14:00-18:00"],
  // ISO weekdays: 1 Monday … 7 Sunday.
  weekdays: [1, 2, 3, 4, 5],
  // Days that are off-peak whatever the weekday says, as YYYY-MM-DD in the
  // timezone above (Chinese public holidays).
  holidays: [],
  // How often the running plugin looks at the clock.
  tickSeconds: 30,
  // Report alone: say what would happen, switch nothing.
  dryRun: false,
  // Whether a provider switched off by hand is left alone in off-peak hours.
  respectManualOff: false,
  // The magpie binary, when it is not on PATH (the plugin's host usually has
  // it, a systemd --user unit may not).
  magpie: "",
};

export function stateDir() {
  const explicit = process.env.DEEPSEEK_PEAK_GUARD_HOME?.trim();
  if (explicit) return path.resolve(explicit);
  return path.join(os.homedir(), ".config", "magpie", "deepseek-peak-guard");
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJSON(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function configPath() {
  return path.join(stateDir(), "config.json");
}

export function loadConfig(overrides = {}) {
  const saved = readJSON(configPath(), {}) ?? {};
  const config = { ...DEFAULT_CONFIG, ...saved, ...overrides };
  config.windows = normaliseWindows(config.windows);
  config.weekdays = normaliseWeekdays(config.weekdays);
  config.holidays = Array.isArray(config.holidays)
    ? config.holidays.map((day) => String(day).slice(0, 10))
    : [];
  config.tickSeconds = Math.max(5, Number(config.tickSeconds) || DEFAULT_CONFIG.tickSeconds);
  config.timezone = String(config.timezone || DEFAULT_CONFIG.timezone);
  config.provider = String(config.provider || DEFAULT_CONFIG.provider).trim();
  config.magpie = String(config.magpie || "").trim();
  return config;
}

export function saveConfig(config) {
  writeJSON(configPath(), config);
}

function normaliseWindows(windows) {
  const list = Array.isArray(windows) ? windows : DEFAULT_CONFIG.windows;
  const kept = list.map((item) => String(item).trim()).filter(Boolean);
  return kept.length ? kept : [...DEFAULT_CONFIG.windows];
}

function normaliseWeekdays(days) {
  const list = Array.isArray(days) ? days : DEFAULT_CONFIG.weekdays;
  const kept = [...new Set(list.map((day) => Number(day)))]
    .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7)
    .sort((a, b) => a - b);
  return kept.length ? kept : [...DEFAULT_CONFIG.weekdays];
}

export function statePath() {
  return path.join(stateDir(), "state.json");
}

export function loadState() {
  const state = readJSON(statePath(), null);
  if (!state || typeof state !== "object") {
    return { version: 1, switchedOff: false, offAt: null, onAt: null, history: [] };
  }
  state.version ??= 1;
  state.switchedOff ??= false;
  state.history ??= [];
  return state;
}

export function saveState(state) {
  state.updatedAt = new Date().toISOString();
  writeJSON(statePath(), state);
}

export function logsDir() {
  return ensureDir(path.join(stateDir(), "logs"));
}

/** logLine appends one line to the guard's log, and echoes it when asked. */
export function logLine(line, { echo = false } = {}) {
  const stamped = `${new Date().toISOString()} ${line}`;
  try {
    fs.appendFileSync(path.join(logsDir(), "guard.log"), `${stamped}\n`);
  } catch {
    // a log that cannot be written must not stop the guard
  }
  if (echo) console.log(stamped);
}
