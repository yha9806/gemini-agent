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
  let seenTelemetry = null;

  const review = await runArtifactReview({
    apiKey: "fake-key",
    cwd: dir,
    file: "design.png",
    now: new Date("2026-05-28T12:00:00.000Z"),
    nowMs: deterministicClock([1000, 1005, 1012]),
    generate: async ({ apiKey, prompt, contents, allowFakeResponse, telemetry }) => {
      seenApiKey = apiKey;
      seenPrompt = prompt;
      seenContents = contents;
      seenAllowFakeResponse = allowFakeResponse;
      seenTelemetry = telemetry;
      return fakeReview;
    },
    writeArtifact: true,
  });

  assert.equal(seenApiKey, "fake-key");
  assert.equal(seenAllowFakeResponse, false);
  assert.deepEqual(seenTelemetry, {
    cwd: dir,
    source: "cli",
    command: "artifact-review",
    contents: [{ source: "design.png", mime_type: "image/png", byte_size: pngBytes.length }],
    metadata: {
      latency_stages_ms: {
        media_prepare: 5,
        policy_prompt: 7,
        pre_gemini_total: 12,
      },
      media_file_count: 1,
      media_byte_count: pngBytes.length,
    },
  });
  assert.match(seenPrompt, /artifact review/i);
  assert.match(seenPrompt, /design\.png/);
  assert.deepEqual(seenContents[0], {
    inlineData: {
      data: pngBytes.toString("base64"),
      mimeType: "image/png",
    },
  });
  assert.deepEqual(seenContents[1], { text: seenPrompt });
  assert.equal(review.metadata.model, "gemini-3.5-flash");
  assert.equal(review.metadata.generated_at, "2026-05-28T12:00:00.000Z");
  assert.deepEqual(review.metadata.sources, ["design.png"]);
  assert.deepEqual(review.metadata.omitted_sources, []);
  assert.ok(Array.isArray(review.metadata.media_manifest));
  assert.deepEqual(review.metadata.media_manifest, [
    {
      mime_type: "image/png",
      byte_size: pngBytes.length,
      basename: review.metadata.media_manifest[0].basename,
      media_kind: "design",
    },
  ]);
  assert.match(review.metadata.media_manifest[0].basename, /^media-[a-f0-9]{12}\.png$/);

  const latest = JSON.parse(await readFile(join(dir, ".gemini-agent/artifacts/latest.json"), "utf8"));
  assert.equal(latest.kind, "artifact_review");
  assert.equal(latest.metadata.generated_at, "2026-05-28T12:00:00.000Z");
  assert.equal(latest.metadata.media_manifest[0].byte_size, pngBytes.length);
  assert.doesNotMatch(JSON.stringify(latest.metadata.media_manifest), /design\.png|inlineData|iVBOR|YWJjZA/);
});

test("runArtifactReview preserves explicit telemetry override and adds safe media references", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-artifact-"));
  await writeFile(join(dir, "design.png"), pngBytes);
  const telemetry = { cwd: "/override", source: "mcp", command: "gemini_artifact_review", awaitCapture: true };
  let seenTelemetry = null;

  await runArtifactReview({
    apiKey: "fake-key",
    cwd: dir,
    file: "design.png",
    telemetry,
    nowMs: deterministicClock([2000, 2003, 2011]),
    generate: async ({ telemetry: generatedTelemetry }) => {
      seenTelemetry = generatedTelemetry;
      return fakeReview;
    },
  });

  assert.deepEqual(seenTelemetry, {
    ...telemetry,
    contents: [{ source: "design.png", mime_type: "image/png", byte_size: pngBytes.length }],
    metadata: {
      latency_stages_ms: {
        media_prepare: 3,
        policy_prompt: 8,
        pre_gemini_total: 11,
      },
      media_file_count: 1,
      media_byte_count: pngBytes.length,
    },
  });
  assert.deepEqual(telemetry, { cwd: "/override", source: "mcp", command: "gemini_artifact_review", awaitCapture: true });
});

test("runArtifactReview passes safe media references for telemetry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-artifact-"));
  await writeFile(join(dir, "before.png"), pngBytes);
  await writeFile(join(dir, "after.png"), pngBytes);
  let seenTelemetry = null;

  await runArtifactReview({
    apiKey: "fake-key",
    cwd: dir,
    files: ["before.png", "after.png"],
    artifactKind: "ui",
    reviewMode: "comparison",
    telemetry: { cwd: dir, source: "cli", command: "artifact-review" },
    generate: async ({ telemetry: generatedTelemetry }) => {
      seenTelemetry = generatedTelemetry;
      return fakeReview;
    },
  });

  assert.deepEqual(seenTelemetry.contents, [
    { source: "before.png", mime_type: "image/png", byte_size: pngBytes.length, media_kind: "design" },
    { source: "after.png", mime_type: "image/png", byte_size: pngBytes.length, media_kind: "design" },
  ]);
  assert.doesNotMatch(JSON.stringify(seenTelemetry.contents), /inlineData|YWJjZA/);
});

function deterministicClock(values) {
  const queue = [...values];
  return () => queue.shift();
}

test("runArtifactReview records safe pre-Gemini latency attribution metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-artifact-"));
  await writeFile(join(dir, "design.png"), pngBytes);
  const clock = [1000, 1005, 1012];
  let seenTelemetry = null;

  await runArtifactReview({
    apiKey: "fake-key",
    cwd: dir,
    file: "design.png",
    nowMs: () => clock.shift(),
    generate: async ({ telemetry: generatedTelemetry }) => {
      seenTelemetry = generatedTelemetry;
      return fakeReview;
    },
  });

  assert.deepEqual(seenTelemetry.metadata, {
    latency_stages_ms: {
      media_prepare: 5,
      policy_prompt: 7,
      pre_gemini_total: 12,
    },
    media_file_count: 1,
    media_byte_count: pngBytes.length,
  });
  assert.doesNotMatch(JSON.stringify(seenTelemetry.metadata), /design\.png|inlineData|iVBOR|YWJjZA/);
});

test("runArtifactReview compares multiple image files in deterministic order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-artifact-"));
  await writeFile(join(dir, "before.png"), pngBytes);
  await writeFile(join(dir, "after.png"), pngBytes);

  let seenPrompt = "";
  let seenContents = null;
  const review = await runArtifactReview({
    apiKey: "fake-key",
    cwd: dir,
    files: ["before.png", "after.png"],
    artifactKind: "ui",
    reviewMode: "comparison",
    now: new Date("2026-06-10T12:00:00.000Z"),
    generate: async ({ prompt, contents }) => {
      seenPrompt = prompt;
      seenContents = contents;
      return fakeReview;
    },
  });

  assert.match(seenPrompt, /compare/i);
  assert.match(seenPrompt, /visual changes/i);
  assert.equal(seenContents.length, 3);
  assert.deepEqual(seenContents[0], {
    inlineData: {
      data: pngBytes.toString("base64"),
      mimeType: "image/png",
    },
  });
  assert.deepEqual(seenContents[1], {
    inlineData: {
      data: pngBytes.toString("base64"),
      mimeType: "image/png",
    },
  });
  assert.deepEqual(seenContents[2], { text: seenPrompt });
  assert.deepEqual(review.metadata.sources, ["before.png", "after.png"]);
  assert.equal(review.metadata.review_mode, "comparison");
});

test("runArtifactReview rejects too many files before generation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-artifact-"));
  for (const name of ["a.png", "b.png", "c.png", "d.png", "e.png"]) {
    await writeFile(join(dir, name), pngBytes);
  }

  await assert.rejects(
    () => runArtifactReview({
      apiKey: "fake-key",
      cwd: dir,
      files: ["a.png", "b.png", "c.png", "d.png", "e.png"],
      generate: assert.fail,
    }),
    /at most 4 files/,
  );
});

test("runArtifactReview rejects PDF with explicit unsupported runtime error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-artifact-"));
  const pdfPath = join(dir, "paper.pdf");
  await writeFile(pdfPath, "%PDF-1.7\n");

  await assert.rejects(
    () => runArtifactReview({
      apiKey: "fake-key",
      cwd: dir,
      file: "paper.pdf",
      generate: assert.fail,
    }),
    /PDF artifact review requires Files API support/,
  );
});

test("runArtifactReview rejects missing image files before generate is called", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-artifact-"));
  await assert.rejects(
    () => runArtifactReview({
      apiKey: "fake-key",
      cwd: dir,
      file: "missing.png",
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
      file: "design.png",
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
    file: "architecture.png",
    artifactKind: "architecture",
    generate: async () => ({
      ...fakeReview,
      artifact_type: "image",
    }),
  });

  assert.equal(review.artifact_type, "diagram");
});

test("runArtifactReview rejects absolute and cwd-escaping paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-artifact-"));
  const imagePath = join(dir, "design.png");
  await writeFile(imagePath, pngBytes);

  await assert.rejects(
    () => runArtifactReview({
      apiKey: "fake-key",
      cwd: dir,
      file: imagePath,
      generate: assert.fail,
    }),
    /File path must be relative to cwd/,
  );

  await assert.rejects(
    () => runArtifactReview({
      apiKey: "fake-key",
      cwd: dir,
      file: "../design.png",
      generate: assert.fail,
    }),
    /File path must stay within cwd/,
  );
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
