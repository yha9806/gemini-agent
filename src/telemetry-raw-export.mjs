import {
  chmod,
  open,
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { loadTelemetryConfigContext } from "./telemetry-config.mjs";
import { telemetryQueueDirs } from "./telemetry-queue.mjs";
import {
  maskCredentialText,
  normalizeTelemetryEvent,
} from "./telemetry-schemas.mjs";

const CREDENTIAL_SCAN_CHAR_LIMIT = 64 * 1024;
const SUPPORTED_STATES = new Set(["pending", "sent"]);

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
}

function zeroExportCounts() {
  return {
    prompt_events: 0,
    response_events: 0,
    prompt_bytes: 0,
    response_bytes: 0,
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

function addEventCounts(counts, event) {
  if (event.prompt) {
    counts.prompt_events += 1;
    counts.prompt_bytes += textByteLength(event.prompt);
  }
  if (event.response) {
    counts.response_events += 1;
    counts.response_bytes += textByteLength(event.response);
  }

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
  throw new Error("telemetry raw export only supports pending or sent states.");
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  if (isAbsolute(rel)) return false;
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && rel !== "..");
}

async function canonicalOutputPath({ output, cwd, dirs }) {
  if (typeof output !== "string" || !output.trim()) {
    throw new Error("--output is required.");
  }

  const resolvedOutput = resolve(cwd, output);
  const parent = dirname(resolvedOutput);
  let canonicalParent;
  try {
    canonicalParent = await realpath(parent);
  } catch {
    throw new Error("Telemetry raw export output parent directory is not accessible.");
  }
  const canonicalOutput = join(canonicalParent, basename(resolvedOutput));
  let canonicalQueue;
  try {
    canonicalQueue = await realpath(dirs.queue);
  } catch {
    canonicalQueue = resolve(cwd, dirs.queue);
  }
  if (isInside(canonicalQueue, canonicalOutput)) {
    throw new Error("Telemetry raw export output path must not be inside telemetry queue storage.");
  }
  return canonicalOutput;
}

async function createOutputHandle(path) {
  try {
    return await open(path, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error("Telemetry raw export output file already exists.");
    }
    throw new Error("Telemetry raw export output file could not be created.");
  }
}

async function readEventFile(path) {
  try {
    return normalizeTelemetryEvent(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return { skipped: true };
    return { invalid: true };
  }
}

export async function runTelemetryRawExport({
  cwd = process.cwd(),
  home,
  scope = "auto",
  state,
  output,
  limit,
  confirmRawContent = false,
  format = "jsonl",
} = {}) {
  if (!confirmRawContent) {
    throw new Error("--confirm-raw-content is required before exporting raw prompt/response telemetry.");
  }
  if (!SUPPORTED_STATES.has(state)) {
    throw new Error("telemetry raw export only supports pending or sent states.");
  }
  assertPositiveInteger(limit, "limit");
  if (format !== "jsonl") {
    throw new Error("telemetry raw export only supports jsonl format.");
  }

  const context = await loadTelemetryConfigContext({ cwd, home, scope });
  const dirs = telemetryQueueDirs(context.storageCwd);
  const outputPath = await canonicalOutputPath({
    output,
    cwd,
    dirs,
  });
  const files = await candidateFiles({ dirs, state });
  const selected = files.slice(0, limit);
  const counts = zeroExportCounts();
  let exportedCount = 0;
  let invalidFileCount = 0;
  let skippedFileCount = 0;
  let outputBytes = 0;
  const handle = await createOutputHandle(outputPath);

  try {
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
      addEventCounts(counts, event);
      const line = `${JSON.stringify(event)}\n`;
      outputBytes += Buffer.byteLength(line, "utf8");
      await handle.write(line);
      exportedCount += 1;
    }
  } finally {
    await handle.close();
  }
  await chmod(outputPath, 0o600).catch(() => {});

  return {
    ok: true,
    scope: context.scope,
    state,
    format,
    matched_count: files.length,
    selected_count: selected.length,
    exported_count: exportedCount,
    invalid_file_count: invalidFileCount,
    skipped_file_count: skippedFileCount,
    excluded_by_limit_count: Math.max(0, files.length - selected.length),
    output_bytes: outputBytes,
    ...counts,
    limitations: [
      "Raw export writes prompt and response content to the requested local file.",
      "Command output is aggregate-only and does not reveal raw prompt, response, event ids, batch ids, paths, or media filenames.",
      "Only pending and sent telemetry are supported; failed and quarantined data require separate recovery or inspection flows.",
      "Existing export files are never overwritten.",
    ],
  };
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatTelemetryRawExportText(report) {
  return [
    "Raw Telemetry Export",
    "",
    `Scope: ${report.scope}`,
    `State: ${report.state}`,
    `Format: ${report.format}`,
    "Raw prompt/response content was written only to the requested local output file.",
    "No raw prompt or response content is shown here.",
    "",
    "Export summary:",
    `- Matched files: ${formatNumber(report.matched_count)}`,
    `- Selected files: ${formatNumber(report.selected_count)}`,
    `- Exported events: ${formatNumber(report.exported_count)}`,
    `- Invalid files: ${formatNumber(report.invalid_file_count)}`,
    `- Skipped files: ${formatNumber(report.skipped_file_count)}`,
    `- Excluded by limit: ${formatNumber(report.excluded_by_limit_count)}`,
    `- Output bytes: ${formatNumber(report.output_bytes)}`,
    "",
    "Raw risk signals for exported events:",
    `- Prompt events: ${formatNumber(report.prompt_events)}`,
    `- Response events: ${formatNumber(report.response_events)}`,
    `- Prompt bytes: ${formatNumber(report.prompt_bytes)}`,
    `- Response bytes: ${formatNumber(report.response_bytes)}`,
    `- Multimodal events: ${formatNumber(report.multimodal_events)}`,
    `- Media items: ${formatNumber(report.media_item_count)}`,
    `- Credential-like prompt events: ${formatNumber(report.credential_like_prompt_events)}`,
    `- Credential-like response events: ${formatNumber(report.credential_like_response_events)}`,
    "",
    "Limitations:",
    report.limitations.map((item) => `- ${item}`).join("\n"),
    "",
  ].join("\n");
}
