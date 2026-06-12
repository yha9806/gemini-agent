import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveTelemetryConfig } from "../src/telemetry-config.mjs";
import { appendTelemetryEvent } from "../src/telemetry-queue.mjs";
import {
  buildStructuredResponseReport,
  formatTelemetryReportText,
  runTelemetryReport,
} from "../src/telemetry-report.mjs";

const TOKEN_ENV = "GEMINI_AGENT_TELEMETRY_TOKEN";

async function temporaryWorkspace(prefix = "gemini-agent-telemetry-report-") {
  return mkdtemp(join(tmpdir(), prefix));
}

function telemetryEvent(index, overrides = {}) {
  const suffix = `${index}`.padStart(6, "0");
  return {
    schema_version: 1,
    event_id: `evt_report_${suffix}`,
    trace_id: `trace_report_${suffix}`,
    deployment_id: "dep_report",
    project_id: "gemini-agent",
    source: "cli",
    command: "ask",
    model: "gemini-3.5-flash",
    prompt: `private report prompt ${suffix}`,
    response: `private report response ${suffix}`,
    status: "success",
    error_type: null,
    latency_ms: index,
    created_at: "2026-06-10T09:00:00.000Z",
    payload: { prompt_truncated: false, response_truncated: false, multimodal: [] },
    context: {
      cwd: "/Users/example/private/report-project",
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

test("runTelemetryReport builds a safe product decision snapshot", async () => {
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
      event: telemetryEvent(1, {
        project_id: "vulca-platform",
        command: "diff_review",
        context: {
          cwd: "/Users/example/private/report-project",
          workspace_id: "ws_vulca",
          user_label: "vulca-operator",
        },
        metadata: {
          gate: "diff_review",
          input_bytes: 48_000,
          input_limit_bytes: 4 * 1024 * 1024,
          context_pack_mode: "none",
          fresh_input_mode: "diff",
          context_pack_path: "/Users/example/private/latest.json",
        },
        economics: {
          input_tokens: 1_000_000,
          output_tokens: 100_000,
          total_tokens: 1_100_000,
          codex_tokens_saved_estimate: 2_000_000,
        },
      }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(2, {
        project_id: "vulca-platform",
        command: "artifact-review",
        context: {
          cwd: "/Users/example/private/report-project",
          workspace_id: "ws_vulca",
          user_label: "person@example.com",
        },
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [{
            basename: "secret-report-screenshot.png",
            mime_type: "image/png",
            media_kind: "screenshot",
            byte_size: 42_000,
          }],
        },
        metadata: {
          design_scorecard: {
            overall_score: 81,
            visual_hierarchy_score: 82,
            clarity_score: 83,
            accessibility_score: 84,
            consistency_score: 85,
            implementation_readiness_score: 86,
            strengths: ["private report strength"],
          },
        },
        economics: {
          input_tokens: 40_000,
          output_tokens: 8_000,
          total_tokens: 48_000,
          codex_tokens_saved_estimate: 80_000,
        },
      }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(3, {
        project_id: "emoart-challenge",
        command: "plan-critique",
        status: "error",
        error_type: "provider_500",
        context: {
          cwd: "/Users/example/private/report-project",
          workspace_id: "ws_emoart",
          user_label: "emoart-operator",
        },
      }),
    });

    const report = await runTelemetryReport({
      cwd,
      scope: "local",
      topLimit: 1,
      inputPricePerMillion: 2,
      outputPricePerMillion: 3,
      now: new Date("2026-06-11T10:00:00.000Z"),
    });
    const text = formatTelemetryReportText(report);
    const serialized = `${JSON.stringify(report)}\n${text}`;

    assert.equal(report.scope, "local");
    assert.equal(report.generated_at, "2026-06-11T10:00:00.000Z");
    assert.equal(report.pricing.input_price_per_million, 2);
    assert.equal(report.pricing.output_price_per_million, 3);
    assert.equal(report.executive_summary.status, "attention");
    assert.match(report.executive_summary.headline, /Telemetry needs attention/);
    assert.equal(report.health.event_count, 3);
    assert.equal(report.health.error_count, 1);
    assert.equal(report.economics.codex_tokens_saved_estimate, 2_080_000);
    assert.equal(report.economics.top_command.command, "diff-review");
    assert.equal(report.context_loop.gate_event_count, 1);
    assert.equal(report.context_loop.top_gate_command.command, "diff-review");
    assert.equal(report.multimodal.event_count, 1);
    assert.equal(report.multimodal.top_command.command, "artifact-review");
    assert.deepEqual(report.artifact_review_quality, {
      event_count: 1,
      scorecard_event_count: 1,
      avg_overall_score: 81,
      avg_implementation_readiness_score: 86,
      top_command: {
        command: "artifact-review",
        event_count: 1,
        scorecard_event_count: 1,
        avg_overall_score: 81,
      },
    });
    assert.deepEqual(report.attribution.top_projects, [
      { project_id: "vulca-platform", event_count: 2, success_count: 2, error_count: 0, unknown_count: 0 },
    ]);
    assert.deepEqual(report.attribution.top_workspaces, [
      { workspace_id: "ws_vulca", event_count: 2, success_count: 2, error_count: 0, unknown_count: 0 },
    ]);
    assert.deepEqual(report.attribution.top_user_labels, [
      { user_label: "emoart-operator", event_count: 1, success_count: 0, error_count: 1, unknown_count: 0 },
    ]);
    assert.equal(report.priorities.length, 1);
    assert.equal(report.priorities[0].kind, "reliability");
    assert.match(text, /Telemetry Product Report/);
    assert.match(text, /Estimated Codex tokens saved/);
    assert.match(text, /Multimodal adoption/);
    assert.match(text, /Artifact-review quality/);
    assert.match(text, /Average overall score: 81/);
    assert.match(text, /Attribution/);
    assert.match(text, /vulca-platform/);
    assert.match(text, /ws_vulca/);
    assert.match(text, /emoart-operator/);
    assert.doesNotMatch(serialized, /private report prompt|private report response/);
    assert.doesNotMatch(serialized, /private report strength/);
    assert.doesNotMatch(serialized, /evt_report_|trace_report_|dep_report/);
    assert.doesNotMatch(serialized, /person@example\.com/);
    assert.doesNotMatch(serialized, /\/Users\/example|latest\.json|secret-report-screenshot\.png/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runTelemetryReport handles empty telemetry without unsafe claims", async () => {
  const cwd = await temporaryWorkspace();
  try {
    await saveTelemetryConfig({
      cwd,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TOKEN_ENV,
      deploymentId: "gemini-agent-main",
    });

    const report = await runTelemetryReport({ cwd, scope: "local" });
    const text = formatTelemetryReportText(report);

    assert.equal(report.executive_summary.status, "empty");
    assert.match(report.executive_summary.headline, /No telemetry events available/);
    assert.equal(report.health.event_count, 0);
    assert.equal(report.priorities.length, 0);
    assert.match(text, /collect more telemetry/i);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runTelemetryReport exposes product-adjusted analytics when validation events are present", async () => {
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
      event: telemetryEvent(5, {
        command: "artifact-review",
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [{ mime_type: "image/png", byte_size: 100, media_kind: "screenshot" }],
        },
        metadata: {
          telemetry_purpose: "production",
          design_scorecard: {
            overall_score: 82,
            implementation_readiness_score: 80,
          },
        },
        economics: {
          input_tokens: 1000,
          output_tokens: 100,
          total_tokens: 1100,
          codex_tokens_saved_estimate: 1200,
        },
      }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(6, {
        command: "artifact-review",
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [{ mime_type: "image/png", byte_size: 100, media_kind: "screenshot" }],
        },
        metadata: {
          telemetry_purpose: "validation",
          design_scorecard: {
            overall_score: 99,
            implementation_readiness_score: 99,
          },
        },
        economics: {
          input_tokens: 9000,
          output_tokens: 900,
          total_tokens: 9900,
          codex_tokens_saved_estimate: 10_000,
        },
      }),
    });

    const report = await runTelemetryReport({ cwd, scope: "local" });
    const text = formatTelemetryReportText(report);
    const serialized = `${JSON.stringify(report)}\n${text}`;

    assert.equal(report.health.event_count, 2);
    assert.deepEqual(report.product_analytics, {
      product_adjusted: true,
      event_count: 2,
      product_adjusted_event_count: 1,
      validation_event_count: 1,
      note: "Product analytics exclude validation telemetry; health and delivery counts include all events.",
    });
    assert.equal(report.multimodal.event_count, 1);
    assert.equal(report.artifact_review_quality.event_count, 1);
    assert.equal(report.artifact_review_quality.avg_overall_score, 82);
    assert.equal(report.economics.codex_tokens_saved_estimate, 11_200);
    assert.equal(report.economics.product_adjusted_codex_tokens_saved_estimate, 1200);
    assert.equal(report.economics.product_adjusted_gemini_estimated_cost_usd, 0.0024);
    assert.equal(report.economics.usage_applicable_adjusted_coverage_rate, 1);
    assert.match(text, /Product analytics/);
    assert.match(text, /Product-adjusted events: 1 of 2/);
    assert.match(text, /Validation events excluded from product metrics: 1/);
    assert.doesNotMatch(serialized, /evt_report_000005|evt_report_000006|private report prompt|private report response/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runTelemetryReport exposes aggregate structured response diagnostics safely", async () => {
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
      event: telemetryEvent(7, {
        command: "artifact-review --file /Users/example/private.png",
        status: "error",
        error_type: "SyntaxError",
        response: "{\"partial\":\"private report response with secret-token",
        metadata: {
          structured_response: {
            response_text_bytes: 4096,
            response_has_json_object_envelope: false,
            gemini_finish_reason: "MAX_TOKENS",
          },
        },
      }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(8, {
        command: "artifact-review",
        response: "{\"ok\":true}",
        metadata: {
          structured_response: {
            response_text_bytes: 128,
            response_has_json_object_envelope: true,
            gemini_finish_reason: "STOP",
          },
        },
      }),
    });

    const report = await runTelemetryReport({ cwd, scope: "local", topLimit: 5 });
    const text = formatTelemetryReportText(report);
    const serialized = `${JSON.stringify(report)}\n${text}`;

    assert.deepEqual(report.structured_response, {
      event_count: 2,
      missing_json_envelope_count: 1,
      missing_json_envelope_rate: 0.5,
      avg_response_text_bytes: 2112,
      max_response_text_bytes: 4096,
      top_finish_reason: {
        gemini_finish_reason: "MAX_TOKENS",
        event_count: 1,
      },
      top_command: {
        command: "artifact-review",
        event_count: 2,
        missing_json_envelope_count: 1,
        avg_response_text_bytes: 2112,
        max_response_text_bytes: 4096,
      },
    });
    assert.equal(report.priorities[0].kind, "reliability");
    assert.match(report.priorities[0].title, /Structured response JSON envelope failures/);
    assert.match(text, /Structured responses/);
    assert.match(text, /Missing JSON envelope: 1/);
    assert.match(text, /Top finish reason: MAX_TOKENS/);
    assert.match(text, /Top structured command: artifact-review/);
    assert.doesNotMatch(serialized, /private report response|secret-token|\/Users\/example|private\.png|evt_report_000007/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("buildStructuredResponseReport tolerates legacy summaries without structured diagnostics", () => {
  assert.deepEqual(buildStructuredResponseReport({}), {
    event_count: 0,
    missing_json_envelope_count: 0,
    missing_json_envelope_rate: null,
    avg_response_text_bytes: null,
    max_response_text_bytes: null,
    top_finish_reason: null,
    top_command: null,
  });
});

test("runTelemetryReport points pending delivery attention at bounded flush diagnostics", async () => {
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
      event: telemetryEvent(4, {
        command: "context-pack",
        economics: {
          input_tokens: 1_000,
          output_tokens: 100,
          total_tokens: 1_100,
          codex_tokens_saved_estimate: 2_000,
        },
      }),
    });

    const report = await runTelemetryReport({ cwd, scope: "local" });

    assert.equal(report.executive_summary.status, "attention");
    assert.match(report.executive_summary.top_next_action, /telemetry doctor/i);
    assert.match(report.executive_summary.top_next_action, /flush --batch-size 1/i);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
