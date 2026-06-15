import { mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { normalizeDesignCandidateManifest, normalizeDesignCandidateQuality } from "./design-schemas.mjs";
import { writeDesignJson } from "./design-run-store.mjs";

const SCORE_FIELDS = [
  "overall_score",
  "visual_hierarchy_score",
  "clarity_score",
  "accessibility_score",
  "consistency_score",
  "implementation_readiness_score",
];

function boundedInteger(value) {
  return Number.isInteger(value) && value >= 0 && value <= 100;
}

function numericScores(scorecard = {}) {
  return SCORE_FIELDS
    .map((field) => scorecard[field])
    .filter(boundedInteger);
}

function averageScore(scores) {
  if (scores.length === 0) return null;
  return Math.round(scores.reduce((total, value) => total + value, 0) / scores.length);
}

function statusForScore(score) {
  if (!Number.isInteger(score)) return "unavailable";
  if (score >= 80) return "pass";
  if (score >= 60) return "warn";
  return "fail";
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()) : [];
}

function errorMessage(error) {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "unknown error";
  }
}

async function resolveContainedCandidateFile(outputDir, file) {
  if (typeof file !== "string" || !file.trim() || isAbsolute(file)) return null;
  try {
    const outputRoot = await realpath(outputDir);
    const candidatePath = resolve(outputRoot, file);
    const candidateRealPath = await realpath(candidatePath);
    const relativePath = relative(outputRoot, candidateRealPath);
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) return null;
    return candidateRealPath;
  } catch {
    return null;
  }
}

export function scoreCandidateReview({ candidateId, file, review }) {
  const scorecard = review?.design_scorecard && typeof review.design_scorecard === "object"
    ? review.design_scorecard
    : {};
  const score = averageScore(numericScores(scorecard));
  const statusScore = boundedInteger(scorecard.overall_score) ? scorecard.overall_score : score;
  return {
    id: candidateId,
    file,
    score,
    status: statusForScore(statusScore),
    strengths: stringList(scorecard.strengths),
    issues: stringList(scorecard.issues),
    recommended_actions: stringList(scorecard.recommended_actions),
    warnings: score === null ? ["Artifact review did not provide numeric design scorecard values."] : [],
  };
}

export function selectCandidateFromQuality(quality) {
  const candidates = Array.isArray(quality?.candidates) ? quality.candidates : [];
  const statusRank = { pass: 0, warn: 1 };
  const usable = candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter((entry) => entry.candidate.status === "pass" || entry.candidate.status === "warn")
    .sort((left, right) => (
      statusRank[left.candidate.status] - statusRank[right.candidate.status]
      || (right.candidate.score ?? -1) - (left.candidate.score ?? -1)
      || left.index - right.index
    ));
  return usable[0]?.candidate.id ?? null;
}

export async function runDesignCandidateQualityGate({
  runDir,
  reviewCandidate,
  telemetry,
} = {}) {
  if (!runDir) throw new Error("runDir is required.");
  if (typeof reviewCandidate !== "function") throw new Error("reviewCandidate is required.");

  const resolvedRunDir = resolve(runDir);
  const manifest = normalizeDesignCandidateManifest(JSON.parse(
    await readFile(join(resolvedRunDir, "candidates", "manifest.json"), "utf8"),
  ));
  const outputDir = resolve(resolvedRunDir, "candidates");
  await mkdir(outputDir, { recursive: true });

  const qualityCandidates = [];
  const warnings = [];
  for (const candidate of manifest.candidates) {
    const resolvedFilePath = await resolveContainedCandidateFile(outputDir, candidate.file);
    if (!resolvedFilePath) {
      qualityCandidates.push({
        id: candidate.id,
        file: candidate.file,
        score: null,
        status: "unavailable",
        strengths: [],
        issues: [],
        recommended_actions: [],
        warnings: ["Candidate file path is outside the candidates directory or cannot be resolved."],
      });
      continue;
    }
    if (candidate.status !== "success") {
      qualityCandidates.push({
        id: candidate.id,
        file: candidate.file,
        score: null,
        status: "unavailable",
        strengths: [],
        issues: [],
        recommended_actions: [],
        warnings: ["Candidate generation did not succeed."],
      });
      continue;
    }
    try {
      const review = await reviewCandidate({
        candidate,
        cwd: outputDir,
        file: candidate.file,
        filePath: resolvedFilePath,
        telemetry,
      });
      qualityCandidates.push(scoreCandidateReview({
        candidateId: candidate.id,
        file: candidate.file,
        review,
      }));
    } catch (error) {
      const message = `Candidate quality review failed for ${candidate.id}: ${errorMessage(error)}`;
      warnings.push(message);
      qualityCandidates.push({
        id: candidate.id,
        file: candidate.file,
        score: null,
        status: "unavailable",
        strengths: [],
        issues: [],
        recommended_actions: [],
        warnings: [message],
      });
    }
  }

  const selected = selectCandidateFromQuality({ candidates: qualityCandidates });
  const quality = normalizeDesignCandidateQuality({
    kind: "design_candidate_quality",
    run_id: manifest.run_id,
    selected_candidate: selected,
    candidates: qualityCandidates,
    warnings,
    metadata: {
      quality_gate: "artifact-review",
    },
  });
  const qualityPath = await writeDesignJson({
    runDir: resolvedRunDir,
    relativePath: join("candidates", "quality.json"),
    value: quality,
  });
  return { quality, qualityPath };
}
