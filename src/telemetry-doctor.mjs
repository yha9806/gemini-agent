import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveTelemetryToken, validateTelemetryEndpoint } from "./telemetry-config.mjs";
import { loadTelemetryQueueSnapshot, loadTelemetryState } from "./telemetry-queue.mjs";
import { normalizeTelemetryConfig } from "./telemetry-schemas.mjs";

const TELEMETRY_ROOT = ".gemini-agent/telemetry";
const CONFIG_FILE = "config.json";
const DIAGNOSTIC_CONFIG_FIELDS = [
  "enabled",
  "level",
  "endpoint",
  "token_env",
  "deployment_id",
  "schedule",
  "max_event_bytes",
  "max_queue_bytes",
  "created_at",
  "updated_at",
];

function telemetryConfigPath(cwd) {
  return join(cwd, TELEMETRY_ROOT, CONFIG_FILE);
}

function check(ok, message) {
  return { ok, message };
}

function messageFromError(error) {
  return error instanceof Error ? error.message : `${error}`;
}

function resolveHome(home) {
  const resolved = home ?? process.env.HOME ?? homedir();
  if (typeof resolved !== "string" || !resolved.trim()) {
    throw new Error("Telemetry global scope requires a home directory.");
  }
  return resolved;
}

function normalizeTelemetryScope(scope = "auto") {
  if (scope === "local" || scope === "global" || scope === "auto") return scope;
  throw new Error(`Unsupported telemetry scope: ${scope}`);
}

function storageCwdForScope({ cwd, home, scope }) {
  if (scope === "local") return cwd;
  if (scope === "global") return resolveHome(home);
  throw new Error(`Unsupported telemetry scope: ${scope}`);
}

function validateTelemetrySchedule(schedule) {
  if (schedule === "hourly" || /^daily@([01]\d|2[0-3]):([0-5]\d)$/.test(schedule)) {
    return schedule;
  }
  throw new Error(`Unsupported telemetry schedule: ${schedule}`);
}

function healthUrlFromEndpoint(endpoint) {
  const url = validateTelemetryEndpoint(endpoint);
  if (/\/ingest\/?$/.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/ingest\/?$/, "/health");
  } else if (url.pathname.endsWith("/")) {
    url.pathname = `${url.pathname}health`;
  } else {
    url.pathname = `${url.pathname}/health`;
  }
  return url;
}

async function readTelemetryConfigJson(cwd) {
  const path = telemetryConfigPath(cwd);
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { path, exists: false, value: null, error: null };
    }
    return {
      path,
      exists: true,
      value: null,
      error: `Telemetry config could not be read: ${messageFromError(error)}`,
    };
  }

  try {
    return { path, exists: true, value: JSON.parse(raw), error: null };
  } catch (error) {
    if (error instanceof SyntaxError) {
      return {
        path,
        exists: true,
        value: null,
        error: `Telemetry config is not valid JSON: ${path}`,
      };
    }
    return {
      path,
      exists: true,
      value: null,
      error: messageFromError(error),
    };
  }
}

function rawConfigFallback(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { enabled: false };
  }

  const config = {};
  for (const field of DIAGNOSTIC_CONFIG_FIELDS) {
    if (Object.hasOwn(value, field)) config[field] = value[field];
  }
  return config;
}

function validateConfigEndpoint(config) {
  if (typeof config.endpoint !== "string" || !config.endpoint.trim()) {
    return {
      endpointValid: false,
      endpointError: "Telemetry endpoint is missing.",
    };
  }

  try {
    validateTelemetryEndpoint(config.endpoint);
    return { endpointValid: true, endpointError: null };
  } catch (error) {
    return {
      endpointValid: false,
      endpointError: messageFromError(error),
    };
  }
}

function validateConfigSchedule(config) {
  try {
    validateTelemetrySchedule(config.schedule ?? "daily@09:00");
    return { scheduleValid: true, scheduleError: null };
  } catch (error) {
    return {
      scheduleValid: false,
      scheduleError: messageFromError(error),
    };
  }
}

function validateConfigTokenEnv(config) {
  const tokenEnv = config.token_env;
  const env = Object.create(null);
  if (typeof tokenEnv === "string") env[tokenEnv] = "telemetry-token";
  try {
    resolveTelemetryToken({ tokenEnv, env });
    return { tokenEnvValid: true, tokenEnvError: null };
  } catch (error) {
    return {
      tokenEnvValid: false,
      tokenEnvError: messageFromError(error),
    };
  }
}

function resolveTokenPresence({ tokenEnv, env, tokenEnvValid, tokenEnvError }) {
  if (!tokenEnvValid) {
    return {
      tokenPresent: false,
      tokenPresentError: tokenEnvError ?? "Telemetry token env name is invalid.",
    };
  }

  try {
    resolveTelemetryToken({ tokenEnv, env });
    return { tokenPresent: true, tokenPresentError: null };
  } catch (error) {
    return {
      tokenPresent: false,
      tokenPresentError: messageFromError(error),
    };
  }
}

function loadConfigFromRaw(rawConfig) {
  if (!rawConfig.exists) {
    return {
      hasConfig: false,
      config: null,
      configValid: true,
      configError: null,
      endpointValid: false,
      endpointError: "Telemetry endpoint is missing.",
      scheduleValid: true,
      scheduleError: null,
      tokenEnvValid: false,
      tokenEnvError: "Telemetry token env is missing.",
    };
  }

  if (rawConfig.error) {
    return {
      hasConfig: true,
      config: { enabled: false },
      configValid: false,
      configError: rawConfig.error,
      endpointValid: false,
      endpointError: "Telemetry endpoint is missing.",
      scheduleValid: false,
      scheduleError: rawConfig.error,
      tokenEnvValid: false,
      tokenEnvError: null,
    };
  }

  let config;
  let configError = null;
  try {
    config = normalizeTelemetryConfig(rawConfig.value);
  } catch (error) {
    config = rawConfigFallback(rawConfig.value);
    configError = "Telemetry config is invalid.";
  }

  const { endpointValid, endpointError } = validateConfigEndpoint(config);
  const { scheduleValid, scheduleError } = validateConfigSchedule(config);
  const { tokenEnvValid, tokenEnvError } = validateConfigTokenEnv(config);
  return {
    hasConfig: true,
    config,
    configValid: !configError && endpointValid && scheduleValid && tokenEnvValid,
    configError: configError ?? endpointError ?? scheduleError ?? tokenEnvError,
    endpointValid,
    endpointError,
    scheduleValid,
    scheduleError,
    tokenEnvValid,
    tokenEnvError,
  };
}

async function loadTelemetryConfigContextTolerant({
  cwd = process.cwd(),
  home,
  scope = "auto",
} = {}) {
  const resolvedScope = normalizeTelemetryScope(scope);

  async function loadAt(storageCwd, selectedScope) {
    return {
      scope: selectedScope,
      storageCwd,
      ...loadConfigFromRaw(await readTelemetryConfigJson(storageCwd)),
    };
  }

  if (resolvedScope !== "auto") {
    return loadAt(storageCwdForScope({ cwd, home, scope: resolvedScope }), resolvedScope);
  }

  const localContext = await loadAt(cwd, "local");
  if (localContext.hasConfig && !localContext.configValid) return localContext;
  if (localContext.config?.enabled) return localContext;
  const globalContext = await loadAt(resolveHome(home), "global");
  if (globalContext.hasConfig && !globalContext.configValid) return globalContext;
  if (globalContext.config?.enabled || (!localContext.hasConfig && globalContext.hasConfig)) {
    return globalContext;
  }
  return localContext;
}

async function endpointHealthCheck({ endpoint, fetchImpl, timeoutMs }) {
  const url = healthUrlFromEndpoint(endpoint);
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new Error(`Telemetry doctor endpoint check timed out after ${timeoutMs}ms.`));
  }, timeoutMs);
  try {
    const response = await fetchImpl(url.href, {
      method: "GET",
      signal: controller.signal,
    });
    return {
      ok: response.ok,
      url: url.href,
      status: response.status,
    };
  } catch (error) {
    return {
      ok: false,
      url: url.href,
      error: error instanceof Error ? error.message : `${error}`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function recommendation({
  enabled,
  configValid,
  endpointValid,
  endpointError,
  tokenEnvValid,
  tokenEnvError,
  tokenPresent,
  pendingCount,
  quarantineCount,
}) {
  if (!configValid) {
    if (!tokenEnvValid && tokenEnvError) return "Fix the telemetry token environment variable name.";
    return endpointError && endpointError !== "Telemetry endpoint is missing."
      ? "Fix the telemetry endpoint URL."
      : "Fix the telemetry config.";
  }
  if (!enabled) return "Enable telemetry before flushing.";
  if (!tokenPresent) return "Set the configured telemetry token environment variable.";
  if (!endpointValid) return "Fix the telemetry endpoint URL.";
  if (quarantineCount > 0) return "Review quarantined telemetry events before broad flushing.";
  if (pendingCount > 0) return "Run telemetry flush --dry-run, then telemetry flush --batch-size 1.";
  return "No pending telemetry events to flush.";
}

export async function runTelemetryDoctor({
  cwd = process.cwd(),
  home,
  scope = "auto",
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 3000,
} = {}) {
  const context = await loadTelemetryConfigContextTolerant({ cwd, home, scope });
  const config = context.config ?? { enabled: false };
  const queue = await loadTelemetryQueueSnapshot({ cwd: context.storageCwd });
  const state = await loadTelemetryState({ cwd: context.storageCwd });
  const enabled = config.enabled === true;
  const configValid = context.configValid;
  const tokenName = config.token_env;
  const tokenEnvValid = context.tokenEnvValid;
  const tokenEnvError = context.tokenEnvError;
  const { tokenPresent, tokenPresentError } = resolveTokenPresence({
    tokenEnv: tokenName,
    env,
    tokenEnvValid,
    tokenEnvError,
  });
  const endpointValid = context.endpointValid;
  const endpointError = context.endpointError;

  const endpointCheck = enabled && configValid && endpointValid
    ? await endpointHealthCheck({ endpoint: config.endpoint, fetchImpl, timeoutMs })
    : {
      ok: false,
      skipped: true,
      reason: configValid ? "endpoint_not_configured" : "invalid_config",
    };

  const pendingCount = queue.pending.count;
  const quarantineCount = queue.quarantine.count;
  const smallFlushSafe = enabled && configValid && tokenPresent && endpointValid && pendingCount > 0;

  return {
    ok: enabled && configValid && endpointValid && tokenPresent,
    scope: context.scope,
    storage_cwd: context.storageCwd,
    config,
    queue,
    state,
    checks: {
      config_valid: check(configValid, configValid ? "Telemetry config is valid." : context.configError ?? "Telemetry config is invalid."),
      config_enabled: check(enabled, enabled ? "Telemetry is enabled." : "Telemetry is not enabled."),
      token_env_valid: check(tokenEnvValid, tokenEnvValid ? "Telemetry token env name is valid." : tokenEnvError ?? "Telemetry token env name is invalid."),
      token_env_present: check(tokenPresent, tokenPresent ? `${tokenName} is set.` : tokenPresentError ?? "Telemetry token env is missing."),
      endpoint_valid: check(endpointValid, endpointValid ? "Telemetry endpoint is valid." : endpointError ?? "Telemetry endpoint is missing."),
    },
    endpoint_check: endpointCheck,
    small_flush_safe: smallFlushSafe,
    recommended_action: recommendation({
      enabled,
      configValid,
      tokenPresent,
      endpointValid,
      endpointError,
      tokenEnvValid,
      tokenEnvError,
      pendingCount,
      quarantineCount,
    }),
  };
}
