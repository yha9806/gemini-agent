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

test("runTelemetryEconomics separates usage-applicable runtime events from synthetic events", async () => {
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
      event: telemetryEvent(21, {
        command: "plan-critique",
        status: "error",
        error_type: "APIError",
      }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(22, { command: "artifact-review-backfill" }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(23, { command: "artifact-review-backfill-correction" }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(24, { command: "telemetry validate" }),
    });

    const report = await runTelemetryEconomics({
      cwd,
      scope: "local",
      topLimit: 10,
    });
    const text = formatTelemetryEconomicsText(report);
    const commands = new Map(report.top_commands.map((item) => [item.command, item]));

    assert.equal(report.totals.event_count, 5);
    assert.equal(report.totals.events_with_usage, 1);
    assert.equal(report.totals.events_missing_usage, 4);
    assert.equal(report.totals.usage_coverage_rate, 0.2);
    assert.equal(report.totals.usage_applicable_event_count, 2);
    assert.equal(report.totals.usage_not_applicable_event_count, 3);
    assert.equal(report.totals.usage_applicable_missing_count, 1);
    assert.equal(report.totals.usage_applicable_coverage_rate, 0.5);
    assert.equal(commands.get("artifact-review-backfill").usage_applicable_event_count, 0);
    assert.equal(commands.get("artifact-review-backfill").usage_not_applicable_event_count, 1);
    assert.equal(commands.get("plan-critique").usage_applicable_missing_count, 1);
    assert.match(text, /plan-critique: .*0\.0% usage-applicable coverage/);
    assert.match(text, /artifact-review-backfill: .*n\/a usage-applicable coverage/);
    assert.match(
      report.recommendations.map((item) => item.message).join("\n"),
      /Usage metadata coverage for Gemini runtime events is below 80%/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runTelemetryEconomics reports aggregate usage metadata gaps safely", async () => {
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
        command: "beta",
        prompt: "private gap prompt beta",
        response: "private gap response beta",
        payload: {
          prompt_truncated: false,
          response_truncated: false,
          multimodal: [{ basename: "private-gap-design.png" }],
        },
      }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(41, { command: "beta" }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(42, { command: "alpha" }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(43, { command: "alpha" }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(44, {
        command: "alpha",
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
      event: telemetryEvent(45, { command: "gamma" }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(46, { command: "artifact-review-backfill" }),
    });

    const report = await runTelemetryEconomics({
      cwd,
      scope: "local",
      topLimit: 10,
    });
    const text = formatTelemetryEconomicsText(report);
    const serialized = `${JSON.stringify(report)}\n${text}`;

    assert.deepEqual(
      report.usage_gap_commands.map((item) => ({
        command: item.command,
        missing: item.usage_applicable_missing_count,
        applicable: item.usage_applicable_event_count,
        coverage: item.usage_applicable_coverage_rate,
        share: item.missing_share_of_total_applicable_gap,
      })),
      [
        { command: "alpha", missing: 2, applicable: 3, coverage: 0.3333, share: 0.4 },
        { command: "beta", missing: 2, applicable: 2, coverage: 0, share: 0.4 },
        { command: "gamma", missing: 1, applicable: 1, coverage: 0, share: 0.2 },
      ],
    );
    assert.match(text, /Usage metadata gaps/);
    assert.match(text, /alpha: 2 missing of 3 usage-applicable events, 33\.3% coverage, 40\.0% of missing usage gap/);
    assert.match(
      report.recommendations.map((item) => item.message).join("\n"),
      /Top gap: alpha has 2 missing usage-applicable events\./,
    );
    assert.doesNotMatch(serialized, /private gap prompt/);
    assert.doesNotMatch(serialized, /private gap response/);
    assert.doesNotMatch(serialized, /evt_000040/);
    assert.doesNotMatch(serialized, /private-gap-design\.png/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runTelemetryEconomics aggregates gate input byte metadata safely", async () => {
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
      event: telemetryEvent(70, {
        command: "plan_critique",
        prompt: "private plan prompt should not appear",
        response: "private plan response should not appear",
        metadata: {
          gate: "plan_critique",
          input_bytes: 1000,
          input_limit_bytes: 1000,
        },
        economics: {
          input_tokens: 200,
          output_tokens: 50,
          total_tokens: 250,
          codex_tokens_saved_estimate: 100,
        },
      }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(71, {
        command: "plan-critique",
        metadata: {
          gate: "plan_critique",
          input_bytes: 500,
          input_limit_bytes: 1000,
        },
        economics: {
          input_tokens: 100,
          output_tokens: 25,
          total_tokens: 125,
          codex_tokens_saved_estimate: 50,
        },
      }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(72, {
        command: "diff-review",
        metadata: {
          gate: "diff_review",
          input_bytes: 250,
          input_limit_bytes: 0,
        },
        economics: {
          input_tokens: 100,
          output_tokens: 25,
          total_tokens: 125,
          codex_tokens_saved_estimate: 200,
        },
      }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(73, {
        command: "patch-precheck",
        metadata: {
          gate: "patch_precheck",
          input_bytes: -1,
          input_limit_bytes: 1000,
        },
      }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(74, { command: "research-brief" }),
    });

    const report = await runTelemetryEconomics({
      cwd,
      scope: "local",
      topLimit: 10,
    });
    const text = formatTelemetryEconomicsText(report);
    const serialized = `${JSON.stringify(report)}\n${text}`;
    const commands = new Map(report.top_commands.map((item) => [item.command, item]));
    const inputCommands = new Map(report.gate_input_commands.map((item) => [item.command, item]));

    assert.equal(report.totals.events_with_input_bytes, 3);
    assert.equal(report.totals.input_bytes_total, 1750);
    assert.equal(report.totals.input_bytes_avg, 583.33);
    assert.equal(report.totals.input_bytes_max, 1000);
    assert.equal(report.totals.events_with_input_limit_bytes, 2);
    assert.equal(report.totals.input_limit_bytes_max, 1000);
    assert.equal(report.totals.input_limit_hit_count, 1);
    assert.equal(report.totals.input_limit_hit_rate, 0.5);
    assert.equal(commands.get("plan-critique").events_with_input_bytes, 2);
    assert.equal(commands.get("plan-critique").input_bytes_total, 1500);
    assert.equal(commands.get("plan-critique").input_bytes_avg, 750);
    assert.equal(commands.get("plan-critique").input_limit_hit_count, 1);
    assert.equal(commands.get("diff-review").events_with_input_limit_bytes, 0);
    assert.deepEqual(
      report.gate_input_commands.map((item) => ({
        command: item.command,
        events: item.events_with_input_bytes,
        total: item.input_bytes_total,
        avg: item.input_bytes_avg,
        max: item.input_bytes_max,
        limitHits: item.input_limit_hit_count,
        hitRate: item.input_limit_hit_rate,
      })),
      [
        {
          command: "plan-critique",
          events: 2,
          total: 1500,
          avg: 750,
          max: 1000,
          limitHits: 1,
          hitRate: 0.5,
        },
        {
          command: "diff-review",
          events: 1,
          total: 250,
          avg: 250,
          max: 250,
          limitHits: 0,
          hitRate: null,
        },
      ],
    );
    assert.equal(inputCommands.get("plan-critique").input_limit_bytes_max, 1000);
    assert.match(text, /Gate input bytes/);
    assert.match(text, /plan-critique: 2 events, 1,500 bytes total, 750 avg, 1,000 max, 50\.0% at limit/);
    assert.match(
      report.recommendations.map((item) => item.message).join("\n"),
      /plan-critique hit its configured input limit in 1 event/,
    );
    assert.doesNotMatch(serialized, /private plan prompt|private plan response|evt_000070/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runTelemetryEconomics reports context loop reuse rates safely", async () => {
  const cwd = await temporaryWorkspace();
  try {
    await saveTelemetryConfig({
      cwd,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: TOKEN_ENV,
      deploymentId: "gemini-agent-main",
    });
    const events = [
      telemetryEvent(90, {
        command: "plan-critique",
        metadata: {
          gate: "plan_critique",
          input_bytes: 1000,
          input_limit_bytes: 2000,
          context_pack_mode: "auto",
          fresh_input_mode: "stdin",
          has_fresh_input: true,
        },
      }),
      telemetryEvent(91, {
        command: "plan_critique",
        metadata: {
          gate: "plan_critique",
          input_bytes: 2000,
          input_limit_bytes: 3000,
          context_pack_mode: "explicit",
          fresh_input_mode: "none",
          has_fresh_input: false,
          context_pack_path: "/Users/example/private/context.json",
        },
      }),
      telemetryEvent(92, {
        command: "plan-critique",
        metadata: {
          gate: "plan_critique",
          input_bytes: 3000,
          input_limit_bytes: 4000,
          context_pack_mode: "none",
          fresh_input_mode: "file",
          has_fresh_input: true,
          context_pack_preflight_warning: true,
        },
      }),
      telemetryEvent(93, {
        command: "diff-review",
        metadata: {
          gate: "diff_review",
          input_bytes: 500,
          context_pack_mode: "not-real",
          fresh_input_mode: "/Users/example/private/diff.patch",
          context_pack_preflight_warning: true,
        },
      }),
      telemetryEvent(94, {
        command: "diff-review",
        metadata: {
          gate: "diff_review",
          input_bytes: 750,
        },
      }),
      telemetryEvent(96, {
        command: "diff-review",
        metadata: {
          gate: "diff_review",
          input_bytes: 950,
          context_pack_mode: "auto",
          fresh_input_mode: "smart-diff",
        },
      }),
      telemetryEvent(95, {
        command: "ask",
        metadata: {
          context_pack_mode: "auto",
          fresh_input_mode: "stdin",
        },
      }),
    ];
    for (const event of events) {
      await appendTelemetryEvent({ cwd, event });
    }

    const report = await runTelemetryEconomics({ cwd, scope: "local", topLimit: 10 });
    const text = formatTelemetryEconomicsText(report);
    const serialized = `${JSON.stringify(report)}\n${text}`;
    const rows = new Map(report.context_loop.top_gate_commands.map((item) => [item.command, item]));

    assert.equal(report.context_loop.gate_event_count, 6);
    assert.equal(report.context_loop.context_pack_reused_event_count, 3);
    assert.equal(report.context_loop.context_pack_reuse_rate, 0.5);
    assert.equal(report.context_loop.auto_context_pack_event_count, 2);
    assert.equal(report.context_loop.auto_context_pack_rate, 0.3333);
    assert.equal(report.context_loop.explicit_context_pack_event_count, 1);
    assert.equal(report.context_loop.no_context_pack_event_count, 1);
    assert.equal(report.context_loop.unknown_context_pack_mode_event_count, 2);
    assert.equal(report.context_loop.has_fresh_input_count, 3);
    assert.equal(report.context_loop.context_pack_preflight_warning_count, 2);
    assert.equal(report.context_loop.context_pack_preflight_warning_rate, 0.3333);
    assert.equal(rows.get("plan-critique").event_count, 3);
    assert.equal(rows.get("plan-critique").context_pack_reused_event_count, 2);
    assert.equal(rows.get("plan-critique").context_pack_reuse_rate, 0.6667);
    assert.equal(rows.get("plan-critique").auto_context_pack_rate, 0.3333);
    assert.equal(rows.get("plan-critique").context_pack_preflight_warning_count, 1);
    assert.equal(rows.get("diff-review").event_count, 3);
    assert.equal(rows.get("diff-review").context_pack_reused_event_count, 1);
    assert.equal(rows.get("diff-review").context_pack_reuse_rate, 0.3333);
    assert.equal(rows.get("diff-review").auto_context_pack_rate, 0.3333);
    assert.equal(rows.get("plan-critique").context_pack_preflight_warning_rate, 0.3333);
    assert.equal(rows.get("plan-critique").input_bytes_avg, 2000);
    assert.equal(rows.get("diff-review").unknown_context_pack_mode_event_count, 2);
    assert.equal(rows.get("diff-review").context_pack_preflight_warning_count, 1);
    assert.equal(rows.get("diff-review").context_pack_preflight_warning_rate, 0.3333);
    assert.match(text, /Context loop/);
    assert.match(text, /Context-pack preflight warning rate: 33\.3%/);
    assert.doesNotMatch(serialized, /\/Users\/example|context\.json|diff\.patch|not-real|NaN|Infinity/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runTelemetryEconomics reports empty gate input byte aggregates without NaN", async () => {
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
      event: telemetryEvent(80, { command: "diff-review" }),
    });

    const report = await runTelemetryEconomics({ cwd, scope: "local" });
    const text = formatTelemetryEconomicsText(report);
    const serialized = `${JSON.stringify(report)}\n${text}`;

    assert.equal(report.totals.events_with_input_bytes, 0);
    assert.equal(report.totals.input_bytes_total, 0);
    assert.equal(report.totals.input_bytes_avg, null);
    assert.equal(report.totals.input_bytes_max, 0);
    assert.equal(report.totals.input_limit_hit_rate, null);
    assert.deepEqual(report.gate_input_commands, []);
    assert.match(text, /Gate input bytes:\nNone/);
    assert.doesNotMatch(serialized, /NaN|Infinity/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runTelemetryEconomics separates suspected test fixtures from adjusted runtime coverage", async () => {
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
        command: "ask",
        prompt: "hello",
        response: "world",
        latency_ms: 5,
      }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(51, {
        command: "ask",
        prompt: "hello",
        response: "world",
        latency_ms: 6,
      }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(52, {
        command: "ask",
        prompt: "hello!",
        response: "world",
        latency_ms: 1,
      }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(53, { command: "diff-review" }),
    });
    await appendTelemetryEvent({
      cwd,
      event: telemetryEvent(54, {
        command: "diff-review",
        economics: {
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
          codex_tokens_saved_estimate: 100,
        },
      }),
    });

    const report = await runTelemetryEconomics({
      cwd,
      scope: "local",
      topLimit: 10,
    });
    const text = formatTelemetryEconomicsText(report);
    const serialized = `${JSON.stringify(report)}\n${text}`;
    const gaps = new Map(report.usage_gap_commands.map((item) => [item.command, item]));

    assert.equal(report.totals.usage_applicable_event_count, 5);
    assert.equal(report.totals.usage_applicable_missing_count, 4);
    assert.equal(report.totals.usage_applicable_coverage_rate, 0.2);
    assert.equal(report.totals.suspected_test_fixture_event_count, 1);
    assert.equal(report.totals.usage_applicable_adjusted_event_count, 4);
    assert.equal(report.totals.usage_applicable_adjusted_missing_count, 3);
    assert.equal(report.totals.usage_applicable_adjusted_coverage_rate, 0.25);
    assert.equal(gaps.get("ask").suspected_test_fixture_event_count, 1);
    assert.equal(gaps.get("ask").adjusted_usage_applicable_missing_count, 2);
    assert.equal(gaps.get("ask").adjusted_usage_applicable_coverage_rate, 0);
    assert.equal(gaps.get("ask").adjusted_missing_share_of_total_applicable_gap, 0.6667);
    assert.equal(gaps.get("diff-review").adjusted_usage_applicable_missing_count, 1);
    assert.match(text, /Adjusted usage-applicable coverage: 25\.0%/);
    assert.match(text, /Suspected test fixture events: 1/);
    assert.match(text, /ask: 2 adjusted missing of 2 adjusted usage-applicable events, 0\.0% adjusted coverage, 66\.7% of adjusted missing usage gap, 1 suspected fixture/);
    assert.doesNotMatch(serialized, /hello|world|evt_000050/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runTelemetryEconomics handles only suspected test fixtures in adjusted coverage", async () => {
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
        command: "ask",
        prompt: "hello",
        response: "world",
        latency_ms: 1,
      }),
    });

    const report = await runTelemetryEconomics({
      cwd,
      scope: "local",
      topLimit: 10,
    });
    const text = formatTelemetryEconomicsText(report);

    assert.equal(report.totals.usage_applicable_event_count, 1);
    assert.equal(report.totals.usage_applicable_missing_count, 1);
    assert.equal(report.totals.usage_applicable_coverage_rate, 0);
    assert.equal(report.totals.suspected_test_fixture_event_count, 1);
    assert.equal(report.totals.usage_applicable_adjusted_event_count, 0);
    assert.equal(report.totals.usage_applicable_adjusted_missing_count, 0);
    assert.equal(report.totals.usage_applicable_adjusted_coverage_rate, null);
    assert.deepEqual(report.usage_gap_commands, []);
    assert.match(text, /Adjusted usage-applicable coverage: n\/a/);
    assert.doesNotMatch(
      report.recommendations.map((item) => item.message).join("\n"),
      /Usage metadata coverage/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runTelemetryEconomics handles datasets with no usage-applicable events", async () => {
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

    const report = await runTelemetryEconomics({ cwd, scope: "local" });

    assert.equal(report.totals.usage_coverage_rate, 0);
    assert.equal(report.totals.usage_applicable_event_count, 0);
    assert.equal(report.totals.usage_applicable_missing_count, 0);
    assert.equal(report.totals.usage_applicable_coverage_rate, null);
    assert.deepEqual(report.usage_gap_commands, []);
    assert.match(formatTelemetryEconomicsText(report), /Usage metadata gaps:\nNone/);
    assert.doesNotMatch(
      report.recommendations.map((item) => item.message).join("\n"),
      /Usage metadata coverage/,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
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
