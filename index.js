// magpie's plugin entry.
//
// The plugin has no clock of its own: a plugin host is started to load a
// plugin and let go again, so a timer inside one stops with the process. The
// guard's next run is put on the operating system's scheduler at the exact
// price boundary instead, and each run puts the one after it there. Between
// boundaries nothing runs at all.
//
// Loading must stay quick: magpie gives a plugin 20 seconds to load, and
// arming runs PowerShell (Windows) or systemctl (Linux), which can be slow on
// a cold machine. So the load starts the arming as its own process and returns.

import { spawn } from "node:child_process";
import path from "node:path";
import { loadConfig, logLine, readJSON, stateDir, writeJSON } from "./lib/config.mjs";
import { statusReport, tick } from "./lib/guard.mjs";
import { cliPath, scheduleState } from "./lib/schedule.mjs";

const ARM_EVERY_MS = 10 * 60_000;

/** armInBackground starts `install-schedule` and does not wait for it. */
export function armInBackground({ config = loadConfig(), force = false } = {}) {
  try {
    const marker = path.join(stateDir(), "armed-at.json");
    const last = Number(readJSON(marker, {})?.at ?? 0);
    if (!force && Date.now() - last < ARM_EVERY_MS) return { skipped: true, last };
    writeJSON(marker, { at: Date.now(), pid: process.pid });
    const child = spawn(process.execPath, [cliPath(), "install-schedule"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      cwd: path.dirname(cliPath()),
      env: { ...process.env },
    });
    child.unref();
    return { started: true, pid: child.pid ?? null };
  } catch (error) {
    logLine(`arming the next boundary could not be started: ${String(error?.message ?? error)}`);
    return { error: String(error?.message ?? error) };
  }
}

/** runOnce applies the rule now and arms the next boundary. */
export async function runOnce({ config = loadConfig(), echo = false, arm = true } = {}) {
  const report = await tick({ config, echo });
  if (arm) report.next = armInBackground({ config, force: true });
  return report;
}

export default async function deepseekPeakGuard(input, options) {
  const config = loadConfig();
  // one action per price change, not a poll: ask the OS scheduler for the next one
  const arming = armInBackground({ config });
  return {
    tool: {
      deepseek_peak_status: {
        description:
          "Report DeepSeek's peak-pricing clock as this computer sees it: whether the peak rate is running now, when it next changes, whether magpie's DeepSeek Official provider is switched off, and when the OS scheduler will run the guard next.",
        args: { type: "object", properties: {}, required: [] },
        execute: async () => ({
          ...statusReport({ config }),
          stateDir: stateDir(),
          schedule: scheduleState(),
          arming,
        }),
      },
      deepseek_peak_sync: {
        description:
          "Apply the peak-pricing rule now instead of waiting for the boundary: switch DeepSeek Official off inside a peak window, on outside one, then arm the next boundary.",
        args: { type: "object", properties: {}, required: [] },
        execute: async () => runOnce({ config }),
      },
    },
  };
}
