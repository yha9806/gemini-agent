# Telemetry Economics Report Design

## Purpose

Build a local `gemini-agent telemetry economics` report so Gemini Agent telemetry can answer product economics questions without exposing raw prompts, raw responses, event ids, batch ids, paths, or media filenames.

The report helps decide which Gemini Agent workflows should be called more aggressively because they move meaningful context out of Codex at acceptable Gemini cost.

## Command

```bash
gemini-agent telemetry economics [--global] [--json] [--top <n>] [--input-price-per-million <usd>] [--output-price-per-million <usd>]
```

Defaults:

- Scope follows existing telemetry scope behavior.
- `--top` defaults to `10`.
- `--input-price-per-million` defaults to `1.50`.
- `--output-price-per-million` defaults to `9.00`.

The default prices are current defaults for `gemini-3.5-flash` paid tier observed on 2026-06-10 from the official Gemini API pricing page. Prices are time-sensitive, so operators can override them.

## Data Source

Use the same local/global telemetry queue files scanned by `telemetry summary`.

Do not use production raw payload APIs in v1. The report is local-first and aggregate-only.

## Metrics

The report returns:

- `totals.event_count`
- `totals.events_with_usage`
- `totals.events_missing_usage`
- `totals.input_tokens`
- `totals.output_tokens`
- `totals.total_tokens`
- `totals.codex_tokens_saved_estimate`
- `totals.gemini_estimated_cost_usd`
- `totals.gemini_tokens_per_codex_token_saved`
- `totals.usage_coverage_rate`

For each command:

- command
- event count
- success count
- error count
- events with usage
- missing usage
- input/output/total tokens
- estimated Codex tokens saved
- Gemini estimated cost USD
- Gemini tokens per estimated Codex token saved
- success rate
- usage coverage rate

## Cost Calculation

```text
input_cost = input_tokens / 1_000_000 * input_price_per_million
output_cost = output_tokens / 1_000_000 * output_price_per_million
gemini_estimated_cost_usd = input_cost + output_cost
```

Use six decimal places for cost values.

Token savings remain estimates. Prefer explicit `economics.codex_tokens_saved_estimate` when present; otherwise use input tokens as the existing conservative fallback. Do not label the result as realized billing savings.

## Recommendations

Add deterministic recommendations:

- `economics`: high estimated savings and low Gemini cost means keep active delegation.
- `instrumentation`: usage coverage below 80% means improve usage metadata before strong ROI claims.
- `workflow`: command has high token volume but weak savings ratio; review prompt size or routing.

Recommendations are based only on aggregate metrics.

## Text Output

Human output should include:

- Pricing assumptions.
- Total events and usage coverage.
- Estimated Gemini cost.
- Estimated Codex tokens saved.
- Top command economics.
- Recommendations.
- Limitations.

Text output must not include raw prompt, response, file path, event id, batch id, or media filenames.

## JSON Output

`--json` prints a stable machine-readable object:

```json
{
  "scope": "global",
  "storage_cwd": "/path",
  "generated_at": "2026-06-10T00:00:00.000Z",
  "pricing": {
    "model": "gemini-3.5-flash",
    "input_price_per_million": 1.5,
    "output_price_per_million": 9,
    "currency": "USD",
    "source": "default_gemini_api_pricing_observed_2026-06-10"
  },
  "totals": {},
  "top_commands": [],
  "recommendations": [],
  "limitations": []
}
```

## Out Of Scope

- Server-side Vulca API changes.
- Frontend admin dashboard changes.
- Actual Codex billing integration.
- Raw prompt/response reveal.
- Provider billing export ingestion.

## Test Requirements

- Aggregates totals and command-level economics.
- Supports global scope.
- Supports price overrides.
- Rejects invalid prices and top limits.
- Text and JSON outputs do not expose raw prompt/response or identifiers.
- CLI route is covered.
- Full `npm test` passes.
