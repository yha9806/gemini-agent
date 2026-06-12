import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveTelemetryConfig } from "../src/telemetry-config.mjs";
import {
  artifactReviewReadinessPlanToText,
  buildArtifactReviewReadinessPlan,
  runArtifactReviewReadinessPlan,
} from "../src/telemetry-artifact-review-readiness-plan.mjs";

const PRIVATE_TEXT = "raw prompt /home/example Authorization: Bearer secret-token evt_private private.png batch_private";

function scorecard({
  eventCount = 0,
  scorecardEventCount = 0,
  coverage = null,
  fieldCoverage = coverage,
} = {}) {
  return {
    event_count: eventCount,
    scorecard_event_count: scorecardEventCount,
    coverage_rate: coverage,
    field_coverage_min: fieldCoverage,
    weakest_field: fieldCoverage === null ? null : {
      field: "accessibility_score",
      event_count: eventCount,
      scored_event_count: scorecardEventCount,
      coverage_rate: fieldCoverage,
    },
    target_coverage_rate: 0.8,
    events_needed_for_target: eventCount > 0
      ? Math.max(0, Math.ceil(eventCount * 0.8) - scorecardEventCount)
      : null,
  };
}

function coveragePlan(overrides = {}) {
  return {
    ok: true,
    scope: "local",
    generated_at: "2026-06-12T00:00:00.000Z",
    command: "artifact-review",
    plan: {
      status: "ready_for_more_collection",
      reasons: ["production_scorecard_coverage_low", "active_quick_low_sample"],
    },
    production_scorecard: scorecard({
      eventCount: 160,
      scorecardEventCount: 10,
      coverage: 0.0625,
      fieldCoverage: 0.0625,
    }),
    validation_scorecard: {
      ...scorecard({
        eventCount: 5,
        scorecardEventCount: 3,
        coverage: 0.6,
        fieldCoverage: 0.6,
      }),
      events_needed_for_target: undefined,
    },
    active_quick_collection: {
      active_budget_cohorts: [
        {
          budget_cohort: "2048",
          event_count: 4,
          success_count: 4,
          error_count: 0,
          error_rate: 0,
          additional_events_needed: 6,
          low_confidence: true,
        },
      ],
      target_events_per_cohort: 10,
      additional_events_needed: 6,
      active_error_rate: 0,
      low_confidence: true,
    },
    latency_guard: {
      status: "within_budget",
      p95_ms: 14055,
      budget_ms: 15000,
      near_budget: true,
    },
    historical_risks: [],
    next_actions: [],
    limitations: [],
    ...overrides,
  };
}

function summary(overrides = {}) {
  return {
    scope: "local",
    generated_at: "2026-06-12T00:00:00.000Z",
    structured_response: {
      event_count: 30,
      missing_json_envelope_count: 1,
      missing_json_envelope_rate: 0.0333,
      retry_event_count: 0,
      retry_scheduled_count: 0,
      retry_recovered_count: 0,
      retry_recovery_rate: null,
      top_commands: [
        {
          command: "artifact-review",
          event_count: 4,
          missing_json_envelope_count: 1,
          retry_event_count: 0,
          retry_recovered_count: 0,
        },
      ],
    },
    private_raw: PRIVATE_TEXT,
    ...overrides,
  };
}

function doctor(overrides = {}) {
  return {
    ok: true,
    scope: "local",
    delivery: {
      status: "flush_ready",
      pending_events: 9,
      inflight_events: 0,
      failed_events: 0,
      quarantine_events: 0,
      recommended_action: "Run telemetry flush --dry-run, then telemetry flush --batch-size 1.",
    },
    queue: {
      pending: { count: 9, bytes: 494396 },
      inflight: { count: 0, bytes: 0 },
      failed: { count: 0, bytes: 0 },
      quarantine: { count: 0, bytes: 0 },
    },
    small_flush_safe: true,
    recommended_action: "Run telemetry flush --dry-run, then telemetry flush --batch-size 1.",
    checks: {
      config_valid: { ok: true },
      config_enabled: { ok: true },
      token_env_valid: { ok: true },
      token_env_present: { ok: true },
      endpoint_valid: { ok: true },
    },
    endpoint_check: { ok: true, status: 200 },
    storage_cwd: "/home/example",
    ...overrides,
  };
}

function rawRisk(overrides = {}) {
  return {
    file_count: 0,
    event_count: 0,
    invalid_file_count: 0,
    skipped_file_count: 0,
    prompt_events: 0,
    response_events: 0,
    prompt_bytes: 0,
    response_bytes: 0,
    truncated_prompt_events: 0,
    truncated_response_events: 0,
    multimodal_events: 0,
    media_item_count: 0,
    credential_like_prompt_events: 0,
    credential_like_response_events: 0,
    credential_scan_truncated_events: 0,
    email_like_prompt_events: 0,
    email_like_response_events: 0,
    path_like_prompt_events: 0,
    path_like_response_events: 0,
    phone_like_prompt_events: 0,
    phone_like_response_events: 0,
    sensitive_scan_truncated_events: 0,
    ...overrides,
  };
}

function rawPreflight(overrides = {}) {
  return {
    ok: true,
    scope: "local",
    pending: { total_count: 9, total_bytes: 494396 },
    batch: {
      batch_size: 9,
      would_send_count: 9,
      batch_bytes: 494396,
      exceeds_max_bytes: false,
      excluded_by_batch_size_count: 0,
      preview_error: null,
    },
    risk: rawRisk({
      file_count: 9,
      event_count: 9,
      prompt_events: 9,
      response_events: 9,
      prompt_bytes: 900,
      response_bytes: 900,
      credential_like_prompt_events: 2,
      path_like_prompt_events: 2,
      phone_like_prompt_events: 3,
      phone_like_response_events: 2,
      sensitive_scan_truncated_events: 2,
    }),
    next_command: "gemini-agent telemetry flush --dry-run --batch-size 9",
    limitations: [],
    ...overrides,
  };
}

function readyCoveragePlan(overrides = {}) {
  return coveragePlan({
    production_scorecard: scorecard({ eventCount: 20, scorecardEventCount: 18, coverage: 0.9, fieldCoverage: 0.85 }),
    validation_scorecard: {
      ...scorecard({ eventCount: 5, scorecardEventCount: 5, coverage: 1, fieldCoverage: 1 }),
      events_needed_for_target: undefined,
    },
    active_quick_collection: {
      active_budget_cohorts: [
        {
          budget_cohort: "2048",
          event_count: 12,
          success_count: 12,
          error_count: 0,
          error_rate: 0,
          additional_events_needed: 0,
          low_confidence: false,
        },
      ],
      target_events_per_cohort: 10,
      additional_events_needed: 0,
      active_error_rate: 0,
      low_confidence: false,
    },
    latency_guard: {
      status: "within_budget",
      p95_ms: 12000,
      budget_ms: 15000,
      near_budget: false,
    },
    ...overrides,
  });
}

function cleanDoctor(overrides = {}) {
  return doctor({
    delivery: {
      status: "delivered",
      pending_events: 0,
      inflight_events: 0,
      failed_events: 0,
      quarantine_events: 0,
      recommended_action: "No pending, inflight, failed, or quarantined telemetry events.",
    },
    queue: {
      pending: { count: 0 },
      inflight: { count: 0 },
      failed: { count: 0 },
      quarantine: { count: 0 },
    },
    small_flush_safe: false,
    ...overrides,
  });
}

function cleanRawPreflight(overrides = {}) {
  return rawPreflight({
    pending: { total_count: 0, total_bytes: 0 },
    batch: {
      batch_size: 100,
      would_send_count: 0,
      batch_bytes: 0,
      exceeds_max_bytes: false,
      excluded_by_batch_size_count: 0,
      preview_error: null,
    },
    risk: rawRisk(),
    ...overrides,
  });
}

test("readiness plan blocks current A2-shaped raw governance data", () => {
  const report = buildArtifactReviewReadinessPlan({
    summary: summary(),
    coveragePlan: coveragePlan(),
    doctor: doctor(),
    rawPreflight: rawPreflight(),
  });

  assert.equal(report.ok, true);
  assert.equal(report.command, "artifact-review");
  assert.equal(report.readiness.status, "blocked");
  assert.equal(report.routing_recommendation.limited_routing_allowed, false);
  assert.equal(report.routing_recommendation.production_sampling_allowed, false);
  assert.equal(report.routing_recommendation.additional_quick_samples_needed, 6);
  assert.deepEqual(report.routing_recommendation.recommended_budget_cohorts, ["2048"]);
  assert.ok(report.readiness.reasons.includes("active_quick_low_sample"));
  assert.ok(report.readiness.reasons.includes("production_scorecard_coverage_low"));
  assert.ok(report.readiness.reasons.includes("structured_response_unrecovered_json_envelope"));
  assert.ok(report.readiness.reasons.includes("raw_pending_sensitive_signals"));
  assert.ok(report.readiness.reasons.includes("generation_latency_near_budget"));
  assert.doesNotMatch(JSON.stringify(report), /raw prompt\b|Authorization|Bearer|evt_private|private\.png|batch_private|\/home\/example/);
});

test("readiness plan blocks unsafe active quick reliability", () => {
  const report = buildArtifactReviewReadinessPlan({
    summary: summary({ structured_response: { event_count: 0, top_commands: [] } }),
    coveragePlan: coveragePlan({
      active_quick_collection: {
        active_budget_cohorts: [
          {
            budget_cohort: "2048",
            event_count: 10,
            success_count: 9,
            error_count: 1,
            error_rate: 0.1,
            additional_events_needed: 0,
            low_confidence: false,
          },
        ],
        target_events_per_cohort: 10,
        additional_events_needed: 0,
        active_error_rate: 0.1,
        low_confidence: false,
      },
    }),
    doctor: cleanDoctor(),
    rawPreflight: cleanRawPreflight(),
  });

  assert.equal(report.readiness.status, "blocked");
  assert.ok(report.readiness.reasons.includes("active_quick_error_rate_high"));
  assert.equal(report.routing_recommendation.production_sampling_allowed, false);
});

test("readiness plan requires production scorecard coverage even with healthy validation", () => {
  const report = buildArtifactReviewReadinessPlan({
    summary: summary({
      structured_response: {
        event_count: 4,
        missing_json_envelope_count: 0,
        retry_event_count: 1,
        retry_recovered_count: 1,
        retry_recovery_rate: 1,
        top_commands: [],
      },
    }),
    coveragePlan: coveragePlan({
      validation_scorecard: {
        ...scorecard({ eventCount: 5, scorecardEventCount: 5, coverage: 1, fieldCoverage: 1 }),
        events_needed_for_target: undefined,
      },
      active_quick_collection: {
        active_budget_cohorts: [
          {
            budget_cohort: "2048",
            event_count: 10,
            success_count: 10,
            error_count: 0,
            error_rate: 0,
            additional_events_needed: 0,
            low_confidence: false,
          },
        ],
        target_events_per_cohort: 10,
        additional_events_needed: 0,
        active_error_rate: 0,
        low_confidence: false,
      },
      latency_guard: {
        status: "within_budget",
        p95_ms: 12000,
        budget_ms: 15000,
        near_budget: false,
      },
    }),
    doctor: cleanDoctor(),
    rawPreflight: cleanRawPreflight(),
  });

  assert.equal(report.readiness.status, "collect_more_samples");
  assert.ok(report.readiness.reasons.includes("production_scorecard_coverage_low"));
  assert.equal(report.routing_recommendation.limited_routing_allowed, false);
});

test("readiness plan blocks zero production scorecard coverage when production events exist", () => {
  const report = buildArtifactReviewReadinessPlan({
    summary: summary({
      structured_response: {
        event_count: 4,
        missing_json_envelope_count: 0,
        retry_event_count: 1,
        retry_recovered_count: 1,
        retry_recovery_rate: 1,
        top_commands: [],
      },
    }),
    coveragePlan: readyCoveragePlan({
      production_scorecard: scorecard({
        eventCount: 20,
        scorecardEventCount: 1,
        coverage: 0,
        fieldCoverage: 0,
      }),
    }),
    doctor: cleanDoctor(),
    rawPreflight: cleanRawPreflight(),
  });

  assert.equal(report.readiness.status, "blocked");
  assert.ok(report.readiness.reasons.includes("production_scorecard_coverage_zero"));
  assert.equal(report.routing_recommendation.limited_routing_allowed, false);
});

test("readiness plan does not use unrelated retry recovery for artifact-review JSON envelope risk", () => {
  const report = buildArtifactReviewReadinessPlan({
    summary: summary({
      structured_response: {
        event_count: 12,
        missing_json_envelope_count: 1,
        missing_json_envelope_rate: 0.0833,
        retry_event_count: 1,
        retry_scheduled_count: 1,
        retry_recovered_count: 1,
        retry_recovery_rate: 1,
        top_commands: [
          {
            command: "artifact-review",
            event_count: 4,
            missing_json_envelope_count: 1,
          },
          {
            command: "diff-review",
            event_count: 8,
            missing_json_envelope_count: 0,
          },
        ],
        top_retry_commands: [
          {
            command: "diff-review",
            retry_event_count: 1,
            retry_scheduled_count: 1,
            retry_recovered_count: 1,
          },
        ],
      },
    }),
    coveragePlan: readyCoveragePlan(),
    doctor: cleanDoctor(),
    rawPreflight: cleanRawPreflight(),
  });

  assert.equal(report.readiness.status, "collect_more_samples");
  assert.ok(report.readiness.reasons.includes("structured_response_unrecovered_json_envelope"));
  assert.equal(report.structured_response.retry_event_count, 0);
  assert.equal(report.structured_response.retry_scheduled_count, 0);
  assert.equal(report.structured_response.retry_recovered_count, 0);
  assert.equal(report.structured_response.retry_recovery_rate, null);
  assert.equal(report.structured_response.diagnosis, "unrecovered_json_envelope");
  assert.equal(report.structured_response.recovery_action, "verify_artifact_review_json_retry_recovery");
  assert.equal(report.routing_recommendation.limited_routing_allowed, false);
});

test("readiness plan requires doctor and raw preflight evidence before limited routing", () => {
  const report = buildArtifactReviewReadinessPlan({
    summary: summary({
      generated_at: "2026-06-12T01:02:03+01:00",
      structured_response: {
        event_count: 12,
        missing_json_envelope_count: 0,
        missing_json_envelope_rate: 0,
        retry_event_count: 0,
        retry_scheduled_count: 0,
        retry_recovered_count: 0,
        retry_recovery_rate: null,
        top_commands: [
          {
            command: "artifact-review",
            event_count: 12,
            missing_json_envelope_count: 0,
          },
        ],
        top_retry_commands: [],
      },
    }),
    coveragePlan: readyCoveragePlan(),
    doctor: null,
    rawPreflight: null,
  });

  assert.equal(report.generated_at, "2026-06-12T00:02:03.000Z");
  assert.equal(report.readiness.status, "blocked");
  assert.ok(report.readiness.reasons.includes("telemetry_doctor_unavailable"));
  assert.ok(report.readiness.reasons.includes("raw_preflight_unavailable"));
  assert.equal(report.routing_recommendation.limited_routing_allowed, false);
});

test("readiness plan requires healthy endpoint diagnostics before limited routing", () => {
  const report = buildArtifactReviewReadinessPlan({
    summary: summary({
      structured_response: {
        event_count: 12,
        missing_json_envelope_count: 0,
        missing_json_envelope_rate: 0,
        retry_event_count: 0,
        retry_scheduled_count: 0,
        retry_recovered_count: 0,
        retry_recovery_rate: null,
        top_commands: [
          {
            command: "artifact-review",
            event_count: 12,
            missing_json_envelope_count: 0,
          },
        ],
        top_retry_commands: [],
      },
    }),
    coveragePlan: readyCoveragePlan(),
    doctor: cleanDoctor({ ok: true, endpoint_check: { ok: false, status: 503 } }),
    rawPreflight: cleanRawPreflight(),
  });

  assert.equal(report.readiness.status, "blocked");
  assert.ok(report.readiness.reasons.includes("telemetry_endpoint_unhealthy"));
  assert.equal(report.routing_recommendation.limited_routing_allowed, false);
});

test("readiness plan requires endpoint diagnostics to be present before limited routing", () => {
  const report = buildArtifactReviewReadinessPlan({
    summary: summary({
      structured_response: {
        event_count: 12,
        missing_json_envelope_count: 0,
        missing_json_envelope_rate: 0,
        retry_event_count: 0,
        retry_scheduled_count: 0,
        retry_recovered_count: 0,
        retry_recovery_rate: null,
        top_commands: [
          {
            command: "artifact-review",
            event_count: 12,
            missing_json_envelope_count: 0,
          },
        ],
        top_retry_commands: [],
      },
    }),
    coveragePlan: readyCoveragePlan(),
    doctor: cleanDoctor({ ok: true, endpoint_check: undefined }),
    rawPreflight: cleanRawPreflight(),
  });

  assert.equal(report.readiness.status, "blocked");
  assert.ok(report.readiness.reasons.includes("telemetry_endpoint_unhealthy"));
  assert.ok(report.next_actions.includes("Run telemetry doctor and restore healthy endpoint diagnostics before limited routing."));
  assert.equal(report.routing_recommendation.limited_routing_allowed, false);
});

test("readiness plan requires explicit healthy doctor evidence before limited routing", () => {
  const report = buildArtifactReviewReadinessPlan({
    summary: summary({
      structured_response: {
        event_count: 12,
        missing_json_envelope_count: 0,
        missing_json_envelope_rate: 0,
        retry_event_count: 0,
        retry_scheduled_count: 0,
        retry_recovered_count: 0,
        retry_recovery_rate: null,
        top_commands: [
          {
            command: "artifact-review",
            event_count: 12,
            missing_json_envelope_count: 0,
          },
        ],
        top_retry_commands: [],
      },
    }),
    coveragePlan: readyCoveragePlan(),
    doctor: {
      endpoint_check: { ok: true, status: 200 },
      queue: {
        pending: { count: 0 },
        inflight: { count: 0 },
        failed: { count: 0 },
        quarantine: { count: 0 },
      },
    },
    rawPreflight: cleanRawPreflight(),
  });

  assert.equal(report.readiness.status, "blocked");
  assert.ok(report.readiness.reasons.includes("telemetry_doctor_incomplete"));
  assert.ok(report.next_actions.includes("Run telemetry doctor to refresh complete delivery diagnostics before limited routing."));
  assert.equal(report.routing_recommendation.limited_routing_allowed, false);
});

test("readiness plan requires explicit doctor delivery counters before limited routing", () => {
  const report = buildArtifactReviewReadinessPlan({
    summary: summary({
      structured_response: {
        event_count: 12,
        missing_json_envelope_count: 0,
        missing_json_envelope_rate: 0,
        retry_event_count: 0,
        retry_scheduled_count: 0,
        retry_recovered_count: 0,
        retry_recovery_rate: null,
        top_commands: [
          {
            command: "artifact-review",
            event_count: 12,
            missing_json_envelope_count: 0,
          },
        ],
        top_retry_commands: [],
      },
    }),
    coveragePlan: readyCoveragePlan(),
    doctor: {
      ok: true,
      endpoint_check: { ok: true, status: 200 },
      queue: {},
    },
    rawPreflight: cleanRawPreflight(),
  });

  assert.equal(report.readiness.status, "blocked");
  assert.ok(report.readiness.reasons.includes("telemetry_doctor_incomplete"));
  assert.equal(report.routing_recommendation.limited_routing_allowed, false);
});

test("readiness plan requires complete raw preflight evidence before limited routing", () => {
  const report = buildArtifactReviewReadinessPlan({
    summary: summary({
      structured_response: {
        event_count: 12,
        missing_json_envelope_count: 0,
        missing_json_envelope_rate: 0,
        retry_event_count: 0,
        retry_scheduled_count: 0,
        retry_recovered_count: 0,
        retry_recovery_rate: null,
        top_commands: [
          {
            command: "artifact-review",
            event_count: 12,
            missing_json_envelope_count: 0,
          },
        ],
        top_retry_commands: [],
      },
    }),
    coveragePlan: readyCoveragePlan(),
    doctor: cleanDoctor(),
    rawPreflight: { ok: true, pending: {}, batch: {}, risk: {} },
  });

  assert.equal(report.readiness.status, "blocked");
  assert.equal(report.raw_governance.preflight_available, false);
  assert.ok(report.readiness.reasons.includes("raw_preflight_incomplete"));
  assert.ok(report.next_actions.includes("Run raw telemetry preflight with pending, batch, and risk summaries before limited routing."));
  assert.equal(report.routing_recommendation.limited_routing_allowed, false);
});

test("readiness plan requires raw delivery to have no in-flight events", () => {
  const report = buildArtifactReviewReadinessPlan({
    summary: summary({
      structured_response: {
        event_count: 12,
        missing_json_envelope_count: 0,
        missing_json_envelope_rate: 0,
        retry_event_count: 0,
        retry_scheduled_count: 0,
        retry_recovered_count: 0,
        retry_recovery_rate: null,
        top_commands: [
          {
            command: "artifact-review",
            event_count: 12,
            missing_json_envelope_count: 0,
          },
        ],
        top_retry_commands: [],
      },
    }),
    coveragePlan: readyCoveragePlan(),
    doctor: cleanDoctor({
      queue: {
        pending: { count: 0 },
        inflight: { count: 1 },
        failed: { count: 0 },
        quarantine: { count: 0 },
      },
    }),
    rawPreflight: cleanRawPreflight(),
  });

  assert.equal(report.readiness.status, "blocked");
  assert.equal(report.raw_governance.inflight_count, 1);
  assert.ok(report.readiness.reasons.includes("raw_inflight_events_present"));
  assert.ok(report.next_actions.includes("Wait for in-flight raw telemetry delivery to settle before limited routing."));
  assert.equal(report.routing_recommendation.limited_routing_allowed, false);
});

test("readiness plan uses raw preflight pending evidence when doctor pending is zero", () => {
  const report = buildArtifactReviewReadinessPlan({
    summary: summary({
      structured_response: {
        event_count: 12,
        missing_json_envelope_count: 0,
        missing_json_envelope_rate: 0,
        retry_event_count: 0,
        retry_scheduled_count: 0,
        retry_recovered_count: 0,
        retry_recovery_rate: null,
        top_commands: [
          {
            command: "artifact-review",
            event_count: 12,
            missing_json_envelope_count: 0,
          },
        ],
        top_retry_commands: [],
      },
    }),
    coveragePlan: readyCoveragePlan(),
    doctor: cleanDoctor({
      delivery: {
        pending_events: 0,
        failed_events: 0,
        quarantine_events: 0,
      },
      queue: {
        pending: { count: 0 },
        inflight: { count: 0 },
        failed: { count: 0 },
        quarantine: { count: 0 },
      },
    }),
    rawPreflight: cleanRawPreflight({
      pending: { total_count: 3, total_bytes: 1200 },
      batch: {
        batch_size: 100,
        would_send_count: 2,
        batch_bytes: 1000,
        exceeds_max_bytes: false,
        excluded_by_batch_size_count: 0,
        preview_error: null,
      },
      risk: rawRisk({
        file_count: 2,
        event_count: 2,
        credential_like_prompt_events: 1,
        path_like_prompt_events: 1,
        phone_like_response_events: 1,
        sensitive_scan_truncated_events: 1,
      }),
    }),
  });

  assert.equal(report.readiness.status, "blocked");
  assert.equal(report.raw_governance.preflight_available, true);
  assert.equal(report.raw_governance.pending_count, 3);
  assert.equal(report.raw_governance.preflight_selected_count, 2);
  assert.equal(report.raw_governance.sensitive_signal_count > 0, true);
  assert.ok(report.readiness.reasons.includes("raw_pending_sensitive_signals"));
  assert.equal(report.routing_recommendation.limited_routing_allowed, false);
});

test("readiness plan requires raw preflight to cover all pending telemetry", () => {
  const report = buildArtifactReviewReadinessPlan({
    summary: summary({
      structured_response: {
        event_count: 12,
        missing_json_envelope_count: 0,
        missing_json_envelope_rate: 0,
        retry_event_count: 0,
        retry_scheduled_count: 0,
        retry_recovered_count: 0,
        retry_recovery_rate: null,
        top_commands: [
          {
            command: "artifact-review",
            event_count: 12,
            missing_json_envelope_count: 0,
          },
        ],
        top_retry_commands: [],
      },
    }),
    coveragePlan: readyCoveragePlan(),
    doctor: cleanDoctor(),
    rawPreflight: cleanRawPreflight({
      pending: { total_count: 101, total_bytes: 4096 },
      batch: {
        batch_size: 100,
        would_send_count: 100,
        batch_bytes: 4000,
        exceeds_max_bytes: false,
        excluded_by_batch_size_count: 1,
        preview_error: null,
      },
      risk: rawRisk({ file_count: 100, event_count: 100 }),
    }),
  });

  assert.equal(report.readiness.status, "blocked");
  assert.ok(report.readiness.reasons.includes("raw_preflight_partial"));
  assert.ok(report.next_actions.includes("Run raw preflight over the remaining pending telemetry before limited routing."));
  assert.equal(report.routing_recommendation.limited_routing_allowed, false);
});

test("readiness plan gates on raw preflight preview errors and invalid files", () => {
  const report = buildArtifactReviewReadinessPlan({
    summary: summary({
      structured_response: {
        event_count: 12,
        missing_json_envelope_count: 0,
        missing_json_envelope_rate: 0,
        retry_event_count: 0,
        retry_scheduled_count: 0,
        retry_recovered_count: 0,
        retry_recovery_rate: null,
        top_commands: [
          {
            command: "artifact-review",
            event_count: 12,
            missing_json_envelope_count: 0,
          },
        ],
        top_retry_commands: [],
      },
    }),
    coveragePlan: readyCoveragePlan(),
    doctor: cleanDoctor(),
    rawPreflight: cleanRawPreflight({
      pending: { total_count: 1, total_bytes: 256 },
      batch: {
        batch_size: 100,
        would_send_count: 1,
        batch_bytes: 256,
        exceeds_max_bytes: false,
        excluded_by_batch_size_count: 0,
        preview_error: "invalid_pending_event",
      },
      risk: rawRisk({ file_count: 1, event_count: 1, invalid_file_count: 1 }),
    }),
  });

  assert.equal(report.readiness.status, "blocked");
  assert.equal(report.raw_governance.preflight_preview_error, "invalid_pending_event");
  assert.equal(report.raw_governance.invalid_file_count, 1);
  assert.ok(report.readiness.reasons.includes("raw_preflight_preview_error"));
  assert.ok(report.readiness.reasons.includes("raw_preflight_invalid_files"));
  assert.ok(report.next_actions.includes(
    "Resolve raw preflight preview errors, invalid or skipped files, and size limits before limited routing.",
  ));
  assert.equal(report.routing_recommendation.limited_routing_allowed, false);
});

test("readiness plan gates on raw preflight max byte limits", () => {
  const report = buildArtifactReviewReadinessPlan({
    summary: summary({
      structured_response: {
        event_count: 12,
        missing_json_envelope_count: 0,
        missing_json_envelope_rate: 0,
        retry_event_count: 0,
        retry_scheduled_count: 0,
        retry_recovered_count: 0,
        retry_recovery_rate: null,
        top_commands: [
          {
            command: "artifact-review",
            event_count: 12,
            missing_json_envelope_count: 0,
          },
        ],
        top_retry_commands: [],
      },
    }),
    coveragePlan: readyCoveragePlan(),
    doctor: cleanDoctor(),
    rawPreflight: cleanRawPreflight({
      pending: { total_count: 1, total_bytes: 256 },
      batch: {
        batch_size: 100,
        would_send_count: 1,
        batch_bytes: 256,
        exceeds_max_bytes: true,
        excluded_by_batch_size_count: 0,
        preview_error: null,
      },
      risk: rawRisk({ file_count: 1, event_count: 1 }),
    }),
  });

  assert.equal(report.readiness.status, "blocked");
  assert.equal(report.raw_governance.exceeds_max_bytes, true);
  assert.ok(report.readiness.reasons.includes("raw_preflight_exceeds_max_bytes"));
  assert.equal(report.routing_recommendation.limited_routing_allowed, false);
});

test("readiness plan gates on raw preflight skipped files", () => {
  const report = buildArtifactReviewReadinessPlan({
    summary: summary({
      structured_response: {
        event_count: 12,
        missing_json_envelope_count: 0,
        missing_json_envelope_rate: 0,
        retry_event_count: 0,
        retry_scheduled_count: 0,
        retry_recovered_count: 0,
        retry_recovery_rate: null,
        top_commands: [
          {
            command: "artifact-review",
            event_count: 12,
            missing_json_envelope_count: 0,
          },
        ],
        top_retry_commands: [],
      },
    }),
    coveragePlan: readyCoveragePlan(),
    doctor: cleanDoctor(),
    rawPreflight: cleanRawPreflight({
      pending: { total_count: 1, total_bytes: 256 },
      batch: {
        batch_size: 100,
        would_send_count: 1,
        batch_bytes: 256,
        exceeds_max_bytes: false,
        excluded_by_batch_size_count: 0,
        preview_error: null,
      },
      risk: rawRisk({ file_count: 1, event_count: 1, skipped_file_count: 1 }),
    }),
  });

  assert.equal(report.readiness.status, "blocked");
  assert.equal(report.raw_governance.skipped_file_count, 1);
  assert.ok(report.readiness.reasons.includes("raw_preflight_skipped_files"));
  assert.equal(report.routing_recommendation.limited_routing_allowed, false);
});

test("readiness plan becomes ready only when every hard gate passes", () => {
  const report = buildArtifactReviewReadinessPlan({
    summary: summary({
      structured_response: {
        event_count: 12,
        missing_json_envelope_count: 0,
        missing_json_envelope_rate: 0,
        retry_event_count: 1,
        retry_scheduled_count: 1,
        retry_recovered_count: 1,
        retry_recovery_rate: 1,
        top_commands: [],
      },
    }),
    coveragePlan: coveragePlan({
      production_scorecard: scorecard({ eventCount: 20, scorecardEventCount: 18, coverage: 0.9, fieldCoverage: 0.85 }),
      validation_scorecard: {
        ...scorecard({ eventCount: 5, scorecardEventCount: 5, coverage: 1, fieldCoverage: 1 }),
        events_needed_for_target: undefined,
      },
      active_quick_collection: {
        active_budget_cohorts: [
          {
            budget_cohort: "2048",
            event_count: 12,
            success_count: 12,
            error_count: 0,
            error_rate: 0,
            additional_events_needed: 0,
            low_confidence: false,
          },
        ],
        target_events_per_cohort: 10,
        additional_events_needed: 0,
        active_error_rate: 0,
        low_confidence: false,
      },
      latency_guard: {
        status: "within_budget",
        p95_ms: 12000,
        budget_ms: 15000,
        near_budget: false,
      },
    }),
    doctor: cleanDoctor(),
    rawPreflight: cleanRawPreflight(),
  });

  assert.equal(report.readiness.status, "ready_for_limited_routing");
  assert.deepEqual(report.readiness.reasons, ["artifact_review_ready_for_limited_routing"]);
  assert.equal(report.structured_response.diagnosis, "none");
  assert.equal(report.structured_response.recovery_action, "none");
  assert.equal(report.routing_recommendation.limited_routing_allowed, true);
  assert.equal(report.routing_recommendation.production_sampling_allowed, true);
});

test("readiness plan text uses aggregate fields only", () => {
  const report = buildArtifactReviewReadinessPlan({
    summary: summary(),
    coveragePlan: coveragePlan(),
    doctor: doctor(),
    rawPreflight: rawPreflight(),
  });
  const text = artifactReviewReadinessPlanToText(report);

  assert.match(text, /Artifact-review readiness plan: blocked/);
  assert.match(text, /Readiness reasons: .*raw_pending_sensitive_signals/);
  assert.match(text, /Limited routing: no/);
  assert.match(text, /Production sampling: no/);
  assert.match(text, /collect 6 more quick 2048 samples/);
  assert.doesNotMatch(text, /raw prompt\b|Authorization|Bearer|evt_private|private\.png|batch_private|\/home\/example/);
});

test("runArtifactReviewReadinessPlan degrades when endpoint diagnostics fail", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "gemini-agent-readiness-runner-"));
  try {
    await saveTelemetryConfig({
      cwd,
      endpoint: "http://127.0.0.1:8787/ingest",
      tokenEnv: "GEMINI_AGENT_TELEMETRY_TOKEN",
      deploymentId: "gemini-agent-main",
    });

    const report = await runArtifactReviewReadinessPlan({
      cwd,
      env: { GEMINI_AGENT_TELEMETRY_TOKEN: "local-token" },
      fetchImpl: async () => {
        throw new Error("offline");
      },
      doctorTimeoutMs: 25,
      now: new Date("2026-06-12T00:00:00.000Z"),
    });

    assert.equal(report.ok, true);
    assert.equal(report.readiness.status, "blocked");
    assert.equal(report.raw_governance.failed_count, 0);
    assert.equal(report.routing_recommendation.limited_routing_allowed, false);
    assert.equal(JSON.stringify(report).includes(cwd), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
