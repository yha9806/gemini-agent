import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadTelemetryConfigContext } from "./telemetry-config.mjs";
import {
  pruneSentTelemetry,
  telemetryQueueDirs,
} from "./telemetry-queue.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const SUPPORTED_STATE = "sent";

function assertNonnegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a nonnegative integer.`);
  }
}

async function regularFileSummaries(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(dir, entry.name);
    let itemStat;
    try {
      itemStat = await stat(path);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    files.push({ size: itemStat.size });
  }
  return files;
}

async function sentDaySummaries(sentDir) {
  let entries;
  try {
    entries = await readdir(sentDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const days = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
    const dayMs = Date.parse(`${entry.name}T00:00:00.000Z`);
    if (Number.isNaN(dayMs)) continue;
    const files = await regularFileSummaries(join(sentDir, entry.name));
    days.push({
      day: entry.name,
      dayMs,
      count: files.length,
      bytes: files.reduce((sum, file) => sum + file.size, 0),
    });
  }
  return days.sort((left, right) => left.dayMs - right.dayMs || left.day.localeCompare(right.day));
}

function utcDay(value) {
  return value.toISOString().slice(0, 10);
}

function buildSentPrunePlan({
  days,
  keepDays,
  maxSentBytes,
  now,
}) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const cutoffMs = today - keepDays * DAY_MS;
  const expired = days.filter((day) => day.dayMs < cutoffMs);
  const selected = [...expired];
  const selectedDays = new Set(selected.map((day) => day.day));
  const remainingAfterAge = days.filter((day) => !selectedDays.has(day.day));
  let remainingBytes = remainingAfterAge.reduce((sum, day) => sum + day.bytes, 0);
  const byteLimitSelected = [];

  if (maxSentBytes !== Number.POSITIVE_INFINITY) {
    for (const day of remainingAfterAge) {
      if (remainingBytes <= maxSentBytes) break;
      selected.push(day);
      byteLimitSelected.push(day);
      selectedDays.add(day.day);
      remainingBytes -= day.bytes;
    }
  }

  const currentCount = days.reduce((sum, day) => sum + day.count, 0);
  const currentBytes = days.reduce((sum, day) => sum + day.bytes, 0);
  const wouldDeleteCount = selected.reduce((sum, day) => sum + day.count, 0);
  const wouldDeleteBytes = selected.reduce((sum, day) => sum + day.bytes, 0);

  return {
    cutoff_day: utcDay(new Date(cutoffMs)),
    current_sent_count: currentCount,
    current_sent_bytes: currentBytes,
    current_sent_day_count: days.length,
    would_delete_count: wouldDeleteCount,
    would_delete_bytes: wouldDeleteBytes,
    would_delete_day_count: selected.length,
    expired_delete_count: expired.reduce((sum, day) => sum + day.count, 0),
    expired_delete_bytes: expired.reduce((sum, day) => sum + day.bytes, 0),
    expired_day_count: expired.length,
    bytes_limit_delete_count: byteLimitSelected.reduce((sum, day) => sum + day.count, 0),
    bytes_limit_delete_bytes: byteLimitSelected.reduce((sum, day) => sum + day.bytes, 0),
    bytes_limit_day_count: byteLimitSelected.length,
    remaining_sent_count_after_prune: currentCount - wouldDeleteCount,
    remaining_sent_bytes_after_prune: currentBytes - wouldDeleteBytes,
  };
}

function pruneNextCommand({ global, keepDays, maxSentBytes, write }) {
  const args = [
    "gemini-agent telemetry raw prune --state sent",
    `--keep-days ${keepDays}`,
    maxSentBytes === Number.POSITIVE_INFINITY ? "" : `--max-sent-bytes ${maxSentBytes}`,
    global ? "--global" : "",
    write ? "--write" : "--dry-run",
  ].filter(Boolean);
  return args.join(" ");
}

export async function runTelemetryRawPrune({
  cwd = process.cwd(),
  home,
  scope = "auto",
  state,
  keepDays,
  maxSentBytes = Number.POSITIVE_INFINITY,
  dryRun = true,
  now = new Date(),
} = {}) {
  if (state !== SUPPORTED_STATE) {
    throw new Error("telemetry raw prune only supports --state sent.");
  }
  assertNonnegativeInteger(keepDays, "keepDays");
  if (maxSentBytes !== Number.POSITIVE_INFINITY) {
    assertNonnegativeInteger(maxSentBytes, "maxSentBytes");
  }
  if (typeof dryRun !== "boolean") {
    throw new TypeError("dryRun must be a boolean.");
  }

  const context = await loadTelemetryConfigContext({ cwd, home, scope });
  const dirs = telemetryQueueDirs(context.storageCwd);
  const beforeDays = await sentDaySummaries(dirs.sent);
  const plan = buildSentPrunePlan({ days: beforeDays, keepDays, maxSentBytes, now });
  const deletedCount = dryRun
    ? 0
    : await pruneSentTelemetry({
      cwd: context.storageCwd,
      now,
      keepDays,
      maxSentBytes,
    });
  const afterDays = dryRun ? beforeDays : await sentDaySummaries(dirs.sent);
  const remainingCount = afterDays.reduce((sum, day) => sum + day.count, 0);
  const remainingBytes = afterDays.reduce((sum, day) => sum + day.bytes, 0);

  return {
    ok: true,
    scope: context.scope,
    state,
    dry_run: dryRun,
    keep_days: keepDays,
    max_sent_bytes: maxSentBytes === Number.POSITIVE_INFINITY ? null : maxSentBytes,
    ...plan,
    deleted_count: deletedCount,
    remaining_sent_count: remainingCount,
    remaining_sent_bytes: remainingBytes,
    limitations: [
      "Prune output is aggregate-only and does not reveal raw prompt, response, event ids, batch ids, paths, or media filenames.",
      "Only sent telemetry is supported; pending, failed, inflight, and quarantined data require separate recovery or inspection flows.",
      "Sent-day retention uses UTC day directories; age pruning runs before byte-limit pruning.",
    ],
    next_command: dryRun
      ? pruneNextCommand({
        global: context.scope === "global",
        keepDays,
        maxSentBytes,
        write: true,
      })
      : "gemini-agent telemetry raw inventory --json",
  };
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatTelemetryRawPruneText(report) {
  return [
    "Raw Telemetry Prune",
    "",
    `Scope: ${report.scope}`,
    `State: ${report.state}`,
    `Mode: ${report.dry_run ? "dry-run" : "write"}`,
    "No raw prompt or response content is shown.",
    "",
    "Policy:",
    `- Keep days: ${formatNumber(report.keep_days)}`,
    `- UTC cutoff day: ${report.cutoff_day}`,
    `- Max sent bytes: ${report.max_sent_bytes == null ? "unlimited" : formatNumber(report.max_sent_bytes)}`,
    "",
    "Current sent raw data:",
    `- Events/files: ${formatNumber(report.current_sent_count)}`,
    `- Bytes: ${formatNumber(report.current_sent_bytes)}`,
    `- UTC day buckets: ${formatNumber(report.current_sent_day_count)}`,
    "",
    "Deletion plan:",
    `- Would delete: ${formatNumber(report.would_delete_count)} events/files`,
    `- Would delete bytes: ${formatNumber(report.would_delete_bytes)}`,
    `- Would delete day buckets: ${formatNumber(report.would_delete_day_count)}`,
    `- Expired by age: ${formatNumber(report.expired_delete_count)} events/files`,
    `- Extra for byte limit: ${formatNumber(report.bytes_limit_delete_count)} events/files`,
    `- Deleted now: ${formatNumber(report.deleted_count)} events/files`,
    `- Remaining after prune: ${formatNumber(report.remaining_sent_count_after_prune)} events/files`,
    "",
    "Actual local state:",
    `- Remaining sent events/files: ${formatNumber(report.remaining_sent_count)}`,
    `- Remaining sent bytes: ${formatNumber(report.remaining_sent_bytes)}`,
    "",
    "Next command:",
    report.next_command,
    "",
    "Limitations:",
    report.limitations.map((item) => `- ${item}`).join("\n"),
    "",
  ].join("\n");
}
