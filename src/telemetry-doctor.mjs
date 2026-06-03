import { loadTelemetryConfigContext, validateTelemetryEndpoint } from "./telemetry-config.mjs";
import { loadTelemetryQueueSnapshot, loadTelemetryState } from "./telemetry-queue.mjs";

function check(ok, message) {
  return { ok, message };
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

function recommendation({ enabled, tokenPresent, endpointValid, pendingCount, quarantineCount }) {
  if (!enabled) return "Enable telemetry before flushing.";
  if (!tokenPresent) return "Set the configured telemetry token environment variable.";
  if (!endpointValid) return "Fix the telemetry endpoint URL.";
  if (quarantineCount > 0) return "Review quarantined telemetry events before broad flushing.";
  if (pendingCount > 0) return "Run telemetry flush --dry-run, then telemetry flush --batch-size 1.";
  return "No pending telemetry events to flush.";
}

export async function runTelemetryDoctor({
  cwd = process.cwd(),
  scope = "auto",
  env = process.env,
  fetchImpl = fetch,
  timeoutMs = 3000,
} = {}) {
  const context = await loadTelemetryConfigContext({ cwd, scope });
  const config = context.config ?? { enabled: false };
  const queue = await loadTelemetryQueueSnapshot({ cwd: context.storageCwd });
  const state = await loadTelemetryState({ cwd: context.storageCwd });
  const enabled = config.enabled === true;
  const tokenName = config.token_env;
  const tokenPresent = typeof tokenName === "string"
    && typeof env[tokenName] === "string"
    && env[tokenName].trim().length > 0;

  let endpointValid = false;
  let endpointError = null;
  try {
    if (config.endpoint) {
      validateTelemetryEndpoint(config.endpoint);
      endpointValid = true;
    }
  } catch (error) {
    endpointError = error instanceof Error ? error.message : `${error}`;
  }

  const endpointCheck = enabled && endpointValid
    ? await endpointHealthCheck({ endpoint: config.endpoint, fetchImpl, timeoutMs })
    : { ok: false, skipped: true, reason: "endpoint_not_configured" };

  const pendingCount = queue.pending.count;
  const quarantineCount = queue.quarantine.count;
  const smallFlushSafe = enabled && tokenPresent && endpointValid && pendingCount > 0;

  return {
    ok: enabled && endpointValid && tokenPresent,
    scope: context.scope,
    storage_cwd: context.storageCwd,
    config,
    queue,
    state,
    checks: {
      config_enabled: check(enabled, enabled ? "Telemetry is enabled." : "Telemetry is not enabled."),
      token_env_present: check(tokenPresent, tokenPresent ? `${tokenName} is set.` : "Telemetry token env is missing."),
      endpoint_valid: check(endpointValid, endpointValid ? "Telemetry endpoint is valid." : endpointError ?? "Telemetry endpoint is missing."),
    },
    endpoint_check: endpointCheck,
    small_flush_safe: smallFlushSafe,
    recommended_action: recommendation({
      enabled,
      tokenPresent,
      endpointValid,
      pendingCount,
      quarantineCount,
    }),
  };
}
