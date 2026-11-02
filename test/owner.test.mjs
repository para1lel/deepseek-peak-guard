// magpie loads a plugin in more than one host, so the lease is what keeps one
// clock in charge. These tests use a real child process as "another host".

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "peak-guard-lease-"));
process.env.DEEPSEEK_PEAK_GUARD_HOME = dir;

const { takeLease, dropLease } = await import("../lib/owner.mjs");

const lease = path.join(dir, "owner.json");

function writeLease(pid, at) {
  fs.writeFileSync(lease, JSON.stringify({ pid, at }));
}

test("a fresh lease held by a live process blocks another host", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)"], { stdio: "ignore" });
  try {
    writeLease(child.pid, new Date().toISOString());
    assert.equal(takeLease(30), false);
  } finally {
    child.kill();
  }
});

test("a lease whose process is gone is taken over", () => {
  writeLease(2 ** 22 + 1, new Date().toISOString()); // a pid that is not running
  assert.equal(takeLease(30), true);
  assert.equal(JSON.parse(fs.readFileSync(lease, "utf8")).pid, process.pid);
});

test("a stale heartbeat is taken over even while its process lives", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 8000)"], { stdio: "ignore" });
  try {
    writeLease(child.pid, new Date(Date.now() - 10 * 60_000).toISOString());
    assert.equal(takeLease(30), true);
  } finally {
    child.kill();
  }
});

test("the holder keeps the lease and can give it back", () => {
  assert.equal(takeLease(30), true);
  assert.equal(takeLease(30), true, "same process may refresh its own lease");
  dropLease();
  assert.equal(fs.existsSync(lease), false);
});

test("no lease file at all is free", () => {
  fs.rmSync(lease, { force: true });
  assert.equal(takeLease(30), true);
});
