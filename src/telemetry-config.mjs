import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeTelemetryConfig } from "./telemetry-schemas.mjs";

const TELEMETRY_ROOT = ".gemini-agent/telemetry";
const CONFIG_FILE = "config.json";

function telemetryDir(cwd) {
  return join(cwd, TELEMETRY_ROOT);
}

function telemetryConfigPath(cwd) {
  return join(telemetryDir(cwd), CONFIG_FILE);
}

async function readTelemetryConfigJson(cwd) {
  const path = telemetryConfigPath(cwd);
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }

  try {
    return {
      path,
      value: JSON.parse(raw),
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Telemetry config is not valid JSON: ${path}`);
    }
    throw error;
  }
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase();
  return normalized === "127.0.0.1"
    || normalized === "localhost"
    || normalized === "::1"
    || normalized === "[::1]";
}

function assertTokenEnvName(tokenEnv) {
  if (typeof tokenEnv !== "string" || tokenEnv.length === 0) {
    throw new Error("Telemetry token env name must be a non-empty string.");
  }
  if (tokenEnv === "GEMINI_API_KEY") {
    throw new Error("Telemetry token env must not be GEMINI_API_KEY.");
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) {
    throw new Error("Telemetry token env name must be a valid environment variable name.");
  }
}

export function validateTelemetryEndpoint(endpoint) {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Telemetry endpoint must use HTTP or HTTPS.");
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new Error("Non-loopback telemetry endpoints must use HTTPS.");
  }
  return url;
}

export function rawTelemetryWarning() {
  return [
    "Raw prompt/response telemetry may capture credentials, personal information, source code, customer data, and other sensitive content.",
    "Masking is best-effort for obvious patterns only and is not complete removal of sensitive content.",
  ].join(" ");
}

export function assertRawConfirmation(confirmed) {
  if (!confirmed) {
    throw new Error("--confirm-raw-content is required before enabling raw prompt/response telemetry.");
  }
}

export function resolveTelemetryToken({ tokenEnv, env = process.env }) {
  assertTokenEnvName(tokenEnv);
  if (!Object.hasOwn(env, tokenEnv)) {
    throw new Error(`Telemetry token env ${tokenEnv} is not set.`);
  }
  const value = env[tokenEnv];
  if (typeof value !== "string") {
    throw new Error(`Telemetry token env ${tokenEnv} must be a string.`);
  }
  if (!value.trim()) {
    throw new Error(`Telemetry token env ${tokenEnv} is empty.`);
  }
  return value;
}

export async function loadTelemetryConfig({ cwd = process.cwd() } = {}) {
  const rawConfig = await readTelemetryConfigJson(cwd);
  if (!rawConfig) return null;

  const config = normalizeTelemetryConfig(rawConfig.value);
  validateTelemetryEndpoint(config.endpoint);
  return config;
}

export async function saveTelemetryConfig({
  cwd = process.cwd(),
  endpoint,
  tokenEnv,
  schedule = "daily@09:00",
  now = new Date(),
} = {}) {
  const url = validateTelemetryEndpoint(endpoint);
  assertTokenEnvName(tokenEnv);
  const dir = telemetryDir(cwd);
  const path = telemetryConfigPath(cwd);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);

  const previousRaw = await readTelemetryConfigJson(cwd);
  const previous = previousRaw ? normalizeTelemetryConfig(previousRaw.value) : null;
  const configInput = {
    enabled: true,
    level: "raw",
    endpoint: url.href,
    token_env: tokenEnv,
    schedule,
    created_at: previous?.created_at ?? now.toISOString(),
    updated_at: now.toISOString(),
  };
  if (previousRaw && Object.hasOwn(previousRaw.value, "max_event_bytes")) {
    configInput.max_event_bytes = previous.max_event_bytes;
  }
  if (previousRaw && Object.hasOwn(previousRaw.value, "max_queue_bytes")) {
    configInput.max_queue_bytes = previous.max_queue_bytes;
  }

  const config = normalizeTelemetryConfig(configInput);
  const configToWrite = { ...config };
  if (previousRaw && !Object.hasOwn(previousRaw.value, "max_event_bytes")) {
    delete configToWrite.max_event_bytes;
  }
  if (previousRaw && !Object.hasOwn(previousRaw.value, "max_queue_bytes")) {
    delete configToWrite.max_queue_bytes;
  }
  await writeFile(path, `${JSON.stringify(configToWrite, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
  return config;
}
