import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handoffToMarkdown, runDesignHandoff } from "../src/design-handoff.mjs";

async function writeBrief(dir, overrides = {}) {
  await writeFile(join(dir, "brief.json"), `${JSON.stringify({
    kind: "design_brief",
    run_id: "20260614T120000000Z-abcdef",
    goal: "Dashboard",
    target_user: "Operator",
    screens: [{ id: "admin", purpose: "Monitor telemetry" }],
    visual_direction: ["quiet", "dense"],
    design_system: { tokens: [{ name: "--surface", value: "#ffffff" }] },
    accessibility: ["AA contrast"],
    responsive_requirements: ["390px and 1440px"],
    acceptance_criteria: ["Shows reliability"],
    implementation_risks: ["Shared CSS"],
    metadata: {},
    ...overrides,
  })}\n`);
}

function generatedHandoff(overrides = {}) {
  return {
    kind: "design_handoff",
    run_id: "wrong-run",
    selected_candidate: "wrong-candidate",
    implementation_summary: "Update dashboard cards.",
    file_hints: ["src/dashboard.tsx"],
    component_tasks: ["Add status row"],
    style_tokens: [{ name: "--surface", value: "#ffffff" }],
    responsive_tasks: ["Check mobile"],
    asset_tasks: ["Export icon assets"],
    verification: ["npm test"],
    open_questions: ["Confirm empty state copy"],
    risk_notes: ["Shared CSS may affect admin pages"],
    ...overrides,
  };
}

test("runDesignHandoff writes handoff JSON and codex tasks with injected generate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-handoff-"));
  try {
    await writeBrief(dir);
    const calls = [];
    const result = await runDesignHandoff({
      runDir: dir,
      apiKey: "key",
      selectedCandidate: "candidate-a",
      env: { GEMINI_DESIGN_MODEL: "configured-design-model" },
      generate: async (input) => {
        calls.push(input);
        return generatedHandoff();
      },
    });

    assert.equal(calls[0].model, "configured-design-model");
    assert.equal(calls[0].selectedCandidate, "candidate-a");
    assert.match(calls[0].prompt, /Goal: Dashboard/);
    assert.equal(result.handoff.run_id, "20260614T120000000Z-abcdef");
    assert.equal(result.handoff.selected_candidate, "candidate-a");
    assert.equal(result.handoff.verification[0], "npm test");

    const handoff = JSON.parse(await readFile(join(dir, "handoff.json"), "utf8"));
    assert.equal(handoff.kind, "design_handoff");
    assert.equal(handoff.run_id, "20260614T120000000Z-abcdef");
    assert.equal(handoff.selected_candidate, "candidate-a");

    const markdown = await readFile(join(dir, "codex-tasks.md"), "utf8");
    assert.match(markdown, /# Codex Tasks: Update dashboard cards\./);
    assert.match(markdown, /## Files/);
    assert.match(markdown, /- src\/dashboard\.tsx/);
    assert.match(markdown, /## Responsive Tasks/);
    assert.match(markdown, /- Check mobile/);
    assert.match(markdown, /## Verification/);
    assert.match(markdown, /- npm test/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runDesignHandoff rejects invalid generated handoff JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-handoff-"));
  try {
    await writeBrief(dir);
    await assert.rejects(() => runDesignHandoff({
      runDir: dir,
      apiKey: "key",
      generate: async () => ({
        kind: "design_handoff",
        run_id: "20260614T120000000Z-abcdef",
        selected_candidate: null,
        implementation_summary: "",
      }),
    }), /Invalid design handoff JSON/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("handoffToMarkdown includes fallback bullets for empty sections", () => {
  const markdown = handoffToMarkdown(generatedHandoff({
    file_hints: [],
    component_tasks: [],
    style_tokens: [],
    responsive_tasks: [],
    asset_tasks: [],
    verification: [],
    open_questions: [],
    risk_notes: [],
  }));
  assert.match(markdown, /## Files\n- None specified/);
  assert.match(markdown, /## Open Questions\n- None specified/);
});
