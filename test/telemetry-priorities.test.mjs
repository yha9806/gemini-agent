import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveTelemetryConfig } from "../src/telemetry-config.mjs";
import { appendTelemetryEvent, claimTelemetryBatch, failTelemetryBatch } from "../src/telemetry-queue.mjs";
import {
  formatTelemetryPrioritiesText,
  runTelemetryPriorities,
} from "../src/telemetry-priorities.mjs";

const TOKEN_ENV = "GEMINI_AGENT_TELEMETRY_TOKEN";

async function temporaryWorkspace(prefix = "gemini-agent-telemetry-priorities-") {
  return mkdtemp(join(tmpdir(), prefix));
}

function telemetryEvent(index, overrides = {}) {
  const suffix = `${index}`.padStart(6, "0");
  return {
    schema_version: 1,
    event_id: `evt_priority_${suffix}`,
    trace_id: `trace_priority_${suffix}`,
    deployment_id: "dep_test",
    project_id: "gemini-agent",
    source: "cli",
    command: "ask",
    model: "gemini-3.5-flash",
    prompt: `private priority prompt ${suffix}`,
    response: `private priority response ${suffix}`,
    status: "success",
    error_type: null,
    latency_ms: index,
    created_at: "2026-06-10T09:00:00.000Z",
    payload: { prompt_truncated: false, response_truncated: false, multimodal: [] },
    context: {
      cwd: "/Users/example/private/project",
      session_id: null,
      run_id: null,
      task_id: null,
      parent_codex_session: null,
    },
    outcome: {
      task_outcome: "unknown",
      user_acceptance: "unknown",
      accepted_files: [],
      modified_after_review: null,
      followup_required: null,
    },
    economics: {
      codex_tokens_saved_estimate: null,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      latency_bucket: null,
      cost_bucket: null,
    },
    ...overrides,
  };
}

test("runTelemetryPriorities ranks reliability before economics when error rate is high", async () => {
  const cwd = await temporaryWorkspace();
  try {
    await saveTelemetryConfig({
      cwd,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TOKEN_ENV,
      deploymentId: "gemini-agent-main",
    });
    for (let index = 1; index <= 3; index += 1) {
      await appendTelemetryEvent({
        cwd,
        event: telemetryEvent(index, {
          command: "diff_review",
          economics: {
            input_tokens: 1_000_000,
            output_tokens: 100_000,
            total_tokens: 1_100_000,
            codex_tokens_saved_estimate: 2_000_000,
          },
        }),
      });
    }
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(4, {
        command: "artifact-review",
        status: "error",
        error_type: "APIError",
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [
            { basename: "private-design.png", byte_size: 100 },
            { mime_type: "image/png", basename: "private-screenshot.png" },
          ],
        },
      }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(5, {
        command: "context-pack",
        status: "error",
        error_type: "APIError",
      }),
    });

    const report = await runTelemetryPriorities({
      cwd,
      scope: "local",
      now: new Date("2026-06-10T10:00:00.000Z"),
      topLimit: 5,
    });
    const text = formatTelemetryPrioritiesText(report);
    const serialized = `${JSON.stringify(report)}\n${text}`;

    assert.equal(report.scope, "local");
    assert.equal(report.totals.event_count, 5);
    assert.equal(report.totals.error_rate, 0.4);
    assert.equal(report.priorities[0].kind, "reliability");
    assert.equal(report.priorities[0].severity, "critical");
    assert.equal(report.priorities[1].kind, "instrumentation");
    assert.ok(report.priorities.some((item) => item.kind === "economics"));
    assert.match(text, /Telemetry Development Priorities/);
    assert.match(text, /Reliability first/);
    assert.match(text, /diff-review/);
    assert.doesNotMatch(serialized, /private priority prompt/);
    assert.doesNotMatch(serialized, /private priority response/);
    assert.doesNotMatch(serialized, /evt_priority_/);
    assert.doesNotMatch(serialized, /private-design\.png/);
    assert.doesNotMatch(serialized, /\/Users\/example/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runTelemetryPriorities ranks delivery diagnostics when queued delivery is blocked", async () => {
  const cwd = await temporaryWorkspace();
  try {
    await saveTelemetryConfig({
      cwd,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TOKEN_ENV,
      deploymentId: "gemini-agent-main",
    });
    for (let index = 1; index <= 3; index += 1) {
      await appendTelemetryEvent({ cwd, event: telemetryEvent(index) });
    }
    const batch = await claimTelemetryBatch({
      cwd,
      batchSize: 3,
      now: new Date("2026-06-10T10:00:00.000Z"),
    });
    await failTelemetryBatch({
      cwd,
      batchId: batch.batchId,
      retryable: true,
      reason: "receiver_error",
    });

    const report = await runTelemetryPriorities({ cwd, scope: "local" });

    assert.equal(report.priorities[0].kind, "delivery");
    assert.equal(report.priorities[0].action, "Run telemetry doctor and bounded raw preflight before flushing again.");
    assert.ok(report.priorities[0].evidence.some((item) => /receiver_error/.test(item)));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runTelemetryPriorities supports global scope, top limit, and pricing overrides", async () => {
  const project = await temporaryWorkspace("gemini-agent-telemetry-priorities-project-");
  const home = await temporaryWorkspace("gemini-agent-telemetry-priorities-home-");
  try {
    await saveTelemetryConfig({
      cwd: home,
      scope: "local",
      endpoint: "https://vulca-api.onrender.com/api/v1/gemini-agent/telemetry/ingest",
      tokenEnv: TOKEN_ENV,
      deploymentId: "gemini-agent-main",
    });
    await appendTelemetryEvent({
      cwd: home,
      event: telemetryEvent(10, {
        command: "context_pack",
        economics: {
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
          total_tokens: 2_000_000,
          codex_tokens_saved_estimate: 1_500_000,
        },
      }),
    });

    const report = await runTelemetryPriorities({
      cwd: project,
      home,
      scope: "global",
      topLimit: 1,
      inputPricePerMillion: 2,
      outputPricePerMillion: 3,
    });

    assert.equal(report.scope, "global");
    assert.equal(report.storage_cwd, home);
    assert.equal(report.pricing.input_price_per_million, 2);
    assert.equal(report.pricing.output_price_per_million, 3);
    assert.equal(report.priorities.length, 1);
    assert.equal(report.priorities[0].kind, "economics");
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("runTelemetryPriorities uses usage-applicable coverage for instrumentation priority", async () => {
  const cwd = await temporaryWorkspace();
  try {
    await saveTelemetryConfig({
      cwd,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TOKEN_ENV,
      deploymentId: "gemini-agent-main",
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(20, {
        command: "diff-review",
        economics: {
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
          codex_tokens_saved_estimate: 100,
        },
      }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(21, { command: "artifact-review-backfill" }),
    });

    const report = await runTelemetryPriorities({
      cwd,
      scope: "local",
      topLimit: 5,
    });
    const instrumentation = report.priorities.find((item) => item.kind === "instrumentation");

    assert.equal(report.totals.usage_coverage_rate, 0.5);
    assert.equal(report.totals.usage_applicable_coverage_rate, 1);
    assert.equal(instrumentation, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runTelemetryPriorities points instrumentation work at the top usage gap command", async () => {
  const cwd = await temporaryWorkspace();
  try {
    await saveTelemetryConfig({
      cwd,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TOKEN_ENV,
      deploymentId: "gemini-agent-main",
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(30, {
        command: "ask",
        prompt: "private priority gap prompt",
        response: "private priority gap response",
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [{ basename: "private-priority-gap.png" }],
        },
      }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(31, { command: "ask" }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(32, {
        command: "diff-review",
        economics: {
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
          codex_tokens_saved_estimate: 100,
        },
      }),
    });

    const report = await runTelemetryPriorities({
      cwd,
      scope: "local",
      topLimit: 5,
    });
    const text = formatTelemetryPrioritiesText(report);
    const serialized = `${JSON.stringify(report)}\n${text}`;
    const instrumentation = report.priorities.find((item) => item.kind === "instrumentation");

    assert.ok(instrumentation);
    assert.match(instrumentation.action, /Fix token usage capture for ask/);
    assert.ok(instrumentation.evidence.some((item) => item === "Top adjusted usage gap: ask missing 2 usage-applicable events"));
    assert.match(text, /Top adjusted usage gap: ask missing 2 usage-applicable events/);
    assert.doesNotMatch(serialized, /private priority gap prompt/);
    assert.doesNotMatch(serialized, /private priority gap response/);
    assert.doesNotMatch(serialized, /evt_priority_000030/);
    assert.doesNotMatch(serialized, /private-priority-gap\.png/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runTelemetryPriorities uses adjusted coverage when suspected test fixtures dominate raw gaps", async () => {
  const cwd = await temporaryWorkspace();
  try {
    await saveTelemetryConfig({
      cwd,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TOKEN_ENV,
      deploymentId: "gemini-agent-main",
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(40, {
        command: "ask",
        prompt: "hello",
        response: "world",
        latency_ms: 1,
      }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(41, {
        command: "ask",
        prompt: "hello",
        response: "world",
        latency_ms: 2,
      }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(42, { command: "diff-review" }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(43, {
        command: "diff-review",
        economics: {
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
          codex_tokens_saved_estimate: 100,
        },
      }),
    });

    const report = await runTelemetryPriorities({
      cwd,
      scope: "local",
      topLimit: 5,
    });
    const text = formatTelemetryPrioritiesText(report);
    const serialized = `${JSON.stringify(report)}\n${text}`;
    const instrumentation = report.priorities.find((item) => item.kind === "instrumentation");

    assert.equal(report.totals.usage_applicable_coverage_rate, 0.25);
    assert.equal(report.totals.usage_applicable_adjusted_coverage_rate, 0.5);
    assert.equal(report.totals.suspected_test_fixture_event_count, 2);
    assert.ok(instrumentation);
    assert.match(instrumentation.action, /Fix token usage capture for diff-review/);
    assert.ok(instrumentation.evidence.some((item) => item === "Adjusted usage-applicable coverage: 50.0%"));
    assert.ok(instrumentation.evidence.some((item) => item === "Raw usage-applicable coverage: 25.0%"));
    assert.ok(instrumentation.evidence.some((item) => item === "Suspected test fixture events excluded from adjusted coverage: 2"));
    assert.ok(instrumentation.evidence.some((item) => item === "Top adjusted usage gap: diff-review missing 1 usage-applicable event"));
    assert.doesNotMatch(serialized, /hello|world|evt_priority_000040/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runTelemetryPriorities explains workflow priorities with gate input bytes", async () => {
  const cwd = await temporaryWorkspace();
  try {
    await saveTelemetryConfig({
      cwd,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TOKEN_ENV,
      deploymentId: "gemini-agent-main",
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(45, {
        command: "plan_critique",
        prompt: "private workflow prompt should not appear",
        response: "private workflow response should not appear",
        metadata: {
          gate: "plan_critique",
          input_bytes: 131072,
          input_limit_bytes: 131072,
        },
        economics: {
          input_tokens: 10_000,
          output_tokens: 1_000,
          total_tokens: 11_000,
          codex_tokens_saved_estimate: 1_000,
        },
      }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(46, {
        command: "plan-critique",
        metadata: {
          gate: "plan_critique",
          input_bytes: 65536,
          input_limit_bytes: 131072,
        },
        economics: {
          input_tokens: 5_000,
          output_tokens: 500,
          total_tokens: 5_500,
          codex_tokens_saved_estimate: 500,
        },
      }),
    });

    const report = await runTelemetryPriorities({
      cwd,
      scope: "local",
      topLimit: 5,
    });
    const text = formatTelemetryPrioritiesText(report);
    const serialized = `${JSON.stringify(report)}\n${text}`;
    const workflow = report.priorities.find((item) => item.kind === "workflow");

    assert.ok(workflow);
    assert.equal(workflow.command, "plan-critique");
    assert.match(workflow.action, /Use context-pack or narrower review input before raising plan-critique limits/);
    assert.ok(workflow.evidence.some((item) => item === "Gate input byte events: 2"));
    assert.ok(workflow.evidence.some((item) => item === "Average gate input bytes: 98,304"));
    assert.ok(workflow.evidence.some((item) => item === "Max gate input bytes: 131,072"));
    assert.ok(workflow.evidence.some((item) => item === "Gate input limit hit rate: 50.0%"));
    assert.match(text, /Gate input byte events: 2/);
    assert.doesNotMatch(serialized, /private workflow prompt/);
    assert.doesNotMatch(serialized, /private workflow response/);
    assert.doesNotMatch(serialized, /evt_priority_000045/);
    assert.doesNotMatch(serialized, /\/Users\/example/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runTelemetryPriorities keeps workflow priority stable without gate input bytes", async () => {
  const cwd = await temporaryWorkspace();
  try {
    await saveTelemetryConfig({
      cwd,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TOKEN_ENV,
      deploymentId: "gemini-agent-main",
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(47, {
        command: "plan-critique",
        economics: {
          input_tokens: 10_000,
          output_tokens: 1_000,
          total_tokens: 11_000,
          codex_tokens_saved_estimate: 1_000,
        },
      }),
    });

    const report = await runTelemetryPriorities({
      cwd,
      scope: "local",
      topLimit: 5,
    });
    const workflow = report.priorities.find((item) => item.kind === "workflow");

    assert.ok(workflow);
    assert.equal(workflow.command, "plan-critique");
    assert.equal(
      workflow.action,
      "Reduce prompt size, narrow context packs, or route only the parts Gemini can handle cheaply.",
    );
    assert.ok(workflow.evidence.some((item) => item === "Gemini tokens per estimated Codex token saved: 11"));
    assert.equal(workflow.evidence.some((item) => /Gate input/.test(item)), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runTelemetryPriorities recommends context pack reuse for heavy low-reuse gates", async () => {
  const cwd = await temporaryWorkspace();
  try {
    await saveTelemetryConfig({
      cwd,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TOKEN_ENV,
      deploymentId: "gemini-agent-main",
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(60, {
        command: "diff-review",
        economics: {
          input_tokens: 1_000_000,
          output_tokens: 100_000,
          total_tokens: 1_100_000,
          codex_tokens_saved_estimate: 2_000_000,
        },
      }),
    });
    for (let index = 1; index <= 5; index += 1) {
      await appendTelemetryEvent({
        cwd,
        event: telemetryEvent(60 + index, {
          command: "plan-critique",
          prompt: `private context loop prompt ${index}`,
          response: `private context loop response ${index}`,
          metadata: {
            gate: "plan_critique",
            input_bytes: 4096 + index,
            input_limit_bytes: 131072,
            context_pack_mode: "none",
            fresh_input_mode: "file",
            context_pack_path: "/Users/example/private/context.json",
          },
          economics: {
            input_tokens: 5_000,
            output_tokens: 500,
            total_tokens: 5_500,
            codex_tokens_saved_estimate: 100,
          },
        }),
      });
    }

    const report = await runTelemetryPriorities({
      cwd,
      scope: "local",
      topLimit: 10,
    });
    const text = formatTelemetryPrioritiesText(report);
    const serialized = `${JSON.stringify(report)}\n${text}`;
    const workflow = report.priorities.find((item) => (
      item.kind === "workflow"
      && /context-pack reuse/i.test(item.title)
    ));

    assert.ok(workflow);
    assert.equal(workflow.command, "plan-critique");
    assert.match(workflow.action, /Increase context-pack reuse for plan-critique/);
    assert.ok(workflow.evidence.some((item) => item === "Gate events: 5"));
    assert.ok(workflow.evidence.some((item) => item === "Context-pack reuse rate: 0.0%"));
    assert.ok(workflow.evidence.some((item) => item === "Average gate input bytes: 4,099"));
    assert.match(text, /context-pack reuse/i);
    assert.doesNotMatch(serialized, /private context loop prompt|private context loop response/);
    assert.doesNotMatch(serialized, /evt_priority_000061|\/Users\/example|context\.json/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runTelemetryPriorities does not recommend usage fixes when only multimodal metadata is weak", async () => {
  const cwd = await temporaryWorkspace();
  try {
    await saveTelemetryConfig({
      cwd,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TOKEN_ENV,
      deploymentId: "gemini-agent-main",
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(50, {
        command: "artifact-review",
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [{ basename: "private-weak-metadata.png" }],
        },
        economics: {
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
          codex_tokens_saved_estimate: 100,
        },
      }),
    });

    const report = await runTelemetryPriorities({
      cwd,
      scope: "local",
      topLimit: 5,
    });
    const serialized = JSON.stringify(report);
    const instrumentation = report.priorities.find((item) => item.kind === "instrumentation");

    assert.equal(report.totals.usage_applicable_adjusted_coverage_rate, 1);
    assert.ok(instrumentation);
    assert.equal(
      instrumentation.action,
      "Fix multimodal MIME, byte-size, and media-kind capture/backfill for artifact-review.",
    );
    assert.ok(instrumentation.evidence.some((item) => item === "Top adjusted multimodal MIME gap: artifact-review missing 1 item"));
    assert.ok(instrumentation.evidence.some((item) => item === "Top adjusted multimodal byte-size gap: artifact-review missing 1 item"));
    assert.ok(instrumentation.evidence.some((item) => item === "Top adjusted multimodal media-kind gap: artifact-review missing 1 item"));
    assert.doesNotMatch(instrumentation.action, /Fix token usage/);
    assert.doesNotMatch(serialized, /private-weak-metadata\.png/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runTelemetryPriorities names only weak adjusted multimodal metadata fields", async () => {
  const cwd = await temporaryWorkspace();
  try {
    await saveTelemetryConfig({
      cwd,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TOKEN_ENV,
      deploymentId: "gemini-agent-main",
    });
    const original = telemetryEvent(60, {
      command: "artifact-review",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: [{ basename: "private-adjusted-byte-gap.png" }],
      },
      economics: {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        codex_tokens_saved_estimate: 100,
      },
    });
    await appendTelemetryEvent({ cwd, event: original });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(61, {
        command: "artifact-review-backfill-correction",
        prompt: "metadata correction",
        response: "metadata correction",
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [{ mime_type: "image/png", basename: "media-adjusted.png", media_kind: "image" }],
        },
        metadata: {
          correction_for_event_id: original.event_id,
          correction_version: "media-v2",
          correction_reason: "media_metadata_inference",
        },
      }),
    });

    const report = await runTelemetryPriorities({
      cwd,
      scope: "local",
      topLimit: 5,
    });
    const serialized = JSON.stringify(report);
    const instrumentation = report.priorities.find((item) => item.kind === "instrumentation");

    assert.ok(instrumentation);
    assert.equal(
      instrumentation.action,
      "Fix multimodal byte-size capture/backfill for artifact-review.",
    );
    assert.ok(instrumentation.evidence.some((item) => item === "Top adjusted multimodal byte-size gap: artifact-review missing 1 item"));
    assert.doesNotMatch(instrumentation.action, /MIME|media-kind/);
    assert.doesNotMatch(serialized, /private-adjusted-byte-gap|media-adjusted/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runTelemetryPriorities separates future capture from recoverable backfill for artifact backfill byte-size gaps", async () => {
  const cwd = await temporaryWorkspace();
  try {
    await saveTelemetryConfig({
      cwd,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TOKEN_ENV,
      deploymentId: "gemini-agent-main",
    });
    const original = telemetryEvent(65, {
      command: "artifact-review-backfill",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: Array.from({ length: 6 }, (_, index) => ({
          mime_type: "image/png",
          basename: `private-backfill-${index}.png`,
          media_kind: "image",
        })),
      },
      economics: {
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
        codex_tokens_saved_estimate: 0,
      },
    });
    await appendTelemetryEvent({ cwd, event: original });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(66, {
        command: "artifact-review-backfill-correction",
        prompt: "metadata correction",
        response: "metadata correction",
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [
            { mime_type: "image/png", basename: "media-1.png", media_kind: "image", byte_size: 100 },
            { mime_type: "image/png", basename: "media-2.png", media_kind: "image", byte_size: 200 },
          ],
        },
        metadata: {
          correction_for_event_id: original.event_id,
          correction_version: "media-v3",
          correction_reason: "media_manifest_enrichment",
        },
      }),
    });

    const report = await runTelemetryPriorities({
      cwd,
      scope: "local",
      topLimit: 5,
    });
    const serialized = JSON.stringify(report);
    const instrumentation = report.priorities.find((item) => item.kind === "instrumentation");

    assert.ok(instrumentation);
    assert.equal(
      instrumentation.action,
      "Fix future artifact-review-backfill byte-size capture; rerun source-available correction backfills for recoverable historical events.",
    );
    assert.ok(instrumentation.evidence.some((item) => item === "Top adjusted multimodal byte-size gap: artifact-review-backfill missing 4 items"));
    assert.ok(instrumentation.evidence.some((item) => item === "artifact-review-backfill byte-size known for 2 of 6 adjusted media items"));
    assert.doesNotMatch(serialized, /private-backfill|evt_priority_000065|media-1|media-2/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runTelemetryPriorities reports aggregate backfill manifest source evidence for artifact byte-size gaps", async () => {
  const cwd = await temporaryWorkspace();
  try {
    await saveTelemetryConfig({
      cwd,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TOKEN_ENV,
      deploymentId: "gemini-agent-main",
    });
    const original = telemetryEvent(67, {
      command: "artifact-review-backfill",
      payload: {
        prompt_truncated: false,
        response_truncated: false,
        multimodal: Array.from({ length: 6 }, (_, index) => ({
          mime_type: "image/png",
          basename: `private-backfill-source-${index}.png`,
          media_kind: "image",
        })),
      },
      metadata: {
        media_manifest_source: "source path /Users/example/private.png",
      },
      economics: {
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
        codex_tokens_saved_estimate: 0,
      },
    });
    await appendTelemetryEvent({ cwd, event: original });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(68, {
        command: "artifact-review-backfill-correction",
        prompt: "metadata correction",
        response: "metadata correction",
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [
            { mime_type: "image/png", basename: "media-source-1.png", media_kind: "image", byte_size: 100 },
            { mime_type: "image/png", basename: "media-source-2.png", media_kind: "image", byte_size: 200 },
          ],
        },
        metadata: {
          correction_for_event_id: original.event_id,
          correction_version: "media-v4",
          correction_reason: "media_manifest_enrichment",
          media_manifest_source: "artifact_media_manifest",
        },
      }),
    });

    const report = await runTelemetryPriorities({
      cwd,
      scope: "local",
      topLimit: 5,
    });
    const serialized = JSON.stringify(report);
    const instrumentation = report.priorities.find((item) => item.kind === "instrumentation");

    assert.ok(instrumentation);
    assert.equal(
      instrumentation.action,
      "Fix future artifact-review-backfill byte-size capture; rerun source-available correction backfills for recoverable historical events.",
    );
    assert.ok(instrumentation.evidence.some((item) => item === "Backfill media manifest sources: unknown 1 event / 6 media items; artifact_media_manifest 1 event / 2 media items"));
    assert.doesNotMatch(serialized, /private-backfill-source|source path|\/Users|evt_priority_000067|media-source/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runTelemetryPriorities breaks multimodal gap ties deterministically", async () => {
  const cwd = await temporaryWorkspace();
  try {
    await saveTelemetryConfig({
      cwd,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TOKEN_ENV,
      deploymentId: "gemini-agent-main",
    });
    for (const [index, command] of [[70, "gemini-artifact-review"], [71, "artifact-review"]]) {
      await appendTelemetryEvent({
        cwd,
        event: telemetryEvent(index, {
          command,
          payload: {
            prompt_truncated: false,
            response_truncated: false,
            multimodal: [{ basename: `private-${command}.png` }],
          },
          economics: {
            input_tokens: 100,
            output_tokens: 50,
            total_tokens: 150,
            codex_tokens_saved_estimate: 100,
          },
        }),
      });
    }

    const report = await runTelemetryPriorities({
      cwd,
      scope: "local",
      topLimit: 5,
    });
    const serialized = JSON.stringify(report);
    const instrumentation = report.priorities.find((item) => item.kind === "instrumentation");

    assert.ok(instrumentation);
    assert.equal(
      instrumentation.action,
      "Fix multimodal MIME, byte-size, and media-kind capture/backfill for artifact-review.",
    );
    assert.ok(instrumentation.evidence.some((item) => item === "Top adjusted multimodal byte-size gap: artifact-review missing 1 item"));
    assert.doesNotMatch(serialized, /private-artifact-review|private-gemini-artifact-review|evt_priority_000070/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runTelemetryPriorities does not warn on usage when no events need usage metadata", async () => {
  const cwd = await temporaryWorkspace();
  try {
    await saveTelemetryConfig({
      cwd,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TOKEN_ENV,
      deploymentId: "gemini-agent-main",
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(30, { command: "artifact-review-backfill" }),
    });

    const report = await runTelemetryPriorities({
      cwd,
      scope: "local",
      topLimit: 5,
    });
    const instrumentation = report.priorities.find((item) => item.kind === "instrumentation");

    assert.equal(report.totals.usage_coverage_rate, 0);
    assert.equal(report.totals.usage_applicable_coverage_rate, null);
    assert.equal(instrumentation, undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runTelemetryPriorities rejects invalid options", async () => {
  await assert.rejects(
    () => runTelemetryPriorities({ topLimit: 0 }),
    /topLimit must be a positive integer/,
  );
  await assert.rejects(
    () => runTelemetryPriorities({ inputPricePerMillion: -1 }),
    /inputPricePerMillion must be a nonnegative number/,
  );
  await assert.rejects(
    () => runTelemetryPriorities({ outputPricePerMillion: Number.NaN }),
    /outputPricePerMillion must be a nonnegative number/,
  );
});
