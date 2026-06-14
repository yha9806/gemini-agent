import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDesignBrief } from "../src/design-brief.mjs";

test("runDesignBrief writes normalized brief JSON and DESIGN.md", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "design-brief-"));
  try {
    const generated = {
      kind: "design_brief",
      run_id: "20260614T120000000Z-wrongid",
      goal: "Improve dashboard",
      target_user: "Operator",
      screens: [{ id: "admin", purpose: "Monitor telemetry" }],
      visual_direction: ["quiet"],
      design_system: { tokens: [{ name: "--surface", value: "#ffffff" }] },
      accessibility: ["AA contrast"],
      responsive_requirements: ["390px"],
      acceptance_criteria: ["Shows reliability"],
      implementation_risks: ["Shared CSS"],
      metadata: { model: "configured-design-model", generated_at: "2026-06-14T12:00:00.000Z" },
    };
    const result = await runDesignBrief({
      cwd,
      inputText: "Design a dashboard",
      apiKey: "key",
      env: { GEMINI_DESIGN_MODEL: "configured-design-model" },
      now: new Date("2026-06-14T12:00:00.000Z"),
      random: () => "abcdef",
      generate: async ({ runId, model }) => {
        assert.equal(model, "configured-design-model");
        return { ...generated, run_id: runId };
      },
    });

    assert.equal(result.brief.goal, "Improve dashboard");
    assert.equal(result.brief.run_id, result.run.runId);
    assert.match(result.run.dir, /\.gemini-agent\/design\/20260614T120000000Z-abcdef$/);
    assert.match(await readFile(join(result.run.dir, "DESIGN.md"), "utf8"), /# Design System/);

    const writtenBrief = JSON.parse(await readFile(join(result.run.dir, "brief.json"), "utf8"));
    assert.equal(writtenBrief.kind, "design_brief");
    assert.equal(writtenBrief.run_id, result.run.runId);
    assert.equal(writtenBrief.metadata.model, "configured-design-model");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
