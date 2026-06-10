# Inline Media Telemetry Kind Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let inline `artifact-review` media produce safe `media_kind` telemetry without changing the Gemini API request payload.

**Architecture:** Add a telemetry-only `contents` override in `src/gemini-client.mjs`, isolated from the SDK request `contents`. Then have `src/artifact-review.mjs` pass safe source references through the telemetry object while continuing to send inline image parts to Gemini.

**Tech Stack:** Node.js ESM, `node:test`, existing `@google/genai` content parts, current raw telemetry capture pipeline.

---

## File Structure

- Modify `src/gemini-client.mjs`: add `telemetryContentsFor()` or equivalent logic so capture uses `telemetry.contents ?? event.contents`.
- Modify `test/gemini-client.test.mjs`: assert API request contents stay unchanged while telemetry capture receives override contents.
- Modify `src/artifact-review.mjs`: merge caller telemetry with `{ contents: sources.map(source => ({ source })) }`.
- Modify `test/artifact-review.test.mjs`: assert generated telemetry contains safe references, not inline base64.
- Modify `test/telemetry-capture.test.mjs`: add an integration-style capture test proving `media_kind` is inferred from safe artifact source references.

## Task 1: Gemini Client Telemetry Override

**Files:**
- Modify: `test/gemini-client.test.mjs`
- Modify: `src/gemini-client.mjs`
- Test: `test/gemini-client.test.mjs`

- [ ] **Step 1: Write failing test**

Add a test that passes distinct Gemini request contents and telemetry-only contents. The fake SDK must see only request contents, while fake telemetry capture sees only telemetry contents.

```js
test("generateJson keeps telemetry contents separate from Gemini request contents", async () => {
  const requestContents = [
    { inlineData: { mimeType: "image/png", data: "YWJjZA==" } },
    { text: "prompt" },
  ];
  const telemetryContents = [{ source: "checkout-screenshot.png" }];
  let seenRequestContents = null;
  let seenTelemetryContents = null;

  const result = await generateJson({
    apiKey: "fake-key",
    prompt: "review screenshot",
    contents: requestContents,
    responseSchema: GeminiArtifactReviewSchema,
    normalize: (value) => value,
    telemetry: {
      cwd: "/tmp/project",
      command: "artifact-review",
      contents: telemetryContents,
      capture: async (event) => {
        seenTelemetryContents = event.contents;
      },
    },
    makeAi: () => ({
      models: {
        async generateContent(request) {
          seenRequestContents = request.contents;
          return {
            text: JSON.stringify({
              kind: "artifact_review",
              artifact_type: "design",
              summary: [],
              important_details: [],
              design_or_research_findings: [],
              implementation_hints_for_codex: [],
              risks_or_ambiguities: [],
              questions_for_user: [],
              limitations: [],
              metadata: {
                model: "gemini-3.5-flash",
                generated_at: "2026-06-10T00:00:00.000Z",
                sources: [],
                omitted_sources: [],
              },
            }),
          };
        },
      },
    }),
  });

  assert.equal(result.kind, "artifact_review");
  assert.equal(seenRequestContents, requestContents);
  assert.equal(seenTelemetryContents, telemetryContents);
});
```

- [ ] **Step 2: Run test and verify RED**

Run:

```bash
node --test test/gemini-client.test.mjs --test-name-pattern "telemetry contents separate"
```

Expected: FAIL because telemetry capture currently receives the request `contents`.

- [ ] **Step 3: Implement minimal override**

Modify `captureTelemetry()` so it uses `telemetry.contents` only for capture:

```js
const telemetryContents = Object.hasOwn(telemetry, "contents") ? telemetry.contents : event.contents;
...
contents: telemetryContents,
```

Do not mutate `event.contents`, and do not pass `telemetry.contents` into the SDK request.

- [ ] **Step 4: Run test and verify GREEN**

Run:

```bash
node --test test/gemini-client.test.mjs --test-name-pattern "telemetry contents separate|reports raw prompt"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/gemini-client.mjs test/gemini-client.test.mjs
git commit -m "feat: separate telemetry contents from Gemini requests"
```

## Task 2: Artifact Review Safe Media References

**Files:**
- Modify: `test/artifact-review.test.mjs`
- Modify: `test/telemetry-capture.test.mjs`
- Modify: `src/artifact-review.mjs`
- Test: `test/artifact-review.test.mjs`, `test/telemetry-capture.test.mjs`

- [ ] **Step 1: Write failing tests**

Add an artifact review test proving the telemetry object passed to generation contains safe source references for all files.

```js
test("runArtifactReview passes safe media references for telemetry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-artifact-"));
  await writeFile(join(dir, "checkout-screenshot.png"), pngBytes);
  await writeFile(join(dir, "homepage-design.png"), pngBytes);
  let seenTelemetry = null;

  await runArtifactReview({
    apiKey: "fake-key",
    cwd: dir,
    files: ["checkout-screenshot.png", "homepage-design.png"],
    artifactKind: "ui",
    reviewMode: "comparison",
    telemetry: { cwd: dir, source: "cli", command: "artifact-review" },
    generate: async ({ telemetry }) => {
      seenTelemetry = telemetry;
      return fakeReview;
    },
  });

  assert.deepEqual(seenTelemetry.contents, [
    { source: "checkout-screenshot.png" },
    { source: "homepage-design.png" },
  ]);
});
```

Add a telemetry capture test proving source references infer `screenshot` and `design`.

```js
test("captureGeminiTelemetry infers media kind from artifact review telemetry references", async () => {
  resetTelemetryCaptureForTests();
  const cwd = await tempDir();
  await writeFile(join(cwd, "checkout-screenshot.png"), Buffer.from("not real png but count bytes"));
  await writeFile(join(cwd, "homepage-design.png"), Buffer.from("not real png but count bytes"));
  const appended = [];

  await captureGeminiTelemetry({
    cwd,
    command: "artifact-review",
    prompt: "compare screenshots",
    response: "ok",
    status: "success",
    contents: [
      { source: "checkout-screenshot.png" },
      { source: "homepage-design.png" },
    ],
    loadConfig: async () => ({ enabled: true, level: "raw", max_queue_bytes: 1024 }),
    appendEvent: async ({ event }) => appended.push(normalizeTelemetryEvent(event)),
  });

  assert.equal(appended[0].payload.multimodal[0].media_kind, "screenshot");
  assert.equal(appended[0].payload.multimodal[1].media_kind, "design");
  assert.doesNotMatch(JSON.stringify(appended[0].payload.multimodal), /checkout-screenshot|homepage-design/);
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node --test test/artifact-review.test.mjs --test-name-pattern "safe media references"
node --test test/telemetry-capture.test.mjs --test-name-pattern "infers media kind"
```

Expected: artifact-review test FAILS because telemetry references are not passed yet. Telemetry-capture test may pass if existing reference enrichment already works; if it passes, keep it as coverage for the behavior this slice depends on.

- [ ] **Step 3: Implement artifact-review telemetry references**

In `src/artifact-review.mjs`, create:

```js
function withArtifactTelemetryContents(telemetry, sources) {
  if (!telemetry) return telemetry;
  return {
    ...telemetry,
    contents: sources.map((source) => ({ source })),
  };
}
```

Pass this merged telemetry object to `generate`, leaving Gemini `contents` unchanged.

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
node --test test/artifact-review.test.mjs --test-name-pattern "safe media references|multiple image|sends image part"
node --test test/telemetry-capture.test.mjs --test-name-pattern "infers media kind|media reference|multiple inline"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/artifact-review.mjs test/artifact-review.test.mjs test/telemetry-capture.test.mjs
git commit -m "feat: classify artifact review telemetry media"
```

## Task 3: Verification And Handoff

**Files:**
- No expected source edits unless review finds issues.

- [ ] **Step 1: Run focused verification**

```bash
node --test test/artifact-review.test.mjs test/gemini-client.test.mjs --test-name-pattern "artifact|telemetry|contents"
node --test test/telemetry-capture.test.mjs test/media-metadata.test.mjs --test-name-pattern "multimodal|media|inline|kind|reference"
git diff --check
```

Expected: PASS.

- [ ] **Step 2: Run full verification**

```bash
npm test
```

Expected: PASS.

- [ ] **Step 3: Run Gemini diff review**

```bash
git diff main...HEAD | ./bin/gemini-agent diff-review --stdin
```

Expected: `verdict` is `pass` or only minor findings. Fix Critical or Important findings before finishing.

- [ ] **Step 4: Flush telemetry safely**

```bash
./bin/gemini-agent telemetry doctor --global --json
./bin/gemini-agent telemetry flush --global --batch-size 5 --timeout-ms 20000
./bin/gemini-agent telemetry doctor --global --json
```

Expected: final doctor has pending 0 and failed 0.

- [ ] **Step 5: Finish branch**

Use `superpowers:finishing-a-development-branch` after full verification.
