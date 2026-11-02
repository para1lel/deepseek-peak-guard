#!/usr/bin/env node
// The guard from a shell, which is how the OS scheduler runs it, and how a
// person checks what it would do.
//
//   deepseek-peak-guard status [--json] [--now 2026-11-03T09:05:00+08:00]
//   deepseek-peak-guard tick   [--now …] [--dry-run] [--json]
//   deepseek-peak-guard install-schedule [--no-converge] [--json]
//   deepseek-peak-guard uninstall-schedule
//   deepseek-peak-guard schedule-status [--json]
//   deepseek-peak-guard config [--json]

import { DEFAULT_CONFIG, loadConfig, stateDir } from "../lib/config.mjs";
import { statusReport, tick } from "../lib/guard.mjs";
import { describeSchedule } from "../lib/calendar.mjs";
import { install, status as scheduleStatus, uninstall } from "../lib/schedule.mjs";
import { tryLock } from "../lib/lock.mjs";

const argv = process.argv.slice(2);
const command = argv[0] ?? "status";

function flag(name) {
  return argv.includes(`--${name}`);
}

function valueOf(name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function at() {
  const given = valueOf("now");
  if (!given) return new Date();
  const parsed = new Date(given);
  if (Number.isNaN(parsed.getTime())) throw new Error(`--now is not a date: ${given}`);
  return parsed;
}

function settings() {
  return loadConfig(flag("dry-run") ? { dryRun: true } : {});
}

function printClock(clock, provider, wanted) {
  const next = clock.next;
  console.log(
    [
      `provider  ${provider}`,
      `now       ${clock.local} (${clock.timezone}, weekday ${clock.weekday}${clock.holiday ? ", holiday" : ""})`,
      `peak      ${clock.peak ? "yes" : "no"} — its models ${wanted}`,
      `windows   ${clock.windows.join("  ")}`,
      next
        ? `next      ${new Date(next.at).toISOString()} — peak ${next.peak ? "starts" : "ends"} in ${next.inMinutes} min`
        : "next      nothing within 8 days",
    ].join("\n"),
  );
}

function printSchedule(schedule) {
  const where = schedule.scheduler === "schtasks" ? `task ${schedule.task}` : `timer ${schedule.timer}`;
  if (!schedule.present) {
    console.log(`schedule  missing — run install-schedule`);
    return;
  }
  const runs = schedule.expected?.length ?? 0;
  console.log(`schedule  ${where}: ${runs} run${runs === 1 ? "" : "s"} per weekday`);
  if (schedule.summary) console.log(`runs at   ${schedule.summary}`);
  if (schedule.next) console.log(`next      ${schedule.next}`);
  console.log(`matches   ${schedule.match ? "yes" : "no — the config and the installed schedule differ, run install-schedule"}`);
  if (schedule.error) console.log(`error     ${schedule.error}`);
}

function printReport(report) {
  console.log(
    [
      `at        ${report.local} (${report.at})`,
      `peak      ${report.peak ? "yes" : "no"}${report.dryRun ? " (dry run)" : ""}`,
      `provider  ${report.provider}: ${report.before} → ${report.after ?? report.before}${
        report.verified === false ? " (not confirmed by providers.json)" : ""
      }`,
      `action    ${report.action}${report.reason ? ` — ${report.reason}` : ""}`,
    ].join("\n"),
  );
}

async function withLock(work) {
  const lock = tryLock();
  if (lock.error) {
    console.error(`deepseek-peak-guard: cannot take the lock: ${lock.error}`);
    process.exitCode = 1;
    return;
  }
  if (!lock.held) {
    console.log("another tick is running; this one does nothing");
    return;
  }
  try {
    await work();
  } finally {
    lock.release();
  }
}

async function main() {
  const config = settings();

  if (command === "status") {
    const report = statusReport({ config, now: at() });
    if (flag("json")) {
      console.log(JSON.stringify({ ...report, schedule: scheduleStatus({ config }), stateDir: stateDir() }, null, 2));
      return;
    }
    printClock(report.clock, report.provider, report.wanted);
    const current =
      report.current.found === false
        ? `unknown — ${report.current.note}`
        : report.current.off
          ? "off"
          : "on";
    console.log(`switch    ${current}  (${report.current.file ?? "no providers.json"})`);
    if (report.state.lastTick) console.log(`last tick ${report.state.lastTick} (${report.state.lastAction})`);
    printSchedule(scheduleStatus({ config }));
    return;
  }

  if (command === "tick" || command === "sync") {
    await withLock(async () => {
      const report = await tick({ config, now: at() });
      if (flag("json")) console.log(JSON.stringify(report, null, 2));
      else printReport(report);
      process.exitCode = report.action === "error" ? 1 : 0;
    });
    return;
  }

  if (command === "install-schedule") {
    const installed = install({ config });
    const report = flag("no-converge") ? null : await tick({ config });
    const schedule = scheduleStatus({ config });
    if (flag("json")) {
      console.log(JSON.stringify({ installed, tick: report, schedule }, null, 2));
    } else {
      console.log(
        installed.error
          ? `install   failed — ${installed.error}`
          : `install   ${installed.scheduler} ${installed.scheduler === "systemd" ? installed.timer : installed.task}: ${
              schedule.match ? "ok" : "written, but it does not read back as expected"
            }`,
      );
      console.log(`runs at   ${installed.summary}`);
      if (schedule.next) console.log(`next      ${schedule.next}`);
      if (report) printReport(report);
    }
    process.exitCode = installed.error ? 1 : 0;
    return;
  }

  if (command === "uninstall-schedule") {
    const result = uninstall();
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.error ? 1 : 0;
    return;
  }

  if (command === "schedule-status") {
    const schedule = scheduleStatus({ config });
    if (flag("json")) {
      console.log(JSON.stringify(schedule, null, 2));
      return;
    }
    printSchedule(schedule);
    return;
  }

  if (command === "config") {
    const current = { ...DEFAULT_CONFIG, ...config };
    if (flag("json")) {
      console.log(JSON.stringify(current, null, 2));
      return;
    }
    console.log(`state dir ${stateDir()}`);
    console.log(`runs at   ${describeSchedule(current)}`);
    for (const [key, value] of Object.entries(current)) {
      console.log(`  ${key.padEnd(16)} ${Array.isArray(value) ? value.join(", ") : value}`);
    }
    return;
  }

  console.error(`unknown command: ${command}`);
  console.error("use: status | tick | install-schedule | uninstall-schedule | schedule-status | config");
  process.exitCode = 2;
}

main().catch((error) => {
  console.error(`deepseek-peak-guard: ${String(error?.message ?? error)}`);
  process.exitCode = 1;
});
