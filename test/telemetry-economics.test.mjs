import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveTelemetryConfig } from "../src/telemetry-config.mjs";
import { appendTelemetryEvent } from "../src/telemetry-queue.mjs";
import {
  formatTelemetryEconomicsText,
  runTelemetryEconomics,
} from "../src/telemetry-economics.mjs";

const TOKEN_ENV = "GEMINI_AGENT_TELEMETRY_TOKEN";

async function temporaryWorkspace(prefix = "gemini-agent-telemetry-economics-") {
  return mkdtemp(join(tmpdir(), prefix));
}

function telemetryEvent(index, overrides = {}) {
  const suffix = `${index}`.padStart(6, "0");
  return {
    schema_version: 1,
    event_id: `evt_${suffix}`,
    trace_id: `trace_${suffix}`,
    deployment_id: "dep_test",
    project_id: "gemini-agent",
    source: "cli",
    command: "ask",
    model: "gemini-3.5-flash",
    prompt: `private economics prompt ${suffix}`,
    response: `private economics response ${suffix}`,
    status: "success",
    error_type: null,
    latency_ms: index,
    created_at: "2026-06-10T09:00:00.000Z",
    payload: { prompt_truncated: false, response_truncated: false, multimodal: [] },
    context: {
      cwd: null,
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

test("runTelemetryEconomics aggregates totals and command ROI safely", async () => {
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
        command: " Diff_Review ",
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
        command: "diff-review",
        status: "error",
        error_type: "APIError",
        economics: {
          input_tokens: 500_000,
          output_tokens: 50_000,
          total_tokens: 550_000,
          codex_tokens_saved_estimate: null,
        },
      }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(3, {
        command: "plan_critique",
        economics: {
          input_tokens: 250_000,
          output_tokens: 25_000,
          total_tokens: 275_000,
          codex_tokens_saved_estimate: 300_000,
        },
      }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(4, { command: "ask" }),
    });

    const report = await runTelemetryEconomics({
      cwd,
      scope: "local",
      now: new Date("2026-06-10T10:00:00.000Z"),
      topLimit: 5,
    });
    const text = formatTelemetryEconomicsText(report);
    const serialized = `${JSON.stringify(report)}\n${text}`;
    const commands = new Map(report.top_commands.map((item) => [item.command, item]));

    assert.equal(report.pricing.input_price_per_million, 1.5);
    assert.equal(report.pricing.output_price_per_million, 9);
    assert.equal(report.totals.event_count, 4);
    assert.equal(report.totals.events_with_usage, 3);
    assert.equal(report.totals.events_missing_usage, 1);
    assert.equal(report.totals.input_tokens, 1_750_000);
    assert.equal(report.totals.output_tokens, 175_000);
    assert.equal(report.totals.total_tokens, 1_925_000);
    assert.equal(report.totals.codex_tokens_saved_estimate, 2_800_000);
    assert.equal(report.totals.gemini_estimated_cost_usd, 4.2);
    assert.equal(report.totals.gemini_tokens_per_codex_token_saved, 0.6875);
    assert.equal(report.totals.usage_coverage_rate, 0.75);
    assert.equal(commands.get("diff-review").event_count, 2);
    assert.equal(commands.get("diff-review").error_count, 1);
    assert.equal(commands.get("diff-review").codex_tokens_saved_estimate, 2_500_000);
    assert.equal(commands.get("diff-review").gemini_estimated_cost_usd, 3.6);
    assert.equal(commands.get("plan-critique").codex_tokens_saved_estimate, 300_000);
    assert.match(report.recommendations.map((item) => item.kind).join("\n"), /instrumentation/);
    assert.match(text, /Telemetry Economics/);
    assert.match(text, /Estimated Gemini cost/);
    assert.doesNotMatch(serialized, /private economics prompt/);
    assert.doesNotMatch(serialized, /private economics response/);
    assert.doesNotMatch(serialized, /evt_000001/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runTelemetryEconomics supports price overrides and global scope", async () => {
  const project = await temporaryWorkspace("gemini-agent-telemetry-economics-project-");
  const home = await temporaryWorkspace("gemini-agent-telemetry-economics-home-");
  try {
    await saveTelemetryConfig({
      cwd: home,
      scope: "local",
      endpoint: "http://127.0.0.1:8787/ingest",
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

    const report = await runTelemetryEconomics({
      cwd: project,
      home,
      scope: "global",
      inputPricePerMillion: 2,
      outputPricePerMillion: 3,
    });

    assert.equal(report.scope, "global");
    assert.equal(report.storage_cwd, home);
    assert.equal(report.pricing.input_price_per_million, 2);
    assert.equal(report.pricing.output_price_per_million, 3);
    assert.equal(report.totals.gemini_estimated_cost_usd, 5);
    assert.equal(report.top_commands[0].command, "context-pack");
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("runTelemetryEconomics rejects invalid options", async () => {
  await assert.rejects(
    () => runTelemetryEconomics({ topLimit: 0 }),
    /topLimit must be a positive integer/,
  );
  await assert.rejects(
    () => runTelemetryEconomics({ inputPricePerMillion: -1 }),
    /inputPricePerMillion must be a nonnegative number/,
  );
  await assert.rejects(
    () => runTelemetryEconomics({ outputPricePerMillion: Number.NaN }),
    /outputPricePerMillion must be a nonnegative number/,
  );
});
