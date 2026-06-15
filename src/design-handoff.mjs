import { readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { generateDesignJson } from "./gemini-client.mjs";
import {
  GeminiDesignHandoffSchema,
  normalizeDesignBrief,
  normalizeDesignHandoff,
} from "./design-schemas.mjs";
import { resolveDesignModels } from "./design-model-router.mjs";
import { writeDesignJson } from "./design-run-store.mjs";

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function markdownList(items, mapper = (item) => item) {
  if (!Array.isArray(items) || items.length === 0) return ["- None specified"];
  return items.map((item) => `- ${mapper(item)}`);
}

function normalizedSelectedCandidate(selectedCandidate) {
  if (selectedCandidate === null || selectedCandidate === undefined) return null;
  const value = String(selectedCandidate).trim();
  return value || null;
}

function screenSummary(brief) {
  if (!Array.isArray(brief?.screens) || brief.screens.length === 0) return "not specified";
  return brief.screens.map((screen) => `${screen.id}: ${screen.purpose}`).join("; ");
}

function tokenSummary(brief) {
  const tokens = Array.isArray(brief?.design_system?.tokens) ? brief.design_system.tokens : [];
  if (tokens.length === 0) return "not specified";
  return tokens.map((token) => `${token.name}=${token.value}`).join(", ");
}

function listSummary(values) {
  return Array.isArray(values) && values.length > 0 ? values.join(", ") : "not specified";
}

function stringList(values) {
  return Array.isArray(values)
    ? values
      .filter((item) => typeof item === "string" && item.trim())
      .map((item) => item.trim())
    : [];
}

function conciseList(values, limit = 3) {
  const items = stringList(values).slice(0, limit);
  return items.length > 0 ? items.join(" | ") : null;
}

function displayValue(value, fallback = "not specified") {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function booleanFlag(value) {
  return value === true || value === "true";
}

function tokenMarkdown(token) {
  return `${token.name}: ${token.value}`;
}

async function readOptionalJson(runDir, relativePath) {
  try {
    const runRoot = await realpath(runDir);
    const candidatePath = resolve(runRoot, relativePath);
    const candidateRealPath = await realpath(candidatePath);
    const pathWithinRun = relative(runRoot, candidateRealPath);
    if (!pathWithinRun || pathWithinRun.startsWith("..") || isAbsolute(pathWithinRun)) {
      return {
        value: null,
        riskNote: `Optional design context ignored: ${relativePath} resolves outside the run directory.`,
      };
    }
    return {
      value: JSON.parse(await readFile(candidateRealPath, "utf8")),
      riskNote: null,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { value: null, riskNote: null };
    return {
      value: null,
      riskNote: `Optional design context ignored: ${relativePath} could not be read as JSON.`,
    };
  }
}

function optionalKindRisk({ value, relativePath, expectedKind }) {
  const actualKind = displayValue(plainObject(value).kind);
  if (actualKind === expectedKind) return null;
  return `Optional design context ignored: ${relativePath} kind=${actualKind}; expected ${expectedKind}.`;
}

function selectedQualityCandidate(quality, selectedCandidate) {
  const qualityObject = plainObject(quality);
  const candidates = Array.isArray(qualityObject.candidates)
    ? qualityObject.candidates.map(plainObject)
    : [];
  const candidateId = normalizedSelectedCandidate(selectedCandidate)
    || normalizedSelectedCandidate(qualityObject.selected_candidate);
  if (!candidateId) return null;
  return candidates.find((candidate) => normalizedSelectedCandidate(candidate.id) === candidateId) ?? null;
}

function candidateQualitySummary(quality, selectedCandidate) {
  const candidate = selectedQualityCandidate(quality, selectedCandidate);
  if (!candidate) return null;

  const id = displayValue(candidate.id, "unknown");
  const status = displayValue(candidate.status, "unknown");
  const score = displayValue(candidate.score, "unavailable");
  const base = `${id} status=${status} score=${score}`;
  const details = [];
  const warnings = conciseList(candidate.warnings, 2);
  if (warnings) details.push(`warnings=${warnings}`);
  const issues = conciseList(candidate.issues, 2);
  if (issues) details.push(`issues=${issues}`);
  const actions = conciseList(candidate.recommended_actions, 2);
  if (actions) details.push(`recommended_actions=${actions}`);
  const strengths = conciseList(candidate.strengths, 2);
  if (strengths) details.push(`strengths=${strengths}`);
  const detailText = details.length > 0 ? `; ${details.join("; ")}` : "";
  return {
    promptLine: `Selected candidate quality: ${base}${detailText}`,
    riskNote: `Candidate quality: ${base}${detailText}`,
    dedupeKey: base,
  };
}

function perceptionFallbackSummary(perception) {
  const perceptionObject = plainObject(perception);
  const metadata = plainObject(perceptionObject.metadata);
  const requestedProvider = displayValue(metadata.requested_provider, displayValue(perceptionObject.provider));
  const resolvedProvider = displayValue(metadata.resolved_provider, displayValue(perceptionObject.provider));
  const enrichment = displayValue(metadata.perception_enrichment);
  const fallbackUsed = booleanFlag(metadata.provider_fallback_used)
    || (requestedProvider !== "not specified" && resolvedProvider !== "not specified" && requestedProvider !== resolvedProvider);
  const shouldSurface = fallbackUsed || enrichment === "unavailable" || enrichment === "visual-review";
  if (!shouldSurface) return null;

  const reason = displayValue(metadata.provider_fallback_reason);
  const base = `requested=${requestedProvider} resolved=${resolvedProvider} reason=${reason} enrichment=${enrichment}`;
  const details = [];
  const warnings = conciseList(perceptionObject.warnings, 2);
  if (warnings) details.push(`warnings=${warnings}`);
  const constraints = conciseList(perceptionObject.implementation_constraints, 2);
  if (constraints) details.push(`implementation_constraints=${constraints}`);
  const observations = conciseList(perceptionObject.layout_observations, 2);
  if (observations) details.push(`layout_observations=${observations}`);
  const detailText = details.length > 0 ? `; ${details.join("; ")}` : "";
  return {
    promptLine: `Perception fallback: ${base}${detailText}`,
    riskNote: `Perception fallback: ${base}${detailText}`,
    dedupeKey: base,
  };
}

async function readDesignLoopContext(runDir, selectedCandidate) {
  const [quality, perception] = await Promise.all([
    readOptionalJson(runDir, "candidates/quality.json"),
    readOptionalJson(runDir, "perceive/perception.json"),
  ]);
  const promptLines = [];
  const riskNotes = [];

  for (const riskNote of [quality.riskNote, perception.riskNote].filter(Boolean)) {
    promptLines.push(riskNote);
    riskNotes.push({ text: riskNote, dedupeKey: riskNote });
  }

  if (quality.value) {
    const kindRisk = optionalKindRisk({
      value: quality.value,
      relativePath: "candidates/quality.json",
      expectedKind: "design_candidate_quality",
    });
    if (kindRisk) {
      promptLines.push(kindRisk);
      riskNotes.push({ text: kindRisk, dedupeKey: kindRisk });
    } else {
      const summary = candidateQualitySummary(quality.value, selectedCandidate);
      if (summary) {
        promptLines.push(summary.promptLine);
        riskNotes.push({ text: summary.riskNote, dedupeKey: summary.dedupeKey });
      }
    }
  }

  if (perception.value) {
    const kindRisk = optionalKindRisk({
      value: perception.value,
      relativePath: "perceive/perception.json",
      expectedKind: "design_perception",
    });
    if (kindRisk) {
      promptLines.push(kindRisk);
      riskNotes.push({ text: kindRisk, dedupeKey: kindRisk });
    } else {
      const summary = perceptionFallbackSummary(perception.value);
      if (summary) {
        promptLines.push(summary.promptLine);
        riskNotes.push({ text: summary.riskNote, dedupeKey: summary.dedupeKey });
      }
    }
  }

  return { promptLines, riskNotes };
}

function normalizedRiskNote(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function appendUniqueRiskNotes(existingRiskNotes, appendedRiskNotes) {
  const riskNotes = [...existingRiskNotes];
  const seen = new Set(riskNotes.map(normalizedRiskNote));
  for (const note of appendedRiskNotes) {
    const text = typeof note === "string" ? note : note?.text;
    if (typeof text !== "string" || !text.trim()) continue;
    const normalizedText = normalizedRiskNote(text);
    if (!seen.has(normalizedText)) {
      riskNotes.push(text);
      seen.add(normalizedText);
    }
  }
  return riskNotes;
}

function buildDesignHandoffPrompt({ brief, selectedCandidate, contextLines = [] }) {
  return [
    "Create a Codex implementation handoff for this design run.",
    "Return JSON only. Keep tasks concrete, implementation-oriented, and scoped to the described design.",
    `Run id: ${brief?.run_id || "not specified"}`,
    `Selected candidate: ${selectedCandidate || "none"}`,
    `Goal: ${brief?.goal || "not specified"}`,
    `Target user: ${brief?.target_user || "not specified"}`,
    `Screens: ${screenSummary(brief)}`,
    `Visual direction: ${listSummary(brief?.visual_direction)}`,
    `Design tokens: ${tokenSummary(brief)}`,
    `Accessibility: ${listSummary(brief?.accessibility)}`,
    `Responsive requirements: ${listSummary(brief?.responsive_requirements)}`,
    `Acceptance criteria: ${listSummary(brief?.acceptance_criteria)}`,
    `Implementation risks: ${listSummary(brief?.implementation_risks)}`,
    ...(contextLines.length > 0 ? ["Visual quality loop context:", ...contextLines] : []),
    "Include file hints, component tasks, style tokens, responsive tasks, asset tasks, verification, open questions, and risk notes.",
  ].join("\n");
}

export function handoffToMarkdown(handoff) {
  return [
    `# Codex Tasks: ${handoff.implementation_summary}`,
    "",
    `Run id: ${handoff.run_id}`,
    `Selected candidate: ${handoff.selected_candidate || "none"}`,
    "",
    "## Files",
    ...markdownList(handoff.file_hints),
    "",
    "## Component Tasks",
    ...markdownList(handoff.component_tasks),
    "",
    "## Style Tokens",
    ...markdownList(handoff.style_tokens, tokenMarkdown),
    "",
    "## Responsive Tasks",
    ...markdownList(handoff.responsive_tasks),
    "",
    "## Asset Tasks",
    ...markdownList(handoff.asset_tasks),
    "",
    "## Verification",
    ...markdownList(handoff.verification),
    "",
    "## Open Questions",
    ...markdownList(handoff.open_questions),
    "",
    "## Risk Notes",
    ...markdownList(handoff.risk_notes),
    "",
  ].join("\n");
}

export async function runDesignHandoff({
  runDir,
  apiKey,
  env = process.env,
  selectedCandidate = null,
  generate,
  telemetry,
  allowFakeResponse = false,
} = {}) {
  if (!runDir) throw new Error("runDir is required.");

  const resolvedRunDir = resolve(runDir);
  const brief = normalizeDesignBrief(JSON.parse(await readFile(join(resolvedRunDir, "brief.json"), "utf8")));
  const models = resolveDesignModels({ env });
  const selected = normalizedSelectedCandidate(selectedCandidate);
  const designLoopContext = await readDesignLoopContext(resolvedRunDir, selected);
  const prompt = buildDesignHandoffPrompt({
    brief,
    selectedCandidate: selected,
    contextLines: designLoopContext.promptLines,
  });
  const baseTelemetryMetadata = plainObject(telemetry?.metadata);
  const generated = generate
    ? await generate({
      apiKey,
      prompt,
      brief,
      selectedCandidate: selected,
      model: models.design_model,
      env,
      responseSchema: GeminiDesignHandoffSchema,
      telemetry,
    })
    : await generateDesignJson({
      apiKey,
      model: models.design_model,
      prompt,
      responseSchema: GeminiDesignHandoffSchema,
      normalize: normalizeDesignHandoff,
      env,
      allowFakeResponse,
      telemetry: telemetry ? {
        ...telemetry,
        command: "design-handoff",
        metadata: {
          ...baseTelemetryMetadata,
          design_stage: "handoff",
          actual_model: models.design_model,
        },
      } : telemetry,
    });

  const generatedHandoff = normalizeDesignHandoff({
    ...generated,
    run_id: brief.run_id,
    selected_candidate: selected,
  });
  const handoff = normalizeDesignHandoff({
    ...generatedHandoff,
    risk_notes: appendUniqueRiskNotes(generatedHandoff.risk_notes, designLoopContext.riskNotes),
  });

  const handoffPath = await writeDesignJson({
    runDir: resolvedRunDir,
    relativePath: "handoff.json",
    value: handoff,
  });
  const tasksPath = join(resolvedRunDir, "codex-tasks.md");
  await writeFile(tasksPath, handoffToMarkdown(handoff));

  return {
    handoff,
    artifacts: {
      handoff_json: handoffPath,
      codex_tasks: tasksPath,
    },
  };
}
