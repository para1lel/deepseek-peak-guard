// magpie starts a plugin host more than once (a host per plugin change, and
// more than one process serves tools), so more than one copy of this guard can
// be loaded at the same time. Only the host holding the lease looks at the
// clock; the others tick quietly, and one of them takes the lease over as soon
// as the holder stops writing its heartbeat.

import fs from "node:fs";
import path from "node:path";
import { ensureDir, stateDir } from "./config.mjs";

function leasePath() {
  return path.join(ensureDir(stateDir()), "owner.json");
}

function alive(pid) {
  if (!pid || pid === process.pid) return pid === process.pid;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else
    return error?.code === "EPERM";
  }
}

/**
 * takeLease claims the tick for this process when no live holder has written
 * its heartbeat lately. It returns true when this process may run the tick.
 */
export function takeLease(tickSeconds) {
  const file = leasePath();
  const fresh = Math.max(5, Number(tickSeconds) || 30) * 2.5 * 1000;
  let holder = null;
  try {
    holder = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    holder = null;
  }
  const now = Date.now();
  const heldByOther =
    holder &&
    holder.pid !== process.pid &&
    alive(holder.pid) &&
    now - Date.parse(holder.at ?? 0) < fresh;
  if (heldByOther) return false;
  try {
    fs.writeFileSync(file, `${JSON.stringify({ pid: process.pid, host: process.env.HOSTNAME ?? "", at: new Date(now).toISOString() }, null, 2)}\n`);
  } catch {
    return true; // a lease that cannot be written must not stop the guard
  }
  return true;
}

/** dropLease gives the lease up, so another host can tick at once. */
export function dropLease() {
  try {
    const file = leasePath();
    const holder = JSON.parse(fs.readFileSync(file, "utf8"));
    if (holder?.pid === process.pid) fs.rmSync(file, { force: true });
  } catch {
    // nothing to drop
  }
}
