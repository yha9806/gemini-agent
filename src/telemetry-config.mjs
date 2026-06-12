import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  hasEmailLikeIdentifier,
  hasUnsafeTelemetryDimensionContent,
  TELEMETRY_USER_LABEL_SENSITIVE_MESSAGE,
} from "./telemetry-dimension-safety.mjs";
import {
  DEFAULT_TELEMETRY_DEPLOYMENT_ID,
  normalizeTelemetryConfig,
} from "./telemetry-schemas.mjs";

const TELEMETRY_ROOT = ".gemini-agent/telemetry";
const CONFIG_FILE = "config.json";

function telemetryDir(cwd) {
  return join(cwd, TELEMETRY_ROOT);
}

function telemetryConfigPath(cwd) {
  return join(telemetryDir(cwd), CONFIG_FILE);
}

function resolveHome(home) {
  const resolved = home ?? process.env.HOME ?? homedir();
  if (typeof resolved !== "string" || !resolved.trim()) {
    throw new Error("Telemetry global scope requires a home directory.");
  }
  return resolved;
}

function storageCwdForScope({ cwd, home, scope }) {
  if (scope === "local") return cwd;
  if (scope === "global") return resolveHome(home);
  throw new Error(`Unsupported telemetry scope: ${scope}`);
}

function normalizeTelemetryScope(scope = "local") {
  if (scope === "local" || scope === "global" || scope === "auto") return scope;
  throw new Error(`Unsupported telemetry scope: ${scope}`);
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

function validateTelemetrySchedule(schedule) {
  if (schedule === "hourly" || /^daily@([01]\d|2[0-3]):([0-5]\d)$/.test(schedule)) {
    return schedule;
  }
  throw new Error(`Unsupported telemetry schedule: ${schedule}`);
}

function assertTelemetryDeploymentId(deploymentId) {
  if (typeof deploymentId !== "string" || deploymentId.length === 0) {
    throw new Error("Telemetry deployment id must be a non-empty string.");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(deploymentId)) {
    throw new Error("Telemetry deployment id must contain only letters, numbers, dot, underscore, or dash.");
  }
}

function makeInstallId() {
  return `install_${randomUUID()}`;
}

function normalizeTelemetryUserLabel(userLabel) {
  if (userLabel === undefined) return undefined;
  if (userLabel === null) return null;
  const text = `${userLabel}`.trim();
  if (!text) return null;
  if (text.length > 80) {
    throw new Error("Telemetry user label must be at most 80 characters.");
  }
  if (hasEmailLikeIdentifier(text)) {
    throw new Error("Telemetry user label must not contain email addresses.");
  }
  if (hasUnsafeTelemetryDimensionContent(text, { includeEmail: false })) {
    throw new Error(TELEMETRY_USER_LABEL_SENSITIVE_MESSAGE);
  }
  if (!/^[A-Za-z0-9._ -]+$/.test(text)) {
    throw new Error("Telemetry user label must contain only letters, numbers, space, dot, underscore, or dash.");
  }
  return text;
}

function shouldClearPersistedUserLabel(userLabel) {
  if (userLabel === undefined || userLabel === null) return false;
  if (typeof userLabel !== "string") return true;
  const text = userLabel.trim();
  if (!text || text.length > 80) return true;
  if (hasEmailLikeIdentifier(text)) return true;
  if (hasUnsafeTelemetryDimensionContent(text, { includeEmail: false })) return true;
  return !/^[A-Za-z0-9._ -]+$/.test(text);
}

function configValueWithSafePersistedUserLabel(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  if (!shouldClearPersistedUserLabel(value.user_label)) return value;
  return {
    ...value,
    user_label: null,
  };
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

export async function loadTelemetryConfig({
  cwd = process.cwd(),
  home,
  scope = "local",
} = {}) {
  return (await loadTelemetryConfigContext({ cwd, home, scope })).config;
}

function normalizedConfigFromRaw(rawConfig) {
  if (!rawConfig) return null;
  const config = normalizeTelemetryConfig(configValueWithSafePersistedUserLabel(rawConfig.value));
  validateTelemetryEndpoint(config.endpoint);
  validateTelemetrySchedule(config.schedule);
  return config;
}

export async function loadTelemetryConfigContext({
  cwd = process.cwd(),
  home,
  scope = "auto",
} = {}) {
  const resolvedScope = normalizeTelemetryScope(scope);
  if (resolvedScope !== "auto") {
    const storageCwd = storageCwdForScope({ cwd, home, scope: resolvedScope });
    return {
      scope: resolvedScope,
      storageCwd,
      config: normalizedConfigFromRaw(await readTelemetryConfigJson(storageCwd)),
    };
  }

  const localConfig = normalizedConfigFromRaw(await readTelemetryConfigJson(cwd));
  if (localConfig?.enabled) {
    return { scope: "local", storageCwd: cwd, config: localConfig };
  }

  const globalCwd = resolveHome(home);
  const globalConfig = normalizedConfigFromRaw(await readTelemetryConfigJson(globalCwd));
  if (globalConfig?.enabled || (!localConfig && globalConfig)) {
    return { scope: "global", storageCwd: globalCwd, config: globalConfig };
  }

  return { scope: "local", storageCwd: cwd, config: localConfig };
}

export async function saveTelemetryConfig({
  cwd = process.cwd(),
  home,
  scope = "local",
  endpoint,
  tokenEnv,
  deploymentId,
  userLabel,
  schedule = "daily@09:00",
  now = new Date(),
} = {}) {
  const url = validateTelemetryEndpoint(endpoint);
  assertTokenEnvName(tokenEnv);
  validateTelemetrySchedule(schedule);
  const storageCwd = storageCwdForScope({ cwd, home, scope: normalizeTelemetryScope(scope) });
  const dir = telemetryDir(storageCwd);
  const path = telemetryConfigPath(storageCwd);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);

  const previousRaw = await readTelemetryConfigJson(storageCwd);
  const previous = previousRaw
    ? normalizeTelemetryConfig(configValueWithSafePersistedUserLabel(previousRaw.value))
    : null;
  const resolvedDeploymentId = deploymentId ?? previous?.deployment_id ?? DEFAULT_TELEMETRY_DEPLOYMENT_ID;
  assertTelemetryDeploymentId(resolvedDeploymentId);
  const resolvedUserLabel = normalizeTelemetryUserLabel(userLabel);
  const configInput = {
    enabled: true,
    level: "raw",
    endpoint: url.href,
    token_env: tokenEnv,
    deployment_id: resolvedDeploymentId,
    install_id: previous?.install_id ?? makeInstallId(),
    user_label: resolvedUserLabel === undefined ? previous?.user_label ?? null : resolvedUserLabel,
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

export async function disableTelemetryConfig({
  cwd = process.cwd(),
  home,
  scope = "local",
  now = new Date(),
} = {}) {
  const storageCwd = storageCwdForScope({ cwd, home, scope: normalizeTelemetryScope(scope) });
  const rawConfig = await readTelemetryConfigJson(storageCwd);
  if (!rawConfig) return { enabled: false };

  const previous = normalizeTelemetryConfig(rawConfig.value);
  const disabled = normalizeTelemetryConfig({
    ...previous,
    enabled: false,
    updated_at: now.toISOString(),
  });
  await writeFile(rawConfig.path, `${JSON.stringify(disabled, null, 2)}\n`, { mode: 0o600 });
  await chmod(rawConfig.path, 0o600);
  return disabled;
}
