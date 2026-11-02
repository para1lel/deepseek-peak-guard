// One tick at a time. Overlapping runs cannot corrupt anything on their own,
// but two ticks can read the switch, disagree, and flip it back and forth, so
// the second run is told to come back later. A lock left behind by a killed
// run is ignored once it is old enough that no tick could still be inside it.

import fs from "node:fs";
import path from "node:path";
import { ensureDir, stateDir } from "./config.mjs";

const STALE_MS = 20 * 60_000;

/**
 * tryLock takes <state>/tick.lock. It returns `release` always, plus either
 * `busy: true` or `error`. The caller runs its work either way only when the
 * lock was actually taken.
 */
export function tryLock(name = "tick", { staleMs = STALE_MS } = {}) {
  const dir = ensureDir(stateDir());
  const file = path.join(dir, `${name}.lock`);
  const release = () => {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // a lock that cannot be removed is stale in twenty minutes anyway
    }
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(file, "wx");
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
      return { file, held: true, release };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        return { file, held: false, error: String(error?.message ?? error), release: () => {} };
      }
      let stale = true;
      try {
        stale = Date.now() - fs.statSync(file).mtimeMs > staleMs;
      } catch {
        stale = true;
      }
      if (!stale) return { file, held: false, busy: true, release: () => {} };
      fs.rmSync(file, { force: true });
    }
  }
  return { file, held: false, busy: true, release: () => {} };
}
