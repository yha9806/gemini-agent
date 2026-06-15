import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runDesignDraft, validateDesignDraftModelPreflight } from "../src/design-draft.mjs";

async function makeBriefRun(cwd) {
  const runId = "20260614T120000000Z-abcdef";
  const dir = join(cwd, ".gemini-agent", "design", runId);
  await mkdir(dir, { recursive: true });
  const brief = {
    kind: "design_brief",
    run_id: runId,
    goal: "Improve dashboard",
    target_user: "Operator",
    screens: [{ id: "admin", purpose: "Monitor telemetry" }],
    visual_direction: ["quiet"],
    design_system: { tokens: [] },
    accessibility: [],
    responsive_requirements: [],
    acceptance_criteria: [],
    implementation_risks: [],
    metadata: {},
  };
  await writeFile(join(dir, "brief.json"), `${JSON.stringify(brief)}\n`);
  return {
    run: { runId, dir },
    brief,
    artifacts: {
      brief_json: join(dir, "brief.json"),
      design_markdown: join(dir, "DESIGN.md"),
    },
  };
}

test("runDesignDraft orchestrates brief, generate, prototype, handoff, and summary", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "design-draft-"));
  const calls = [];
  try {
    const result = await runDesignDraft({
      cwd,
      inputText: "Design a telemetry dashboard",
      apiKey: "key",
      env: {
        GEMINI_DESIGN_MODEL: "configured-design-model",
        GEMINI_IMAGE_MODEL: "configured-image-model",
      },
      variants: 2,
      quality: "fast",
      targetStack: "html",
      runners: {
        brief: async (input) => {
          calls.push(["brief", input.inputText]);
          return makeBriefRun(cwd);
        },
        generate: async (input) => {
          calls.push(["generate", input.variants, input.quality]);
          return { manifest: { candidates: [{ id: "candidate-a", file: "candidate-a.png" }] } };
        },
        prototype: async (input) => {
          calls.push(["prototype", input.selectedCandidate, input.targetStack]);
          return { manifest: { preview_entry: "preview.html" } };
        },
        handoff: async (input) => {
          calls.push(["handoff", input.selectedCandidate]);
          return { handoff: { implementation_summary: "Update dashboard cards." } };
        },
      },
    });

    assert.deepEqual(calls, [
      ["brief", "Design a telemetry dashboard"],
      ["generate", 2, "fast"],
      ["prototype", "candidate-a", "html"],
      ["handoff", "candidate-a"],
    ]);
    assert.equal(result.status, "success");
    assert.equal(result.run_id, "20260614T120000000Z-abcdef");
    assert.equal(result.selected_candidate, "candidate-a");
    assert.equal(result.steps.map((step) => step.name).join(","), "brief,generate,perceive,prototype,handoff");
    const summary = JSON.parse(await readFile(join(result.run_dir, "draft-summary.json"), "utf8"));
    assert.equal(summary.kind, "design_draft_summary");
    assert.equal(summary.status, "success");
    assert.equal(summary.model_routes.design_model, "configured-design-model");
    assert.equal(summary.model_routes.image_model, "configured-image-model");
    assert.match(summary.next_actions.join("\n"), /codex-tasks\.md/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runDesignDraft can create a text-only draft when generation and prototype are skipped", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "design-draft-"));
  const calls = [];
  try {
    const result = await runDesignDraft({
      cwd,
      inputText: "Create a settings page",
      apiKey: "key",
      env: { GEMINI_DESIGN_MODEL: "configured-design-model" },
      skipGenerate: true,
      skipPrototype: true,
      runners: {
        brief: async () => {
          calls.push("brief");
          return makeBriefRun(cwd);
        },
        handoff: async () => {
          calls.push("handoff");
          return { handoff: { implementation_summary: "Build settings page." } };
        },
      },
    });
    assert.deepEqual(calls, ["brief", "handoff"]);
    assert.equal(result.steps.find((step) => step.name === "generate").status, "skipped");
    assert.equal(result.steps.find((step) => step.name === "prototype").status, "skipped");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runDesignDraft selects highest passing quality candidate", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "design-draft-"));
  const calls = [];
  try {
    const result = await runDesignDraft({
      cwd,
      inputText: "Design a telemetry dashboard",
      apiKey: "key",
      env: {
        GEMINI_DESIGN_MODEL: "configured-design-model",
        GEMINI_IMAGE_MODEL: "configured-image-model",
      },
      runners: {
        brief: () => makeBriefRun(cwd),
        generate: async () => ({
          manifest: {
            candidates: [
              { id: "candidate-a", file: "candidate-a.png" },
              { id: "candidate-b", file: "candidate-b.png" },
            ],
          },
          quality: {
            selected_candidate: "candidate-b",
            candidates: [
              { id: "candidate-a", score: 69, status: "warn", issues: ["Flat hierarchy"] },
              { id: "candidate-b", score: 88, status: "pass", issues: [] },
            ],
          },
        }),
        prototype: async (input) => {
          calls.push(["prototype", input.selectedCandidate]);
          return { manifest: { preview_entry: "preview.html" } };
        },
        handoff: async (input) => {
          calls.push(["handoff", input.selectedCandidate]);
          return { handoff: { implementation_summary: "Update dashboard cards." } };
        },
      },
    });

    assert.equal(result.selected_candidate, "candidate-b");
    assert.equal(result.candidate_quality.status, "pass");
    assert.deepEqual(calls, [["prototype", "candidate-b"], ["handoff", "candidate-b"]]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runDesignDraft preserves run when all generated candidates fail quality", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "design-draft-"));
  try {
    await assert.rejects(
      () => runDesignDraft({
        cwd,
        inputText: "Design a telemetry dashboard",
        apiKey: "key",
        env: {
          GEMINI_DESIGN_MODEL: "configured-design-model",
          GEMINI_IMAGE_MODEL: "configured-image-model",
        },
        runners: {
          brief: () => makeBriefRun(cwd),
          generate: async () => ({
            manifest: { candidates: [{ id: "candidate-a", file: "candidate-a.png" }] },
            quality: {
              selected_candidate: null,
              candidates: [{ id: "candidate-a", score: 45, status: "fail", issues: ["Unreadable text"] }],
            },
          }),
        },
      }),
      /All generated design candidates failed the visual quality gate/,
    );
    const summary = JSON.parse(await readFile(
      join(cwd, ".gemini-agent", "design", "20260614T120000000Z-abcdef", "draft-summary.json"),
      "utf8",
    ));
    assert.equal(summary.status, "partial_failure");
    assert.match(summary.warnings.join("\n"), /visual quality gate/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("validateDesignDraftModelPreflight fails clearly when default generation lacks image model", () => {
  assert.throws(
    () => validateDesignDraftModelPreflight({ env: {}, quality: "fast", skipGenerate: false }),
    /GEMINI_IMAGE_MODEL is required.*design doctor.*--skip-generate/s,
  );
});

test("runDesignDraft writes partial summary before rethrowing a step failure", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "design-draft-"));
  try {
    await assert.rejects(
      () => runDesignDraft({
        cwd,
        inputText: "Design a dashboard",
        apiKey: "key",
        env: {
          GEMINI_DESIGN_MODEL: "configured-design-model",
          GEMINI_IMAGE_MODEL: "configured-image-model",
        },
        runners: {
          brief: () => makeBriefRun(cwd),
          generate: async () => ({ manifest: { candidates: [{ id: "candidate-a", file: "candidate-a.png" }] } }),
          prototype: async () => {
            throw new Error("prototype failed");
          },
        },
      }),
      /prototype failed/,
    );
    const summary = JSON.parse(await readFile(
      join(cwd, ".gemini-agent", "design", "20260614T120000000Z-abcdef", "draft-summary.json"),
      "utf8",
    ));
    assert.equal(summary.status, "partial_failure");
    assert.equal(summary.steps.find((step) => step.name === "prototype").status, "error");
    assert.match(summary.next_actions.join("\n"), /design prototype/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runDesignDraft ensures .gemini-agent is ignored before writing draft artifacts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "design-draft-"));
  try {
    await runDesignDraft({
      cwd,
      inputText: "Design a dashboard",
      apiKey: "key",
      env: { GEMINI_DESIGN_MODEL: "configured-design-model" },
      skipGenerate: true,
      skipPrototype: true,
      skipHandoff: true,
      runners: { brief: () => makeBriefRun(cwd) },
    });
    assert.match(await readFile(join(cwd, ".gitignore"), "utf8"), /^\.gemini-agent\/$/m);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runDesignDraft captures aggregate design-draft telemetry", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "design-draft-"));
  const events = [];
  try {
    const result = await runDesignDraft({
      cwd,
      inputText: "Design a dashboard",
      apiKey: "key",
      env: { GEMINI_DESIGN_MODEL: "configured-design-model" },
      skipGenerate: true,
      skipPrototype: true,
      skipHandoff: true,
      telemetry: {
        cwd,
        source: "cli",
        command: "design-draft",
        capture: async (event) => events.push(event),
      },
      runners: { brief: () => makeBriefRun(cwd) },
    });
    assert.equal(result.status, "success");
    assert.equal(events.length, 1);
    assert.equal(events[0].command, "design-draft");
    assert.equal(events[0].status, "success");
    assert.equal(events[0].metadata.design_stage, "draft");
    assert.deepEqual(events[0].metadata.draft_steps_completed, [
      "brief",
      "generate",
      "perceive",
      "prototype",
      "handoff",
    ]);
    assert.deepEqual(events[0].metadata.draft_steps_requested, [
      "brief",
      "generate",
      "perceive",
      "prototype",
      "handoff",
    ]);
    assert.equal(events[0].metadata.actual_design_model, "configured-design-model");
    assert.equal(events[0].metadata.vision_banana_provider, "missing");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
