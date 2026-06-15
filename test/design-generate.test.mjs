import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDesignGeneratePrompt, runDesignGenerate } from "../src/design-generate.mjs";

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

test("runDesignGenerate writes candidate images and manifest with injected generator", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-generate-"));
  try {
    await writeBrief(dir);
    const calls = [];
    const result = await runDesignGenerate({
      runDir: dir,
      variants: 2,
      quality: "fast",
      apiKey: "key",
      generateImage: async ({ prompt, index, model }) => {
        calls.push({ prompt, index, model });
        return {
          mimeType: "image/png",
          buffer: Buffer.from(`image-${index}`),
        };
      },
      env: { GEMINI_IMAGE_MODEL: "configured-image-model" },
    });

    assert.equal(result.manifest.candidates.length, 2);
    assert.equal(calls[0].model, "configured-image-model");
    assert.match(calls[0].prompt, /Goal: Dashboard/);
    assert.equal(await readFile(join(dir, "candidates", "candidate-a.png"), "utf8"), "image-0");
    assert.equal(await readFile(join(dir, "candidates", "candidate-b.png"), "utf8"), "image-1");

    const manifest = JSON.parse(await readFile(join(dir, "candidates", "manifest.json"), "utf8"));
    assert.equal(manifest.kind, "design_candidates");
    assert.equal(manifest.run_id, "20260614T120000000Z-abcdef");
    assert.deepEqual(manifest.candidates.map((candidate) => candidate.file), [
      "candidate-a.png",
      "candidate-b.png",
    ]);
    assert.equal(manifest.candidates[0].status, "success");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runDesignGenerate can run candidate quality gate after image generation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-generate-"));
  try {
    await writeBrief(dir);
    const result = await runDesignGenerate({
      runDir: dir,
      variants: 1,
      quality: "fast",
      apiKey: "key",
      generateImage: async () => ({ mimeType: "image/png", buffer: Buffer.from("image") }),
      qualityGate: async ({ runDir }) => ({
        quality: {
          kind: "design_candidate_quality",
          run_id: "20260614T120000000Z-abcdef",
          selected_candidate: "candidate-a",
          candidates: [{
            id: "candidate-a",
            file: "candidate-a.png",
            score: 84,
            status: "pass",
            strengths: ["Clear hierarchy"],
            issues: [],
            recommended_actions: [],
            warnings: [],
          }],
          warnings: [],
          metadata: {},
        },
        qualityPath: join(runDir, "candidates", "quality.json"),
      }),
      env: { GEMINI_IMAGE_MODEL: "configured-image-model" },
    });

    assert.equal(result.quality.selected_candidate, "candidate-a");
    assert.equal(result.qualityPath, join(dir, "candidates", "quality.json"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runDesignGenerate fails clearly when image model is not configured", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-generate-"));
  try {
    await writeBrief(dir);
    await assert.rejects(() => runDesignGenerate({
      runDir: dir,
      variants: 1,
      quality: "fast",
      apiKey: "key",
      env: {},
    }), /GEMINI_IMAGE_MODEL/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runDesignGenerate requires pro image model for pro quality", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-generate-"));
  try {
    await writeBrief(dir);
    await assert.rejects(() => runDesignGenerate({
      runDir: dir,
      variants: 1,
      quality: "pro",
      apiKey: "key",
      env: { GEMINI_IMAGE_MODEL: "configured-image-model" },
    }), /GEMINI_IMAGE_PRO_MODEL/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runDesignGenerate validates variants and quality", async () => {
  await assert.rejects(() => runDesignGenerate({
    runDir: "/tmp/not-used",
    variants: 0,
    quality: "fast",
    env: { GEMINI_IMAGE_MODEL: "configured-image-model" },
  }), /--variants must be between 1 and 4/);

  await assert.rejects(() => runDesignGenerate({
    runDir: "/tmp/not-used",
    variants: 1,
    quality: "best",
    env: { GEMINI_IMAGE_MODEL: "configured-image-model" },
  }), /--quality must be fast or pro/);
});

test("buildDesignGeneratePrompt tolerates partially shaped brief objects", () => {
  const prompt = buildDesignGeneratePrompt({
    brief: { goal: "Dashboard" },
    index: 0,
  });
  assert.match(prompt, /Goal: Dashboard/);
  assert.match(prompt, /Target user: not specified/);
  assert.match(prompt, /Design tokens: not specified/);
});
