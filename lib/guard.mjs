// One look at the clock, and the switch that follows: out of peak, DeepSeek
// Official is on; inside a peak window it is off, so a routing group of
// DeepSeek's models falls to its next member instead of paying the peak rate.

import { describe } from "./peak.mjs";
import { loadConfig, loadState, logLine, saveState } from "./config.mjs";
import { providerOff, switchProvider } from "./magpie.mjs";

/**
 * tick decides once and acts once. It reads the provider's own switch first,
 * so a tick that has nothing to change is a single `magpie providers` call.
 */
export async function tick({ config = loadConfig(), now = new Date(), echo = false, save = true } = {}) {
  const state = loadState();
  const clock = describe(now, config);
  const wantOff = clock.peak;
  const report = {
    at: now.toISOString(),
    local: clock.local,
    peak: clock.peak,
    provider: config.provider,
    before: null,
    after: null,
    action: "none",
    reason: "",
    dryRun: config.dryRun === true,
    next: clock.next,
  };

  let off;
  try {
    off = await providerOff(config.provider, { configured: config.magpie });
  } catch (error) {
    return fail(report, state, `could not read ${config.provider}: ${String(error?.message ?? error)}`, { echo, save, config });
  }
  if (off === null) {
    return fail(report, state, `magpie knows no provider "${config.provider}"`, { echo, save, config });
  }
  report.before = off ? "off" : "on";

  if (wantOff === off) {
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
      await applySwitch(config, false, report, echo);
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
    await applySwitch(config, true, report, echo);
    if (report.action === "on") {
      state.switchedOff = false;
      state.onAt = report.at;
    }
  }

  report.state = { switchedOff: state.switchedOff, offAt: state.offAt, onAt: state.onAt };
  state.lastTick = report.at;
  state.lastPeak = clock.peak;
  state.history = [
    ...(state.history ?? []),
    { at: report.at, peak: clock.peak, action: report.action, reason: report.reason },
  ].slice(-50);
  if (save && !config.dryRun) saveState(state);
  return report;
}

function fail(report, state, reason, { echo, save, config }) {
  report.action = "error";
  report.reason = reason;
  logLine(reason, { echo });
  if (save && !config.dryRun) saveState(state);
  return report;
}

async function applySwitch(config, on, report, echo) {
  try {
    const said = await switchProvider(config.provider, on, { configured: config.magpie });
    report.action = on ? "on" : "off";
    report.reason = on ? "peak pricing has ended" : "peak pricing has started";
    report.after = on ? "on" : "off";
    logLine(`${config.provider}: switched ${on ? "on" : "off"} (${report.reason})`, { echo });
    if (said) logLine(`  magpie said: ${said}`, { echo });
  } catch (error) {
    report.action = "error";
    report.after = report.before;
    report.reason = `switching ${on ? "on" : "off"} failed: ${String(error?.message ?? error)}`;
    logLine(`  ${report.reason}`, { echo });
  }
}

/** statusReport is what `status` prints and the plugin's tool returns. */
export function statusReport({ config = loadConfig(), now = new Date() } = {}) {
  const state = loadState();
  const clock = describe(now, config);
  return {
    provider: config.provider,
    clock,
    wanted: clock.peak ? "off" : "on",
    state,
    config,
  };
}
