# Gemini Agent Productization Release Notes

## Product Slice

This slice productizes Gemini Agent beyond ad hoc review calls:

- Raw-v1 telemetry capture, queueing, validation, and flush commands.
- Scheduler installation, status, and uninstall flows for launchd, cron, and systemd.
- Global active Codex installer for `~/.codex/AGENTS.md`, including dry-run, write, backup, and rollback support.
- Backend raw telemetry ingest API and admin governance endpoints in VULCA.
- Frontend admin dashboard at `/admin/gemini-agent` for metrics, deployments, event inspection, raw reveal audit, retention updates, pause, and purge actions.

## Operator Commands

```bash
gemini-agent telemetry enable --level raw --endpoint https://telemetry.example.com/api/v1/gemini-agent/telemetry/ingest --token-env GEMINI_AGENT_TELEMETRY_TOKEN --confirm-raw-content
gemini-agent telemetry validate --endpoint https://telemetry.example.com/api/v1/gemini-agent/telemetry/ingest --token-env GEMINI_AGENT_TELEMETRY_TOKEN --confirm-raw-content
gemini-agent telemetry install-scheduler --target launchd --name gemini-agent-main --schedule daily@09:00 --env-file ~/.gemini-agent/telemetry.env --dry-run
gemini-agent telemetry scheduler-status --target launchd --name gemini-agent-main
gemini-agent telemetry uninstall-scheduler --target launchd --name gemini-agent-main
gemini-agent install-codex-global --mode active --dry-run
gemini-agent install-codex-global --mode active --write
```

## Safety Notes

- Raw telemetry mode remains explicit and requires `--confirm-raw-content`.
- Scheduler artifacts reference an env file and never store `GEMINI_API_KEY` or telemetry token values inline.
- launchd activation defaults to `gui/<uid>`.
- Loopback HTTP endpoints are allowed for local validation; non-loopback telemetry endpoints require HTTPS.
- Global active install defaults to dry-run behavior and writes a backup before changing global Codex instructions.
- The allowed runtime model remains `gemini-3.5-flash`.

## Backend Operations

The VULCA backend exposes `/api/v1/gemini-agent/telemetry` for raw-v1 ingest and admin governance. Configure deployment ingest tokens with:

```bash
GEMINI_AGENT_TELEMETRY_TOKENS=deployment-id:token
GEMINI_AGENT_ALLOWED_MODELS=gemini-3.5-flash
```

Ingest uses deployment bearer tokens. Metrics, deployment controls, event reads, raw reveal, retention updates, pause, purge, and audit-log reads use admin JWT authentication. Raw payload retention defaults to 30 days and metadata retention defaults to 180 days.

## Validation Commands

```bash
cd /Users/yhryzy/.config/superpowers/worktrees/gemini-agent/gemini-agent-productization-impl
npm test

cd /Users/yhryzy/.config/superpowers/worktrees/vulca-platform/gemini-agent-telemetry-platform/wenxin-backend
.venv/bin/python -m pytest tests/test_gemini_agent_telemetry_api.py -q

cd /Users/yhryzy/.config/superpowers/worktrees/vulca-platform/gemini-agent-telemetry-platform/wenxin-moyun
npm run type-check
npm test -- src/__tests__/services/geminiAgentTelemetry.service.test.ts src/__tests__/pages/GeminiAgentTelemetryPage.test.tsx
npm run build
```

## Known Caveats

- The backend full dependency install path, `pip install -r requirements.txt -c constraints.txt`, still has an existing LangChain/LangGraph resolver conflict: `langchain==0.1.0` is pinned alongside `langgraph==0.2.76` and `langgraph-checkpoint==2.0.26`.
- Default SQLite `alembic upgrade head` is still limited by the existing migration `12aa0300721d_add_individual_score_columns_and_.py`, which uses direct SQLite `op.alter_column(...)` calls instead of a batch table rebuild.
