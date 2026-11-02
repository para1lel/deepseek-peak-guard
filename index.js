// magpie's plugin entry.
//
// The plugin gives two tools — the guard's own clock and the provider switch it
// keeps — and starts the loop that looks at the clock every tickSeconds.
// magpie calls this once per plugin host, at its start and after every plugin
// change, so a host that restarts starts the loop again; ticks that follow each
// other closely only ever repeat the same comparison.

import { loadConfig, logLine, stateDir } from "./lib/config.mjs";
import { statusReport, tick } from "./lib/guard.mjs";
import { describe } from "./lib/peak.mjs";
import { takeLease } from "./lib/owner.mjs";

let timer = null;
let started = false;
let running = false;

/** runOnce is one tick, with the loop's own guard against overlapping ticks. */
export async function runOnce({ config = loadConfig(), echo = false } = {}) {
  if (running) return { skipped: true, reason: "a tick is still running" };
  if (!takeLease(config.tickSeconds)) return { skipped: true, reason: "another host holds the clock" };
  running = true;
  try {
    const report = await tick({ config, echo });
    if (report.action !== "none" && report.action !== "error") {
      logLine(`tick: ${report.action} (${report.reason})`, { echo });
    }
    return report;
  } finally {
    running = false;
  }
}

/** startScheduler starts the clock once per process. */
export function startScheduler({ config = loadConfig(), echo = false } = {}) {
  if (started) return { started: false, reason: "already started" };
  started = true;
  const clock = describe(new Date(), config);
  const holdsClock = takeLease(config.tickSeconds);
  runOnce({ config, echo }).catch((error) => logLine(`the first tick failed: ${String(error)}`));
  timer = setInterval(() => {
    runOnce({ config, echo }).catch((error) => logLine(`a tick failed: ${String(error)}`));
  }, Math.max(5, config.tickSeconds) * 1000);
  timer.unref?.();
  logLine(
    holdsClock
      ? `deepseek-peak-guard started (pid ${process.pid}): ${config.provider} ${clock.peak ? "off" : "on"} now, ` +
          `peak ${config.windows.join(" and ")} ${config.timezone} on weekdays ${config.weekdays.join(",")}`
      : `deepseek-peak-guard loaded (pid ${process.pid}): another host holds the clock, this one stands by`,
  );
  return { started: true, clock, holdsClock };
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

export default async function deepseekPeakGuard(input, options) {
  const config = loadConfig();
  startScheduler({ config });
  return {
    tool: {
      deepseek_peak_status: {
        description:
          "Report DeepSeek's peak-pricing clock as this computer sees it: whether the peak rate is running now, when it next changes, and whether magpie's DeepSeek Official provider is switched off.",
        args: { type: "object", properties: {}, required: [] },
        execute: async () => ({ ...statusReport({ config }), stateDir: stateDir() }),
      },
      deepseek_peak_sync: {
        description:
          "Apply the peak-pricing rule now instead of waiting for the next tick: switch DeepSeek Official off inside a peak window, on outside one.",
        args: { type: "object", properties: {}, required: [] },
        execute: async () => runOnce({ config }),
      },
    },
  };
}
