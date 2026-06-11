import { chmod, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadTelemetryConfigContext } from "./telemetry-config.mjs";
import {
  loadTelemetryState,
  telemetryQueueDirs,
  withTelemetryQueueLock,
} from "./telemetry-queue.mjs";
import { normalizeTelemetryEvent } from "./telemetry-schemas.mjs";

const SUPPORTED_STATES = new Set(["pending", "sent"]);
const SAFE_EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;
const SECURE_FILE_MODE = 0o600;

function assertSafeEventId(value) {
  if (typeof value !== "string" || !SAFE_EVENT_ID.test(value)) {
    throw new Error("--event-id must be a safe telemetry event id.");
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
  throw new Error("telemetry raw delete only supports pending or sent states.");
}

async function readEventFile(path) {
  try {
    return normalizeTelemetryEvent(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return { skipped: true };
    return { invalid: true };
  }
}

async function pendingQueueBytes(cwd) {
  const dirs = telemetryQueueDirs(cwd);
  const files = await regularJsonFiles(dirs.pending);
  return files.reduce((sum, file) => sum + file.size, 0);
}

async function deleteMatches({ cwd, dirs, files, dryRun, state }) {
  let deletedCount = 0;
  let deletedBytes = 0;
  if (dryRun) return { deletedCount, deletedBytes };

  for (const file of files) {
    try {
      await unlink(file.path);
      deletedCount += 1;
      deletedBytes += file.size;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  if (state === "pending") {
    const stateSnapshot = await loadTelemetryState({ cwd });
    const nextState = {
      ...stateSnapshot,
      queue_bytes: await pendingQueueBytes(cwd),
    };
    await writeFile(dirs.state, `${JSON.stringify(nextState, null, 2)}\n`, { mode: SECURE_FILE_MODE });
    await chmod(dirs.state, SECURE_FILE_MODE);
  }

  return { deletedCount, deletedBytes };
}

export async function runTelemetryRawDelete({
  cwd = process.cwd(),
  home,
  scope = "auto",
  state,
  eventId,
  confirmRawContent = false,
  dryRun = true,
} = {}) {
  if (!confirmRawContent) {
    throw new Error("--confirm-raw-content is required before deleting raw prompt/response telemetry.");
  }
  if (!SUPPORTED_STATES.has(state)) {
    throw new Error("telemetry raw delete only supports pending or sent states.");
  }
  assertSafeEventId(eventId);

  const context = await loadTelemetryConfigContext({ cwd, home, scope });

  return withTelemetryQueueLock({ cwd: context.storageCwd }, async () => {
    const dirs = telemetryQueueDirs(context.storageCwd);
    const files = await candidateFiles({ dirs, state });
    const matches = [];
    let invalidFileCount = 0;
    let skippedFileCount = 0;

    for (const file of files) {
      const event = await readEventFile(file.path);
      if (event.skipped) {
        skippedFileCount += 1;
        continue;
      }
      if (event.invalid) {
        invalidFileCount += 1;
        continue;
      }
      if (event.event_id === eventId) matches.push(file);
    }

    const { deletedCount, deletedBytes } = await deleteMatches({
      cwd: context.storageCwd,
      dirs,
      files: matches,
      dryRun,
      state,
    });

    return {
      ok: true,
      scope: context.scope,
      state,
      dry_run: dryRun,
      scanned_count: files.length,
      matched_count: matches.length,
      would_delete_count: matches.length,
      would_delete_bytes: matches.reduce((sum, file) => sum + file.size, 0),
      deleted_count: deletedCount,
      deleted_bytes: deletedBytes,
      invalid_file_count: invalidFileCount,
      skipped_file_count: skippedFileCount,
      limitations: [
        "Raw delete removes only local pending or sent raw telemetry queue files for the requested event id.",
        "Command output is aggregate-only and does not reveal raw prompt, response, event ids, batch ids, paths, or media filenames.",
        "Failed and quarantined telemetry require separate recovery or inspection flows.",
      ],
    };
  });
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatTelemetryRawDeleteText(report) {
  return [
    "Raw Telemetry Delete",
    "",
    `Scope: ${report.scope}`,
    `State: ${report.state}`,
    `Mode: ${report.dry_run ? "dry-run" : "write"}`,
    "No raw prompt, response, event id, path, or media filename is shown here.",
    "",
    "Delete summary:",
    `- Scanned files: ${formatNumber(report.scanned_count)}`,
    `- Matched files: ${formatNumber(report.matched_count)}`,
    `- Would delete: ${formatNumber(report.would_delete_count)}`,
    `- Would delete bytes: ${formatNumber(report.would_delete_bytes)}`,
    `- Deleted files: ${formatNumber(report.deleted_count)}`,
    `- Deleted bytes: ${formatNumber(report.deleted_bytes)}`,
    `- Invalid files: ${formatNumber(report.invalid_file_count)}`,
    `- Skipped files: ${formatNumber(report.skipped_file_count)}`,
    "",
    "Limitations:",
    report.limitations.map((item) => `- ${item}`).join("\n"),
    "",
  ].join("\n");
}
