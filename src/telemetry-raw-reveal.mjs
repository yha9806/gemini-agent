import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadTelemetryConfigContext } from "./telemetry-config.mjs";
import { telemetryQueueDirs } from "./telemetry-queue.mjs";
import { normalizeTelemetryEvent } from "./telemetry-schemas.mjs";

const SUPPORTED_STATES = new Set(["pending", "sent"]);
const RAW_REVEAL_WARNING = "This output includes raw prompt/response telemetry and event payloads; do not pipe it to public logs or shared channels.";

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
}

async function regularJsonFiles(dir) {
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

async function sentJsonFiles(sentDir) {
  let entries;
  try {
    entries = await readdir(sentDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const dayDirs = entries
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
  const files = [];
  for (const day of dayDirs) {
    files.push(...await regularJsonFiles(join(sentDir, day)));
  }
  return files;
}

async function candidateFiles({ dirs, state }) {
  if (state === "pending") return regularJsonFiles(dirs.pending);
  if (state === "sent") return sentJsonFiles(dirs.sent);
  throw new Error("telemetry raw reveal only supports pending or sent states.");
}

async function readEventFile(path) {
  try {
    return normalizeTelemetryEvent(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return { skipped: true };
    return { invalid: true };
  }
}

export async function runTelemetryRawReveal({
  cwd = process.cwd(),
  home,
  scope = "auto",
  state,
  limit,
  confirmRawContent = false,
} = {}) {
  if (!confirmRawContent) {
    throw new Error("--confirm-raw-content is required before revealing raw prompt/response telemetry.");
  }
  if (!SUPPORTED_STATES.has(state)) {
    throw new Error("telemetry raw reveal only supports pending or sent states.");
  }
  assertPositiveInteger(limit, "limit");

  const context = await loadTelemetryConfigContext({ cwd, home, scope });
  const dirs = telemetryQueueDirs(context.storageCwd);
  const files = await candidateFiles({ dirs, state });
  const selected = files.slice(0, limit);
  const events = [];
  let invalidFileCount = 0;
  let skippedFileCount = 0;

  for (const file of selected) {
    const event = await readEventFile(file.path);
    if (event.skipped) {
      skippedFileCount += 1;
      continue;
    }
    if (event.invalid) {
      invalidFileCount += 1;
      continue;
    }
    events.push(event);
  }

  return {
    ok: true,
    scope: context.scope,
    state,
    matched_count: files.length,
    selected_count: selected.length,
    revealed_count: events.length,
    invalid_file_count: invalidFileCount,
    skipped_file_count: skippedFileCount,
    excluded_by_limit_count: Math.max(0, files.length - selected.length),
    warning: RAW_REVEAL_WARNING,
    events,
    limitations: [
      "Raw reveal intentionally prints raw prompt, response, payload, and event metadata for local inspection.",
      "Raw reveal requires --confirm-raw-content and a positive --limit to avoid accidental unbounded disclosure.",
      "Credential-shaped prompt and response content is normalized with the same masking used by raw telemetry.",
      "Only pending and sent telemetry are supported; failed and quarantined data require separate recovery or inspection flows.",
    ],
  };
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatTelemetryRawRevealText(report) {
  return [
    "Raw Telemetry Reveal",
    "",
    `WARNING: ${report.warning}`,
    `Scope: ${report.scope}`,
    `State: ${report.state}`,
    "",
    "Reveal summary:",
    `- Matched files: ${formatNumber(report.matched_count)}`,
    `- Selected files: ${formatNumber(report.selected_count)}`,
    `- Revealed events: ${formatNumber(report.revealed_count)}`,
    `- Invalid files: ${formatNumber(report.invalid_file_count)}`,
    `- Skipped files: ${formatNumber(report.skipped_file_count)}`,
    `- Excluded by limit: ${formatNumber(report.excluded_by_limit_count)}`,
    "",
    "Events:",
    report.events.map((event) => JSON.stringify(event, null, 2)).join("\n"),
    "",
    "Limitations:",
    report.limitations.map((item) => `- ${item}`).join("\n"),
    "",
  ].join("\n");
}
