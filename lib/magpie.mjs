// Everything the guard does to magpie goes through magpie's own command line:
// the provider switch it flips is the same one the app's provider list and
// `magpie provider on|off` flip, and no file of magpie's is written here.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const TIMEOUT_MS = 60_000;

let cachedBin = null;

/** magpieBin is the binary to run: the setting, the env, PATH, then ~/.local/bin. */
export function magpieBin(configured = "") {
  const explicit =
    configured?.trim() ||
    process.env.DEEPSEEK_PEAK_GUARD_MAGPIE?.trim() ||
    process.env.MAGPIE_BIN?.trim() ||
    "";
  if (explicit) return explicit;
  return cachedBin ?? "magpie";
}

function localBin() {
  const exe = process.platform === "win32" ? "magpie.exe" : "magpie";
  const candidate = path.join(os.homedir(), ".local", "bin", exe);
  return fs.existsSync(candidate) ? candidate : "";
}

async function magpie(args, { configured = "", timeout = TIMEOUT_MS } = {}) {
  const bin = magpieBin(configured);
  const attempt = async (name) =>
    run(name, args, { timeout, windowsHide: true, maxBuffer: 8 << 20, env: process.env });

  try {
    const { stdout, stderr } = await attempt(bin);
    if (!cachedBin) cachedBin = bin;
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (error?.code === "ENOENT") {
      // a systemd --user unit starts magpie with a bare PATH: fall back to the
      // place magpie installs itself.
      const fallback = localBin();
      if (fallback && fallback !== bin) {
        try {
          const { stdout, stderr } = await attempt(fallback);
          cachedBin = fallback;
          return { code: 0, stdout, stderr };
        } catch (inner) {
          if (inner?.code === "ENOENT") throw new Error(missingMagpie(bin, fallback));
          return failed(inner);
        }
      }
      throw new Error(missingMagpie(bin, fallback));
    }
    return failed(error);
  }
}

function missingMagpie(bin, fallback) {
  const tried = fallback ? `${bin} and ${fallback}` : bin;
  return `magpie was not found (tried ${tried}). Put it on PATH, set DEEPSEEK_PEAK_GUARD_MAGPIE, or set "magpie" in config.json.`;
}

function failed(error) {
  return {
    code: typeof error?.code === "number" ? error.code : 1,
    stdout: error?.stdout ?? "",
    stderr: error?.stderr ?? String(error?.message ?? error),
  };
}

/** switchProvider is `magpie provider off|on <id>`. */
export async function switchProvider(id, on, { configured = "" } = {}) {
  const out = await magpie(["provider", on ? "on" : "off", id], { configured });
  if (out.code !== 0) {
    throw new Error(`magpie provider ${on ? "on" : "off"} ${id} failed: ${(out.stderr || out.stdout).trim()}`);
  }
  return (out.stdout || out.stderr).trim();
}

/**
 * providerOff reads whether the provider is switched off. `magpie providers`
 * prints the row with "switched off" in place of its key; providers.json keeps
 * the same fact as an `off` flag, which is used when the row cannot be read.
 */
export async function providerOff(id, { configured = "" } = {}) {
  const out = await magpie(["providers"], { configured });
  if (out.code === 0) {
    const rows = out.stdout.split(/\r?\n/);
    const token = new RegExp(`(^|\\s)${escapeRegExp(id)}(\\s|$)`);
    const row = rows.find((line) => token.test(line) && !/^\s*$/.test(line));
    if (row) return /switched off/i.test(row);
  }
  return providerOffFromStore(id);
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** providerOffFromStore reads magpie's providers.json directly, for reading only. */
export function providerOffFromStore(id, file = providersFile()) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const provider = (data.providers ?? []).find((item) => item && item.id === id);
    if (!provider) return null;
    return provider.off === true;
  } catch {
    return null;
  }
}

export function providersFile() {
  const dir = process.env.MAGPIE_CONFIG_DIR?.trim();
  return dir ? path.join(dir, "providers.json") : path.join(os.homedir(), ".config", "magpie", "providers.json");
}

/** healthcheck is `magpie healthcheck`: the gateway answers. */
export async function healthcheck({ configured = "" } = {}) {
  const out = await magpie(["healthcheck"], { configured, timeout: 20_000 });
  return out.code === 0;
}
