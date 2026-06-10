# Correction-Aware Multimodal Summary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a safe `multimodal_adjusted` section to `gemini-agent telemetry summary` so product analysis can see correction-aware media coverage without mutating raw events or exposing identifiers.

**Architecture:** Keep the existing raw `multimodal` and `corrections` sections unchanged. Extend `src/telemetry-summary.mjs` with compact in-memory reconciliation maps that store only event IDs and aggregate-ready media metadata, choose one best correction per original event, and build a separate adjusted aggregate at return time. Text output and recommendations read only aggregate counts.

**Tech Stack:** Node.js ESM, `node:test`, existing telemetry queue helpers, existing `telemetry-summary` aggregation code.

---

## File Structure

- Modify `src/telemetry-summary.mjs`
  - Add adjusted aggregate zero shape.
  - Add compact media normalization and aggregate helpers.
  - Add correction candidate ranking and final reconciliation.
  - Add text output block and correction-aware recommendation logic.
  - Reuse the existing `topCorrectionVersions(map, limit)` helper for public correction-version summaries.
- Modify `test/telemetry-summary.test.mjs`
  - Add focused tests for zero shape, adjusted correction aggregation, duplicate correction precedence, orphan/malformed corrections, privacy safety, recommendations, and top-limit behavior.
- Create this plan file only in `docs/superpowers/plans/`.

No README changes are needed in this slice because the CLI surface does not change.

## Task 1: Add Adjusted Summary Skeleton

**Files:**
- Modify: `test/telemetry-summary.test.mjs`
- Modify: `src/telemetry-summary.mjs`

- [ ] **Step 1: Write the failing zero-shape test**

In `test/telemetry-summary.test.mjs`, extend `runTelemetrySummary returns a zero summary for an enabled empty queue without creating queue dirs` after the existing `assert.deepEqual(result.palette_split, ...)` block:

```js
  assert.deepEqual(result.multimodal_adjusted, {
    event_count: 0,
    item_count: 0,
    byte_count: 0,
    unknown_mime_items: 0,
    unknown_byte_size_items: 0,
    unknown_kind_items: 0,
    media_items_with_mime: 0,
    media_items_with_byte_size: 0,
    media_items_with_kind: 0,
    correction_event_count: 0,
    corrected_original_event_count: 0,
    orphan_correction_event_count: 0,
    superseded_correction_event_count: 0,
    applied_correction_event_count: 0,
    top_media_mime: [],
    top_media_kind: [],
    top_correction_versions: [],
  });
```

Also add this assertion after `const text = formatTelemetrySummaryText(summary);` in `runTelemetrySummary aggregates multimodal metadata without exposing media file names`:

```js
  assert.match(text, /Adjusted multimodal:/);
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node --test test/telemetry-summary.test.mjs --test-name-pattern "zero summary|multimodal metadata"
```

Expected: FAIL because `multimodal_adjusted` does not exist and text output does not include `Adjusted multimodal:`.

- [ ] **Step 3: Add minimal zero shape and text block**

In `src/telemetry-summary.mjs`, add this function after `zeroMultimodal()`:

```js
function zeroAdjustedMultimodal() {
  return {
    ...zeroMultimodal(),
    correction_event_count: 0,
    corrected_original_event_count: 0,
    orphan_correction_event_count: 0,
    superseded_correction_event_count: 0,
    applied_correction_event_count: 0,
  };
}
```

In `runTelemetrySummary()`, after `const multimodal = { ... }`, add:

```js
  const multimodalAdjusted = {
    ...zeroAdjustedMultimodal(),
    top_media_mime: [],
    top_media_kind: [],
    top_correction_versions: [],
  };
```

Then add `multimodal_adjusted: multimodalAdjusted,` to the returned object immediately after `multimodal,`.

In `formatTelemetrySummaryText(summary)`, add these lines between the existing "Multimodal" block and "Corrections":

```js
    "Adjusted multimodal:",
    `- Events: ${formatNumber(summary.multimodal_adjusted?.event_count ?? 0)}`,
    `- Media items: ${formatNumber(summary.multimodal_adjusted?.item_count ?? 0)}`,
    `- Media bytes: ${formatNumber(summary.multimodal_adjusted?.byte_count ?? 0)}`,
    `- Unknown MIME items: ${formatNumber(summary.multimodal_adjusted?.unknown_mime_items ?? 0)}`,
    `- Unknown byte-size items: ${formatNumber(summary.multimodal_adjusted?.unknown_byte_size_items ?? 0)}`,
    `- Unknown media-kind items: ${formatNumber(summary.multimodal_adjusted?.unknown_kind_items ?? 0)}`,
    `- Applied correction events: ${formatNumber(summary.multimodal_adjusted?.applied_correction_event_count ?? 0)}`,
    `- Orphan correction events: ${formatNumber(summary.multimodal_adjusted?.orphan_correction_event_count ?? 0)}`,
    "",
```

- [ ] **Step 4: Run the test and verify GREEN**

Run:

```bash
node --test test/telemetry-summary.test.mjs --test-name-pattern "zero summary|multimodal metadata"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/telemetry-summary.mjs test/telemetry-summary.test.mjs
git commit -m "feat: add adjusted multimodal summary skeleton"
```

## Task 2: Apply Basic Correction Aggregates

**Files:**
- Modify: `test/telemetry-summary.test.mjs`
- Modify: `src/telemetry-summary.mjs`

- [ ] **Step 1: Write the failing applied-correction test**

Add this new test after `runTelemetrySummary reports correction overlays without polluting original multimodal totals`:

```js
test("runTelemetrySummary applies correction media to adjusted multimodal totals", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(401, {
      event_id: "artifact_original_private_screen",
      command: "artifact-review-backfill",
      prompt: "raw prompt private customer",
      response: "raw response private customer",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [{ basename: "private-customer-screen.png" }],
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(402, {
      event_id: "artifact_correction_private_screen",
      command: "artifact-review-backfill-correction",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [
          { mime_type: "image/png", byte_size: 100, basename: "private-customer-screen.png", media_kind: "screenshot" },
        ],
      },
      metadata: {
        correction_for_event_id: "artifact_original_private_screen",
        correction_version: "media-v1",
      },
    }),
  });

  const summary = await runTelemetrySummary({ cwd, scope: "local" });
  const text = formatTelemetrySummaryText(summary);
  const serialized = JSON.stringify(summary);

  assert.deepEqual(summary.multimodal, {
    event_count: 1,
    item_count: 1,
    byte_count: 0,
    unknown_mime_items: 1,
    unknown_byte_size_items: 1,
    unknown_kind_items: 1,
    media_items_with_mime: 0,
    media_items_with_byte_size: 0,
    media_items_with_kind: 0,
    top_media_mime: [
      { mime_type: "unknown", event_count: 1, item_count: 1, byte_count: 0 },
    ],
    top_media_kind: [
      { media_kind: "unknown", event_count: 1, item_count: 1, byte_count: 0 },
    ],
  });
  assert.deepEqual(summary.multimodal_adjusted, {
    event_count: 1,
    item_count: 1,
    byte_count: 100,
    unknown_mime_items: 0,
    unknown_byte_size_items: 0,
    unknown_kind_items: 0,
    media_items_with_mime: 1,
    media_items_with_byte_size: 1,
    media_items_with_kind: 1,
    correction_event_count: 1,
    corrected_original_event_count: 1,
    orphan_correction_event_count: 0,
    superseded_correction_event_count: 0,
    applied_correction_event_count: 1,
    top_media_mime: [
      { mime_type: "image/png", event_count: 1, item_count: 1, byte_count: 100 },
    ],
    top_media_kind: [
      { media_kind: "screenshot", event_count: 1, item_count: 1, byte_count: 100 },
    ],
    top_correction_versions: [
      {
        correction_version: "media-v1",
        event_count: 1,
        corrected_original_event_count: 1,
        media_item_count: 1,
        media_byte_count: 100,
      },
    ],
  });
  assert.match(text, /Applied correction events: 1/);
  assert.doesNotMatch(serialized, /artifact_original_private_screen/);
  assert.doesNotMatch(serialized, /artifact_correction_private_screen/);
  assert.doesNotMatch(serialized, /private-customer-screen/);
  assert.doesNotMatch(serialized, /raw prompt private customer/);
  assert.doesNotMatch(text, /private-customer-screen/);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node --test test/telemetry-summary.test.mjs --test-name-pattern "applies correction media"
```

Expected: FAIL because `multimodal_adjusted` remains zero.

- [ ] **Step 3: Add compact media aggregate helpers**

In `src/telemetry-summary.mjs`, add these helpers after `topMediaKind()`:

```js
function createMediaAggregate() {
  return {
    ...zeroMultimodal(),
    mediaMimes: createDimensionMap(),
    mediaKinds: createDimensionMap(),
  };
}

function compactMediaItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => {
    const mimeType = typeof item?.mime_type === "string" && item.mime_type.trim()
      ? item.mime_type
      : "unknown";
    const mediaKind = typeof item?.media_kind === "string" && item.media_kind.trim()
      ? item.media_kind
      : "unknown";
    const hasByteSize = Number.isInteger(item?.byte_size) && item.byte_size >= 0;
    return {
      mimeType,
      mediaKind,
      byteSize: hasByteSize ? item.byte_size : 0,
      hasByteSize,
    };
  });
}

function addCompactMediaItems(aggregate, items) {
  if (items.length === 0) return;
  aggregate.event_count += 1;
  const seenMimes = new Set();
  const seenKinds = new Set();
  for (const item of items) {
    aggregate.item_count += 1;
    aggregate.byte_count += item.byteSize;
    if (item.mimeType === "unknown") aggregate.unknown_mime_items += 1;
    else aggregate.media_items_with_mime += 1;
    if (!item.hasByteSize) aggregate.unknown_byte_size_items += 1;
    else aggregate.media_items_with_byte_size += 1;
    if (item.mediaKind === "unknown") aggregate.unknown_kind_items += 1;
    else aggregate.media_items_with_kind += 1;
    updateMediaMime(aggregate.mediaMimes, item.mimeType, item.byteSize, seenMimes);
    updateMediaKind(aggregate.mediaKinds, item.mediaKind, item.byteSize, seenKinds);
  }
}

function publicMediaAggregate(aggregate, topLimit) {
  return {
    event_count: aggregate.event_count,
    item_count: aggregate.item_count,
    byte_count: aggregate.byte_count,
    unknown_mime_items: aggregate.unknown_mime_items,
    unknown_byte_size_items: aggregate.unknown_byte_size_items,
    unknown_kind_items: aggregate.unknown_kind_items,
    media_items_with_mime: aggregate.media_items_with_mime,
    media_items_with_byte_size: aggregate.media_items_with_byte_size,
    media_items_with_kind: aggregate.media_items_with_kind,
    top_media_mime: topMediaMime(aggregate.mediaMimes, topLimit),
    top_media_kind: topMediaKind(aggregate.mediaKinds, topLimit),
  };
}
```

Then in `addEvent()`, replace the existing non-correction multimodal loop with:

```js
  const compactItems = compactMediaItems(multimodalItems);
  if (isCorrectionEvent(event)) {
    addCorrectionEvent(accumulator, event, multimodalItems);
    addAdjustedCorrectionCandidate(accumulator, event, compactItems);
  } else {
    accumulator.existingEventIds.add(event.event_id);
    if (compactItems.length > 0) {
      accumulator.adjustedOriginals.set(event.event_id, compactItems);
      addCompactMediaItems(accumulator.rawMedia, compactItems);
    }
  }
```

This step will need `rawMedia`, `existingEventIds`, and `adjustedOriginals`; add them in `createAccumulator()`:

```js
    rawMedia: createMediaAggregate(),
    existingEventIds: new Set(),
    adjustedOriginals: new Map(),
    adjustedCorrections: new Map(),
    adjustedMalformedCorrectionCount: 0,
    adjustedCorrectionSequence: 0,
```

In `runTelemetrySummary()`, build `multimodal` from the raw aggregate:

```js
  const multimodal = publicMediaAggregate(accumulator.rawMedia, topLimit);
```

Remove the direct use of `accumulator.mediaMimes` and `accumulator.mediaKinds` for raw multimodal after this change.

- [ ] **Step 4: Add basic correction candidate and adjusted builder**

Add these helpers after `addCorrectionEvent()`:

```js
function safeCorrectionTarget(event) {
  const target = event.metadata?.correction_for_event_id;
  return typeof target === "string" && target.trim() ? target : null;
}

function safeCorrectionVersion(event) {
  const version = sanitizeDimension(event.metadata?.correction_version, "unknown");
  return version && version !== "unknown" ? version : null;
}

function addAdjustedCorrectionCandidate(accumulator, event, mediaItems) {
  accumulator.adjustedCorrectionSequence += 1;
  const target = safeCorrectionTarget(event);
  const version = safeCorrectionVersion(event);
  if (!target || !version) {
    accumulator.adjustedMalformedCorrectionCount += 1;
    return;
  }
  const correction = {
    target,
    version,
    createdAt: event.created_at,
    sequence: accumulator.adjustedCorrectionSequence,
    mediaItems,
  };
  const candidates = accumulator.adjustedCorrections.get(target) ?? [];
  candidates.push(correction);
  accumulator.adjustedCorrections.set(target, candidates);
}

function buildAdjustedMultimodal(accumulator, topLimit) {
  const aggregate = createMediaAggregate();
  const appliedVersions = createDimensionMap();
  const appliedOriginals = new Set();
  let correctionEventCount = accumulator.adjustedMalformedCorrectionCount;
  let orphanCorrectionEventCount = accumulator.adjustedMalformedCorrectionCount;
  let supersededCorrectionEventCount = 0;
  let appliedCorrectionEventCount = 0;

  for (const [target, candidates] of accumulator.adjustedCorrections.entries()) {
    correctionEventCount += candidates.length;
    const originalExists = accumulator.existingEventIds.has(target);
    if (!originalExists) {
      orphanCorrectionEventCount += candidates.length;
      continue;
    }
    const originalItems = accumulator.adjustedOriginals.get(target) ?? [];
    const applied = candidates[candidates.length - 1];
    appliedOriginals.add(target);
    appliedCorrectionEventCount += 1;
    supersededCorrectionEventCount += Math.max(0, candidates.length - 1);
    addCompactMediaItems(aggregate, applied.mediaItems);
    const item = appliedVersions.get(applied.version) ?? {
      key: applied.version,
      event_count: 0,
      media_item_count: 0,
      media_byte_count: 0,
      correctedOriginalIds: new Set(),
    };
    item.event_count += 1;
    item.media_item_count += applied.mediaItems.length;
    item.media_byte_count += applied.mediaItems.reduce((total, media) => total + media.byteSize, 0);
    item.correctedOriginalIds.add(target);
    appliedVersions.set(applied.version, item);
  }

  for (const [eventId, originalItems] of accumulator.adjustedOriginals.entries()) {
    if (!appliedOriginals.has(eventId)) addCompactMediaItems(aggregate, originalItems);
  }

  return {
    ...publicMediaAggregate(aggregate, topLimit),
    correction_event_count: correctionEventCount,
    corrected_original_event_count: appliedOriginals.size,
    orphan_correction_event_count: orphanCorrectionEventCount,
    superseded_correction_event_count: supersededCorrectionEventCount,
    applied_correction_event_count: appliedCorrectionEventCount,
    top_correction_versions: topCorrectionVersions(appliedVersions, topLimit),
  };
}
```

`topCorrectionVersions()` already exists in `src/telemetry-summary.mjs`; do not create a second implementation. It sorts correction-version rows and applies `topLimit`.

In `runTelemetrySummary()`, replace the skeleton `multimodalAdjusted` object with:

```js
  const multimodalAdjusted = buildAdjustedMultimodal(accumulator, topLimit);
```

- [ ] **Step 5: Run the test and verify GREEN**

Run:

```bash
node --test test/telemetry-summary.test.mjs --test-name-pattern "applies correction media|correction overlays|multimodal metadata"
```

Expected: PASS. The existing correction overlay test should still prove raw `multimodal` remains unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/telemetry-summary.mjs test/telemetry-summary.test.mjs
git commit -m "feat: add correction-adjusted multimodal totals"
```

## Task 3: Implement Correction Precedence And Orphans

**Files:**
- Modify: `test/telemetry-summary.test.mjs`
- Modify: `src/telemetry-summary.mjs`

- [ ] **Step 1: Write failing precedence/orphan tests**

Add this test after `runTelemetrySummary applies correction media to adjusted multimodal totals`:

```js
test("runTelemetrySummary chooses one correction deterministically and counts orphan corrections", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(411, {
      event_id: "artifact_original_precedence",
      command: "artifact-review-backfill",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [{ mime_type: "image/png" }],
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(412, {
      event_id: "artifact_correction_media_v1",
      command: "artifact-review-backfill-correction",
      created_at: "2026-06-04T09:00:00.000Z",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [{ mime_type: "image/png", byte_size: 10, media_kind: "image" }],
      },
      metadata: {
        correction_for_event_id: "artifact_original_precedence",
        correction_version: "media-v1",
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(413, {
      event_id: "artifact_correction_media_v2",
      command: "artifact-review-backfill-correction",
      created_at: "2026-06-04T08:00:00.000Z",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [{ mime_type: "image/png", byte_size: 20, media_kind: "screenshot" }],
      },
      metadata: {
        correction_for_event_id: "artifact_original_precedence",
        correction_version: "media-v2",
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(414, {
      event_id: "artifact_correction_orphan",
      command: "artifact-review-backfill-correction",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [{ mime_type: "image/png", byte_size: 999, media_kind: "design" }],
      },
      metadata: {
        correction_for_event_id: "artifact_missing_original",
        correction_version: "media-v9",
      },
    }),
  });

  const summary = await runTelemetrySummary({ cwd, scope: "local" });

  assert.equal(summary.multimodal_adjusted.correction_event_count, 3);
  assert.equal(summary.multimodal_adjusted.corrected_original_event_count, 1);
  assert.equal(summary.multimodal_adjusted.applied_correction_event_count, 1);
  assert.equal(summary.multimodal_adjusted.superseded_correction_event_count, 1);
  assert.equal(summary.multimodal_adjusted.orphan_correction_event_count, 1);
  assert.equal(summary.multimodal_adjusted.byte_count, 20);
  assert.deepEqual(summary.multimodal_adjusted.top_media_kind, [
    { media_kind: "screenshot", event_count: 1, item_count: 1, byte_count: 20 },
  ]);
  assert.deepEqual(summary.multimodal_adjusted.top_correction_versions, [
    {
      correction_version: "media-v2",
      event_count: 1,
      corrected_original_event_count: 1,
      media_item_count: 1,
      media_byte_count: 20,
    },
  ]);
});
```

Add this test after it:

```js
test("runTelemetrySummary applies corrections to originals without raw multimodal items", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(426, {
      event_id: "artifact_original_without_media",
      command: "artifact-review-backfill",
      payload: { prompt_truncated: false, response_truncated: false, multimodal: [] },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(427, {
      event_id: "artifact_correction_without_media_original",
      command: "artifact-review-backfill-correction",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [{ mime_type: "image/png", byte_size: 44, media_kind: "design" }],
      },
      metadata: {
        correction_for_event_id: "artifact_original_without_media",
        correction_version: "media-v1",
      },
    }),
  });

  const summary = await runTelemetrySummary({ cwd, scope: "local" });
  const serialized = JSON.stringify(summary);

  assert.equal(summary.multimodal.event_count, 0);
  assert.equal(summary.multimodal_adjusted.event_count, 1);
  assert.equal(summary.multimodal_adjusted.item_count, 1);
  assert.equal(summary.multimodal_adjusted.orphan_correction_event_count, 0);
  assert.equal(summary.multimodal_adjusted.applied_correction_event_count, 1);
  assert.deepEqual(summary.multimodal_adjusted.top_media_kind, [
    { media_kind: "design", event_count: 1, item_count: 1, byte_count: 44 },
  ]);
  assert.doesNotMatch(serialized, /artifact_original_without_media/);
  assert.doesNotMatch(serialized, /artifact_correction_without_media_original/);
});
```

Add this test after it:

```js
test("runTelemetrySummary falls back to lexical correction versions and valid timestamps", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(421, {
      event_id: "artifact_original_lexical",
      command: "artifact-review-backfill",
      payload: { prompt_truncated: false, response_truncated: false, multimodal: [{ byte_size: 1 }] },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(422, {
      event_id: "artifact_correction_alpha",
      command: "artifact-review-backfill-correction",
      created_at: "not-a-date",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [{ mime_type: "image/png", byte_size: 10, media_kind: "image" }],
      },
      metadata: {
        correction_for_event_id: "artifact_original_lexical",
        correction_version: "alpha",
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(423, {
      event_id: "artifact_correction_beta_old",
      command: "artifact-review-backfill-correction",
      created_at: "2026-06-04T07:00:00.000Z",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [{ mime_type: "image/png", byte_size: 20, media_kind: "design" }],
      },
      metadata: {
        correction_for_event_id: "artifact_original_lexical",
        correction_version: "beta",
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(424, {
      event_id: "artifact_correction_beta_new",
      command: "artifact-review-backfill-correction",
      created_at: "2026-06-04T08:00:00.000Z",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [{ mime_type: "image/png", byte_size: 30, media_kind: "screenshot" }],
      },
      metadata: {
        correction_for_event_id: "artifact_original_lexical",
        correction_version: "beta",
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(425, {
      event_id: "artifact_correction_beta_missing_time",
      command: "artifact-review-backfill-correction",
      created_at: null,
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [{ mime_type: "image/png", byte_size: 25, media_kind: "document" }],
      },
      metadata: {
        correction_for_event_id: "artifact_original_lexical",
        correction_version: "beta",
      },
    }),
  });

  const summary = await runTelemetrySummary({ cwd, scope: "local" });

  assert.equal(summary.multimodal_adjusted.byte_count, 30);
  assert.deepEqual(summary.multimodal_adjusted.top_media_kind, [
    { media_kind: "screenshot", event_count: 1, item_count: 1, byte_count: 30 },
  ]);
  assert.equal(summary.multimodal_adjusted.superseded_correction_event_count, 3);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
node --test test/telemetry-summary.test.mjs --test-name-pattern "chooses one correction|falls back to lexical|originals without raw"
```

Expected: FAIL because correction selection currently uses the last candidate only and originals without raw media are not tracked separately from raw multimodal originals.

- [ ] **Step 3: Implement correction ranking**

In `src/telemetry-summary.mjs`, add these helpers after `safeCorrectionVersion()`:

```js
const MEDIA_CORRECTION_VERSION_PATTERN = /^media-v(\d+)$/;

function semanticCorrectionNumber(version) {
  const match = MEDIA_CORRECTION_VERSION_PATTERN.exec(version);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function validTimestampMs(value) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

function compareCorrectionCandidates(left, right) {
  const leftSemantic = semanticCorrectionNumber(left.version);
  const rightSemantic = semanticCorrectionNumber(right.version);
  if (leftSemantic !== null && rightSemantic !== null && leftSemantic !== rightSemantic) {
    return leftSemantic - rightSemantic;
  }
  if ((leftSemantic === null || rightSemantic === null) && left.version !== right.version) {
    return left.version.localeCompare(right.version);
  }
  const leftTime = validTimestampMs(left.createdAt);
  const rightTime = validTimestampMs(right.createdAt);
  if (leftTime !== rightTime) return leftTime - rightTime;
  return left.sequence - right.sequence;
}

function bestCorrectionCandidate(candidates) {
  return candidates.reduce((best, candidate) => (
    compareCorrectionCandidates(best, candidate) >= 0 ? best : candidate
  ));
}
```

In `buildAdjustedMultimodal()`, replace:

```js
    const applied = candidates[candidates.length - 1];
```

with:

```js
    const applied = bestCorrectionCandidate(candidates);
```

- [ ] **Step 4: Run the tests and verify GREEN**

Run:

```bash
node --test test/telemetry-summary.test.mjs --test-name-pattern "chooses one correction|falls back to lexical|originals without raw|applies correction media"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/telemetry-summary.mjs test/telemetry-summary.test.mjs
git commit -m "feat: reconcile correction precedence in telemetry summary"
```

## Task 4: Recommendations, Malformed Corrections, And Safety

**Files:**
- Modify: `test/telemetry-summary.test.mjs`
- Modify: `src/telemetry-summary.mjs`

- [ ] **Step 1: Write failing recommendation and malformed-correction tests**

Add this test after the precedence tests:

```js
test("runTelemetrySummary recommendations use adjusted media-kind coverage", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  for (let index = 1; index <= 6; index += 1) {
    const originalId = `artifact_original_recommendation_${index}`;
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(430 + index, {
        event_id: originalId,
        command: "artifact-review-backfill",
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [],
        },
      }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(440 + index, {
        event_id: `artifact_correction_recommendation_${index}`,
        command: "artifact-review-backfill-correction",
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [{ mime_type: "image/png", byte_size: index, media_kind: "screenshot" }],
        },
        metadata: {
          correction_for_event_id: originalId,
          correction_version: "media-v1",
        },
      }),
    });
  }

  const summary = await runTelemetrySummary({ cwd, scope: "local" });
  const messages = summary.recommendations.map((item) => item.message).join("\n");

  assert.equal(summary.multimodal.item_count, 0);
  assert.equal(summary.multimodal_adjusted.item_count, 6);
  assert.match(messages, /Correction-aware multimodal coverage is materially better/);
  assert.doesNotMatch(messages, /Most multimodal metadata is missing media kind/);
});
```

Add this test after it:

```js
test("runTelemetrySummary handles malformed correction payloads without leaking identifiers", async () => {
  const cwd = await temporaryWorkspace();
  await saveTelemetryConfig({
    cwd,
    endpoint: "http://127.0.0.1:8787/ingest",
    tokenEnv: TOKEN_ENV,
    deploymentId: "gemini-agent-main",
  });

  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(451, {
      event_id: "artifact_original_malformed",
      command: "artifact-review-backfill",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [{ basename: "private-malformed.png" }],
      },
    }),
  });
  await appendTelemetryEvent({
    cwd,
    event: telemetryEvent(452, {
      event_id: "artifact_correction_missing_target",
      command: "artifact-review-backfill-correction",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: { not: "an array" },
      },
      metadata: {
        correction_version: "media-v1",
      },
    }),
  });

  const summary = await runTelemetrySummary({ cwd, scope: "local" });
  const text = formatTelemetrySummaryText(summary);
  const serialized = JSON.stringify(summary);

  assert.equal(summary.multimodal_adjusted.correction_event_count, 1);
  assert.equal(summary.multimodal_adjusted.orphan_correction_event_count, 1);
  assert.equal(summary.multimodal_adjusted.applied_correction_event_count, 0);
  assert.doesNotMatch(serialized, /artifact_original_malformed/);
  assert.doesNotMatch(serialized, /artifact_correction_missing_target/);
  assert.doesNotMatch(serialized, /private-malformed/);
  assert.doesNotMatch(text, /private-malformed/);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
node --test test/telemetry-summary.test.mjs --test-name-pattern "recommendations use adjusted|malformed correction"
```

Expected: FAIL because recommendations still use raw multimodal only, and malformed correction payload counting is not fully covered yet.

- [ ] **Step 3: Implement correction-aware recommendation logic**

In `src/telemetry-summary.mjs`, add this helper near `successRate()`:

```js
function mediaKindCoverage(multimodal) {
  return multimodal.item_count > 0 ? multimodal.media_items_with_kind / multimodal.item_count : 0;
}
```

Change `buildRecommendations()` signature from:

```js
function buildRecommendations({ commands, counts, statusCounts, queue, usage, multimodal }) {
```

to:

```js
function buildRecommendations({ commands, counts, statusCounts, queue, usage, multimodal, multimodalAdjusted }) {
```

Replace the existing media-kind recommendation block:

```js
  if (multimodal.item_count >= 5 && multimodal.unknown_kind_items / multimodal.item_count > 0.5) {
    recommendations.push({
      kind: "instrumentation",
      message: "Most multimodal metadata is missing media kind; classify screenshots, designs, documents, and images before making quality claims.",
    });
  }
```

with:

```js
  const rawKindCoverage = mediaKindCoverage(multimodal);
  const adjustedKindCoverage = mediaKindCoverage(multimodalAdjusted ?? zeroAdjustedMultimodal());
  const recommendationItemCount = Math.max(multimodal.item_count, multimodalAdjusted?.item_count ?? 0);
  if (recommendationItemCount >= 5 && rawKindCoverage < 0.5 && adjustedKindCoverage < 0.5) {
    recommendations.push({
      kind: "instrumentation",
      message: "Most multimodal metadata is missing media kind; classify screenshots, designs, documents, and images before making quality claims.",
    });
  } else if (
    recommendationItemCount >= 5
    && rawKindCoverage < 0.5
    && adjustedKindCoverage >= 0.5
    && adjustedKindCoverage - rawKindCoverage >= 0.25
  ) {
    recommendations.push({
      kind: "instrumentation",
      message: "Correction-aware multimodal coverage is materially better; keep correction-aware reporting and prioritize backfill operationalization.",
    });
  }
```

In the `runTelemetrySummary()` return object, update the call:

```js
    recommendations: buildRecommendations({
      commands: allCommands,
      counts: accumulator.counts,
      statusCounts: accumulator.statusCounts,
      queue,
      usage: accumulator.usage,
      multimodal,
      multimodalAdjusted,
    }),
```

- [ ] **Step 4: Harden malformed correction counting**

If `addAdjustedCorrectionCandidate()` currently increments malformed corrections only for missing metadata, keep that behavior. Ensure `compactMediaItems()` returns `[]` for non-array payloads, so malformed payloads do not throw.

In `buildAdjustedMultimodal()`, malformed metadata is already counted through `adjustedMalformedCorrectionCount`. Confirm this line exists:

```js
  let orphanCorrectionEventCount = accumulator.adjustedMalformedCorrectionCount;
```

If it is missing, add it exactly as shown.

- [ ] **Step 5: Run the tests and verify GREEN**

Run:

```bash
node --test test/telemetry-summary.test.mjs --test-name-pattern "recommendations use adjusted|malformed correction|multimodal metadata|correction overlays"
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/telemetry-summary.mjs test/telemetry-summary.test.mjs
git commit -m "feat: make multimodal recommendations correction-aware"
```

## Task 5: Scale Coverage, Verification, And Review

**Files:**
- Modify: `test/telemetry-summary.test.mjs`
- No source edits expected unless tests expose a defect.

- [ ] **Step 1: Write bounded large-queue correction test**

In `test/telemetry-summary.test.mjs`, extend `runTelemetrySummary keeps large queues bounded by topLimit` before calling `runTelemetrySummary()`:

```js
  for (let index = 1; index <= 50; index += 1) {
    const originalId = `artifact_large_original_${index}`;
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(1000 + index, {
        event_id: originalId,
        project_id: `correction-project-${index}`,
        command: "artifact-review-backfill",
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [{ basename: `private-large-${index}.png` }],
        },
      }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(2000 + index, {
        event_id: `artifact_large_correction_${index}`,
        command: "artifact-review-backfill-correction",
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [{ mime_type: "image/png", byte_size: index, media_kind: index % 2 === 0 ? "design" : "screenshot" }],
        },
        metadata: {
          correction_for_event_id: originalId,
          correction_version: `media-v${index % 3}`,
        },
      }),
    });
  }
```

Then replace the total count assertion:

```js
  assert.equal(summary.event_counts.total, 250);
```

with:

```js
  assert.equal(summary.event_counts.total, 350);
```

Add these assertions after the existing top dimension assertions:

```js
  assert.equal(summary.top_projects.length, 5);
  assert.equal(summary.multimodal_adjusted.top_media_mime.length <= 5, true);
  assert.equal(summary.multimodal_adjusted.top_media_kind.length <= 5, true);
  assert.equal(summary.multimodal_adjusted.top_correction_versions.length <= 5, true);
  assert.doesNotMatch(JSON.stringify(summary), /artifact_large_original|artifact_large_correction|private-large/);
```

- [ ] **Step 2: Run the large-queue test and verify RED or GREEN**

Run:

```bash
node --test test/telemetry-summary.test.mjs --test-name-pattern "large queues"
```

Expected: PASS if earlier tasks already enforce top limits; FAIL if adjusted top lists or privacy output still leak. If it passes immediately, keep it as coverage for the scale invariant.

- [ ] **Step 3: Fix any large-queue defects minimally**

If the test fails because adjusted top lists are not capped, confirm `buildAdjustedMultimodal()` returns:

```js
top_media_mime: topMediaMime(aggregate.mediaMimes, topLimit),
top_media_kind: topMediaKind(aggregate.mediaKinds, topLimit),
top_correction_versions: topCorrectionVersions(appliedVersions, topLimit),
```

If the test fails because identifiers leak, remove the leaking field from the returned public object. Do not mask identifiers into public output; omit them.

- [ ] **Step 4: Run focused verification**

Run:

```bash
node --test test/telemetry-summary.test.mjs --test-name-pattern "adjusted|correction|multimodal|large queues|recommendations"
git diff --check
```

Expected: PASS and no diff whitespace errors.

- [ ] **Step 5: Commit**

```bash
git add src/telemetry-summary.mjs test/telemetry-summary.test.mjs
git commit -m "test: cover correction-aware multimodal summary scale"
```

- [ ] **Step 6: Full verification**

Run:

```bash
npm test
```

Expected: all tests pass. The current baseline is 417 tests, so the final count should be greater than 417.

- [ ] **Step 7: Gemini diff review**

Run:

```bash
git diff main...HEAD | ./bin/gemini-agent diff-review --stdin
```

Expected: JSON with `"verdict": "pass"` or only actionable issues that have been resolved before continuing.

- [ ] **Step 8: Flush telemetry safely**

Run:

```bash
./bin/gemini-agent telemetry doctor --global --json
./bin/gemini-agent telemetry flush --global --dry-run --batch-size 1
./bin/gemini-agent telemetry flush --global --batch-size 1 --timeout-ms 10000
./bin/gemini-agent telemetry doctor --global --json
```

Expected: final doctor reports `pending=0`, `failed=0`, and `quarantine=0`. Do not paste raw event IDs or batch IDs into the final report.

- [ ] **Step 9: Finish the branch**

Use `superpowers:finishing-a-development-branch`.

Expected local merge path if continuing the existing project convention:

```bash
REPO=/path/to/gemini-agent
cd "$REPO"
git merge codex/correction-aware-multimodal-summary
npm test
git worktree remove "$REPO/.worktrees/correction-aware-multimodal-summary"
git worktree prune
git branch -d codex/correction-aware-multimodal-summary
git push origin main
```

Do not remove unrelated untracked files such as `.DS_Store` or `.superpowers/` from the main checkout.
