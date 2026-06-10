import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { loadTelemetryConfigContext } from "./telemetry-config.mjs";
import { telemetryQueueDirs } from "./telemetry-queue.mjs";
import {
  maskCredentialText,
  normalizeTelemetryEvent,
} from "./telemetry-schemas.mjs";

const QUEUE_STATES = ["pending", "inflight", "sent", "failed", "quarantine"];
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const CREDENTIAL_SCAN_CHAR_LIMIT = 64 * 1024;

function zeroRawInventoryCounts() {
  return {
    file_count: 0,
    event_count: 0,
    invalid_file_count: 0,
    oversized_file_count: 0,
    skipped_file_count: 0,
    byte_count: 0,
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

function addCounts(target, source) {
  for (const key of Object.keys(target)) target[key] += source[key] ?? 0;
}

function skippableFileSystemError(error) {
  return ["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes(error?.code);
}

async function* walkFiles(root, stateCounts) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (skippableFileSystemError(error)) {
      if (error.code !== "ENOENT") stateCounts.skipped_file_count += 1;
      return;
    }
    throw error;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile()) yield path;
    else if (entry.isDirectory()) yield* walkFiles(path, stateCounts);
  }
}

function eventFileForState(state, path) {
  const name = basename(path);
  if (state === "failed") return name !== "reason.json" && name.endsWith(".json");
  if (state === "quarantine") return name === "event.json";
  return name.endsWith(".json");
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

function addEventToCounts(counts, rawEvent, event) {
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

  const promptCredential = credentialLikeText(rawEvent?.prompt);
  const responseCredential = credentialLikeText(rawEvent?.response);
  if (promptCredential.credentialLike) counts.credential_like_prompt_events += 1;
  if (responseCredential.credentialLike) counts.credential_like_response_events += 1;
  if (promptCredential.scanTruncated || responseCredential.scanTruncated) {
    counts.credential_scan_truncated_events += 1;
  }
}

async function scanEventFile(path, stateCounts, maxFileBytes) {
  let fileStat;
  try {
    fileStat = await stat(path);
  } catch (error) {
    if (skippableFileSystemError(error)) {
      stateCounts.skipped_file_count += 1;
      return;
    }
    throw error;
  }

  if (fileStat.size > maxFileBytes) {
    stateCounts.oversized_file_count += 1;
    return;
  }

  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (skippableFileSystemError(error)) {
      stateCounts.skipped_file_count += 1;
      return;
    }
    throw error;
  }

  stateCounts.file_count += 1;
  stateCounts.byte_count += fileStat.size;
  try {
    const parsed = JSON.parse(raw);
    addEventToCounts(stateCounts, parsed, normalizeTelemetryEvent(parsed));
  } catch {
    stateCounts.invalid_file_count += 1;
  }
}

function emptyStateCounts() {
  return Object.fromEntries(QUEUE_STATES.map((state) => [state, zeroRawInventoryCounts()]));
}

export async function runTelemetryRawInventory({
  cwd = process.cwd(),
  home,
  scope = "auto",
  now = new Date(),
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
} = {}) {
  if (!Number.isInteger(maxFileBytes) || maxFileBytes <= 0) {
    throw new RangeError("maxFileBytes must be a positive integer.");
  }

  const context = await loadTelemetryConfigContext({ cwd, home, scope });
  const dirs = telemetryQueueDirs(context.storageCwd);
  const states = emptyStateCounts();
  const totals = zeroRawInventoryCounts();

  for (const state of QUEUE_STATES) {
    for await (const path of walkFiles(dirs[state], states[state])) {
      if (!eventFileForState(state, path)) continue;
      await scanEventFile(path, states[state], maxFileBytes);
    }
    addCounts(totals, states[state]);
  }

  return {
    scope: context.scope,
    generated_at: now.toISOString(),
    max_file_bytes: maxFileBytes,
    totals,
    states,
    limitations: [
      "Inventory is aggregate-only and does not reveal raw prompt, response, event ids, batch ids, paths, or media filenames.",
      "Credential-like detection uses a bounded local scan and can miss secrets outside the scanned prefix.",
      "Unreadable files or directories are skipped and counted without revealing their names.",
      "Inventory only covers telemetry files available on this machine.",
    ],
  };
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatStateRows(states) {
  return QUEUE_STATES.map((state) => {
    const item = states[state];
    return `- ${state}: ${formatNumber(item.event_count)} events, ${formatNumber(item.file_count)} files, ${formatNumber(item.byte_count)} bytes, ${formatNumber(item.invalid_file_count)} invalid, ${formatNumber(item.oversized_file_count)} oversized`;
  }).join("\n");
}

export function formatTelemetryRawInventoryText(report) {
  return [
    "Raw Telemetry Inventory",
    "",
    `Scope: ${report.scope}`,
    "No raw prompt or response content is shown.",
    "",
    "Totals:",
    `- Events: ${formatNumber(report.totals.event_count)}`,
    `- Files: ${formatNumber(report.totals.file_count)}`,
    `- Bytes: ${formatNumber(report.totals.byte_count)}`,
    `- Prompt events: ${formatNumber(report.totals.prompt_events)}`,
    `- Response events: ${formatNumber(report.totals.response_events)}`,
    `- Prompt bytes: ${formatNumber(report.totals.prompt_bytes)}`,
    `- Response bytes: ${formatNumber(report.totals.response_bytes)}`,
    `- Truncated prompt events: ${formatNumber(report.totals.truncated_prompt_events)}`,
    `- Truncated response events: ${formatNumber(report.totals.truncated_response_events)}`,
    `- Multimodal events: ${formatNumber(report.totals.multimodal_events)}`,
    `- Media items: ${formatNumber(report.totals.media_item_count)}`,
    `- Credential-like prompt events: ${formatNumber(report.totals.credential_like_prompt_events)}`,
    `- Credential-like response events: ${formatNumber(report.totals.credential_like_response_events)}`,
    `- Invalid files: ${formatNumber(report.totals.invalid_file_count)}`,
    `- Oversized files skipped: ${formatNumber(report.totals.oversized_file_count)}`,
    `- Files skipped during scan errors: ${formatNumber(report.totals.skipped_file_count)}`,
    "",
    "By state:",
    formatStateRows(report.states),
    "",
    "Limitations:",
    report.limitations.map((item) => `- ${item}`).join("\n"),
    "",
  ].join("\n");
}
