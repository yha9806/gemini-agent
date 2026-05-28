import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runArtifactReview } from "../src/artifact-review.mjs";

const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const fakeReview = {
  kind: "artifact_review",
  artifact_type: "image",
  summary: ["Dashboard screenshot"],
  important_details: ["Primary action is visible"],
  design_or_research_findings: ["Layout is readable"],
  implementation_hints_for_codex: ["Use existing button styles"],
  risks_or_ambiguities: [],
  questions_for_user: [],
  limitations: ["Single image only"],
  metadata: {
    model: "gemini-3.5-flash",
    generated_at: "2000-01-01T00:00:00.000Z",
    sources: [],
    omitted_sources: [],
  },
};

test("runArtifactReview sends image part and prompt part, attaches metadata, and writes artifact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-artifact-"));
  const imagePath = join(dir, "design.png");
  await writeFile(imagePath, pngBytes);

  let seenApiKey = "";
  let seenPrompt = "";
  let seenContents = null;
  let seenAllowFakeResponse = null;

  const review = await runArtifactReview({
    apiKey: "fake-key",
    cwd: dir,
    file: imagePath,
    now: new Date("2026-05-28T12:00:00.000Z"),
    generate: async ({ apiKey, prompt, contents, allowFakeResponse }) => {
      seenApiKey = apiKey;
      seenPrompt = prompt;
      seenContents = contents;
      seenAllowFakeResponse = allowFakeResponse;
      return fakeReview;
    },
    writeArtifact: true,
  });

  assert.equal(seenApiKey, "fake-key");
  assert.equal(seenAllowFakeResponse, false);
  assert.match(seenPrompt, /artifact review/i);
  assert.match(seenPrompt, new RegExp(imagePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.deepEqual(seenContents[0], {
    inlineData: {
      data: pngBytes.toString("base64"),
      mimeType: "image/png",
    },
  });
  assert.deepEqual(seenContents[1], { text: seenPrompt });
  assert.equal(review.metadata.model, "gemini-3.5-flash");
  assert.equal(review.metadata.generated_at, "2026-05-28T12:00:00.000Z");
  assert.deepEqual(review.metadata.sources, [imagePath]);
  assert.deepEqual(review.metadata.omitted_sources, []);

  const latest = JSON.parse(await readFile(join(dir, ".gemini-agent/artifacts/latest.json"), "utf8"));
  assert.equal(latest.kind, "artifact_review");
  assert.equal(latest.metadata.generated_at, "2026-05-28T12:00:00.000Z");
});

test("runArtifactReview rejects PDF with explicit unsupported runtime error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-artifact-"));
  const pdfPath = join(dir, "paper.pdf");
  await writeFile(pdfPath, "%PDF-1.7\n");

  await assert.rejects(
    () => runArtifactReview({
      apiKey: "fake-key",
      cwd: dir,
      file: pdfPath,
      generate: assert.fail,
    }),
    /PDF artifact review requires Files API support/,
  );
});

test("runArtifactReview rejects missing image files before generate is called", async () => {
  await assert.rejects(
    () => runArtifactReview({
      apiKey: "fake-key",
      file: "/path/that/does/not/exist.png",
      generate: assert.fail,
    }),
    /ENOENT/,
  );
});

test("runArtifactReview rejects invalid generated review via normalizeArtifactReview", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-artifact-"));
  const imagePath = join(dir, "design.png");
  await writeFile(imagePath, pngBytes);

  await assert.rejects(
    () => runArtifactReview({
      apiKey: "fake-key",
      cwd: dir,
      file: imagePath,
      generate: async () => ({ kind: "context_pack" }),
    }),
    /Invalid artifact review JSON/,
  );
});

test("runArtifactReview maps architecture artifact kind to diagram", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-artifact-"));
  const imagePath = join(dir, "architecture.png");
  await writeFile(imagePath, pngBytes);

  const review = await runArtifactReview({
    apiKey: "fake-key",
    cwd: dir,
    file: imagePath,
    artifactKind: "architecture",
    generate: async () => ({
      ...fakeReview,
      artifact_type: "image",
    }),
  });

  assert.equal(review.artifact_type, "diagram");
});

test("runArtifactReview requires file path", async () => {
  await assert.rejects(
    () => runArtifactReview({
      apiKey: "fake-key",
      generate: assert.fail,
    }),
    /--file requires a path\./,
  );
});
