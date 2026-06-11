# Artifact Review Latency Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add artifact-review latency attribution metadata and aggregate reporting so slow multimodal routes can be diagnosed without exposing raw media or prompts.

**Architecture:** Keep the existing Gemini call telemetry boundary intact: top-level `latency_ms` remains the Gemini generation latency recorded by `generateJson`. Add separate safe `metadata.latency_stages_ms` for pre-Gemini artifact-review work that is accurately measured in `runArtifactReview`, plus aggregate-only summary output for those stages.

**Tech Stack:** Node.js ESM, `node:test`, existing telemetry summary helpers.

---

### Task 1: Capture Artifact-Review Stage Metadata

**Files:**
- Modify: `src/artifact-review.mjs`
- Test: `test/artifact-review.test.mjs`

- [ ] **Step 1: Write the failing test**

Add an artifact-review test that injects a deterministic clock and asserts generated telemetry includes:

```js
metadata: {
  latency_stages_ms: {
    media_prepare: 5,
    policy_prompt: 7,
    pre_gemini_total: 12,
  },
  media_file_count: 1,
  media_byte_count: 8,
}
```

Also assert raw filenames, image bytes, and base64 are not added to metadata.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/artifact-review.test.mjs --test-name-pattern latency`

Expected: FAIL because `runArtifactReview` does not yet expose stage metadata or clock injection.

- [ ] **Step 3: Write minimal implementation**

Add a local `nowMs = Date.now` option to `runArtifactReview`, measure:

- `media_prepare`: resolving/reading/encoding image parts and media metadata.
- `policy_prompt`: loading project policy and building the prompt.
- `pre_gemini_total`: `media_prepare + policy_prompt`.

Merge the safe metadata into `telemetry.metadata` before calling `generate`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/artifact-review.test.mjs --test-name-pattern latency`

Expected: PASS.

### Task 2: Aggregate Stage Attribution In Summary

**Files:**
- Modify: `src/telemetry-summary.mjs`
- Test: `test/telemetry-summary.test.mjs`

- [ ] **Step 1: Write the failing test**

Add telemetry events with `metadata.latency_stages_ms.media_prepare`, `policy_prompt`, and `pre_gemini_total`, then assert `summary.latency_stages.top_stages` includes aggregate p50/p95/max values and top commands. Include malformed stage metadata with invalid stage names, negative values, floats, strings, and unsafe path-like names, and assert they are ignored without leaking into JSON or text output.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/telemetry-summary.test.mjs --test-name-pattern "latency stage"`

Expected: FAIL because `summary.latency_stages` does not exist.

- [ ] **Step 3: Write minimal implementation**

Add a stage latency accumulator that accepts only safe stage names matching `/^[a-z][a-z0-9_]{0,63}$/` and nonnegative safe integer values. Reuse the existing nearest-rank percentile helper. Output:

```js
latency_stages: {
  stage_count: 0,
  top_stages: [],
}
```

Each stage row includes `stage`, `event_count`, `p50_ms`, `p95_ms`, `max_ms`, and `top_commands`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/telemetry-summary.test.mjs --test-name-pattern "latency stage"`

Expected: PASS.

### Task 3: Document And Review

**Files:**
- Modify: `README.md`
- Modify: `test/package.test.mjs`

- [ ] **Step 1: Add README assertion**

Assert README documents aggregate artifact-review latency stage attribution and says it does not expose raw prompts, responses, event ids, paths, or media file names.

- [ ] **Step 2: Update README**

Document that `telemetry summary` aggregates `latency_stages_ms` for artifact-review pre-Gemini diagnosis.

- [ ] **Step 3: Verify and review**

Run:

```bash
node --test test/artifact-review.test.mjs test/telemetry-summary.test.mjs test/package.test.mjs
npm test
git diff --no-ext-diff HEAD | ./bin/gemini-agent diff-review --auto-context-pack --stdin
```

Expected: tests pass and Gemini review returns `verdict: pass`.
