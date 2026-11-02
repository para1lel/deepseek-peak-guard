// One look at the clock, and the switch that follows: out of peak, DeepSeek
// Official is on; inside a peak window it is off, so a routing group of
// DeepSeek's models falls to its next member instead of paying the peak rate.
//
// A tick is cheap and idempotent. It reads providers.json (a file), and it
// calls `magpie provider on|off` only when the switch disagrees with the
// clock. Nothing here schedules anything, so a tick can never start another.

import { describe } from "./peak.mjs";
import { loadConfig, loadState, logLine, saveState } from "./config.mjs";
import { providerState, switchProvider } from "./magpie.mjs";

const HISTORY = 20;

/**
 * tick decides once and acts once. `io` exists for the tests: readState(id)
 * and switch(id, on) default to providers.json and magpie's own command line.
 */
export async function tick({ config = loadConfig(), now = new Date(), echo = false, save = true, io = {} } = {}) {
  const state = loadState();
  const clock = describe(now, config);
  const wantOff = clock.peak;
  const read = io.readState ?? ((id) => providerState(id));
  const flip = io.switch ?? ((id, on) => switchProvider(id, on, { configured: config.magpie }));

  const report = {
    at: now.toISOString(),
    local: clock.local,
    peak: clock.peak,
    provider: config.provider,
    before: null,
    after: null,
    verified: null,
    action: "none",
    reason: "",
    dryRun: config.dryRun === true,
    next: clock.next,
  };

  const current = read(config.provider);
  if (!current?.found) {
    const reason = current?.reason ?? `magpie knows no provider "${config.provider}"`;
    return fail(report, state, reason, { echo, save, config });
  }
  report.before = current.off ? "off" : "on";

  if (wantOff === current.off) {
    report.after = report.before;
    report.reason = wantOff ? "already off in a peak window" : "already on outside peak hours";
    // the guard no longer holds the switch: let a later off-peak tick be free
    // to turn it on even if it was turned off by hand in the meantime
    if (!wantOff && state.switchedOff) {
      state.switchedOff = false;
      state.onAt = report.at;
    }
  } else if (wantOff) {
    if (config.dryRun) {
      report.action = "would-off";
      report.reason = "peak pricing has started";
    } else {
      await applySwitch(config, false, report, echo, flip);
      if (report.action === "off") {
        state.switchedOff = true;
        state.offAt = report.at;
      }
    }
  } else if (config.respectManualOff && !state.switchedOff) {
    report.reason = "it was switched off by hand; respectManualOff leaves it that way";
  } else if (config.dryRun) {
    report.action = "would-on";
    report.reason = "peak pricing has ended";
  } else {
    await applySwitch(config, true, report, echo, flip);
    if (report.action === "on") {
      state.switchedOff = false;
      state.onAt = report.at;
    }
  }

  if (report.action === "off" || report.action === "on") {
    verify(config, report, read, echo);
  }

  report.state = { switchedOff: state.switchedOff, offAt: state.offAt ?? null, onAt: state.onAt ?? null };
  state.lastTick = report.at;
  state.lastPeak = clock.peak;
  state.lastAction = report.action;
  state.history = [
    ...(state.history ?? []),
    { at: report.at, peak: clock.peak, action: report.action, reason: report.reason },
  ].slice(-HISTORY);
  if (save && !config.dryRun) saveState(state);

  logLine(
    `${clock.local} peak=${clock.peak ? "yes" : "no"} ${config.provider} ${report.before}->${report.after ?? report.before} ${report.action}`,
    { echo },
  );
  return report;
}

/**
 * verify reads the switch back after magpie was asked to flip it. magpie
 * writes providers.json itself, so a disagreement here means the gateway did
 * not take the change; it is reported, never retried in a loop.
 */
function verify(config, report, read, echo) {
  const after = read(config.provider);
  if (!after?.found) return;
  report.after = after.off ? "off" : "on";
  report.verified = after.off === (report.action === "off");
  if (!report.verified) {
    logLine(
      `${config.provider}: asked magpie to switch ${report.action}, but providers.json still reads ${report.after}`,
      { echo },
    );
  }
}

function fail(report, state, reason, { echo, save, config }) {
  report.action = "error";
  report.reason = reason;
  logLine(reason, { echo });
  if (save && !config.dryRun) saveState(state);
  return report;
}

async function applySwitch(config, on, report, echo, flip) {
  try {
    const said = await flip(config.provider, on);
    report.action = on ? "on" : "off";
    report.reason = on ? "peak pricing has ended" : "peak pricing has started";
    report.after = on ? "on" : "off";
    logLine(`${config.provider}: switched ${on ? "on" : "off"} (${report.reason})`, { echo });
    if (said) logLine(`  magpie said: ${String(said).split(/\r?\n/)[0]}`, { echo });
  } catch (error) {
    report.action = "error";
    report.after = report.before;
    report.reason = `switching ${on ? "on" : "off"} failed: ${String(error?.message ?? error)}`;
    logLine(`  ${report.reason}`, { echo });
  }
}

/** statusReport is what `status` prints and the plugin's status tool returns. */
export function statusReport({ config = loadConfig(), now = new Date() } = {}) {
  const state = loadState();
  const clock = describe(now, config);
  const current = providerState(config.provider);
  return {
    provider: config.provider,
    clock,
    wanted: clock.peak ? "off" : "on",
    current: {
      found: current.found,
      off: current.off,
      file: current.file,
      note: current.reason ?? null,
    },
    state: {
      switchedOff: state.switchedOff,
      offAt: state.offAt ?? null,
      onAt: state.onAt ?? null,
      lastTick: state.lastTick ?? null,
      lastAction: state.lastAction ?? null,
    },
    config: {
      timezone: config.timezone,
      windows: config.windows,
      weekdays: config.weekdays,
      holidays: config.holidays,
      dryRun: config.dryRun,
      respectManualOff: config.respectManualOff,
    },
  };
}
