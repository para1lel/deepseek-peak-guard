// Everything the guard does to magpie goes through magpie's own command line:
// the switch it flips is the one the app's provider list flips, and no file of
// magpie's is written here.
//
// Reading the switch is different. `magpie providers` starts a whole magpie
// process, and with it a plugin host, just to print a table — far too much for
// a question that a read of providers.json answers. The file is only read.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const TIMEOUT_MS = 30_000;

/** magpieBin is the binary to run: the setting, the env, then magpie on PATH. */
export function magpieBin(configured = "") {
  return (
    String(configured ?? "").trim() ||
    process.env.DEEPSEEK_PEAK_GUARD_MAGPIE?.trim() ||
    process.env.MAGPIE_BIN?.trim() ||
    "magpie"
  );
}

/** localBin is where magpie installs itself when it is not on a unit's PATH. */
function localBin() {
  const exe = process.platform === "win32" ? "magpie.exe" : "magpie";
  const candidate = path.join(os.homedir(), ".local", "bin", exe);
  return fs.existsSync(candidate) ? candidate : "";
}

function failed(error) {
  return {
    code: typeof error?.code === "number" ? error.code : 1,
    stdout: error?.stdout ?? "",
    stderr: error?.stderr ?? String(error?.message ?? error),
  };
}

function missing(bin, fallback) {
  const tried = fallback && fallback !== bin ? `${bin} and ${fallback}` : bin;
  return new Error(
    `magpie was not found (tried ${tried}). Put it on PATH, set DEEPSEEK_PEAK_GUARD_MAGPIE, or set "magpie" in config.json.`,
  );
}

async function magpie(args, { configured = "", timeout = TIMEOUT_MS } = {}) {
  const bin = magpieBin(configured);
  const options = { timeout, windowsHide: true, maxBuffer: 8 << 20, env: process.env };

  try {
    const { stdout, stderr } = await run(bin, args, options);
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (error?.code === "ENOENT") {
      const fallback = localBin();
      if (fallback) {
        try {
          const { stdout, stderr } = await run(fallback, args, options);
          return { code: 0, stdout, stderr };
        } catch (inner) {
          if (inner?.code === "ENOENT") throw missing(bin, fallback);
          return failed(inner);
        }
      }
      throw missing(bin, fallback);
    }
    return failed(error);
  }
}

/** switchProvider is `magpie provider off|on <id>`; nothing else is run. */
export async function switchProvider(id, on, { configured = "" } = {}) {
  const out = await magpie(["provider", on ? "on" : "off", id], { configured });
  if (out.code !== 0) {
    throw new Error(`magpie provider ${on ? "on" : "off"} ${id} failed: ${(out.stderr || out.stdout).trim()}`);
  }
  return (out.stdout || out.stderr).trim();
}

/** providersFile is the store magpie keeps its providers in. */
export function providersFile() {
  const dir = process.env.MAGPIE_CONFIG_DIR?.trim();
  return dir ? path.join(dir, "providers.json") : path.join(os.homedir(), ".config", "magpie", "providers.json");
}

function readProviders(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(data?.providers) ? data.providers : null;
  } catch {
    return null;
  }
}

/**
 * providerState is what providers.json says about one provider: found, and the
 * `off` flag the switch is stored as. `file: null` means the store is missing
 * or not JSON, which is a different problem from an unknown provider id.
 */
export function providerState(id, file = providersFile()) {
  const providers = readProviders(file);
  if (!providers) return { id, found: false, off: null, file: null, reason: "providers.json could not be read" };
  const provider = providers.find((item) => item && item.id === id);
  if (!provider) return { id, found: false, off: null, file, reason: `providers.json has no provider "${id}"` };
  return { id, found: true, off: provider.off === true, file };
}

/** providerOffFromStore is providerState reduced to the flag. */
export function providerOffFromStore(id, file = providersFile()) {
  const state = providerState(id, file);
  return state.found ? state.off : null;
}
