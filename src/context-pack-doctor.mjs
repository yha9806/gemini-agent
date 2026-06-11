import { readFile, stat } from "node:fs/promises";
import { relative } from "node:path";
import { autoContextPackPath, resolveProjectRootForContextPack } from "./gate-input.mjs";
import { currentGitHead, execFileAsync } from "./git-utils.mjs";
import { normalizeContextPack } from "./schemas.mjs";
const DEFAULT_MAX_AGE_HOURS = 24;

function toPosixPath(path) {
  return path.split(/[/\\]+/).join("/");
}

function isoOrNull(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function hoursBetween(later, earlier) {
  return Number(((later.getTime() - earlier.getTime()) / (60 * 60 * 1000)).toFixed(4));
}

function recommendation(status) {
  if (status === "ready") return "Use --auto-context-pack or diff-review --smart-diff.";
  return "Run gemini-agent context-pack --bootstrap --write-artifact from the project root.";
}

export async function runContextPackDoctor({
  cwd = process.cwd(),
  now = new Date(),
  maxAgeHours = DEFAULT_MAX_AGE_HOURS,
  runner = execFileAsync,
} = {}) {
  const projectRoot = await resolveProjectRootForContextPack({ cwd, runner });
  const packPath = await autoContextPackPath({ cwd, runner });
  const relativePackPath = toPosixPath(relative(projectRoot, packPath));
  const base = {
    project_root: projectRoot,
    context_pack_path: relativePackPath,
    max_age_hours: maxAgeHours,
  };

  let stats;
  try {
    stats = await stat(packPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return {
      ...base,
      ok: false,
      status: "missing",
      exists: false,
      recommended_action: recommendation("missing"),
    };
  }

  let parsed;
  try {
    parsed = normalizeContextPack(JSON.parse(await readFile(packPath, "utf8")));
  } catch (error) {
    return {
      ...base,
      ok: false,
      status: "invalid",
      exists: true,
      bytes: stats.size,
      reason: error instanceof SyntaxError ? "invalid_json" : "invalid_schema",
      recommended_action: recommendation("invalid"),
    };
  }

  const generatedAtIso = isoOrNull(parsed.metadata?.generated_at);
  const generatedAt = generatedAtIso ? new Date(generatedAtIso) : null;
  const ageHours = generatedAt ? hoursBetween(now, generatedAt) : null;
  const packHead = typeof parsed.metadata?.git_head === "string" && parsed.metadata.git_head.trim()
    ? parsed.metadata.git_head.trim()
    : null;
  const currentHead = await currentGitHead({ cwd: projectRoot, runner });
  const gitHeadStatus = packHead && currentHead
    ? (packHead === currentHead ? "match" : "mismatch")
    : (currentHead ? "missing" : "unknown");
  const status = !generatedAt || ageHours > maxAgeHours || ["mismatch", "missing"].includes(gitHeadStatus)
    ? "stale"
    : "ready";

  return {
    ...base,
    ok: status === "ready",
    status,
    exists: true,
    bytes: stats.size,
    generated_at: generatedAtIso,
    age_hours: ageHours,
    git_head_status: gitHeadStatus,
    context_pack_git_head: packHead,
    current_git_head: currentHead,
    recommended_action: recommendation(status),
  };
}

export function formatContextPackDoctorText(result) {
  return [
    "Context Pack Doctor",
    `- Status: ${result.status}`,
    `- Project root: ${result.project_root}`,
    `- Context pack: ${result.context_pack_path}`,
    `- Exists: ${result.exists ? "yes" : "no"}`,
    `- Max age hours: ${result.max_age_hours}`,
    `- Recommended action: ${result.recommended_action}`,
  ].join("\n") + "\n";
}
