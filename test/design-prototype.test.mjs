import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPrototypePrompt, runDesignPrototype } from "../src/design-prototype.mjs";

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

function generatedPrototype(overrides = {}) {
  return {
    manifest: {
      kind: "design_prototype",
      run_id: "wrong-run",
      selected_candidate: "wrong-candidate",
      target_stack: "react",
      model: "wrong-model",
      files: ["preview.html", "review-notes.md"],
      preview_entry: "preview.html",
      review_notes: ["Review only"],
      limitations: ["Not production source"],
      integration_recommendation: "Use as a visual reference.",
      ...overrides.manifest,
    },
    files: overrides.files ?? [
      { path: "preview.html", content: "<!doctype html><title>Preview</title><main>Dashboard</main>" },
      { path: "review-notes.md", content: "# Review\n" },
    ],
  };
}

test("runDesignPrototype writes isolated static preview with injected generate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-prototype-"));
  try {
    await writeBrief(dir);
    const calls = [];
    const result = await runDesignPrototype({
      runDir: dir,
      apiKey: "key",
      targetStack: "html",
      selectedCandidate: "candidate-a",
      env: { GEMINI_DESIGN_MODEL: "configured-design-model" },
      generate: async (input) => {
        calls.push(input);
        return generatedPrototype();
      },
    });

    assert.equal(calls[0].model, "configured-design-model");
    assert.equal(calls[0].selectedCandidate, "candidate-a");
    assert.match(calls[0].prompt, /Goal: Dashboard/);
    assert.equal(result.manifest.run_id, "20260614T120000000Z-abcdef");
    assert.equal(result.manifest.selected_candidate, "candidate-a");
    assert.equal(result.manifest.target_stack, "html");
    assert.equal(result.manifest.model, "configured-design-model");
    assert.equal(result.manifest.preview_entry, "preview.html");
    assert.match(await readFile(join(dir, "prototype", "preview.html"), "utf8"), /Preview/);
    assert.match(await readFile(join(dir, "prototype", "review-notes.md"), "utf8"), /# Review/);

    const manifest = JSON.parse(await readFile(join(dir, "prototype", "manifest.json"), "utf8"));
    assert.equal(manifest.kind, "design_prototype");
    assert.equal(manifest.preview_entry, "preview.html");
    assert.deepEqual(manifest.files, ["preview.html", "review-notes.md"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runDesignPrototype rejects path traversal in generated files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-prototype-"));
  try {
    await writeBrief(dir);
    await assert.rejects(() => runDesignPrototype({
      runDir: dir,
      apiKey: "key",
      targetStack: "html",
      generate: async () => generatedPrototype({
        files: [{ path: "../src/app.js", content: "bad" }],
      }),
    }), /Prototype file path must stay/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runDesignPrototype rejects path traversal in manifest files and preview", async () => {
  const dir = await mkdtemp(join(tmpdir(), "design-prototype-"));
  try {
    await writeBrief(dir);
    await assert.rejects(() => runDesignPrototype({
      runDir: dir,
      apiKey: "key",
      targetStack: "html",
      generate: async () => generatedPrototype({
        manifest: { files: ["../preview.html"], preview_entry: "preview.html" },
      }),
    }), /Prototype file path must stay/);

    await assert.rejects(() => runDesignPrototype({
      runDir: dir,
      apiKey: "key",
      targetStack: "html",
      generate: async () => generatedPrototype({
        manifest: { files: ["preview.html"], preview_entry: "../preview.html" },
      }),
    }), /Prototype file path must stay/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runDesignPrototype validates target stack before reading run files", async () => {
  await assert.rejects(() => runDesignPrototype({
    runDir: "/tmp/not-used",
    targetStack: "vue",
    generate: async () => generatedPrototype(),
  }), /--target-stack must be html, react, tailwind, or auto/);
});

test("buildPrototypePrompt includes stack and candidate context", () => {
  const prompt = buildPrototypePrompt({
    targetStack: "tailwind",
    selectedCandidate: "candidate-a",
    brief: {
      run_id: "20260614T120000000Z-abcdef",
      goal: "Dashboard",
      target_user: "Operator",
      screens: [{ id: "admin", purpose: "Monitor telemetry" }],
      visual_direction: ["quiet"],
      design_system: { tokens: [{ name: "--surface", value: "#ffffff" }] },
      accessibility: ["AA contrast"],
      responsive_requirements: ["390px"],
      acceptance_criteria: ["Shows reliability"],
    },
  });
  assert.match(prompt, /Target stack: tailwind/);
  assert.match(prompt, /Selected candidate: candidate-a/);
  assert.match(prompt, /admin: Monitor telemetry/);
});
