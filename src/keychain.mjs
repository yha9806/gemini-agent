import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SERVICE = "GEMINI_API_KEY";

export function currentAccount(env = process.env) {
  return env.USER || env.LOGNAME || "";
}

export function getApiKeyFromEnv(env = process.env) {
  const value = env.GEMINI_API_KEY || env.GOOGLE_API_KEY;
  if (!value || !value.trim()) return null;
  return value.trim();
}

export function buildFindArgs(account = currentAccount()) {
  return ["find-generic-password", "-a", account, "-s", SERVICE, "-w"];
}

export function buildSaveArgs(account, key) {
  return ["add-generic-password", "-U", "-a", account, "-s", SERVICE, "-w", key];
}

export function buildDeleteArgs(account = currentAccount()) {
  return ["delete-generic-password", "-a", account, "-s", SERVICE];
}

export function redactSecret(message, secret) {
  if (!secret) return message;
  return String(message).split(secret).join("[REDACTED]");
}

export async function getApiKeyFromKeychain({
  account = currentAccount(),
  platform = process.platform,
  runner = execFileAsync,
} = {}) {
  if (platform !== "darwin") return null;
  try {
    const { stdout } = await runner("security", buildFindArgs(account), { encoding: "utf8" });
    const key = stdout.trim();
    return key || null;
  } catch {
    return null;
  }
}

export async function resolveApiKey(options = {}) {
  const envKey = getApiKeyFromEnv(options.env || process.env);
  if (envKey) return { ok: true, source: "env", key: envKey };
  const key = await getApiKeyFromKeychain(options);
  if (key) return { ok: true, source: "keychain", key };
  return { ok: false, source: null, key: null };
}

export async function saveApiKeyToKeychain(
  key,
  { account = currentAccount(), platform = process.platform, runner = execFileAsync } = {},
) {
  if (!key || !key.trim()) throw new Error("Gemini API key is empty.");
  if (platform !== "darwin") throw new Error("Keychain storage is only available on macOS.");
  const trimmedKey = key.trim();
  try {
    await runner("security", buildSaveArgs(account, trimmedKey), { encoding: "utf8" });
  } catch (error) {
    throw new Error(redactSecret(error.message, trimmedKey));
  }
}

export async function deleteApiKeyFromKeychain({
  account = currentAccount(),
  platform = process.platform,
  runner = execFileAsync,
} = {}) {
  if (platform !== "darwin") throw new Error("Keychain deletion is only available on macOS.");
  await runner("security", buildDeleteArgs(account), { encoding: "utf8" });
}
