#!/usr/bin/env node
// The guard from a shell, for the times a plugin host is not running: a
// systemd timer, a container's cron, or a person checking what it would do.
//
//   deepseek-peak-guard status [--json] [--now 2026-11-03T09:05:00+08:00]
//   deepseek-peak-guard tick   [--now …]     look once, switch if needed
//   deepseek-peak-guard sync   [--now …]     the same, named for what it does
//   deepseek-peak-guard schedule             keep looking, in this process
//   deepseek-peak-guard config [--json]

import { loadConfig, saveConfig, DEFAULT_CONFIG, stateDir, logLine } from "../lib/config.mjs";
import { statusReport, tick } from "../lib/guard.mjs";
import { parseWindows } from "../lib/peak.mjs";
import { ensureSchedule, removeSchedule, scheduleState } from "../lib/schedule.mjs";

const argv = process.argv.slice(2);
const command = argv[0] ?? "status";

function flag(name) {
  return argv.includes(`--${name}`);
}

function valueOf(name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function now() {
  const given = valueOf("now");
  if (!given) return new Date();
  const parsed = new Date(given);
  if (Number.isNaN(parsed.getTime())) throw new Error(`--now is not a date: ${given}`);
  return parsed;
}

function printClock(clock, provider, wanted) {
  const next = clock.next;
  const lines = [
    `provider  ${provider}`,
    `now       ${clock.local} (${clock.timezone}, weekday ${clock.weekday}${clock.holiday ? ", holiday" : ""})`,
    `peak      ${clock.peak ? "yes" : "no"} — its models ${wanted}`,
    `windows   ${clock.windows.join("  ")}`,
    next
      ? `next      ${new Date(next.at).toISOString()} — peak ${next.peak ? "starts" : "ends"} in ${next.inMinutes} min`
      : "next      nothing within 8 days",
  ];
  console.log(lines.join("\n"));
}

async function main() {
  const config = loadConfig();

  if (command === "status") {
    const report = statusReport({ config, now: now() });
    if (flag("json")) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    printClock(report.clock, report.provider, report.wanted);
    console.log(`state     ${report.state.switchedOff ? "switched off by the guard" : "left on"}`);
    if (report.state.offAt) console.log(`off since ${report.state.offAt}`);
    if (report.state.onAt) console.log(`on since  ${report.state.onAt}`);
    const scheduler = scheduleState();
    console.log(
      scheduler.scheduler === "none"
        ? "schedule  none on this platform"
        : `schedule  ${scheduler.scheduler} ${scheduler.present ? (scheduler.active === false ? "present, not running" : "present") : "missing"}`,
    );
    return;
  }

  if (command === "tick" || command === "sync") {
    const report = await tick({ config, now: now(), echo: true });
    if (flag("json")) console.log(JSON.stringify(report, null, 2));
    else console.log(`${report.action}: ${report.reason} (${report.before} → ${report.after})`);
    return process.exitCode = report.action === "error" ? 1 : 0;
  }

  if (command === "schedule") {
    let running = false;
    const once = async () => {
      if (running) return;
      running = true;
      try {
        await tick({ config, echo: true });
      } catch (error) {
        logLine(`a tick failed: ${String(error)}`, { echo: true });
      } finally {
        running = false;
      }
    };
    await once();
    setInterval(once, Math.max(5, config.tickSeconds) * 1000);
    return;
  }

  if (command === "install-schedule") {
    const result = ensureSchedule({ tickSeconds: config.tickSeconds });
    console.log(JSON.stringify(result, null, 2));
    return process.exitCode = result.installed ? 0 : 1;
  }

  if (command === "uninstall-schedule") {
    const result = removeSchedule();
    console.log(JSON.stringify(result, null, 2));
    return process.exitCode = result.removed ? 0 : 1;
  }

  if (command === "schedule-status") {
    console.log(JSON.stringify(scheduleState(), null, 2));
    return;
  }

  if (command === "config") {
    const current = { ...DEFAULT_CONFIG, ...config };
    if (flag("json")) {
      console.log(JSON.stringify(current, null, 2));
      return;
    }
    console.log(`state dir ${stateDir()}`);
    for (const [key, value] of Object.entries(current)) {
      console.log(`  ${key.padEnd(16)} ${Array.isArray(value) ? value.join(", ") : value}`);
    }
    parseWindows(config.windows);
    return;
  }

  console.error(`unknown command: ${command}`);
  console.error("use: status | tick | sync | schedule | config");
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(`deepseek-peak-guard: ${String(error?.message ?? error)}`);
  process.exitCode = 1;
});
