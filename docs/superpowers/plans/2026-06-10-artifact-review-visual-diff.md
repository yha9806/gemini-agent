# Artifact Review Visual Diff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `artifact-review` to support bounded multi-image visual comparison while preserving the existing artifact review JSON contract and safe telemetry behavior.

**Architecture:** Parse repeated `--file` flags in the CLI, normalize `file`/`files` in `runArtifactReview`, build one image part per source, and add comparison-specific prompt guidance through `buildArtifactReviewPrompt`. Telemetry continues to use the existing content-part media metadata collector so raw image bytes are not added to event metadata.

**Tech Stack:** Node.js ESM, `node:test`, `@google/genai` content parts, existing Gemini Agent CLI/test helpers.

---

## File Structure

- Modify `src/cli.mjs`: update artifact-review usage, `parseArtifactArgs`, `runArtifactReviewCommand`, and prevalidation loop.
- Modify `src/artifact-review.mjs`: accept `files`, `reviewMode`, max file count, multi-image contents, metadata sources, and comparison artifact writing.
- Modify `src/prompts.mjs`: add `reviewMode` handling and comparison prompt guidance.
- Modify `test/artifact-review.test.mjs`: core multi-file behavior and limits.
- Modify `test/cli.test.mjs`: CLI parsing and pre-auth validation for repeated `--file`.
- Modify `test/prompts-and-schema.test.mjs`: prompt comparison guidance.
- Optionally modify `README.md`: document new multi-file example after tests are green.

## Task 1: Core Multi-File Artifact Review

**Files:**
- Modify: `test/artifact-review.test.mjs`
- Modify: `src/artifact-review.mjs`
- Modify: `src/prompts.mjs`
- Test: `test/artifact-review.test.mjs`

- [ ] **Step 1: Write failing tests**

Add tests showing two image parts plus one prompt, source metadata for both files, comparison prompt guidance, and max file rejection.

```js
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
  assert.deepEqual(seenContents[0].inlineData.mimeType, "image/png");
  assert.deepEqual(seenContents[1].inlineData.mimeType, "image/png");
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
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
node --test test/artifact-review.test.mjs --test-name-pattern "multiple image|too many files"
```

Expected: FAIL because `files` and `reviewMode` are not implemented.

- [ ] **Step 3: Implement minimal core support**

In `src/artifact-review.mjs`, normalize sources and build image parts:

```js
const MAX_ARTIFACT_REVIEW_FILES = 4;
const ARTIFACT_REVIEW_MODES = new Set(["single", "comparison"]);

function normalizeReviewMode(mode, sourceCount) {
  const value = String(mode ?? "").trim().toLowerCase();
  if (!value) return sourceCount > 1 ? "comparison" : "single";
  if (!ARTIFACT_REVIEW_MODES.has(value)) throw new Error("--review-mode must be single or comparison.");
  return value;
}

function normalizeArtifactFiles({ file, files }) {
  const values = Array.isArray(files) ? files : file ? [file] : [];
  const normalized = values.map((value) => String(value ?? "").trim()).filter(Boolean);
  if (normalized.length === 0) throw new Error("--file requires a path.");
  if (normalized.length > MAX_ARTIFACT_REVIEW_FILES) throw new Error("artifact-review supports at most 4 files.");
  return normalized;
}
```

Then use `sources`, `resolvedFiles`, `imageParts`, and `reviewMode` in `runArtifactReview`.

In `src/prompts.mjs`, add `reviewMode` to `buildArtifactReviewPrompt` and include comparison-specific guidance when the mode is `comparison`.

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
node --test test/artifact-review.test.mjs --test-name-pattern "multiple image|too many files|sends image part"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/artifact-review.mjs src/prompts.mjs test/artifact-review.test.mjs
git commit -m "feat: support multi-file artifact review core"
```

## Task 2: CLI Multi-File Parsing And Validation

**Files:**
- Modify: `src/cli.mjs`
- Modify: `test/cli.test.mjs`
- Test: `test/cli.test.mjs`

- [ ] **Step 1: Write failing CLI tests**

Add tests for two files with fake response, unsupported second file before auth, invalid review mode, and too many files.

```js
test("artifact-review accepts multiple image files for comparison", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cli-"));
  await writeFile(join(dir, "before.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  await writeFile(join(dir, "after.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  const { stdout } = await execFileAsync(bin, [
    "artifact-review",
    "--file",
    "before.png",
    "--file",
    "after.png",
    "--kind",
    "ui",
    "--review-mode",
    "comparison",
  ], {
    cwd: dir,
    env: {
      ...process.env,
      HOME: CLI_TEST_HOME,
      GEMINI_API_KEY: "fake-key",
      GEMINI_AGENT_ALLOW_FAKE_RESPONSE: "1",
      GEMINI_AGENT_FAKE_RESPONSE: fakeArtifactReview,
    },
  });

  const parsed = JSON.parse(stdout);
  assert.equal(parsed.kind, "artifact_review");
  assert.deepEqual(parsed.metadata.sources, ["before.png", "after.png"]);
  assert.equal(parsed.metadata.review_mode, "comparison");
});
```

- [ ] **Step 2: Run CLI tests and verify RED**

Run:

```bash
node --test test/cli.test.mjs --test-name-pattern "multiple image|review-mode|unsupported artifact"
```

Expected: FAIL because `parseArtifactArgs` only accepts one `--file` and does not parse `--review-mode`.

- [ ] **Step 3: Implement CLI parser and prevalidation**

Update usage text:

```js
"  gemini-agent artifact-review --file <path> [--file <path> ...] [--kind image|ui|design|architecture|research] [--review-mode single|comparison] [--write-artifact]",
```

Update `parseArtifactArgs` to collect `files`, set `file` to the first value for compatibility, and reject invalid `--review-mode` early.

Update `runArtifactReviewCommand`:

```js
const { file, files, artifactKind, reviewMode, writeArtifact } = parseArtifactArgs(args);
const cwd = process.cwd();
for (const source of files) {
  await prevalidateArtifactFile(source, cwd);
}
```

Pass `files` and `reviewMode` to `runArtifactReview`.

- [ ] **Step 4: Run CLI tests and verify GREEN**

Run:

```bash
node --test test/cli.test.mjs --test-name-pattern "artifact-review"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli.mjs test/cli.test.mjs
git commit -m "feat: add artifact review comparison cli"
```

## Task 3: Telemetry And Documentation

**Files:**
- Modify: `test/telemetry-capture.test.mjs`
- Modify: `README.md`
- Modify: `test/package.test.mjs`
- Test: `test/telemetry-capture.test.mjs`, `test/package.test.mjs`

- [ ] **Step 1: Write focused telemetry/doc tests**

Extend the existing multimodal telemetry test to ensure two inline image parts produce two metadata items and do not contain base64.

Add README assertions for a repeated `--file` example and `--review-mode comparison`.

- [ ] **Step 2: Run tests and verify RED if docs are not updated**

Run:

```bash
node --test test/telemetry-capture.test.mjs --test-name-pattern "multimodal"
node --test test/package.test.mjs
```

Expected: telemetry should already pass through the existing collector once core support sends multiple image parts; README assertion fails until docs are updated.

- [ ] **Step 3: Update README**

Add a compact comparison example near existing artifact-review commands:

```bash
./bin/gemini-agent artifact-review --file before.png --file after.png --kind ui --review-mode comparison
```

Add one safety bullet noting that multi-file artifact review records media metadata but not raw image bytes in ordinary telemetry output.

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
node --test test/telemetry-capture.test.mjs --test-name-pattern "multimodal|media reference|fileData"
node --test test/package.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add README.md test/package.test.mjs test/telemetry-capture.test.mjs
git commit -m "docs: document artifact review visual diff"
```

## Task 4: Final Verification And Review

**Files:**
- No expected source edits unless review finds an issue.

- [ ] **Step 1: Run focused tests**

```bash
node --test test/artifact-review.test.mjs test/cli.test.mjs --test-name-pattern "artifact-review"
node --test test/prompts-and-schema.test.mjs --test-name-pattern "artifact review|comparison"
node --test test/telemetry-capture.test.mjs --test-name-pattern "multimodal|media reference|fileData"
node --test test/package.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run full verification**

```bash
git diff --check
npm test
```

Expected: PASS with zero failures.

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
