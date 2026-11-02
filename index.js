// magpie's plugin entry.
//
// The plugin has no clock of its own: a plugin host is started to load a
// plugin and let go again, so a timer inside one stops with the process. The
// guard's next run is put on the operating system's scheduler at the exact
// price boundary instead, and each run puts the one after it there. Between
// boundaries nothing runs at all.

import { loadConfig, logLine, stateDir } from "./lib/config.mjs";
import { statusReport, tick } from "./lib/guard.mjs";
import { armQuietly, scheduleState } from "./lib/schedule.mjs";

/** runOnce applies the rule now and arms the next boundary. */
export async function runOnce({ config = loadConfig(), echo = false, arm = true } = {}) {
  const report = await tick({ config, echo });
  if (arm) {
    const next = await safeArm({ config, echo });
    if (next) report.next = next;
  }
  return report;
}

async function safeArm({ config, echo }) {
  try {
    return armQuietly({ config });
  } catch (error) {
    logLine(`arming the next boundary failed: ${String(error)}`, { echo });
    return null;
  }
}

export default async function deepseekPeakGuard(input, options) {
  const config = loadConfig();
  // one action per price change, not a poll: ask the OS scheduler for the next one
  const next = armQuietly({ config });
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
          armed: next?.error ? { error: next.error } : { at: next?.boundary ?? next?.at ?? null, peak: next?.peak },
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
