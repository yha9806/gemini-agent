import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadTelemetryConfigContext } from "./telemetry-config.mjs";
import {
  loadTelemetryQueueSnapshot,
  telemetryQueueDirs,
} from "./telemetry-queue.mjs";
import { buildTelemetryFlushPreview } from "./telemetry-sender.mjs";
import {
  maskCredentialText,
  normalizeTelemetryEvent,
} from "./telemetry-schemas.mjs";

const CREDENTIAL_SCAN_CHAR_LIMIT = 64 * 1024;

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
}

function zeroRiskCounts() {
  return {
    file_count: 0,
    event_count: 0,
    invalid_file_count: 0,
    skipped_file_count: 0,
    prompt_events: 0,
    response_events: 0,
    prompt_bytes: 0,
    response_bytes: 0,
    truncated_prompt_events: 0,
    truncated_response_events: 0,
    multimodal_events: 0,
    media_item_count: 0,
    credential_like_prompt_events: 0,
    credential_like_response_events: 0,
    credential_scan_truncated_events: 0,
  };
}

function textByteLength(value) {
  return Buffer.byteLength(`${value ?? ""}`, "utf8");
}

function credentialLikeText(value) {
  if (typeof value !== "string" || value.length === 0) {
    return { credentialLike: false, scanTruncated: false };
  }
  const scanText = value.slice(0, CREDENTIAL_SCAN_CHAR_LIMIT);
  return {
    credentialLike: scanText.includes("[MASKED]") || maskCredentialText(scanText) !== scanText,
    scanTruncated: value.length > CREDENTIAL_SCAN_CHAR_LIMIT,
  };
}

function addEventRisk(counts, event) {
  counts.file_count += 1;
  counts.event_count += 1;
  if (event.prompt) {
    counts.prompt_events += 1;
    counts.prompt_bytes += textByteLength(event.prompt);
  }
  if (event.response) {
    counts.response_events += 1;
    counts.response_bytes += textByteLength(event.response);
  }
  if (event.payload?.prompt_truncated) counts.truncated_prompt_events += 1;
  if (event.payload?.response_truncated) counts.truncated_response_events += 1;

  const multimodal = Array.isArray(event.payload?.multimodal) ? event.payload.multimodal : [];
  if (multimodal.length > 0) {
    counts.multimodal_events += 1;
    counts.media_item_count += multimodal.length;
  }

  const promptCredential = credentialLikeText(event.prompt);
  const responseCredential = credentialLikeText(event.response);
  if (promptCredential.credentialLike) counts.credential_like_prompt_events += 1;
  if (responseCredential.credentialLike) counts.credential_like_response_events += 1;
  if (promptCredential.scanTruncated || responseCredential.scanTruncated) {
    counts.credential_scan_truncated_events += 1;
  }
}

async function pendingFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(dir, entry.name);
    try {
      const itemStat = await stat(path);
      files.push({
        name: entry.name,
        path,
        size: itemStat.size,
        mtimeMs: itemStat.mtimeMs,
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return files.sort((left, right) => (
    left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name)
  ));
}

async function countInvalidPendingSelection({ cwd, batchSize }) {
  const counts = zeroRiskCounts();
  const dirs = telemetryQueueDirs(cwd);
  const files = (await pendingFiles(dirs.pending)).slice(0, batchSize);
  for (const file of files) {
    let raw;
    try {
      raw = await readFile(file.path, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        counts.skipped_file_count += 1;
        continue;
      }
      throw error;
    }
    counts.file_count += 1;
    try {
      normalizeTelemetryEvent(JSON.parse(raw));
    } catch {
      counts.invalid_file_count += 1;
    }
  }
  return counts;
}

function riskCountsForEvents(events) {
  const counts = zeroRiskCounts();
  for (const event of events) addEventRisk(counts, event);
  return counts;
}

function flushNextCommand({ scope, batchSize, maxBytes }) {
  return [
    "gemini-agent telemetry flush",
    scope === "global" ? "--global" : "",
    "--dry-run",
    "--batch-size",
    String(batchSize),
    maxBytes === undefined ? "" : "--max-bytes",
    maxBytes === undefined ? "" : String(maxBytes),
  ].filter(Boolean).join(" ");
}

export async function runTelemetryRawPreflight({
  cwd = process.cwd(),
  home,
  scope = "auto",
  batchSize = 100,
  maxBytes,
  now = new Date(),
} = {}) {
  assertPositiveInteger(batchSize, "batchSize");
  if (maxBytes !== undefined) assertPositiveInteger(maxBytes, "maxBytes");

  const context = await loadTelemetryConfigContext({ cwd, home, scope });
  const snapshot = await loadTelemetryQueueSnapshot({
    cwd: context.storageCwd,
    createMissingDirs: false,
  });
  let structured = null;
  let risk = zeroRiskCounts();
  let previewError = null;

  try {
    structured = await buildTelemetryFlushPreview({
      cwd: context.storageCwd,
      now,
      batchSize,
      maxBytes,
    });
    risk = riskCountsForEvents(structured.events);
  } catch (error) {
    risk = await countInvalidPendingSelection({ cwd: context.storageCwd, batchSize });
    previewError = "invalid_pending_event";
  }

  const preview = structured?.preview ?? {
    ok: false,
    dry_run: true,
    would_send_count: 0,
    batch_bytes: 0,
    exceeds_max_bytes: false,
  };
  const pendingTotalCount = snapshot.pending.count;
  const selectedOrInspectedCount = Math.max(preview.would_send_count, risk.file_count);

  return {
    ok: true,
    scope: context.scope,
    generated_at: now.toISOString(),
    pending: {
      total_count: pendingTotalCount,
      total_bytes: snapshot.pending.bytes,
    },
    batch: {
      batch_size: batchSize,
      max_bytes: maxBytes ?? null,
      would_send_count: preview.would_send_count,
      batch_bytes: preview.batch_bytes,
      exceeds_max_bytes: preview.exceeds_max_bytes,
      excluded_by_batch_size_count: Math.max(0, pendingTotalCount - selectedOrInspectedCount),
      preview_error: previewError,
    },
    risk,
    next_command: flushNextCommand({
      scope: context.scope,
      batchSize,
      maxBytes,
    }),
    limitations: [
      "Preflight output is aggregate-only and does not reveal raw prompt, response, event ids, batch ids, paths, or media filenames.",
      "Preflight does not send, move, delete, or quarantine telemetry files.",
      "Credential-like detection uses a bounded local scan and can miss secrets outside the scanned prefix.",
    ],
  };
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatTelemetryRawPreflightText(report) {
  return [
    "Raw Telemetry Preflight",
    "",
    `Scope: ${report.scope}`,
    "No raw prompt or response content is shown.",
    "",
    "Pending queue:",
    `- Events/files: ${formatNumber(report.pending.total_count)}`,
    `- Bytes: ${formatNumber(report.pending.total_bytes)}`,
    "",
    "Selected upload batch:",
    `- Batch size: ${formatNumber(report.batch.batch_size)}`,
    `- Would send: ${formatNumber(report.batch.would_send_count)}`,
    `- Batch bytes: ${formatNumber(report.batch.batch_bytes)}`,
    `- Exceeds max bytes: ${report.batch.exceeds_max_bytes ? "yes" : "no"}`,
    `- Pending excluded by batch size: ${formatNumber(report.batch.excluded_by_batch_size_count)}`,
    `- Preview error: ${report.batch.preview_error ?? "none"}`,
    "",
    "Raw risk signals for selected batch:",
    `- Events: ${formatNumber(report.risk.event_count)}`,
    `- Invalid files: ${formatNumber(report.risk.invalid_file_count)}`,
    `- Prompt events: ${formatNumber(report.risk.prompt_events)}`,
    `- Response events: ${formatNumber(report.risk.response_events)}`,
    `- Prompt bytes: ${formatNumber(report.risk.prompt_bytes)}`,
    `- Response bytes: ${formatNumber(report.risk.response_bytes)}`,
    `- Truncated prompt events: ${formatNumber(report.risk.truncated_prompt_events)}`,
    `- Truncated response events: ${formatNumber(report.risk.truncated_response_events)}`,
    `- Multimodal events: ${formatNumber(report.risk.multimodal_events)}`,
    `- Media items: ${formatNumber(report.risk.media_item_count)}`,
    `- Credential-like prompt events: ${formatNumber(report.risk.credential_like_prompt_events)}`,
    `- Credential-like response events: ${formatNumber(report.risk.credential_like_response_events)}`,
    "",
    "Next command:",
    report.next_command,
    "",
    "Limitations:",
    report.limitations.map((item) => `- ${item}`).join("\n"),
    "",
  ].join("\n");
}
