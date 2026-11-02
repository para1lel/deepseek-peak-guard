// magpie's plugin host is not a place a timer can live: the host is started to
// load a plugin and goes away again, so a setInterval inside it stops with the
// process. The guard therefore puts its clock on the operating system's own
// scheduler — a systemd --user timer on Linux, a scheduled task on Windows —
// and asks for it again every time the plugin loads (the write is skipped when
// the unit already says the same thing).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, logLine, stateDir } from "./config.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const UNIT = "deepseek-peak-guard";
export const TASK = "DeepSeekPeakGuard";

export function cliPath() {
  return path.join(HERE, "..", "bin", "deepseek-peak-guard.mjs");
}

function nodePath() {
  return process.execPath;
}

function run(command, args, { allowFail = false } = {}) {
  try {
    const stdout = execFileSync(command, args, { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, stdout: stdout.trim(), stderr: "" };
  } catch (error) {
    const stderr = String(error?.stderr ?? error?.message ?? error).trim();
    if (!allowFail) throw new Error(`${command} ${args.join(" ")} failed: ${stderr}`);
    return { ok: false, stdout: String(error?.stdout ?? "").trim(), stderr };
  }
}

function unitDir() {
  const base = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  return path.join(base, "systemd", "user");
}

function unitPathEnv() {
  const parts = [path.dirname(nodePath()), "/usr/local/bin", "/usr/bin", "/bin"];
  const magpie = process.env.DEEPSEEK_PEAK_GUARD_MAGPIE?.trim();
  if (magpie) parts.unshift(path.dirname(magpie));
  else parts.splice(1, 0, path.join(os.homedir(), ".local", "bin"));
  return [...new Set(parts)].join(":");
}

export function serviceContent() {
  return [
    "[Unit]",
    "Description=DeepSeek peak guard for magpie (deepseek-peak-guard)",
    "",
    "[Service]",
    "Type=oneshot",
    `Environment="PATH=${unitPathEnv()}"`,
    `ExecStart=${nodePath()} ${cliPath()} tick`,
    "",
  ].join("\n");
}

export function timerContent(tickSeconds = 60) {
  const every = Math.max(1, Math.round(Number(tickSeconds) / 60)) || 1;
  return [
    "[Unit]",
    "Description=DeepSeek peak guard for magpie, every minute",
    "",
    "[Timer]",
    every === 1 ? "OnCalendar=*:*:00" : `OnCalendar=*:0/${every}`,
    "AccuracySec=1s",
    "Persistent=true",
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
}

function writeIfChanged(file, content) {
  try {
    if (fs.readFileSync(file, "utf8") === content) return false;
  } catch {
    // no file yet
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return true;
}

/** ensureSchedule puts the clock on the OS scheduler, if it is not already there. */
export function ensureSchedule({ tickSeconds = 60 } = {}) {
  if (process.platform === "win32") return ensureWindowsTask(tickSeconds);
  if (process.platform === "linux") return ensureSystemdTimer(tickSeconds);
  return { installed: false, reason: `no scheduler for ${process.platform}` };
}

function ensureSystemdTimer(tickSeconds) {
  const dir = unitDir();
  const service = path.join(dir, `${UNIT}.service`);
  const timer = path.join(dir, `${UNIT}.timer`);
  const changed = [
    writeIfChanged(service, serviceContent()),
    writeIfChanged(timer, timerContent(tickSeconds)),
  ].some(Boolean);
  if (changed) run("systemctl", ["--user", "daemon-reload"]);
  const enabled = run("systemctl", ["--user", "enable", "--now", `${UNIT}.timer`], { allowFail: true });
  if (!enabled.ok) {
    return { installed: false, reason: `systemd --user could not enable the timer: ${enabled.stderr}`, service, timer };
  }
  return { installed: true, changed, service, timer, scheduler: "systemd" };
}

function ensureWindowsTask(tickSeconds) {
  const every = Math.max(1, Math.round(Number(tickSeconds) / 60)) || 1;
  const command = `"${nodePath()}" "${cliPath()}" tick`;
  const args = [
    "/Create",
    "/SC",
    "MINUTE",
    "/MO",
    String(every),
    "/TN",
    TASK,
    "/TR",
    command,
    "/F",
  ];
  const created = run("schtasks", args, { allowFail: true });
  if (!created.ok) {
    return { installed: false, reason: `schtasks could not create the task: ${created.stderr}`, task: TASK };
  }
  return { installed: true, changed: /SUCCESS|成功/i.test(created.stdout), task: TASK, scheduler: "schtasks", every };
}

/** removeSchedule takes the clock off the OS scheduler. */
export function removeSchedule() {
  if (process.platform === "win32") {
    const out = run("schtasks", ["/Delete", "/TN", TASK, "/F"], { allowFail: true });
    return { removed: out.ok, reason: out.ok ? "" : out.stderr };
  }
  if (process.platform === "linux") {
    const dir = unitDir();
    run("systemctl", ["--user", "disable", "--now", `${UNIT}.timer`], { allowFail: true });
    for (const file of [`${UNIT}.timer`, `${UNIT}.service`]) {
      fs.rmSync(path.join(dir, file), { force: true });
    }
    run("systemctl", ["--user", "daemon-reload"], { allowFail: true });
    return { removed: true };
  }
  return { removed: false, reason: `no scheduler for ${process.platform}` };
}

/** scheduleState says what the OS scheduler currently has, for `status`. */
export function scheduleState() {
  if (process.platform === "win32") {
    const out = run("schtasks", ["/Query", "/TN", TASK], { allowFail: true });
    return { scheduler: "schtasks", task: TASK, present: out.ok };
  }
  if (process.platform === "linux") {
    const timer = path.join(unitDir(), `${UNIT}.timer`);
    const active = run("systemctl", ["--user", "is-active", `${UNIT}.timer`], { allowFail: true });
    return { scheduler: "systemd", timer, present: fs.existsSync(timer), active: active.stdout === "active" };
  }
  return { scheduler: "none" };
}

/** ensureScheduleQuietly is what the plugin calls: a failure is logged, never thrown. */
export function ensureScheduleQuietly(options = {}) {
  try {
    const result = ensureSchedule(options);
    logLine(
      result.installed
        ? `the clock is on ${result.scheduler}${result.changed ? " (unit written)" : " (already there)"}`
        : `the clock could not be put on a scheduler: ${result.reason}`,
    );
    return result;
  } catch (error) {
    logLine(`the clock could not be put on a scheduler: ${String(error?.message ?? error)}`);
    return { installed: false, reason: String(error?.message ?? error) };
  }
}

export function stateFile() {
  return path.join(ensureDir(stateDir()), "schedule.json");
}
