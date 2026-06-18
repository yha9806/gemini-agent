# Telemetry

Telemetry is opt-in. Raw telemetry mode can capture prompts and responses, so
enable it only when your project data policy permits it.

Raw telemetry stores prompt and response text after best-effort
credential-pattern masking. Masking is not a complete PII or secret removal
guarantee. Summary, economics, priorities, and report commands are designed to
show aggregate product signals without printing raw prompts, raw responses,
local paths, event ids, batch ids, media file names, or image bytes in ordinary
output.

## Status And Reports

```bash
./bin/gemini-agent telemetry status --global
./bin/gemini-agent telemetry summary --global
./bin/gemini-agent telemetry summary --global --json
./bin/gemini-agent telemetry economics --global
./bin/gemini-agent telemetry priorities --global
./bin/gemini-agent telemetry report --global --json
```

## Raw Governance

Raw telemetry governance commands are explicit and bounded:

```bash
./bin/gemini-agent telemetry raw inventory --global
./bin/gemini-agent telemetry raw inventory --global --json
./bin/gemini-agent telemetry raw preflight --global --batch-size 1 --json
./bin/gemini-agent telemetry raw export --global --state pending --output ./raw-export.jsonl --limit 100 --confirm-raw-content --json
./bin/gemini-agent telemetry raw reveal --global --state sent --limit 1 --confirm-raw-content --json
./bin/gemini-agent telemetry raw delete --global --state sent --event-id evt_example --confirm-raw-content --dry-run --json
./bin/gemini-agent telemetry raw prune --global --state sent --keep-days 30 --dry-run
./bin/gemini-agent telemetry raw prune --global --state sent --keep-days 30 --write --json
```

Use `raw preflight` before broad delivery changes. Use `raw reveal`, `raw
export`, and `raw delete` only with `--confirm-raw-content` and only on data you
are allowed to inspect.

## Delivery Validation

Loopback HTTP endpoints are allowed for local validation. Non-loopback telemetry
endpoints require HTTPS.

```bash
./bin/gemini-agent telemetry enable --global --level raw --endpoint http://127.0.0.1:8787/ingest --token-env GEMINI_AGENT_TELEMETRY_TOKEN --deployment-id gemini-agent-main --user-label local-admin --confirm-raw-content
./bin/gemini-agent telemetry validate --global --endpoint http://127.0.0.1:8787/ingest --token-env GEMINI_AGENT_TELEMETRY_TOKEN --deployment-id gemini-agent-main --confirm-raw-content
./bin/gemini-agent telemetry flush --global
./bin/gemini-agent telemetry tick --global --batch-size 1 --timeout-ms 20000
```

## Scheduler

```bash
./bin/gemini-agent telemetry install-scheduler --global --target launchd --name gemini-agent-main --schedule daily@09:00 --batch-size 1 --timeout-ms 20000 --env-file ~/.gemini-agent/telemetry.env --dry-run
./bin/gemini-agent telemetry scheduler-status --target launchd --name gemini-agent-main
./bin/gemini-agent telemetry uninstall-scheduler --target launchd --name gemini-agent-main
```

Scheduler artifacts reference an env file and should not store
`GEMINI_API_KEY` or telemetry token values inline.

## Local Receiver

```bash
./bin/gemini-agent-telemetry-receiver --host 127.0.0.1 --port 8787 --storage ./.telemetry-data --token-env GEMINI_AGENT_TELEMETRY_TOKEN
```

The receiver stores raw JSONL and SQLite metrics under the configured storage
directory. Keep receiver storage, raw exports, scheduler env files, and tokens
out of source control.
