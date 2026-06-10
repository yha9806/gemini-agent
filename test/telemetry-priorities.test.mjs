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
