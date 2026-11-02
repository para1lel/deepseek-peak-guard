// The installed schedule is text: a systemd unit pair, or a task description
// plus a VBScript shim. These tests read that text, so a change in quoting or
// in the shim's indirection is caught here rather than at 09:00.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

process.env.DEEPSEEK_PEAK_GUARD_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dspg-schedule-"));

const {
  CLI_FILE,
  POSIX_SHIM,
  WINDOWS_SHIM,
  cliPath,
  ensureLauncher,
  interpreter,
  posixShim,
  serviceContent,
  timerContent,
  windowsShim,
} = await import("../lib/schedule.mjs");

const config = {
  timezone: "Asia/Shanghai",
  windows: ["09:00-12:00", "14:00-18:00"],
  weekdays: [1, 2, 3, 4, 5],
  holidays: [],
};

test("the timer holds all four weekday runs and persists a missed one", () => {
  const text = timerContent(config);
  assert.match(text, /\[Timer\]/);
  assert.match(text, /OnCalendar=Mon\.\.Fri 09:00:00/);
  assert.match(text, /OnCalendar=Mon\.\.Fri 12:00:00/);
  assert.match(text, /OnCalendar=Mon\.\.Fri 14:00:00/);
  assert.match(text, /OnCalendar=Mon\.\.Fri 18:00:00/);
  assert.match(text, /Persistent=true/);
  assert.match(text, /WantedBy=timers\.target/);
  assert.equal(text.match(/OnCalendar=/g).length, 4, "exactly four runs, not a wildcard");
});

test("the unit runs the shim, not a path into the plugin folder", () => {
  const text = serviceContent("/home/someone/.config/magpie/deepseek-peak-guard/tick.sh");
  assert.match(text, /Type=oneshot/);
  assert.match(text, /ExecStart=\/bin\/sh "\/home\/someone\/\.config\/magpie\/deepseek-peak-guard\/tick\.sh" tick/);
  assert.ok(!text.includes("bin/deepseek-peak-guard.mjs"), "the unit must not name the plugin's own script");
  assert.match(text, /Environment="PATH=/);
});

test("the shim reads the interpreter and script from cli.txt", () => {
  const text = posixShim();
  assert.match(text, /^#!\/bin\/sh/);
  assert.match(text, /cli\.txt/);
  assert.match(text, /exec "\$interp" "\$cli" "\$@"/);
});

test("the Windows shim starts the interpreter with window style 0", () => {
  const text = windowsShim();
  assert.match(text, /OpenTextFile\(home & "\\cli\.txt"/);
  assert.match(text, /shell\.Run cmd, 0, False/);
  assert.match(text, /WScript\.Arguments/);
  assert.match(text, /Option Explicit/);
});

test("ensureLauncher writes cli.txt and the shim, then leaves them alone", () => {
  const cli = path.join(process.env.DEEPSEEK_PEAK_GUARD_HOME, "fake-cli.mjs");
  fs.writeFileSync(cli, "// stand-in for the plugin's CLI\n");

  const first = ensureLauncher({ interp: process.execPath, cli });
  assert.ok(first.wrote.includes(first.cliFile));
  assert.equal(fs.readFileSync(first.cliFile, "utf8"), `${process.execPath}\n${cli}\n`);

  const shim = path.join(path.dirname(first.cliFile), process.platform === "win32" ? WINDOWS_SHIM : POSIX_SHIM);
  assert.ok(fs.existsSync(shim));

  const second = ensureLauncher({ interp: process.execPath, cli });
  assert.deepEqual(second.wrote, [], "a second visit rewrites nothing");
});

test("a load repairs a launcher whose script has moved", () => {
  const cli = path.join(process.env.DEEPSEEK_PEAK_GUARD_HOME, "moved-cli.mjs");
  fs.writeFileSync(cli, "// the plugin came back somewhere else\n");
  const file = path.join(process.env.DEEPSEEK_PEAK_GUARD_HOME, CLI_FILE);
  fs.writeFileSync(file, `${process.execPath}\n/nowhere/old-cli.mjs\n`);

  const repaired = ensureLauncher({ interp: process.execPath, cli });
  assert.ok(repaired.wrote.includes(repaired.cliFile));
  assert.equal(fs.readFileSync(file, "utf8"), `${process.execPath}\n${cli}\n`);
});

test("install forces its own interpreter over whatever is recorded", () => {
  const cli = path.join(process.env.DEEPSEEK_PEAK_GUARD_HOME, "forced-cli.mjs");
  fs.writeFileSync(cli, "// forced\n");
  const file = path.join(process.env.DEEPSEEK_PEAK_GUARD_HOME, CLI_FILE);
  fs.writeFileSync(file, `${process.execPath}\n${cli}\n`);

  const forced = ensureLauncher({ interp: "/opt/other-node", cli, force: true });
  assert.ok(forced.wrote.includes(forced.cliFile));
  assert.equal(fs.readFileSync(file, "utf8"), "/opt/other-node\n" + cli + "\n");
});

test("the interpreter is a file that exists", () => {
  assert.ok(fs.statSync(interpreter()).isFile());
});

test("the CLI path is this plugin's own command", () => {
  assert.match(cliPath(), /deepseek-peak-guard[\\/]bin[\\/]deepseek-peak-guard\.mjs$/);
});
