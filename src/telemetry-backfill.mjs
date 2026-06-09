import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import {
  mediaReferenceMetadata,
  mediaBasename,
} from "./media-metadata.mjs";
import {
  RAW_TELEMETRY_SCHEMA_VERSION,
  maskCredentialText,
  normalizeRawTelemetryBatch,
} from "./telemetry-schemas.mjs";

const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_ARTIFACT_BYTES = 1024 * 1024;
const DEFAULT_PROMPT_RAW = "Backfilled gemini-agent artifact review JSON.";
const LOCAL_PATH_PATTERN = /\bfile:\/\/\/(?:Users|home|tmp|var|private|Volumes)\/[^\s"',)]+|\/(?:Users|home|tmp|var|private|Volumes)\/[^\s"',)]+/g;
const CORRECTION_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,48}$/;

function utcNow() {
  return new Date().toISOString();
}

function isoFromDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? utcNow() : date.toISOString();
}

function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}

function eventIdForArtifact(fileName, raw) {
  const safeName = fileName.replace(/[^A-Za-z0-9_.-]/g, "_");
  return `artifact_${safeName}_${hashText(raw).slice(0, 12)}`;
}

function correctionEventIdForArtifact(originalEventId, correctionVersion) {
  return `artifact_correction_${hashText(`${originalEventId}\0${correctionVersion}`).slice(0, 24)}`;
}

function normalizeCorrectionVersion(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !CORRECTION_VERSION_PATTERN.test(value)) {
    throw new Error("correctionVersion must contain 1-48 letters, numbers, dots, underscores, or dashes.");
  }
  return value;
}

function checksumEvents(events) {
  return `sha256:${hashText(JSON.stringify(events))}`;
}

function sanitizeLocalPath(match) {
  return `[PATH]/${basename(match.replace(/^file:\/\//, ""))}`;
}

export function sanitizeBackfillValue(value) {
  if (typeof value === "string") {
    return maskCredentialText(value).replace(LOCAL_PATH_PATTERN, sanitizeLocalPath);
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeBackfillValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeBackfillValue(item)]),
    );
  }
  return value;
}

function summaryText(artifact) {
  if (Array.isArray(artifact?.summary)) return artifact.summary.join(" ");
  if (typeof artifact?.summary === "string") return artifact.summary;
  return "";
}

function inferRunId(artifact) {
  const combined = [
    summaryText(artifact),
    ...(Array.isArray(artifact?.metadata?.sources) ? artifact.metadata.sources : []),
  ].join(" ");
  const match = combined.match(/Run\s+([0-9]+(?:\.[0-9]+)?[A-Za-z]?)/i)
    ?? combined.match(/run([0-9]+(?:[_-][0-9]+)?[A-Za-z]?)/i);
  if (!match) return null;
  return `run-${match[1].replace(/[_-]/g, ".").toLowerCase()}`;
}

function projectRootFromArtifactsDir(artifactsDir) {
  const resolved = resolve(artifactsDir);
  const segments = resolved.split(sep);
  const markerIndex = segments.lastIndexOf(".gemini-agent");
  if (markerIndex <= 0 || segments[markerIndex + 1] !== "artifacts") return null;
  const rootSegments = segments.slice(0, markerIndex);
  if (rootSegments.length === 1 && rootSegments[0] === "") return sep;
  return rootSegments.join(sep);
}

async function sourceManifest(artifact, { projectRoot } = {}) {
  const sources = Array.isArray(artifact?.metadata?.sources) ? artifact.metadata.sources : [];
  const manifest = [];
  for (const source of sources) {
    const safeSource = sanitizeBackfillValue(source);
    const referenceMetadata = await mediaReferenceMetadata(source, { root: projectRoot }) ?? {};
    const item = {
      basename: referenceMetadata.basename ?? mediaBasename(safeSource) ?? basename(`${safeSource}`),
    };
    const mimeType = referenceMetadata.mime_type;
    if (mimeType) item.mime_type = mimeType;
    const byteSize = referenceMetadata.byte_size;
    if (byteSize !== undefined) item.byte_size = byteSize;
    manifest.push(item);
  }
  return manifest;
}

async function rawEventFromArtifact({ fileName, raw, artifact, projectRoot, correctionVersion }) {
  const sanitized = sanitizeBackfillValue(artifact);
  const generatedAt = artifact?.metadata?.generated_at || new Date().toISOString();
  const artifactType = typeof artifact?.artifact_type === "string" ? artifact.artifact_type : "unknown";
  const runId = inferRunId(artifact);
  const originalEventId = eventIdForArtifact(fileName, raw);
  const isCorrection = correctionVersion !== null;

  return {
    event_id: isCorrection
      ? correctionEventIdForArtifact(originalEventId, correctionVersion)
      : originalEventId,
    source_host_app: "other",
    trigger_source: "manual",
    model_provider: "google",
    model: artifact?.metadata?.model || "gemini-3.5-flash",
    command: isCorrection ? "artifact-review-backfill-correction" : "artifact-review-backfill",
    started_at: generatedAt,
    ended_at: generatedAt,
    latency_ms: 0,
    status: "success",
    usage: null,
    request_raw: null,
    prompt_raw: DEFAULT_PROMPT_RAW,
    response_raw: JSON.stringify(sanitized),
    response_candidates_raw: [],
    tool_calls_raw: [],
    media_manifest: await sourceManifest(artifact, { projectRoot }),
    error: null,
    metadata: {
      backfill_source: isCorrection ? "artifact_review_json_correction" : "artifact_review_json",
      ...(isCorrection ? {
        correction_for_event_id: originalEventId,
        correction_version: correctionVersion,
        correction_reason: "media_manifest_enrichment",
      } : {}),
      artifact_type: artifactType,
      generated_at: generatedAt,
      source_file: sanitizeBackfillValue(fileName),
      source_paths: sanitizeBackfillValue(artifact?.metadata?.sources ?? []),
      context: {
        run_id: runId,
      },
      outcome: {
        task_outcome: "unknown",
        user_acceptance: "unknown",
      },
      economics: {
        cost_bucket: "low",
      },
    },
  };
}

async function artifactFiles(artifactsDir) {
  const entries = await readdir(artifactsDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "latest.json")
    .map((entry) => entry.name)
    .sort();
}

export async function artifactReviewsToRawTelemetryBatch({
  artifactsDir,
  deploymentId,
  agentVersion,
  batchId = `batch_artifact_backfill_${randomUUID()}`,
  generatedAt = new Date(),
  maxFiles = DEFAULT_MAX_FILES,
  maxArtifactBytes = DEFAULT_MAX_ARTIFACT_BYTES,
  correctionVersion,
} = {}) {
  if (typeof artifactsDir !== "string" || !artifactsDir.trim()) {
    throw new Error("artifactsDir is required.");
  }
  if (typeof deploymentId !== "string" || !deploymentId.trim()) {
    throw new Error("deploymentId is required.");
  }
  if (typeof agentVersion !== "string" || !agentVersion.trim()) {
    throw new Error("agentVersion is required.");
  }
  if (!Number.isInteger(maxFiles) || maxFiles <= 0) {
    throw new RangeError("maxFiles must be a positive integer.");
  }
  if (!Number.isInteger(maxArtifactBytes) || maxArtifactBytes <= 0) {
    throw new RangeError("maxArtifactBytes must be a positive integer.");
  }
  const normalizedCorrectionVersion = normalizeCorrectionVersion(correctionVersion);

  const files = await artifactFiles(artifactsDir);
  if (files.length > maxFiles) {
    throw new Error(`Backfill found too many artifact review files: ${files.length} > ${maxFiles}.`);
  }

  const events = [];
  const projectRoot = projectRootFromArtifactsDir(artifactsDir);
  for (const fileName of files) {
    const path = join(artifactsDir, fileName);
    const info = await stat(path);
    if (info.size > maxArtifactBytes) {
      throw new Error(`Artifact review file exceeds maxArtifactBytes: ${fileName}.`);
    }
    const raw = await readFile(path, "utf8");
    const artifact = JSON.parse(raw);
    events.push(await rawEventFromArtifact({
      fileName,
      raw,
      artifact,
      projectRoot,
      correctionVersion: normalizedCorrectionVersion,
    }));
  }

  if (events.length === 0) {
    throw new Error("No timestamped artifact review JSON files found for backfill.");
  }

  return normalizeRawTelemetryBatch({
    schema_version: RAW_TELEMETRY_SCHEMA_VERSION,
    batch_id: batchId,
    deployment_id: deploymentId,
    agent_version: agentVersion,
    generated_at: isoFromDate(generatedAt),
    checksum: checksumEvents(events),
    events,
  });
}
