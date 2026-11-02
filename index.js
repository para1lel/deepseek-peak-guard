// magpie's plugin entry.
//
// There is no clock inside the plugin: a plugin host is started to load a
// plugin and let go again, so an interval in one stops with the process. The
// runs live on the operating system's scheduler instead, installed once by
// `install-schedule`; loading only repairs the launcher, which is a text file
// in the guard's state directory. Nothing here shells out, so loading stays
// well inside magpie's 20 seconds.

import { loadConfig, logLine, stateDir } from "./lib/config.mjs";
import { statusReport, tick } from "./lib/guard.mjs";
import { ensureLauncher, install, status as scheduleStatus } from "./lib/schedule.mjs";

/** heal rewrites cli.txt and the shim when an update moved the plugin. */
function heal() {
  try {
    const launcher = ensureLauncher();
    if (launcher.wrote.length) logLine(`launcher rewritten: ${launcher.wrote.join(", ")}`);
    return launcher;
  } catch (error) {
    logLine(`the launcher could not be written: ${String(error?.message ?? error)}`);
    return null;
  }
}

export default async function deepseekPeakGuard() {
  const config = loadConfig();
  heal();

  return {
    tool: {
      deepseek_peak_status: {
        description:
          "Report DeepSeek's peak-pricing clock as this computer sees it: whether the peak rate is running now, when it next changes, whether magpie's DeepSeek Official provider is switched off in providers.json, and whether the installation still holds the four weekday runs (09:00, 12:00, 14:00, 18:00).",
        args: { type: "object", properties: {}, required: [] },
        execute: async () => ({
          ...statusReport({ config }),
          schedule: scheduleStatus({ config }),
          stateDir: stateDir(),
        }),
      },
      deepseek_peak_sync: {
        description:
          "Apply the peak-pricing rule now instead of waiting for the next scheduled run: switch DeepSeek Official off inside a peak window, on outside one. Reads providers.json and calls magpie only when the switch has to move.",
        args: { type: "object", properties: {}, required: [] },
        execute: async () => tick({ config }),
      },
      deepseek_peak_install: {
        description:
          "Install (or repair) the guard's schedule on this computer: one systemd --user timer or one Windows task that runs the guard at the four DeepSeek price boundaries, weekdays only. Safe to run again; it never re-arms itself afterwards.",
        args: { type: "object", properties: {}, required: [] },
        execute: async () => {
          const installed = install({ config });
          const report = await tick({ config });
          return { installed, tick: report };
        },
      },
    },
  };
}
