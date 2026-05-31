# Gemini Agent Productization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first production-ready telemetry and product feedback slice across `gemini-agent`, `vulca-platform/wenxin-backend`, and `vulca-platform/wenxin-moyun`.

**Architecture:** `gemini-agent` captures and sends versioned raw telemetry batches, installs local schedulers, and installs global active Codex instructions. `wenxin-backend` owns the `/api/v1/gemini-agent/telemetry` API, storage, retention, audit, and governance. `wenxin-moyun` exposes an admin-only operational dashboard for deployments, usage, raw reveal, and governance actions.

**Tech Stack:** Node.js ESM CLI with `node --test`; FastAPI, Pydantic, SQLAlchemy, Alembic, pytest; Vite, React Router, TypeScript, Axios, Vitest.

---

## Scope Check

This work touches three repositories, but it is one integrated product slice: the dashboard is implemented after the backend contract is testable, and the scheduler is implemented after the client can send the new telemetry contract. Keep the implementation order strict:

1. Backend contract and storage.
2. `gemini-agent` contract alignment and sender hardening.
3. Scheduler and global active installer.
4. Frontend dashboard.
5. Cross-repo release validation.

Do not start dashboard work until backend API tests pass. Do not start production scheduler work until `gemini-agent` can send the new `raw-v1` contract.

Path note: absolute paths in this plan are for the current local workspace. If a worker executes from a different checkout, replace only the repository root prefixes and keep the relative paths unchanged.

## File Structure

### `/Users/yhryzy/dev/vulca-platform/wenxin-backend`

- Create `app/models/gemini_agent_telemetry.py`
  - SQLAlchemy models for deployments, batches, events, raw payloads, audit log.
- Modify `app/models/__init__.py`
  - Import and export telemetry models so metadata registration works.
- Create `app/api/v1/gemini_agent_telemetry.py`
  - FastAPI router for ingest, metrics, deployments, events, raw reveal, export, retention, pause, rotate, purge, delete.
- Modify `app/api/v1/__init__.py`
  - Include router with prefix `/gemini-agent/telemetry`.
- Create `alembic/versions/gemini_agent_telemetry.py`
  - Migration for telemetry tables and indexes.
- Create `tests/test_gemini_agent_telemetry_api.py`
  - API, auth, idempotency, retention, audit, and governance tests.

### `/Users/yhryzy/dev/gemini-agent`

- Modify `src/telemetry-schemas.mjs`
  - Add `raw-v1` payload schemas while preserving local receiver compatibility where needed.
- Modify `src/telemetry-sender.mjs`
  - Send `raw-v1` batches, parse item-level ACKs, classify retryable/non-retryable failures, add bounded backoff metadata.
- Modify `src/telemetry-capture.mjs`
  - Capture richer request/response/tool-call/media fields while preserving credential masking.
- Modify `src/telemetry-queue.mjs`
  - Keep bounded queue behavior and record local errors for non-retryable oversized events.
- Create `src/telemetry-scheduler.mjs`
  - Generate launchd, cron, and systemd scheduler artifacts.
- Create `src/codex-global-install.mjs`
  - Dry-run/write/rollback global active invocation installer with marker blocks.
- Modify `src/cli.mjs`
  - Wire new scheduler and global install commands.
- Add tests:
  - `test/telemetry-contract.test.mjs`
  - `test/telemetry-scheduler.test.mjs`
  - `test/codex-global-install.test.mjs`
  - Extend `test/telemetry-sender.test.mjs`, `test/telemetry-capture.test.mjs`, `test/cli.test.mjs`.

### `/Users/yhryzy/dev/vulca-platform/wenxin-moyun`

- Create `src/services/geminiAgentTelemetry.service.ts`
  - Typed API client functions.
- Create `src/pages/admin/GeminiAgentTelemetryPage.tsx`
  - Admin dashboard page.
- Modify `src/App.tsx`
  - Add guarded `/admin/gemini-agent` route with `RequireAdmin`.
- Add tests:
  - `src/__tests__/services/geminiAgentTelemetry.service.test.ts`
  - `src/__tests__/pages/GeminiAgentTelemetryPage.test.tsx`

### Documentation And Fixtures

- Create `/Users/yhryzy/dev/gemini-agent/test/fixtures/telemetry/raw-v1-batch.json`.
- Create `/Users/yhryzy/dev/vulca-platform/wenxin-backend/tests/fixtures/gemini_agent_raw_v1_batch.json`.
- Modify `/Users/yhryzy/dev/gemini-agent/README.md`.
- Modify `/Users/yhryzy/dev/vulca-platform/wenxin-backend/README.md`.
- Modify `/Users/yhryzy/dev/vulca-platform/wenxin-moyun/src/config/version.ts` only if release notes require a visible build version bump.

---

### Task 1: Backend Telemetry Models And Migration

**Files:**
- Create: `/Users/yhryzy/dev/vulca-platform/wenxin-backend/app/models/gemini_agent_telemetry.py`
- Modify: `/Users/yhryzy/dev/vulca-platform/wenxin-backend/app/models/__init__.py`
- Create: `/Users/yhryzy/dev/vulca-platform/wenxin-backend/alembic/versions/gemini_agent_telemetry.py`
- Test: `/Users/yhryzy/dev/vulca-platform/wenxin-backend/tests/test_gemini_agent_telemetry_api.py`

- [ ] **Step 1: Write the failing model registration test**

Append this test file:

```python
"""Tests for Gemini Agent telemetry backend API and storage."""
from __future__ import annotations

from app.core.database import Base


def test_gemini_agent_telemetry_tables_are_registered() -> None:
    expected = {
        "gemini_agent_telemetry_deployments",
        "gemini_agent_telemetry_batches",
        "gemini_agent_telemetry_events",
        "gemini_agent_telemetry_raw_payloads",
        "gemini_agent_telemetry_audit_log",
    }
    assert expected.issubset(set(Base.metadata.tables))
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
cd /Users/yhryzy/dev/vulca-platform/wenxin-backend
pytest tests/test_gemini_agent_telemetry_api.py::test_gemini_agent_telemetry_tables_are_registered -q
```

Expected: FAIL because the telemetry models are not registered in `Base.metadata`.

- [ ] **Step 3: Add SQLAlchemy models**

Create `/Users/yhryzy/dev/vulca-platform/wenxin-backend/app/models/gemini_agent_telemetry.py`:

```python
"""SQLAlchemy models for gemini-agent telemetry."""
from __future__ import annotations

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func
from sqlalchemy.types import JSON

from app.core.database import Base

JsonType = JSON().with_variant(JSONB(), "postgresql")


class GeminiAgentTelemetryDeployment(Base):
    __tablename__ = "gemini_agent_telemetry_deployments"

    id = Column(String(120), primary_key=True)
    label = Column(String(120), nullable=False)
    token_hash = Column(String(255), nullable=False, index=True)
    status = Column(String(40), nullable=False, default="active")
    raw_enabled = Column(Boolean, nullable=False, default=True)
    retention_days = Column(Integer, nullable=False, default=30)
    metadata_retention_days = Column(Integer, nullable=False, default=180)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    updated_at = Column(DateTime(timezone=True), nullable=True, onupdate=func.now())
    last_seen_at = Column(DateTime(timezone=True), nullable=True)

    batches = relationship("GeminiAgentTelemetryBatch", back_populates="deployment")
    events = relationship("GeminiAgentTelemetryEvent", back_populates="deployment")


class GeminiAgentTelemetryBatch(Base):
    __tablename__ = "gemini_agent_telemetry_batches"

    batch_id = Column(String(120), primary_key=True)
    deployment_id = Column(String(120), ForeignKey("gemini_agent_telemetry_deployments.id"), nullable=False, index=True)
    schema_version = Column(String(40), nullable=False)
    checksum = Column(String(128), nullable=False)
    agent_version = Column(String(80), nullable=False)
    event_count = Column(Integer, nullable=False)
    byte_size = Column(Integer, nullable=False)
    accepted_count = Column(Integer, nullable=False, default=0)
    rejected_count = Column(Integer, nullable=False, default=0)
    generated_at = Column(DateTime(timezone=True), nullable=False)
    received_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    deployment = relationship("GeminiAgentTelemetryDeployment", back_populates="batches")
    events = relationship("GeminiAgentTelemetryEvent", back_populates="batch")


class GeminiAgentTelemetryEvent(Base):
    __tablename__ = "gemini_agent_telemetry_events"
    __table_args__ = (
        UniqueConstraint("deployment_id", "event_id", name="uq_gemini_agent_event_deployment_event"),
    )

    event_id = Column(String(160), primary_key=True)
    deployment_id = Column(String(120), ForeignKey("gemini_agent_telemetry_deployments.id"), nullable=False, index=True)
    batch_id = Column(String(120), ForeignKey("gemini_agent_telemetry_batches.batch_id"), nullable=False, index=True)
    source_host_app = Column(String(60), nullable=False)
    trigger_source = Column(String(60), nullable=False)
    model_provider = Column(String(60), nullable=False)
    model = Column(String(120), nullable=False, index=True)
    command = Column(String(120), nullable=False, index=True)
    status = Column(String(40), nullable=False, index=True)
    started_at = Column(DateTime(timezone=True), nullable=True)
    ended_at = Column(DateTime(timezone=True), nullable=True)
    latency_ms = Column(Integer, nullable=False, default=0)
    input_tokens = Column(Integer, nullable=True)
    output_tokens = Column(Integer, nullable=True)
    total_tokens = Column(Integer, nullable=True)
    prompt_bytes = Column(Integer, nullable=False, default=0)
    response_bytes = Column(Integer, nullable=False, default=0)
    error_type = Column(String(120), nullable=True)
    error_message = Column(Text, nullable=True)
    event_metadata = Column(JsonType, nullable=False, default=dict)
    received_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())

    deployment = relationship("GeminiAgentTelemetryDeployment", back_populates="events")
    batch = relationship("GeminiAgentTelemetryBatch", back_populates="events")
    raw_payload = relationship("GeminiAgentTelemetryRawPayload", back_populates="event", uselist=False)


class GeminiAgentTelemetryRawPayload(Base):
    __tablename__ = "gemini_agent_telemetry_raw_payloads"

    event_id = Column(String(160), ForeignKey("gemini_agent_telemetry_events.event_id"), primary_key=True)
    request_raw = Column(JsonType, nullable=True)
    prompt_raw = Column(Text, nullable=True)
    response_raw = Column(Text, nullable=True)
    response_candidates_raw = Column(JsonType, nullable=True)
    tool_calls_raw = Column(JsonType, nullable=True)
    media_manifest = Column(JsonType, nullable=True)
    sensitivity_flags = Column(JsonType, nullable=False, default=list)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
    expires_at = Column(DateTime(timezone=True), nullable=False, index=True)

    event = relationship("GeminiAgentTelemetryEvent", back_populates="raw_payload")


class GeminiAgentTelemetryAuditLog(Base):
    __tablename__ = "gemini_agent_telemetry_audit_log"

    id = Column(String(160), primary_key=True)
    operator_id = Column(String(160), nullable=True, index=True)
    action = Column(String(80), nullable=False, index=True)
    target_type = Column(String(80), nullable=False)
    target_id = Column(String(160), nullable=False, index=True)
    reason = Column(Text, nullable=True)
    audit_metadata = Column(JsonType, nullable=False, default=dict)
    created_at = Column(DateTime(timezone=True), nullable=False, server_default=func.now())
```

- [ ] **Step 4: Register the models**

Modify `/Users/yhryzy/dev/vulca-platform/wenxin-backend/app/models/__init__.py`:

```python
from .gemini_agent_telemetry import (
    GeminiAgentTelemetryAuditLog,
    GeminiAgentTelemetryBatch,
    GeminiAgentTelemetryDeployment,
    GeminiAgentTelemetryEvent,
    GeminiAgentTelemetryRawPayload,
)
```

Add the five names to `__all__`.

- [ ] **Step 5: Add Alembic migration**

Run first:

```bash
cd /Users/yhryzy/dev/vulca-platform/wenxin-backend
alembic heads
```

Expected: output includes `0523013558b1`. If it does not, stop and replace only the `down_revision` value below with the single head printed by `alembic heads` before creating the file; do not create a split migration history.

Create `/Users/yhryzy/dev/vulca-platform/wenxin-backend/alembic/versions/gemini_agent_telemetry.py`:

```python
"""add gemini agent telemetry tables

Revision ID: gemini_agent_telemetry
Revises: 0523013558b1
Create Date: 2026-05-31
"""
from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "gemini_agent_telemetry"
down_revision = "0523013558b1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    json_type = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")
    op.create_table(
        "gemini_agent_telemetry_deployments",
        sa.Column("id", sa.String(length=120), primary_key=True),
        sa.Column("label", sa.String(length=120), nullable=False),
        sa.Column("token_hash", sa.String(length=255), nullable=False),
        sa.Column("status", sa.String(length=40), nullable=False, server_default="active"),
        sa.Column("raw_enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("retention_days", sa.Integer(), nullable=False, server_default="30"),
        sa.Column("metadata_retention_days", sa.Integer(), nullable=False, server_default="180"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_gemini_agent_deployments_token_hash", "gemini_agent_telemetry_deployments", ["token_hash"])

    op.create_table(
        "gemini_agent_telemetry_batches",
        sa.Column("batch_id", sa.String(length=120), primary_key=True),
        sa.Column("deployment_id", sa.String(length=120), sa.ForeignKey("gemini_agent_telemetry_deployments.id"), nullable=False),
        sa.Column("schema_version", sa.String(length=40), nullable=False),
        sa.Column("checksum", sa.String(length=128), nullable=False),
        sa.Column("agent_version", sa.String(length=80), nullable=False),
        sa.Column("event_count", sa.Integer(), nullable=False),
        sa.Column("byte_size", sa.Integer(), nullable=False),
        sa.Column("accepted_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("rejected_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("generated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_gemini_agent_batches_deployment_id", "gemini_agent_telemetry_batches", ["deployment_id"])

    op.create_table(
        "gemini_agent_telemetry_events",
        sa.Column("event_id", sa.String(length=160), primary_key=True),
        sa.Column("deployment_id", sa.String(length=120), sa.ForeignKey("gemini_agent_telemetry_deployments.id"), nullable=False),
        sa.Column("batch_id", sa.String(length=120), sa.ForeignKey("gemini_agent_telemetry_batches.batch_id"), nullable=False),
        sa.Column("source_host_app", sa.String(length=60), nullable=False),
        sa.Column("trigger_source", sa.String(length=60), nullable=False),
        sa.Column("model_provider", sa.String(length=60), nullable=False),
        sa.Column("model", sa.String(length=120), nullable=False),
        sa.Column("command", sa.String(length=120), nullable=False),
        sa.Column("status", sa.String(length=40), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("latency_ms", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("input_tokens", sa.Integer(), nullable=True),
        sa.Column("output_tokens", sa.Integer(), nullable=True),
        sa.Column("total_tokens", sa.Integer(), nullable=True),
        sa.Column("prompt_bytes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("response_bytes", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("error_type", sa.String(length=120), nullable=True),
        sa.Column("error_message", sa.Text(), nullable=True),
        sa.Column("event_metadata", json_type, nullable=False, server_default="{}"),
        sa.Column("received_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("deployment_id", "event_id", name="uq_gemini_agent_event_deployment_event"),
    )
    op.create_index("ix_gemini_agent_events_deployment_id", "gemini_agent_telemetry_events", ["deployment_id"])
    op.create_index("ix_gemini_agent_events_batch_id", "gemini_agent_telemetry_events", ["batch_id"])
    op.create_index("ix_gemini_agent_events_command", "gemini_agent_telemetry_events", ["command"])
    op.create_index("ix_gemini_agent_events_status", "gemini_agent_telemetry_events", ["status"])

    op.create_table(
        "gemini_agent_telemetry_raw_payloads",
        sa.Column("event_id", sa.String(length=160), sa.ForeignKey("gemini_agent_telemetry_events.event_id"), primary_key=True),
        sa.Column("request_raw", json_type, nullable=True),
        sa.Column("prompt_raw", sa.Text(), nullable=True),
        sa.Column("response_raw", sa.Text(), nullable=True),
        sa.Column("response_candidates_raw", json_type, nullable=True),
        sa.Column("tool_calls_raw", json_type, nullable=True),
        sa.Column("media_manifest", json_type, nullable=True),
        sa.Column("sensitivity_flags", json_type, nullable=False, server_default="[]"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_gemini_agent_raw_expires_at", "gemini_agent_telemetry_raw_payloads", ["expires_at"])

    op.create_table(
        "gemini_agent_telemetry_audit_log",
        sa.Column("id", sa.String(length=160), primary_key=True),
        sa.Column("operator_id", sa.String(length=160), nullable=True),
        sa.Column("action", sa.String(length=80), nullable=False),
        sa.Column("target_type", sa.String(length=80), nullable=False),
        sa.Column("target_id", sa.String(length=160), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("audit_metadata", json_type, nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_gemini_agent_audit_operator_id", "gemini_agent_telemetry_audit_log", ["operator_id"])
    op.create_index("ix_gemini_agent_audit_action", "gemini_agent_telemetry_audit_log", ["action"])
    op.create_index("ix_gemini_agent_audit_target_id", "gemini_agent_telemetry_audit_log", ["target_id"])


def downgrade() -> None:
    op.drop_index("ix_gemini_agent_audit_target_id", table_name="gemini_agent_telemetry_audit_log")
    op.drop_index("ix_gemini_agent_audit_action", table_name="gemini_agent_telemetry_audit_log")
    op.drop_index("ix_gemini_agent_audit_operator_id", table_name="gemini_agent_telemetry_audit_log")
    op.drop_table("gemini_agent_telemetry_audit_log")
    op.drop_index("ix_gemini_agent_raw_expires_at", table_name="gemini_agent_telemetry_raw_payloads")
    op.drop_table("gemini_agent_telemetry_raw_payloads")
    op.drop_index("ix_gemini_agent_events_status", table_name="gemini_agent_telemetry_events")
    op.drop_index("ix_gemini_agent_events_command", table_name="gemini_agent_telemetry_events")
    op.drop_index("ix_gemini_agent_events_batch_id", table_name="gemini_agent_telemetry_events")
    op.drop_index("ix_gemini_agent_events_deployment_id", table_name="gemini_agent_telemetry_events")
    op.drop_table("gemini_agent_telemetry_events")
    op.drop_index("ix_gemini_agent_batches_deployment_id", table_name="gemini_agent_telemetry_batches")
    op.drop_table("gemini_agent_telemetry_batches")
    op.drop_index("ix_gemini_agent_deployments_token_hash", table_name="gemini_agent_telemetry_deployments")
    op.drop_table("gemini_agent_telemetry_deployments")
```

- [ ] **Step 6: Run model and migration checks**

Run:

```bash
cd /Users/yhryzy/dev/vulca-platform/wenxin-backend
pytest tests/test_gemini_agent_telemetry_api.py::test_gemini_agent_telemetry_tables_are_registered -q
alembic upgrade head
alembic downgrade 0523013558b1
alembic upgrade head
```

Expected: test passes; Alembic upgrade/downgrade/upgrade completes.

- [ ] **Step 7: Commit backend model and migration**

```bash
cd /Users/yhryzy/dev/vulca-platform
git add wenxin-backend/app/models/gemini_agent_telemetry.py wenxin-backend/app/models/__init__.py wenxin-backend/alembic/versions/gemini_agent_telemetry.py wenxin-backend/tests/test_gemini_agent_telemetry_api.py
git commit -m "feat: add gemini agent telemetry tables"
```

### Task 2: Backend Ingest Contract

**Files:**
- Create: `/Users/yhryzy/dev/vulca-platform/wenxin-backend/app/api/v1/gemini_agent_telemetry.py`
- Modify: `/Users/yhryzy/dev/vulca-platform/wenxin-backend/app/api/v1/__init__.py`
- Test: `/Users/yhryzy/dev/vulca-platform/wenxin-backend/tests/test_gemini_agent_telemetry_api.py`
- Fixture: `/Users/yhryzy/dev/vulca-platform/wenxin-backend/tests/fixtures/gemini_agent_raw_v1_batch.json`

- [ ] **Step 1: Add a raw-v1 fixture**

Create `/Users/yhryzy/dev/vulca-platform/wenxin-backend/tests/fixtures/gemini_agent_raw_v1_batch.json`:

```json
{
  "schema_version": "raw-v1",
  "batch_id": "batch-test-1",
  "deployment_id": "deployment-test-1",
  "agent_version": "0.1.0",
  "generated_at": "2026-05-31T10:00:00Z",
  "checksum": "sha256:test",
  "events": [
    {
      "event_id": "event-test-1",
      "source_host_app": "codex",
      "trigger_source": "manual",
      "model_provider": "google",
      "model": "gemini-3.5-flash",
      "command": "context-pack",
      "started_at": "2026-05-31T09:59:59Z",
      "ended_at": "2026-05-31T10:00:00Z",
      "latency_ms": 1000,
      "status": "success",
      "usage": {
        "input_tokens": 10,
        "output_tokens": 20,
        "total_tokens": 30
      },
      "request_raw": {
        "contents": "prompt"
      },
      "prompt_raw": "summarize this project",
      "response_raw": "compact summary",
      "response_candidates_raw": [],
      "tool_calls_raw": [],
      "media_manifest": [],
      "error": null,
      "metadata": {
        "test": true
      }
    }
  ]
}
```

- [ ] **Step 2: Write failing ingest tests**

Append to `tests/test_gemini_agent_telemetry_api.py`:

```python
import json
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)
FIXTURE = Path(__file__).parent / "fixtures" / "gemini_agent_raw_v1_batch.json"


def _batch() -> dict:
    return json.loads(FIXTURE.read_text())


def test_ingest_requires_bearer_token() -> None:
    response = client.post("/api/v1/gemini-agent/telemetry/ingest", json=_batch())
    assert response.status_code == 401


def test_ingest_rejects_malformed_authorization_header(monkeypatch) -> None:
    monkeypatch.setenv("GEMINI_AGENT_TELEMETRY_TOKENS", "deployment-test-1:test-token")
    response = client.post(
        "/api/v1/gemini-agent/telemetry/ingest",
        json=_batch(),
        headers={"Authorization": "Token test-token"},
    )
    assert response.status_code == 401


def test_ingest_rejects_empty_bearer_token(monkeypatch) -> None:
    monkeypatch.setenv("GEMINI_AGENT_TELEMETRY_TOKENS", "deployment-test-1:test-token")
    response = client.post(
        "/api/v1/gemini-agent/telemetry/ingest",
        json=_batch(),
        headers={"Authorization": "Bearer "},
    )
    assert response.status_code == 401


def test_ingest_accepts_raw_v1_batch(monkeypatch) -> None:
    monkeypatch.setenv("GEMINI_AGENT_TELEMETRY_TOKENS", "deployment-test-1:test-token")
    response = client.post(
        "/api/v1/gemini-agent/telemetry/ingest",
        json=_batch(),
        headers={"Authorization": "Bearer test-token"},
    )
    assert response.status_code == 200
    assert response.json() == {
        "ok": True,
        "batch_id": "batch-test-1",
        "accepted_event_ids": ["event-test-1"],
        "rejected": [],
        "received_at": response.json()["received_at"],
    }


def test_ingest_rejects_non_flash_model_by_default(monkeypatch) -> None:
    monkeypatch.setenv("GEMINI_AGENT_TELEMETRY_TOKENS", "deployment-test-1:test-token")
    monkeypatch.delenv("GEMINI_AGENT_ALLOWED_MODELS", raising=False)
    batch = _batch()
    batch["batch_id"] = "batch-test-model-reject"
    batch["events"][0]["event_id"] = "event-test-model-reject"
    batch["events"][0]["model"] = "gemini-pro"
    response = client.post(
        "/api/v1/gemini-agent/telemetry/ingest",
        json=batch,
        headers={"Authorization": "Bearer test-token"},
    )
    assert response.status_code == 200
    assert response.json()["accepted_event_ids"] == []
    assert response.json()["rejected"] == [
        {"event_id": "event-test-model-reject", "reason": "unsupported_model"}
    ]


def test_require_deployment_handles_bootstrap_integrity_race(monkeypatch) -> None:
    import asyncio

    from sqlalchemy.exc import IntegrityError

    from app.api.v1.gemini_agent_telemetry import TelemetryBatchPayload, require_deployment
    from app.models.gemini_agent_telemetry import GeminiAgentTelemetryDeployment

    class NestedTransaction:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, traceback):
            return False

    class RaceSession:
        def __init__(self) -> None:
            self.get_calls = 0
            self.rollback_called = False
            self.deployment = GeminiAgentTelemetryDeployment(
                id="deployment-test-1",
                label="deployment-test-1",
                token_hash="",
                status="active",
                raw_enabled=True,
                retention_days=30,
                metadata_retention_days=180,
            )

        async def get(self, model, key):
            self.get_calls += 1
            if self.get_calls == 1:
                return None
            self.deployment.token_hash = "4c5dc9b7708905f77f5e5d16316b5dfb425e68cb326dcd55a860e90a7707031e"
            return self.deployment

        def begin_nested(self):
            return NestedTransaction()

        def add(self, value) -> None:
            return None

        async def flush(self) -> None:
            raise IntegrityError("insert", {}, Exception("duplicate deployment"))

        async def rollback(self) -> None:
            self.rollback_called = True

    monkeypatch.setenv("GEMINI_AGENT_TELEMETRY_TOKENS", "deployment-test-1:test-token")
    db = RaceSession()
    deployment = asyncio.run(require_deployment(TelemetryBatchPayload(**_batch()), "Bearer test-token", db))
    assert deployment.id == "deployment-test-1"
    assert db.rollback_called is False
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```bash
cd /Users/yhryzy/dev/vulca-platform/wenxin-backend
pytest tests/test_gemini_agent_telemetry_api.py::test_ingest_requires_bearer_token tests/test_gemini_agent_telemetry_api.py::test_ingest_rejects_malformed_authorization_header tests/test_gemini_agent_telemetry_api.py::test_ingest_rejects_empty_bearer_token tests/test_gemini_agent_telemetry_api.py::test_ingest_accepts_raw_v1_batch tests/test_gemini_agent_telemetry_api.py::test_ingest_rejects_non_flash_model_by_default tests/test_gemini_agent_telemetry_api.py::test_require_deployment_handles_bootstrap_integrity_race -q
```

Expected: FAIL because route does not exist.

- [ ] **Step 4: Implement route schemas and token parsing**

Create `/Users/yhryzy/dev/vulca-platform/wenxin-backend/app/api/v1/gemini_agent_telemetry.py`:

```python
"""Gemini Agent telemetry ingest and operator API."""
from __future__ import annotations

import hashlib
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any
from uuid import uuid4

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.gemini_agent_telemetry import (
    GeminiAgentTelemetryAuditLog,
    GeminiAgentTelemetryBatch,
    GeminiAgentTelemetryDeployment,
    GeminiAgentTelemetryEvent,
    GeminiAgentTelemetryRawPayload,
)

router = APIRouter()
MAX_EVENT_BYTES = 1024 * 1024
MAX_BATCH_BYTES = 10 * 1024 * 1024


class UsagePayload(BaseModel):
    input_tokens: int | None = Field(default=None, ge=0)
    output_tokens: int | None = Field(default=None, ge=0)
    total_tokens: int | None = Field(default=None, ge=0)


class TelemetryEventPayload(BaseModel):
    event_id: str = Field(min_length=1)
    source_host_app: str = Field(min_length=1)
    trigger_source: str = Field(min_length=1)
    model_provider: str = "google"
    model: str
    command: str = Field(min_length=1)
    started_at: datetime | None = None
    ended_at: datetime | None = None
    latency_ms: int = Field(ge=0)
    status: str
    usage: UsagePayload = Field(default_factory=UsagePayload)
    request_raw: dict[str, Any] | None = None
    prompt_raw: str | None = None
    response_raw: str | None = None
    response_candidates_raw: list[Any] = Field(default_factory=list)
    tool_calls_raw: list[Any] = Field(default_factory=list)
    media_manifest: list[dict[str, Any]] = Field(default_factory=list)
    error: dict[str, Any] | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class TelemetryBatchPayload(BaseModel):
    schema_version: str
    batch_id: str = Field(min_length=1)
    deployment_id: str = Field(min_length=1)
    agent_version: str = Field(min_length=1)
    generated_at: datetime
    checksum: str = Field(min_length=1)
    events: list[TelemetryEventPayload] = Field(min_length=1)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def configured_tokens() -> dict[str, str]:
    raw = os.environ.get("GEMINI_AGENT_TELEMETRY_TOKENS", "")
    result: dict[str, str] = {}
    for item in raw.split(","):
        item = item.strip()
        if not item:
            continue
        if ":" not in item:
            continue
        deployment_id, token = item.split(":", 1)
        result[deployment_id.strip()] = token.strip()
    return result


def allowed_models() -> set[str]:
    raw = os.environ.get("GEMINI_AGENT_ALLOWED_MODELS", "gemini-3.5-flash")
    return {model.strip() for model in raw.split(",") if model.strip()}


async def require_deployment(
    batch: TelemetryBatchPayload,
    authorization: str | None,
    db: AsyncSession,
) -> GeminiAgentTelemetryDeployment:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")
    supplied = authorization.removeprefix("Bearer ").strip()
    supplied_hash = hash_token(supplied)
    deployment = await db.get(GeminiAgentTelemetryDeployment, batch.deployment_id)
    if deployment is None:
        configured = configured_tokens().get(batch.deployment_id)
        if not configured or not secrets.compare_digest(configured, supplied):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid deployment token")
        deployment = GeminiAgentTelemetryDeployment(
            id=batch.deployment_id,
            label=batch.deployment_id,
            token_hash=supplied_hash,
            status="active",
            raw_enabled=True,
            retention_days=30,
            metadata_retention_days=180,
            last_seen_at=utc_now(),
        )
        try:
            async with db.begin_nested():
                db.add(deployment)
                await db.flush()
        except IntegrityError:
            deployment = await db.get(GeminiAgentTelemetryDeployment, batch.deployment_id)
            if deployment is None:
                raise HTTPException(status_code=409, detail="Deployment registration conflict")
    if not secrets.compare_digest(deployment.token_hash, supplied_hash):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid deployment token")
    if deployment.status != "active":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Deployment is not active")
    deployment.last_seen_at = utc_now()
    return deployment


def event_size(event: TelemetryEventPayload) -> int:
    return len(event.model_dump_json().encode("utf-8"))


@router.post("/ingest")
async def ingest_telemetry(
    batch: TelemetryBatchPayload,
    authorization: str | None = Header(default=None, alias="Authorization"),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    if batch.schema_version != "raw-v1":
        raise HTTPException(status_code=422, detail="Unsupported telemetry schema_version")
    if len(batch.model_dump_json().encode("utf-8")) > MAX_BATCH_BYTES:
        raise HTTPException(status_code=413, detail="Telemetry batch is too large")

    deployment = await require_deployment(batch, authorization, db)
    existing = await db.get(GeminiAgentTelemetryBatch, batch.batch_id)
    if existing is not None:
        await db.flush()
        return {
            "ok": True,
            "batch_id": batch.batch_id,
            "accepted_event_ids": [],
            "rejected": [],
            "received_at": utc_now().isoformat(),
        }

    accepted: list[str] = []
    rejected: list[dict[str, str]] = []
    received_at = utc_now()
    batch_row = GeminiAgentTelemetryBatch(
        batch_id=batch.batch_id,
        deployment_id=deployment.id,
        schema_version=batch.schema_version,
        checksum=batch.checksum,
        agent_version=batch.agent_version,
        event_count=len(batch.events),
        byte_size=len(batch.model_dump_json().encode("utf-8")),
        accepted_count=0,
        rejected_count=0,
        generated_at=batch.generated_at,
        received_at=received_at,
    )
    db.add(batch_row)
    await db.flush()

    for event in batch.events:
        if event.model not in allowed_models():
            rejected.append({"event_id": event.event_id, "reason": "unsupported_model"})
            continue
        if event_size(event) > MAX_EVENT_BYTES:
            rejected.append({"event_id": event.event_id, "reason": "event_too_large"})
            continue
        existing_event = await db.get(GeminiAgentTelemetryEvent, event.event_id)
        if existing_event is not None:
            continue
        prompt_raw = event.prompt_raw or ""
        response_raw = event.response_raw or ""
        row = GeminiAgentTelemetryEvent(
            event_id=event.event_id,
            deployment_id=deployment.id,
            batch_id=batch.batch_id,
            source_host_app=event.source_host_app,
            trigger_source=event.trigger_source,
            model_provider=event.model_provider,
            model=event.model,
            command=event.command,
            status=event.status,
            started_at=event.started_at,
            ended_at=event.ended_at,
            latency_ms=event.latency_ms,
            input_tokens=event.usage.input_tokens,
            output_tokens=event.usage.output_tokens,
            total_tokens=event.usage.total_tokens,
            prompt_bytes=len(prompt_raw.encode("utf-8")),
            response_bytes=len(response_raw.encode("utf-8")),
            error_type=(event.error or {}).get("type"),
            error_message=(event.error or {}).get("message"),
            event_metadata=event.metadata,
            received_at=received_at,
        )
        db.add(row)
        db.add(GeminiAgentTelemetryRawPayload(
            event_id=event.event_id,
            request_raw=event.request_raw,
            prompt_raw=prompt_raw,
            response_raw=response_raw,
            response_candidates_raw=event.response_candidates_raw,
            tool_calls_raw=event.tool_calls_raw,
            media_manifest=event.media_manifest,
            sensitivity_flags=[],
            expires_at=received_at + timedelta(days=deployment.retention_days),
        ))
        accepted.append(event.event_id)

    batch_row.accepted_count = len(accepted)
    batch_row.rejected_count = len(rejected)
    db.add(GeminiAgentTelemetryAuditLog(
        id=f"audit_{uuid4()}",
        operator_id=None,
        action="ingest",
        target_type="batch",
        target_id=batch.batch_id,
        reason=None,
        audit_metadata={"accepted": len(accepted), "rejected": len(rejected)},
    ))
    await db.commit()
    return {
        "ok": True,
        "batch_id": batch.batch_id,
        "accepted_event_ids": accepted,
        "rejected": rejected,
        "received_at": received_at.isoformat(),
    }
```

- [ ] **Step 5: Wire the router**

Modify `/Users/yhryzy/dev/vulca-platform/wenxin-backend/app/api/v1/__init__.py`:

```python
from .gemini_agent_telemetry import router as gemini_agent_telemetry_router
```

Add:

```python
api_router.include_router(
    gemini_agent_telemetry_router,
    prefix="/gemini-agent/telemetry",
    tags=["Gemini Agent Telemetry"],
)
```

- [ ] **Step 6: Run ingest tests**

Run:

```bash
cd /Users/yhryzy/dev/vulca-platform/wenxin-backend
pytest tests/test_gemini_agent_telemetry_api.py -q
```

Expected: all tests in the file pass.

- [ ] **Step 7: Commit backend ingest contract**

```bash
cd /Users/yhryzy/dev/vulca-platform
git add wenxin-backend/app/api/v1/gemini_agent_telemetry.py wenxin-backend/app/api/v1/__init__.py wenxin-backend/tests/test_gemini_agent_telemetry_api.py wenxin-backend/tests/fixtures/gemini_agent_raw_v1_batch.json
git commit -m "feat: add gemini agent telemetry ingest"
```

### Task 3: Backend Operator Metrics And Governance

**Files:**
- Modify: `/Users/yhryzy/dev/vulca-platform/wenxin-backend/app/api/v1/gemini_agent_telemetry.py`
- Test: `/Users/yhryzy/dev/vulca-platform/wenxin-backend/tests/test_gemini_agent_telemetry_api.py`

- [ ] **Step 1: Write failing operator route tests**

Append:

```python
from app.core.auth import get_current_admin_user


class AdminUser:
    id = "admin-test"
    username = "admin"
    is_active = True
    is_superuser = True


def _override_admin() -> None:
    app.dependency_overrides[get_current_admin_user] = lambda: AdminUser()


def _clear_overrides() -> None:
    app.dependency_overrides.clear()


def test_metrics_requires_admin() -> None:
    response = client.get("/api/v1/gemini-agent/telemetry/metrics")
    assert response.status_code in {401, 403}


def test_metrics_returns_ingested_counts(monkeypatch) -> None:
    monkeypatch.setenv("GEMINI_AGENT_TELEMETRY_TOKENS", "deployment-test-1:test-token")
    client.post(
        "/api/v1/gemini-agent/telemetry/ingest",
        json=_batch(),
        headers={"Authorization": "Bearer test-token"},
    )
    _override_admin()
    try:
        response = client.get("/api/v1/gemini-agent/telemetry/metrics")
    finally:
        _clear_overrides()
    assert response.status_code == 200
    data = response.json()
    assert data["ok"] is True
    assert data["event_count"] >= 1
    assert data["deployment_count"] >= 1


def test_events_list_exposes_redacted_previews(monkeypatch) -> None:
    monkeypatch.setenv("GEMINI_AGENT_TELEMETRY_TOKENS", "deployment-test-1:test-token")
    client.post(
        "/api/v1/gemini-agent/telemetry/ingest",
        json=_batch(),
        headers={"Authorization": "Bearer test-token"},
    )
    _override_admin()
    try:
        response = client.get("/api/v1/gemini-agent/telemetry/events")
    finally:
        _clear_overrides()
    assert response.status_code == 200
    item = response.json()["items"][0]
    assert item["event_id"] == "event-test-1"
    assert item["prompt_preview"] == "summarize this project"
    assert "prompt_raw" not in item


def test_raw_reveal_writes_audit_log(monkeypatch) -> None:
    monkeypatch.setenv("GEMINI_AGENT_TELEMETRY_TOKENS", "deployment-test-1:test-token")
    client.post(
        "/api/v1/gemini-agent/telemetry/ingest",
        json=_batch(),
        headers={"Authorization": "Bearer test-token"},
    )
    _override_admin()
    try:
        reveal = client.get("/api/v1/gemini-agent/telemetry/events/event-test-1?reveal_raw=true")
        audit = client.get("/api/v1/gemini-agent/telemetry/audit-log")
    finally:
        _clear_overrides()
    assert reveal.status_code == 200
    assert reveal.json()["raw"]["prompt_raw"] == "summarize this project"
    assert any(item["action"] == "raw_reveal" for item in audit.json()["items"])


def test_retention_update_writes_audit_log(monkeypatch) -> None:
    monkeypatch.setenv("GEMINI_AGENT_TELEMETRY_TOKENS", "deployment-test-1:test-token")
    client.post(
        "/api/v1/gemini-agent/telemetry/ingest",
        json=_batch(),
        headers={"Authorization": "Bearer test-token"},
    )
    _override_admin()
    try:
        response = client.patch("/api/v1/gemini-agent/telemetry/deployments/deployment-test-1/retention?days=14")
        audit = client.get("/api/v1/gemini-agent/telemetry/audit-log")
    finally:
        _clear_overrides()
    assert response.status_code == 200
    assert response.json()["retention_days"] == 14
    assert any(item["action"] == "retention_update" for item in audit.json()["items"])


def test_purge_expired_raw_deletes_old_payload(monkeypatch) -> None:
    import asyncio
    from datetime import datetime, timedelta, timezone

    from sqlalchemy import update

    from app.core.database import AsyncSessionLocal
    from app.models.gemini_agent_telemetry import GeminiAgentTelemetryRawPayload

    async def expire_payload() -> None:
        async with AsyncSessionLocal() as db:
            await db.execute(
                update(GeminiAgentTelemetryRawPayload)
                .where(GeminiAgentTelemetryRawPayload.event_id == "event-test-1")
                .values(expires_at=datetime.now(timezone.utc) - timedelta(days=1))
            )
            await db.commit()

    monkeypatch.setenv("GEMINI_AGENT_TELEMETRY_TOKENS", "deployment-test-1:test-token")
    client.post(
        "/api/v1/gemini-agent/telemetry/ingest",
        json=_batch(),
        headers={"Authorization": "Bearer test-token"},
    )
    asyncio.run(expire_payload())
    _override_admin()
    try:
        response = client.post("/api/v1/gemini-agent/telemetry/deployments/deployment-test-1/purge-expired")
    finally:
        _clear_overrides()
    assert response.status_code == 200
    assert response.json()["deleted_raw_payloads"] == 1
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
cd /Users/yhryzy/dev/vulca-platform/wenxin-backend
pytest tests/test_gemini_agent_telemetry_api.py::test_metrics_requires_admin tests/test_gemini_agent_telemetry_api.py::test_metrics_returns_ingested_counts tests/test_gemini_agent_telemetry_api.py::test_events_list_exposes_redacted_previews tests/test_gemini_agent_telemetry_api.py::test_raw_reveal_writes_audit_log tests/test_gemini_agent_telemetry_api.py::test_retention_update_writes_audit_log tests/test_gemini_agent_telemetry_api.py::test_purge_expired_raw_deletes_old_payload -q
```

Expected: FAIL because operator routes do not exist.

- [ ] **Step 3: Add admin dependency and metrics routes**

Modify `app/api/v1/gemini_agent_telemetry.py`:

```python
from sqlalchemy import delete, func, update
from app.core.auth import get_current_admin_user
from app.models.user import User
```

Add:

```python
@router.get("/metrics")
async def telemetry_metrics(
    _admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    event_count = await db.scalar(select(func.count()).select_from(GeminiAgentTelemetryEvent))
    deployment_count = await db.scalar(select(func.count()).select_from(GeminiAgentTelemetryDeployment))
    error_count = await db.scalar(
        select(func.count()).select_from(GeminiAgentTelemetryEvent).where(GeminiAgentTelemetryEvent.status == "error")
    )
    return {
        "ok": True,
        "event_count": int(event_count or 0),
        "deployment_count": int(deployment_count or 0),
        "error_count": int(error_count or 0),
    }


@router.get("/deployments")
async def list_deployments(
    _admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    rows = (await db.execute(select(GeminiAgentTelemetryDeployment))).scalars().all()
    return {
        "items": [
            {
                "deployment_id": row.id,
                "label": row.label,
                "status": row.status,
                "raw_enabled": row.raw_enabled,
                "retention_days": row.retention_days,
                "last_seen_at": row.last_seen_at.isoformat() if row.last_seen_at else None,
            }
            for row in rows
        ],
    }


def redacted_preview(value: str | None) -> str:
    if not value:
        return ""
    return value[:120] + ("..." if len(value) > 120 else "")


@router.get("/events")
async def list_events(
    deployment_id: str | None = None,
    limit: int = 50,
    _admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    limit = max(1, min(limit, 100))
    query = select(GeminiAgentTelemetryEvent, GeminiAgentTelemetryRawPayload).outerjoin(
        GeminiAgentTelemetryRawPayload,
        GeminiAgentTelemetryRawPayload.event_id == GeminiAgentTelemetryEvent.event_id,
    )
    if deployment_id:
        query = query.where(GeminiAgentTelemetryEvent.deployment_id == deployment_id)
    query = query.order_by(GeminiAgentTelemetryEvent.received_at.desc()).limit(limit)
    rows = (await db.execute(query)).all()
    items = []
    for row, raw in rows:
        items.append({
            "event_id": row.event_id,
            "deployment_id": row.deployment_id,
            "command": row.command,
            "model": row.model,
            "status": row.status,
            "received_at": row.received_at.isoformat() if row.received_at else None,
            "prompt_preview": redacted_preview(raw.prompt_raw if raw else ""),
            "response_preview": redacted_preview(raw.response_raw if raw else ""),
        })
    return {"items": items}


@router.get("/events/{event_id}")
async def get_event(
    event_id: str,
    reveal_raw: bool = False,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    event = await db.get(GeminiAgentTelemetryEvent, event_id)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not found")
    raw = await db.get(GeminiAgentTelemetryRawPayload, event_id)
    response = {
        "event_id": event.event_id,
        "deployment_id": event.deployment_id,
        "command": event.command,
        "model": event.model,
        "status": event.status,
        "prompt_preview": redacted_preview(raw.prompt_raw if raw else ""),
        "response_preview": redacted_preview(raw.response_raw if raw else ""),
        "raw": None,
    }
    if reveal_raw and raw:
        response["raw"] = {
            "prompt_raw": raw.prompt_raw,
            "response_raw": raw.response_raw,
            "request_raw": raw.request_raw,
            "media_manifest": raw.media_manifest,
        }
        db.add(GeminiAgentTelemetryAuditLog(
            id=f"audit_{uuid4()}",
            operator_id=str(admin.id),
            action="raw_reveal",
            target_type="event",
            target_id=event_id,
            reason=None,
            audit_metadata={},
        ))
        await db.commit()
    return response


@router.get("/audit-log")
async def audit_log(
    _admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    rows = (await db.execute(
        select(GeminiAgentTelemetryAuditLog).order_by(GeminiAgentTelemetryAuditLog.created_at.desc()).limit(100)
    )).scalars().all()
    return {
        "items": [
            {
                "id": row.id,
                "operator_id": row.operator_id,
                "action": row.action,
                "target_type": row.target_type,
                "target_id": row.target_id,
                "created_at": row.created_at.isoformat() if row.created_at else None,
            }
            for row in rows
        ],
    }
```

- [ ] **Step 4: Add governance routes**

Add:

```python
@router.post("/deployments/{deployment_id}/pause")
async def pause_deployment(
    deployment_id: str,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    deployment = await db.get(GeminiAgentTelemetryDeployment, deployment_id)
    if deployment is None:
        raise HTTPException(status_code=404, detail="Deployment not found")
    deployment.status = "paused"
    db.add(GeminiAgentTelemetryAuditLog(
        id=f"audit_{uuid4()}",
        operator_id=str(admin.id),
        action="pause",
        target_type="deployment",
        target_id=deployment_id,
        audit_metadata={},
    ))
    await db.commit()
    return {"ok": True, "deployment_id": deployment_id, "status": "paused"}


@router.patch("/deployments/{deployment_id}/retention")
async def set_retention(
    deployment_id: str,
    days: int,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    if days < 1 or days > 365:
        raise HTTPException(status_code=422, detail="Retention days must be 1..365")
    deployment = await db.get(GeminiAgentTelemetryDeployment, deployment_id)
    if deployment is None:
        raise HTTPException(status_code=404, detail="Deployment not found")
    deployment.retention_days = days
    db.add(GeminiAgentTelemetryAuditLog(
        id=f"audit_{uuid4()}",
        operator_id=str(admin.id),
        action="retention_update",
        target_type="deployment",
        target_id=deployment_id,
        audit_metadata={"retention_days": days},
    ))
    await db.commit()
    return {"ok": True, "deployment_id": deployment_id, "retention_days": days}


@router.post("/deployments/{deployment_id}/purge-expired")
async def purge_expired_raw(
    deployment_id: str,
    admin: User = Depends(get_current_admin_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    result = await db.execute(
        delete(GeminiAgentTelemetryRawPayload)
        .where(GeminiAgentTelemetryRawPayload.expires_at < utc_now())
        .where(GeminiAgentTelemetryRawPayload.event_id.in_(
            select(GeminiAgentTelemetryEvent.event_id)
            .where(GeminiAgentTelemetryEvent.deployment_id == deployment_id)
        ))
    )
    deleted = int(result.rowcount or 0)
    db.add(GeminiAgentTelemetryAuditLog(
        id=f"audit_{uuid4()}",
        operator_id=str(admin.id),
        action="purge_expired",
        target_type="deployment",
        target_id=deployment_id,
        audit_metadata={"deleted_raw_payloads": deleted},
    ))
    await db.commit()
    return {"ok": True, "deleted_raw_payloads": deleted}
```

- [ ] **Step 5: Run operator tests**

Run:

```bash
cd /Users/yhryzy/dev/vulca-platform/wenxin-backend
pytest tests/test_gemini_agent_telemetry_api.py -q
```

Expected: all tests pass.

- [ ] **Step 6: Commit backend operator API**

```bash
cd /Users/yhryzy/dev/vulca-platform
git add wenxin-backend/app/api/v1/gemini_agent_telemetry.py wenxin-backend/tests/test_gemini_agent_telemetry_api.py
git commit -m "feat: add gemini agent telemetry governance api"
```

### Task 4: Gemini Agent Raw-v1 Contract And Sender Hardening

**Files:**
- Modify: `/Users/yhryzy/dev/gemini-agent/src/telemetry-schemas.mjs`
- Modify: `/Users/yhryzy/dev/gemini-agent/src/telemetry-sender.mjs`
- Modify: `/Users/yhryzy/dev/gemini-agent/src/telemetry-queue.mjs`
- Modify: `/Users/yhryzy/dev/gemini-agent/src/telemetry-capture.mjs`
- Test: `/Users/yhryzy/dev/gemini-agent/test/telemetry-contract.test.mjs`
- Test: `/Users/yhryzy/dev/gemini-agent/test/telemetry-sender.test.mjs`
- Fixture: `/Users/yhryzy/dev/gemini-agent/test/fixtures/telemetry/raw-v1-batch.json`

- [ ] **Step 1: Add contract fixture**

Create `/Users/yhryzy/dev/gemini-agent/test/fixtures/telemetry/raw-v1-batch.json` with the same content as the backend fixture from Task 2.

- [ ] **Step 2: Write failing schema tests**

Create `/Users/yhryzy/dev/gemini-agent/test/telemetry-contract.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { normalizeRawTelemetryBatch, RAW_TELEMETRY_SCHEMA_VERSION } from "../src/telemetry-schemas.mjs";

test("normalizes raw-v1 telemetry batch fixture", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/telemetry/raw-v1-batch.json", import.meta.url), "utf8"));
  const batch = normalizeRawTelemetryBatch(fixture);
  assert.equal(RAW_TELEMETRY_SCHEMA_VERSION, "raw-v1");
  assert.equal(batch.schema_version, "raw-v1");
  assert.equal(batch.events[0].model, "gemini-3.5-flash");
  assert.equal(batch.events[0].prompt_raw, "summarize this project");
});

test("normalizes raw-v1 telemetry with credential masking", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/telemetry/raw-v1-batch.json", import.meta.url), "utf8"));
  fixture.events[0].prompt_raw = "GEMINI_API_KEY=AIzaSyabcdefghijklmnopqrstuvwxyz";
  fixture.events[0].response_raw = "Authorization: Bearer secret-token-value";
  const batch = normalizeRawTelemetryBatch(fixture);
  assert.equal(batch.events[0].prompt_raw, "GEMINI_API_KEY=[MASKED]");
  assert.equal(batch.events[0].response_raw, "Authorization: [MASKED]");
});

test("rejects unknown raw telemetry major schema", () => {
  assert.throws(
    () => normalizeRawTelemetryBatch({
      schema_version: "raw-v2",
      batch_id: "batch",
      deployment_id: "dep",
      agent_version: "0.1.0",
      generated_at: "2026-05-31T10:00:00Z",
      checksum: "sha256:test",
      events: [],
    }),
    /schema_version/,
  );
});
```

- [ ] **Step 3: Run schema tests and verify failure**

Run:

```bash
cd /Users/yhryzy/dev/gemini-agent
node --test test/telemetry-contract.test.mjs
```

Expected: FAIL because `normalizeRawTelemetryBatch` is not exported.

- [ ] **Step 4: Add raw-v1 schemas**

Modify `/Users/yhryzy/dev/gemini-agent/src/telemetry-schemas.mjs`:

Keep the existing `z` import, existing `IsoString` validator, and existing `maskCredentialText()` helper in this file; add the raw-v1 exports below the current credential masking helpers.

```js
export const RAW_TELEMETRY_SCHEMA_VERSION = "raw-v1";

const RawUsageZodSchema = z.strictObject({
  input_tokens: z.number().int().nonnegative().nullable().optional(),
  output_tokens: z.number().int().nonnegative().nullable().optional(),
  total_tokens: z.number().int().nonnegative().nullable().optional(),
}).default(() => ({}));

const RawTelemetryEventZodSchema = z.strictObject({
  event_id: z.string().min(1),
  source_host_app: z.enum(["codex", "cli", "mcp", "other"]),
  trigger_source: z.enum(["manual", "scheduled", "mcp", "global_policy"]),
  model_provider: z.literal("google").default("google"),
  model: z.string().min(1),
  command: z.string().min(1),
  started_at: IsoString.nullable().optional(),
  ended_at: IsoString.nullable().optional(),
  latency_ms: z.number().int().nonnegative(),
  status: z.enum(["success", "error"]),
  usage: RawUsageZodSchema,
  request_raw: z.record(z.string(), z.unknown()).nullable().default(null),
  prompt_raw: z.string().nullable().default(""),
  response_raw: z.string().nullable().default(""),
  response_candidates_raw: z.array(z.unknown()).default(() => []),
  tool_calls_raw: z.array(z.unknown()).default(() => []),
  media_manifest: z.array(z.record(z.string(), z.unknown())).default(() => []),
  error: z.record(z.string(), z.unknown()).nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default(() => ({})),
});

export const RawTelemetryBatchZodSchema = z.strictObject({
  schema_version: z.literal(RAW_TELEMETRY_SCHEMA_VERSION),
  batch_id: z.string().min(1),
  deployment_id: z.string().min(1),
  agent_version: z.string().min(1),
  generated_at: IsoString,
  checksum: z.string().min(1),
  events: z.array(RawTelemetryEventZodSchema).min(1),
});

export function normalizeRawTelemetryBatch(value) {
  const parsed = RawTelemetryBatchZodSchema.parse(value);
  return {
    ...parsed,
    events: parsed.events.map((event) => ({
      ...event,
      prompt_raw: maskCredentialText(event.prompt_raw),
      response_raw: maskCredentialText(event.response_raw),
      request_raw: event.request_raw,
      tool_calls_raw: event.tool_calls_raw,
    })),
  };
}
```

- [ ] **Step 5: Write non-retryable sender tests**

Append to `/Users/yhryzy/dev/gemini-agent/test/telemetry-sender.test.mjs`:

```js
test("flushTelemetryQueue archives unauthorized batches instead of retrying forever", async () => {
  const cwd = await temporaryWorkspace();
  await appendTelemetryEvent({ cwd, event: telemetryEvent(10) });

  await assert.rejects(
    () => flushTelemetryQueue({
      cwd,
      endpoint: ENDPOINT,
      token: TOKEN,
      fetchImpl: async () => new Response("unauthorized", { status: 401 }),
      now: NOW,
    }),
    /disable sender until token is fixed/,
  );

  const dirs = telemetryQueueDirs(cwd);
  assert.deepEqual(await readPendingEvents(cwd), []);
  assert.equal((await directoryNames(dirs.failed)).length, 1);
  const state = await loadTelemetryState({ cwd });
  assert.equal(state.sent_failure_count, 1);
  assert.equal(state.non_retryable_failure_count, 1);
});

test("flushTelemetryQueue archives oversized batches on 413", async () => {
  const cwd = await temporaryWorkspace();
  await appendTelemetryEvent({ cwd, event: telemetryEvent(11) });

  await assert.rejects(
    () => flushTelemetryQueue({
      cwd,
      endpoint: ENDPOINT,
      token: TOKEN,
      fetchImpl: async () => new Response("too large", { status: 413 }),
      now: NOW,
    }),
    /Telemetry batch is too large/,
  );

  const dirs = telemetryQueueDirs(cwd);
  assert.deepEqual(await readPendingEvents(cwd), []);
  assert.equal((await directoryNames(dirs.failed)).length, 1);
});

test("flushTelemetryQueue archives validation failures on 422", async () => {
  const cwd = await temporaryWorkspace();
  await appendTelemetryEvent({ cwd, event: telemetryEvent(12) });

  await assert.rejects(
    () => flushTelemetryQueue({
      cwd,
      endpoint: ENDPOINT,
      token: TOKEN,
      fetchImpl: async () => new Response("schema mismatch", { status: 422 }),
      now: NOW,
    }),
    /Telemetry receiver returned non-retryable 422/,
  );

  const dirs = telemetryQueueDirs(cwd);
  assert.deepEqual(await readPendingEvents(cwd), []);
  assert.equal((await directoryNames(dirs.failed)).length, 1);
});
```

- [ ] **Step 6: Add non-retryable queue archiving**

Modify `/Users/yhryzy/dev/gemini-agent/src/telemetry-queue.mjs`:

```js
export function telemetryQueueDirs(cwd = process.cwd()) {
  const root = telemetryRoot(cwd);
  const queue = join(root, "queue");
  return {
    root,
    queue,
    pending: join(queue, "pending"),
    inflight: join(queue, "inflight"),
    sent: join(queue, "sent"),
    failed: join(queue, "failed"),
    tmp: join(queue, "tmp"),
    state: join(root, "state.json"),
  };
}
```

Update `ensureQueueDirs()` so it creates the failed archive:

```js
for (const dir of [dirs.root, dirs.queue, dirs.pending, dirs.inflight, dirs.sent, dirs.failed, dirs.tmp]) {
  await mkdir(dir, { recursive: true, mode: SECURE_DIR_MODE });
  await chmod(dir, SECURE_DIR_MODE);
}
```

Replace `failTelemetryBatch()` with:

```js
export async function failTelemetryBatch({
  cwd = process.cwd(),
  batchId,
  retryable = true,
  reason = "receiver_error",
} = {}) {
  assertSafeBatchId(batchId);

  return withTelemetryQueueLock({ cwd }, async () => {
    const dirs = await ensureQueueDirs(cwd);
    const batchDir = join(dirs.inflight, batchId);
    if (!await fileExists(batchDir)) return 0;

    const files = await regularFiles(batchDir);
    let moved = 0;
    if (retryable) {
      for (const file of files) {
        const destination = join(dirs.pending, file.name);
        await rename(file.path, destination);
        await chmod(destination, SECURE_FILE_MODE);
        moved += 1;
      }
    } else {
      const failedDir = join(dirs.failed, batchId);
      await mkdir(failedDir, { recursive: true, mode: SECURE_DIR_MODE });
      await writeFile(join(failedDir, "reason.json"), JSON.stringify({ reason }, null, 2), { mode: SECURE_FILE_MODE });
      for (const file of files) {
        const destination = join(failedDir, file.name);
        await rename(file.path, destination);
        await chmod(destination, SECURE_FILE_MODE);
        moved += 1;
      }
    }
    await rm(batchDir, { recursive: true, force: true });

    const state = await loadStateFromPath(dirs.state);
    await saveState(cwd, {
      ...state,
      queue_bytes: await pendingQueueBytes(cwd),
      sent_failure_count: state.sent_failure_count + moved,
      non_retryable_failure_count: retryable
        ? (state.non_retryable_failure_count || 0)
        : (state.non_retryable_failure_count || 0) + moved,
      last_failure_reason: reason,
    });
    return moved;
  });
}
```

- [ ] **Step 7: Update sender to post raw-v1 and item ACK**

Modify `flushTelemetryQueue()` in `/Users/yhryzy/dev/gemini-agent/src/telemetry-sender.mjs` so it maps existing queued events into raw-v1:

```js
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { RAW_TELEMETRY_SCHEMA_VERSION, normalizeRawTelemetryBatch } from "./telemetry-schemas.mjs";

const require = createRequire(import.meta.url);
const { version: agentVersion } = require("../package.json");

function checksumFor(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function rawEventFromLegacy(event) {
  return {
    event_id: event.event_id,
    source_host_app: event.source === "mcp" ? "mcp" : "cli",
    trigger_source: event.source === "mcp" ? "mcp" : "manual",
    model_provider: "google",
    model: event.model,
    command: event.command,
    started_at: event.created_at,
    ended_at: event.created_at,
    latency_ms: event.latency_ms,
    status: event.status,
    usage: {},
    request_raw: null,
    prompt_raw: event.prompt,
    response_raw: event.response,
    response_candidates_raw: [],
    tool_calls_raw: [],
    media_manifest: event.payload?.multimodal || [],
    error: event.error_type ? { type: event.error_type } : null,
    metadata: {
      legacy_schema_version: event.schema_version,
      trace_id: event.trace_id,
      project_id: event.project_id,
    },
  };
}
```

Add a receiver error type:

```js
class TelemetryReceiverError extends Error {
  constructor(message, { retryable = true, reason = "receiver_error" } = {}) {
    super(message);
    this.retryable = retryable;
    this.reason = reason;
  }
}
```

Construct the batch with:

```js
const rawDraft = {
  schema_version: RAW_TELEMETRY_SCHEMA_VERSION,
  batch_id: claimed.batchId,
  deployment_id: claimed.events[0].deployment_id,
  agent_version: agentVersion,
  generated_at: now.toISOString(),
  checksum: "sha256:pending",
  events: claimed.events.map(rawEventFromLegacy),
};
rawDraft.checksum = checksumFor(rawDraft.events);
const batch = normalizeRawTelemetryBatch(rawDraft);
```

Accept either old local ACK or new production ACK:

```js
function normalizeProductionAck(value) {
  if (value?.ok === true && Array.isArray(value.accepted_event_ids) && Array.isArray(value.rejected)) {
    return value;
  }
  return null;
}
```

Status handling must mark all `4xx` responses except `429` as non-retryable failures archived under `queue/failed`; `429` and `>=500` stay retryable and return events to `queue/pending`.

Replace receiver status handling with:

```js
if (!response.ok) {
  if (response.status === 401) {
    throw new TelemetryReceiverError(
      "Telemetry receiver returned 401; disable sender until token is fixed.",
      { retryable: false, reason: "unauthorized" },
    );
  }
  if (response.status === 413) {
    throw new TelemetryReceiverError(
      "Telemetry batch is too large.",
      { retryable: false, reason: "payload_too_large" },
    );
  }
  if (response.status >= 400 && response.status < 500 && response.status !== 429) {
    throw new TelemetryReceiverError(
      `Telemetry receiver returned non-retryable ${response.status}.`,
      { retryable: false, reason: `http_${response.status}` },
    );
  }
  throw new TelemetryReceiverError(`Telemetry receiver returned ${response.status}.`);
}
```

Update the send catch block:

```js
} catch (error) {
  await failTelemetryBatch({
    cwd,
    batchId: claimed.batchId,
    retryable: error.retryable !== false,
    reason: error.reason || "receiver_error",
  });
  throw error;
}
```

- [ ] **Step 8: Run contract and sender tests**

Run:

```bash
cd /Users/yhryzy/dev/gemini-agent
node --test test/telemetry-contract.test.mjs test/telemetry-sender.test.mjs
```

Expected: PASS.

- [ ] **Step 9: Commit client contract alignment**

```bash
cd /Users/yhryzy/dev/gemini-agent
git add src/telemetry-schemas.mjs src/telemetry-sender.mjs src/telemetry-queue.mjs src/telemetry-capture.mjs test/telemetry-contract.test.mjs test/telemetry-sender.test.mjs test/fixtures/telemetry/raw-v1-batch.json
git commit -m "feat: send raw v1 telemetry batches"
```

### Task 5: Gemini Agent Scheduler Installer

**Files:**
- Create: `/Users/yhryzy/dev/gemini-agent/src/telemetry-scheduler.mjs`
- Modify: `/Users/yhryzy/dev/gemini-agent/src/cli.mjs`
- Test: `/Users/yhryzy/dev/gemini-agent/test/telemetry-scheduler.test.mjs`
- Extend: `/Users/yhryzy/dev/gemini-agent/test/cli.test.mjs`

- [ ] **Step 1: Write scheduler generator tests**

Create `/Users/yhryzy/dev/gemini-agent/test/telemetry-scheduler.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  generateCronEntry,
  generateLaunchdPlist,
  generateSystemdService,
  generateSystemdTimer,
  installScheduler,
  normalizeSchedulerOptions,
  schedulerStatus,
  uninstallScheduler,
} from "../src/telemetry-scheduler.mjs";

const base = {
  name: "gemini-agent-test",
  schedule: "hourly",
  cwd: "/tmp/project",
  bin: "/usr/local/bin/gemini-agent",
  envFile: "/tmp/project/.gemini-agent/telemetry/env",
};

test("normalizes scheduler options and rejects root user", () => {
  const options = normalizeSchedulerOptions({ ...base, uid: 501 });
  assert.equal(options.name, "gemini-agent-test");
  assert.throws(() => normalizeSchedulerOptions({ ...base, uid: 0 }), /must not run as root/);
});

test("generates launchd plist without secrets", () => {
  const plist = generateLaunchdPlist(base);
  assert.match(plist, /com\.gemini-agent\.gemini-agent-test/);
  assert.match(plist, /telemetry/);
  assert.match(plist, /tick/);
  assert.doesNotMatch(plist, /GEMINI_API_KEY|GEMINI_AGENT_TELEMETRY_TOKEN/);
});

test("generates cron entry", () => {
  const cron = generateCronEntry(base);
  assert.match(cron, /^0 \* \* \* \*/);
  assert.match(cron, /cd \/tmp\/project/);
  assert.match(cron, /telemetry tick/);
});

test("generates systemd service and timer", () => {
  assert.match(generateSystemdService(base), /ExecStart=\/usr\/local\/bin\/gemini-agent telemetry tick/);
  assert.match(generateSystemdTimer(base), /OnCalendar=hourly/);
});

test("writes and activates launchd with the provided uid and domain", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-agent-scheduler-"));
  const envFile = join(home, "env");
  await writeFile(envFile, "GEMINI_AGENT_TELEMETRY_TOKEN=test\n", { mode: 0o600 });
  const calls = [];
  const runner = async (...args) => {
    calls.push(args);
    if (args[1][0] === "bootout") {
      throw new Error("not bootstrapped");
    }
    return { stdout: "" };
  };

  try {
    const result = await installScheduler({
      ...base,
      target: "launchd",
      write: true,
      home,
      envFile,
      uid: 501,
      launchdDomain: "user",
      runner,
    });
    assert.equal(result.changed, true);
    assert.equal(calls[0][0], "launchctl");
    assert.deepEqual(calls[0][1].slice(0, 2), ["bootout", "user/501"]);
    assert.deepEqual(calls[1][1].slice(0, 2), ["bootstrap", "user/501"]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("cron activation preserves existing entries and installs managed block", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-agent-scheduler-"));
  let installed = "";
  const runner = async (command, args) => {
    if (command === "crontab" && args[0] === "-l") {
      return { stdout: "15 7 * * * /usr/bin/true\n" };
    }
    if (command === "crontab") {
      installed = await readFile(args[0], "utf8");
      return { stdout: "" };
    }
    return { stdout: "" };
  };

  try {
    await installScheduler({
      ...base,
      target: "cron",
      write: true,
      cwd: home,
      home,
      uid: 501,
      runner,
    });
    assert.match(installed, /15 7 \* \* \* \/usr\/bin\/true/);
    assert.match(installed, /# gemini-agent managed block/);
    assert.match(installed, /gemini-agent telemetry tick/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("cron activation treats missing crontab as empty", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-agent-scheduler-"));
  let installed = "";
  const runner = async (command, args) => {
    if (command === "crontab" && args[0] === "-l") {
      throw new Error("no crontab for user");
    }
    if (command === "crontab") {
      installed = await readFile(args[0], "utf8");
      return { stdout: "" };
    }
    return { stdout: "" };
  };

  try {
    await installScheduler({
      ...base,
      target: "cron",
      write: true,
      cwd: home,
      home,
      uid: 501,
      runner,
    });
    assert.match(installed, /# gemini-agent managed block/);
    assert.match(installed, /gemini-agent telemetry tick/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("reports scheduler status and uninstalls artifacts", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-agent-scheduler-"));
  const runner = async () => ({ stdout: "" });

  try {
    await installScheduler({
      ...base,
      target: "cron",
      write: true,
      cwd: home,
      home,
      uid: 501,
      runner,
    });
    const before = await schedulerStatus({ target: "cron", name: base.name, cwd: home, home });
    assert.equal(before.files[0].exists, true);
    const removed = await uninstallScheduler({ target: "cron", name: base.name, cwd: home, home });
    assert.equal(removed.ok, true);
    const after = await schedulerStatus({ target: "cron", name: base.name, cwd: home, home });
    assert.equal(after.files[0].exists, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
cd /Users/yhryzy/dev/gemini-agent
node --test test/telemetry-scheduler.test.mjs
```

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement scheduler generators**

Create `/Users/yhryzy/dev/gemini-agent/src/telemetry-scheduler.mjs`:

```js
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

function assertName(name) {
  if (!/^[A-Za-z0-9._-]+$/.test(name || "")) {
    throw new Error("Scheduler name must contain only letters, numbers, dot, underscore, or dash.");
  }
}

function cronSchedule(schedule) {
  if (schedule === "hourly") return "0 * * * *";
  const match = /^daily@([01]\d|2[0-3]):([0-5]\d)$/.exec(schedule);
  if (!match) throw new Error(`Unsupported scheduler schedule: ${schedule}`);
  return `${Number(match[2])} ${Number(match[1])} * * *`;
}

function systemdCalendar(schedule) {
  if (schedule === "hourly") return "hourly";
  const match = /^daily@([01]\d|2[0-3]):([0-5]\d)$/.exec(schedule);
  if (!match) throw new Error(`Unsupported scheduler schedule: ${schedule}`);
  return `*-*-* ${match[1]}:${match[2]}:00`;
}

export function normalizeSchedulerOptions({
  name,
  schedule = "daily@09:00",
  cwd = process.cwd(),
  bin = "gemini-agent",
  envFile = null,
  home = process.env.HOME,
  uid = typeof process.getuid === "function" ? process.getuid() : 1,
  launchdDomain = "gui",
} = {}) {
  assertName(name);
  if (uid === 0) throw new Error("Scheduler must not run as root.");
  if (!["gui", "user"].includes(launchdDomain)) {
    throw new Error("launchdDomain must be gui or user.");
  }
  return { name, schedule, cwd, bin, envFile, home, uid, launchdDomain };
}

export function generateLaunchdPlist(input) {
  const options = normalizeSchedulerOptions(input);
  const program = [options.bin, "telemetry", "tick"];
  const env = options.envFile ? `<key>EnvironmentVariables</key><dict><key>GEMINI_AGENT_ENV_FILE</key><string>${options.envFile}</string></dict>` : "";
  const schedule = options.schedule === "hourly"
    ? "<key>StartInterval</key><integer>3600</integer>"
    : (() => {
        const [, hour, minute] = /^daily@([01]\d|2[0-3]):([0-5]\d)$/.exec(options.schedule);
        return `<key>StartCalendarInterval</key><dict><key>Hour</key><integer>${Number(hour)}</integer><key>Minute</key><integer>${Number(minute)}</integer></dict>`;
      })();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.gemini-agent.${options.name}</string>
<key>WorkingDirectory</key><string>${options.cwd}</string>
<key>ProgramArguments</key><array>${program.map((part) => `<string>${part}</string>`).join("")}</array>
${env}
<key>RunAtLoad</key><true/>
${schedule}
</dict></plist>
`;
}

export function generateCronEntry(input) {
  const options = normalizeSchedulerOptions(input);
  const env = options.envFile ? `. ${options.envFile} && ` : "";
  return `${cronSchedule(options.schedule)} cd ${options.cwd} && ${env}${options.bin} telemetry tick # gemini-agent:${options.name}`;
}

export function generateSystemdService(input) {
  const options = normalizeSchedulerOptions(input);
  const env = options.envFile ? `EnvironmentFile=${options.envFile}\n` : "";
  return `[Unit]
Description=Gemini Agent telemetry tick ${options.name}

[Service]
Type=oneshot
WorkingDirectory=${options.cwd}
${env}ExecStart=${options.bin} telemetry tick
`;
}

export function generateSystemdTimer(input) {
  const options = normalizeSchedulerOptions(input);
  return `[Unit]
Description=Gemini Agent telemetry timer ${options.name}

[Timer]
OnCalendar=${systemdCalendar(options.schedule)}
Persistent=true

[Install]
WantedBy=timers.target
`;
}

export function schedulerArtifact({ target, ...options }) {
  if (target === "launchd") {
    return {
      files: [{
        path: `${options.home}/Library/LaunchAgents/com.gemini-agent.${options.name}.plist`,
        content: generateLaunchdPlist(options),
      }],
    };
  }
  if (target === "cron") {
    return {
      files: [{
        path: `${options.cwd}/.gemini-agent/telemetry/cron.${options.name}`,
        content: `${generateCronEntry(options)}\n`,
      }],
    };
  }
  if (target === "systemd") {
    return {
      files: [
        {
          path: `${options.home}/.config/systemd/user/gemini-agent-${options.name}.service`,
          content: generateSystemdService(options),
        },
        {
          path: `${options.home}/.config/systemd/user/gemini-agent-${options.name}.timer`,
          content: generateSystemdTimer(options),
        },
      ],
    };
  }
  throw new Error(`Unsupported scheduler target: ${target}`);
}

async function assertEnvFileSecure(path) {
  if (!path) return;
  const info = await stat(path);
  if ((info.mode & 0o077) !== 0) {
    throw new Error("Scheduler env file must not be readable by group or others.");
  }
}

async function installCron(files, runner) {
  const current = await runner("crontab", ["-l"]).then((result) => result.stdout || "", () => "");
  const markerStart = "# gemini-agent managed block";
  const markerEnd = "# end gemini-agent managed block";
  const managed = files.map((file) => file.content.trim()).filter(Boolean).join("\n");
  const stripped = current
    .replace(/\n?# gemini-agent managed block[\s\S]*?# end gemini-agent managed block\n?/g, "\n")
    .trim();
  const next = [stripped, markerStart, managed, markerEnd].filter(Boolean).join("\n") + "\n";
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cron-"));
  try {
    const crontabPath = join(dir, "crontab");
    await writeFile(crontabPath, next, { mode: 0o600 });
    await chmod(crontabPath, 0o600);
    await runner("crontab", [crontabPath]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function activateScheduler({ target, files, uid, launchdDomain = "gui", runner = execFile } = {}) {
  if (target === "launchd") {
    await runner("launchctl", ["bootout", `${launchdDomain}/${uid}`, files[0].path]).catch(() => undefined);
    await runner("launchctl", ["bootstrap", `${launchdDomain}/${uid}`, files[0].path]);
    return;
  }
  if (target === "systemd") {
    const timer = files.find((file) => file.path.endsWith(".timer"));
    await runner("systemctl", ["--user", "daemon-reload"]);
    await runner("systemctl", ["--user", "enable", "--now", timer.path.split("/").pop()]);
    return;
  }
  if (target === "cron") {
    await installCron(files, runner);
    return;
  }
  throw new Error(`Unsupported scheduler target: ${target}`);
}

export async function installScheduler({ target, write = false, home = process.env.HOME, runner = execFile, ...input } = {}) {
  const options = normalizeSchedulerOptions({ ...input, home });
  await assertEnvFileSecure(options.envFile);
  const artifact = schedulerArtifact({ target, ...options, home });
  if (!write) return { changed: false, dry_run: true, ...artifact };
  for (const file of artifact.files) {
    await mkdir(dirname(file.path), { recursive: true, mode: 0o700 });
    await writeFile(file.path, file.content, { mode: 0o600 });
    await chmod(file.path, 0o600);
  }
  await activateScheduler({
    target,
    files: artifact.files,
    uid: options.uid,
    launchdDomain: options.launchdDomain,
    runner,
  });
  return { changed: true, dry_run: false, ...artifact };
}

export async function schedulerStatus({ target, name, home = process.env.HOME, cwd = process.cwd() } = {}) {
  assertName(name);
  const artifact = schedulerArtifact({ target, name, schedule: "hourly", cwd, bin: "gemini-agent", home });
  const files = [];
  for (const file of artifact.files) {
    try {
      const info = await stat(file.path);
      files.push({ path: file.path, exists: true, mode: info.mode & 0o777 });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      files.push({ path: file.path, exists: false, mode: null });
    }
  }
  return { files };
}

export async function uninstallScheduler({ target, name, home = process.env.HOME, cwd = process.cwd() } = {}) {
  assertName(name);
  const artifact = schedulerArtifact({ target, name, schedule: "hourly", cwd, bin: "gemini-agent", home });
  for (const file of artifact.files) {
    await rm(file.path, { force: true });
  }
  return { ok: true, removed: artifact.files.map((file) => file.path) };
}
```

- [ ] **Step 4: Add CLI parsing tests**

Extend `test/cli.test.mjs` with an exec test for:

```js
await execFileAsync(bin, [
  "telemetry",
  "install-scheduler",
  "--target",
  "cron",
  "--name",
  "test",
  "--schedule",
  "hourly",
  "--dry-run",
], { cwd: dir, env: { PATH: process.env.PATH } });
```

Assert stdout contains `gemini-agent:test` and stderr is empty.

- [ ] **Step 5: Wire CLI commands**

Modify `printUsage()` in `src/cli.mjs` to include:

```js
"  gemini-agent telemetry install-scheduler --target launchd|cron|systemd --name <label> [--schedule hourly|daily@HH:MM] [--env-file <path>] [--launchd-domain gui|user] [--dry-run]",
"  gemini-agent telemetry scheduler-status --target launchd|cron|systemd --name <label>",
"  gemini-agent telemetry uninstall-scheduler --target launchd|cron|systemd --name <label>",
```

Import the scheduler helpers:

```js
import { installScheduler, schedulerStatus, uninstallScheduler } from "./telemetry-scheduler.mjs";
```

Add parser helpers:

```js
function parseSchedulerOptions(args) {
  const options = { schedule: "daily@09:00", write: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--target") {
      options.target = args[++index];
    } else if (arg === "--name") {
      options.name = args[++index];
    } else if (arg === "--schedule") {
      options.schedule = args[++index];
    } else if (arg === "--env-file") {
      options.envFile = args[++index];
    } else if (arg === "--launchd-domain") {
      options.launchdDomain = args[++index];
    } else if (arg === "--write") {
      options.write = true;
    } else if (arg === "--dry-run") {
      options.write = false;
    } else {
      throw new Error(`Unknown scheduler argument: ${arg}`);
    }
  }
  if (!options.target) throw new Error("--target is required.");
  if (!options.name) throw new Error("--name is required.");
  return options;
}
```

In `runTelemetry(args)`, add:

```js
if (subcommand === "install-scheduler") {
  const options = parseSchedulerOptions(subArgs);
  const result = await installScheduler({
    ...options,
    cwd: process.cwd(),
    bin: process.argv[1],
    home: process.env.HOME,
  });
  output.write(`${JSON.stringify(result, null, 2)}\n`);
  return;
}

if (subcommand === "scheduler-status") {
  const options = parseSchedulerOptions(subArgs);
  const result = await schedulerStatus({ ...options, cwd: process.cwd(), home: process.env.HOME });
  output.write(`${JSON.stringify(result, null, 2)}\n`);
  return;
}

if (subcommand === "uninstall-scheduler") {
  const options = parseSchedulerOptions(subArgs);
  const result = await uninstallScheduler({ ...options, cwd: process.cwd(), home: process.env.HOME });
  output.write(`${JSON.stringify(result, null, 2)}\n`);
  return;
}
```

- [ ] **Step 6: Run scheduler and CLI tests**

Run:

```bash
cd /Users/yhryzy/dev/gemini-agent
node --test test/telemetry-scheduler.test.mjs test/cli.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit scheduler dry-run**

```bash
cd /Users/yhryzy/dev/gemini-agent
git add src/telemetry-scheduler.mjs src/cli.mjs test/telemetry-scheduler.test.mjs test/cli.test.mjs
git commit -m "feat: add telemetry scheduler installer"
```

### Task 6: Global Active Codex Installer

**Files:**
- Create: `/Users/yhryzy/dev/gemini-agent/src/codex-global-install.mjs`
- Modify: `/Users/yhryzy/dev/gemini-agent/src/cli.mjs`
- Test: `/Users/yhryzy/dev/gemini-agent/test/codex-global-install.test.mjs`
- Extend: `/Users/yhryzy/dev/gemini-agent/test/cli.test.mjs`

- [ ] **Step 1: Write installer tests**

Create `/Users/yhryzy/dev/gemini-agent/test/codex-global-install.test.mjs`:

```js
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { test } from "node:test";
import {
  ACTIVE_POLICY_BLOCK,
  applyCodexGlobalInstall,
  planCodexGlobalInstall,
} from "../src/codex-global-install.mjs";

test("dry run creates marker block and MCP reference without writing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-global-"));
  await mkdir(join(dir, ".codex"), { recursive: true });
  const target = join(dir, ".codex", "AGENTS.md");
  await writeFile(target, "# Existing\n");
  const plan = await planCodexGlobalInstall({ home: dir, mode: "active" });
  assert.match(plan.nextContent, /BEGIN GEMINI AGENT ACTIVE POLICY/);
  assert.match(plan.nextContent, /gemini_context_pack/);
  assert.equal(await readFile(target, "utf8"), "# Existing\n");
});

test("write is idempotent and creates backup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-global-"));
  await mkdir(join(dir, ".codex"), { recursive: true });
  const target = join(dir, ".codex", "AGENTS.md");
  await writeFile(target, "# Existing\n");
  const first = await applyCodexGlobalInstall({ home: dir, mode: "active", write: true, now: new Date("2026-05-31T10:00:00Z") });
  const second = await applyCodexGlobalInstall({ home: dir, mode: "active", write: true, now: new Date("2026-05-31T10:01:00Z") });
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.ok(first.backupPath);
  assert.match(await readFile(target, "utf8"), /recursion guard/i);
});

test("active policy block names expected tools", () => {
  for (const name of ["context-pack", "artifact-review", "plan-critique", "patch-precheck", "diff-review", "research-brief"]) {
    assert.match(ACTIVE_POLICY_BLOCK, new RegExp(name));
  }
});
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```bash
cd /Users/yhryzy/dev/gemini-agent
node --test test/codex-global-install.test.mjs
```

Expected: FAIL because module does not exist.

- [ ] **Step 3: Implement installer module**

Create `/Users/yhryzy/dev/gemini-agent/src/codex-global-install.mjs`:

```js
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const START = "<!-- BEGIN GEMINI AGENT ACTIVE POLICY -->";
const END = "<!-- END GEMINI AGENT ACTIVE POLICY -->";

export const ACTIVE_POLICY_BLOCK = `${START}
## Gemini Agent Active Policy

Use gemini-agent proactively when it reduces Codex token load or adds multimodal/design review:

- context-pack: large code, diffs, notes, or source context.
- artifact-review: UI screenshots, diagrams, images, PDFs, and design artifacts.
- plan-critique: before implementation plans or risky designs.
- patch-precheck: before broad or risky edits.
- diff-review: before commits, releases, or merge-back work.
- research-brief: when compact sourced research is useful.

Priority: user instructions > Superpowers process gates > Codex execution > gemini-agent advice.
Codex remains responsible for edits, tests, commits, and final claims.
Recursion guard: do not call gemini-agent only to review a gemini-agent response unless the user explicitly asks.
${END}
`;

function replaceBlock(content, block) {
  const start = content.indexOf(START);
  const end = content.indexOf(END);
  if (start !== -1 && end !== -1 && end > start) {
    return `${content.slice(0, start)}${block}${content.slice(end + END.length)}`.replace(/\n{3,}/g, "\n\n");
  }
  return `${content.replace(/\s*$/, "")}\n\n${block}`;
}

async function readExisting(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

export async function planCodexGlobalInstall({ home, mode = "active" } = {}) {
  if (mode !== "active") throw new Error("Only active mode is supported.");
  const targetPath = join(home, ".codex", "AGENTS.md");
  const currentContent = await readExisting(targetPath);
  const nextContent = replaceBlock(currentContent, ACTIVE_POLICY_BLOCK);
  return {
    targetPath,
    currentContent,
    nextContent,
    changed: currentContent !== nextContent,
  };
}

export async function applyCodexGlobalInstall({ home, mode = "active", write = false, now = new Date() } = {}) {
  const plan = await planCodexGlobalInstall({ home, mode });
  if (!write || !plan.changed) return { ...plan, backupPath: null };
  await mkdir(join(home, ".codex", "backups"), { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const backupPath = join(home, ".codex", "backups", `AGENTS.md.${stamp}.${randomUUID()}.bak`);
  await writeFile(backupPath, plan.currentContent, { mode: 0o600 });
  const tmpPath = `${plan.targetPath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmpPath, plan.nextContent, { mode: 0o600 });
  await rename(tmpPath, plan.targetPath);
  return { ...plan, backupPath };
}
```

- [ ] **Step 4: Wire CLI**

In `src/cli.mjs`, import `applyCodexGlobalInstall`. Add usage:

```js
"  gemini-agent install-codex-global --mode active [--dry-run|--write]",
```

Add parser:

```js
function parseGlobalInstallOptions(args) {
  const options = { mode: "active", write: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--mode") {
      options.mode = args[++index];
    } else if (arg === "--write") {
      options.write = true;
    } else if (arg === "--dry-run") {
      options.write = false;
    } else {
      throw new Error(`Unknown install-codex-global argument: ${arg}`);
    }
  }
  return options;
}
```

In `main()` command routing:

```js
if (command === "install-codex-global") {
  const options = parseGlobalInstallOptions(args);
  const result = await applyCodexGlobalInstall({ home: process.env.HOME, mode: options.mode, write: options.write });
  output.write(`${JSON.stringify({ changed: result.changed, targetPath: result.targetPath, backupPath: result.backupPath, dry_run: !options.write }, null, 2)}\n`);
  return;
}
```

- [ ] **Step 5: Run tests**

Run:

```bash
cd /Users/yhryzy/dev/gemini-agent
node --test test/codex-global-install.test.mjs test/cli.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit global installer**

```bash
cd /Users/yhryzy/dev/gemini-agent
git add src/codex-global-install.mjs src/cli.mjs test/codex-global-install.test.mjs test/cli.test.mjs
git commit -m "feat: add active codex global installer"
```

### Task 7: Frontend Admin Dashboard

**Files:**
- Create: `/Users/yhryzy/dev/vulca-platform/wenxin-moyun/src/services/geminiAgentTelemetry.service.ts`
- Create: `/Users/yhryzy/dev/vulca-platform/wenxin-moyun/src/pages/admin/GeminiAgentTelemetryPage.tsx`
- Modify: `/Users/yhryzy/dev/vulca-platform/wenxin-moyun/src/App.tsx`
- Test: `/Users/yhryzy/dev/vulca-platform/wenxin-moyun/src/__tests__/services/geminiAgentTelemetry.service.test.ts`
- Test: `/Users/yhryzy/dev/vulca-platform/wenxin-moyun/src/__tests__/pages/GeminiAgentTelemetryPage.test.tsx`

- [ ] **Step 1: Write service tests**

Create `/Users/yhryzy/dev/vulca-platform/wenxin-moyun/src/__tests__/services/geminiAgentTelemetry.service.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import apiClient from '../../services/api';
import { getTelemetryMetrics, listTelemetryDeployments, listTelemetryEvents, revealTelemetryEvent } from '../../services/geminiAgentTelemetry.service';

vi.mock('../../services/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

describe('geminiAgentTelemetry service', () => {
  it('fetches metrics from the telemetry endpoint', async () => {
    vi.mocked(apiClient.get).mockResolvedValueOnce({ data: { ok: true, event_count: 1 } });
    await expect(getTelemetryMetrics()).resolves.toEqual({ ok: true, event_count: 1 });
    expect(apiClient.get).toHaveBeenCalledWith('/gemini-agent/telemetry/metrics');
  });

  it('lists deployments', async () => {
    vi.mocked(apiClient.get).mockResolvedValueOnce({ data: { items: [] } });
    await expect(listTelemetryDeployments()).resolves.toEqual({ items: [] });
  });

  it('lists event previews for discovery', async () => {
    vi.mocked(apiClient.get).mockResolvedValueOnce({ data: { items: [{ event_id: 'evt' }] } });
    await expect(listTelemetryEvents()).resolves.toEqual({ items: [{ event_id: 'evt' }] });
    expect(apiClient.get).toHaveBeenCalledWith('/gemini-agent/telemetry/events');
  });

  it('reveals raw event explicitly', async () => {
    vi.mocked(apiClient.get).mockResolvedValueOnce({ data: { event_id: 'evt', raw: { prompt_raw: 'p' } } });
    await revealTelemetryEvent('evt');
    expect(apiClient.get).toHaveBeenCalledWith('/gemini-agent/telemetry/events/evt?reveal_raw=true');
  });
});
```

- [ ] **Step 2: Run service tests and verify failure**

Run:

```bash
cd /Users/yhryzy/dev/vulca-platform/wenxin-moyun
npm test -- src/__tests__/services/geminiAgentTelemetry.service.test.ts
```

Expected: FAIL because service file does not exist.

- [ ] **Step 3: Implement service**

Create `/Users/yhryzy/dev/vulca-platform/wenxin-moyun/src/services/geminiAgentTelemetry.service.ts`:

```ts
import apiClient from './api';

export interface TelemetryMetrics {
  ok: boolean;
  event_count: number;
  deployment_count: number;
  error_count: number;
}

export interface TelemetryDeployment {
  deployment_id: string;
  label: string;
  status: string;
  raw_enabled: boolean;
  retention_days: number;
  last_seen_at: string | null;
}

export interface TelemetryEventDetail {
  event_id: string;
  deployment_id: string;
  command: string;
  model: string;
  status: string;
  prompt_preview: string;
  response_preview: string;
  raw: null | {
    prompt_raw: string;
    response_raw: string;
    request_raw: unknown;
    media_manifest: unknown[];
  };
}

export interface TelemetryEventPreview {
  event_id: string;
  deployment_id: string;
  command: string;
  model: string;
  status: string;
  received_at: string | null;
  prompt_preview: string;
  response_preview: string;
}

const BASE = '/gemini-agent/telemetry';

export async function getTelemetryMetrics(): Promise<TelemetryMetrics> {
  const { data } = await apiClient.get(`${BASE}/metrics`);
  return data;
}

export async function listTelemetryDeployments(): Promise<{ items: TelemetryDeployment[] }> {
  const { data } = await apiClient.get(`${BASE}/deployments`);
  return data;
}

export async function listTelemetryEvents(): Promise<{ items: TelemetryEventPreview[] }> {
  const { data } = await apiClient.get(`${BASE}/events`);
  return data;
}

export async function revealTelemetryEvent(eventId: string): Promise<TelemetryEventDetail> {
  const { data } = await apiClient.get(`${BASE}/events/${encodeURIComponent(eventId)}?reveal_raw=true`);
  return data;
}

export async function pauseTelemetryDeployment(deploymentId: string): Promise<{ ok: boolean; status: string }> {
  const { data } = await apiClient.post(`${BASE}/deployments/${encodeURIComponent(deploymentId)}/pause`);
  return data;
}

export async function setTelemetryRetention(deploymentId: string, days: number): Promise<{ ok: boolean; retention_days: number }> {
  const { data } = await apiClient.patch(`${BASE}/deployments/${encodeURIComponent(deploymentId)}/retention?days=${days}`);
  return data;
}
```

- [ ] **Step 4: Add dashboard page**

Create `/Users/yhryzy/dev/vulca-platform/wenxin-moyun/src/pages/admin/GeminiAgentTelemetryPage.tsx`:

```tsx
import { AlertTriangle, Eye, Pause, RefreshCw, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  getTelemetryMetrics,
  listTelemetryEvents,
  listTelemetryDeployments,
  pauseTelemetryDeployment,
  revealTelemetryEvent,
  type TelemetryDeployment,
  type TelemetryEventDetail,
  type TelemetryEventPreview,
  type TelemetryMetrics,
} from '../../services/geminiAgentTelemetry.service';

export default function GeminiAgentTelemetryPage() {
  const [metrics, setMetrics] = useState<TelemetryMetrics | null>(null);
  const [deployments, setDeployments] = useState<TelemetryDeployment[]>([]);
  const [events, setEvents] = useState<TelemetryEventPreview[]>([]);
  const [selectedEventId, setSelectedEventId] = useState('');
  const [eventDetail, setEventDetail] = useState<TelemetryEventDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [nextMetrics, nextDeployments, nextEvents] = await Promise.all([
        getTelemetryMetrics(),
        listTelemetryDeployments(),
        listTelemetryEvents(),
      ]);
      setMetrics(nextMetrics);
      setDeployments(nextDeployments.items);
      setEvents(nextEvents.items);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load telemetry');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function revealRaw() {
    if (!selectedEventId.trim()) return;
    setError(null);
    try {
      setEventDetail(await revealTelemetryEvent(selectedEventId.trim()));
    } catch (err) {
      setEventDetail(null);
      setError(err instanceof Error ? err.message : 'Failed to reveal raw telemetry');
    }
  }

  async function revealRawById(eventId: string) {
    setSelectedEventId(eventId);
    setError(null);
    try {
      setEventDetail(await revealTelemetryEvent(eventId));
    } catch (err) {
      setEventDetail(null);
      setError(err instanceof Error ? err.message : 'Failed to reveal raw telemetry');
    }
  }

  async function pauseDeployment(id: string) {
    setError(null);
    try {
      await pauseTelemetryDeployment(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to pause deployment');
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-on-surface">Gemini Agent Telemetry</h1>
          <p className="text-sm text-on-surface-variant">Operational view for deployed raw telemetry and governance.</p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="inline-flex items-center gap-2 rounded-md border border-gray-300 px-3 py-2 text-sm hover:bg-surface-container-low"
        >
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          <AlertTriangle className="h-4 w-4" /> {error}
        </div>
      )}

      <section className="grid gap-3 md:grid-cols-3">
        <div className="rounded-md border border-gray-200 bg-white p-4 dark:bg-gray-900">
          <div className="text-sm text-on-surface-variant">Events</div>
          <div className="mt-2 text-3xl font-semibold">{metrics?.event_count ?? 0}</div>
        </div>
        <div className="rounded-md border border-gray-200 bg-white p-4 dark:bg-gray-900">
          <div className="text-sm text-on-surface-variant">Deployments</div>
          <div className="mt-2 text-3xl font-semibold">{metrics?.deployment_count ?? 0}</div>
        </div>
        <div className="rounded-md border border-gray-200 bg-white p-4 dark:bg-gray-900">
          <div className="text-sm text-on-surface-variant">Errors</div>
          <div className="mt-2 text-3xl font-semibold">{metrics?.error_count ?? 0}</div>
        </div>
      </section>

      <section className="rounded-md border border-gray-200 bg-white dark:bg-gray-900">
        <div className="border-b border-gray-200 p-4">
          <h2 className="text-lg font-medium">Deployments</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-on-surface-variant">
                <th className="p-3">Deployment</th>
                <th className="p-3">Status</th>
                <th className="p-3">Raw</th>
                <th className="p-3">Retention</th>
                <th className="p-3">Last Seen</th>
                <th className="p-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {deployments.map((deployment) => (
                <tr key={deployment.deployment_id} className="border-b border-gray-100">
                  <td className="p-3 font-medium">{deployment.label}</td>
                  <td className="p-3">{deployment.status}</td>
                  <td className="p-3">{deployment.raw_enabled ? 'enabled' : 'disabled'}</td>
                  <td className="p-3">{deployment.retention_days} days</td>
                  <td className="p-3">{deployment.last_seen_at || 'never'}</td>
                  <td className="p-3">
                    <button
                      type="button"
                      onClick={() => void pauseDeployment(deployment.deployment_id)}
                      className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 hover:bg-surface-container-low"
                    >
                      <Pause className="h-3.5 w-3.5" /> Pause
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-md border border-gray-200 bg-white dark:bg-gray-900">
        <div className="border-b border-gray-200 p-4">
          <h2 className="text-lg font-medium">Latest Events</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-on-surface-variant">
                <th className="p-3">Event</th>
                <th className="p-3">Command</th>
                <th className="p-3">Status</th>
                <th className="p-3">Prompt Preview</th>
                <th className="p-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.event_id} className="border-b border-gray-100">
                  <td className="p-3 font-mono text-xs">{event.event_id}</td>
                  <td className="p-3">{event.command}</td>
                  <td className="p-3">{event.status}</td>
                  <td className="max-w-md truncate p-3">{event.prompt_preview}</td>
                  <td className="p-3">
                    <button
                      type="button"
                      onClick={() => void revealRawById(event.event_id)}
                      className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 hover:bg-surface-container-low"
                    >
                      <Eye className="h-3.5 w-3.5" /> Reveal
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-md border border-gray-200 bg-white p-4 dark:bg-gray-900">
        <h2 className="text-lg font-medium">Raw Event Reveal</h2>
        <div className="mt-3 flex gap-2">
          <input
            value={selectedEventId}
            onChange={(event) => setSelectedEventId(event.target.value)}
            className="min-w-0 flex-1 rounded-md border border-gray-300 px-3 py-2"
            placeholder="event id"
          />
          <button type="button" onClick={() => void revealRaw()} className="inline-flex items-center gap-2 rounded-md bg-gray-900 px-3 py-2 text-white">
            <Eye className="h-4 w-4" /> Reveal
          </button>
        </div>
        {eventDetail?.raw && (
          <pre className="mt-4 max-h-80 overflow-auto rounded-md bg-gray-950 p-3 text-xs text-gray-100">{JSON.stringify(eventDetail.raw, null, 2)}</pre>
        )}
        <p className="mt-3 flex items-center gap-2 text-xs text-on-surface-variant">
          <ShieldCheck className="h-3.5 w-3.5" /> Raw reveal is audited by the backend.
        </p>
      </section>

      {loading && <p className="text-sm text-on-surface-variant">Loading telemetry...</p>}
    </div>
  );
}
```

- [ ] **Step 5: Add dashboard page tests**

Create `/Users/yhryzy/dev/vulca-platform/wenxin-moyun/src/__tests__/pages/GeminiAgentTelemetryPage.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GeminiAgentTelemetryPage from '../../pages/admin/GeminiAgentTelemetryPage';
import {
  getTelemetryMetrics,
  listTelemetryDeployments,
  listTelemetryEvents,
  pauseTelemetryDeployment,
  revealTelemetryEvent,
} from '../../services/geminiAgentTelemetry.service';

vi.mock('../../services/geminiAgentTelemetry.service', () => ({
  getTelemetryMetrics: vi.fn(),
  listTelemetryDeployments: vi.fn(),
  listTelemetryEvents: vi.fn(),
  pauseTelemetryDeployment: vi.fn(),
  revealTelemetryEvent: vi.fn(),
}));

const metrics = {
  ok: true,
  event_count: 42,
  deployment_count: 2,
  error_count: 1,
};

const deployments = {
  items: [{
    deployment_id: 'deployment-test-1',
    label: 'Local Mac',
    status: 'active',
    raw_enabled: true,
    retention_days: 30,
    last_seen_at: '2026-05-31T10:00:00Z',
  }],
};

const events = {
  items: [{
    event_id: 'event-test-1',
    deployment_id: 'deployment-test-1',
    command: 'context-pack',
    model: 'gemini-3.5-flash',
    status: 'success',
    received_at: '2026-05-31T10:00:00Z',
    prompt_preview: 'summarize this project',
    response_preview: 'compact summary',
  }],
};

describe('GeminiAgentTelemetryPage', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getTelemetryMetrics).mockResolvedValue(metrics);
    vi.mocked(listTelemetryDeployments).mockResolvedValue(deployments);
    vi.mocked(listTelemetryEvents).mockResolvedValue(events);
    vi.mocked(pauseTelemetryDeployment).mockResolvedValue({ ok: true, status: 'paused' });
    vi.mocked(revealTelemetryEvent).mockResolvedValue({
      event_id: 'event-test-1',
      deployment_id: 'deployment-test-1',
      command: 'context-pack',
      model: 'gemini-3.5-flash',
      status: 'success',
      prompt_preview: 'summarize this project',
      response_preview: 'compact summary',
      raw: {
        prompt_raw: 'summarize this project',
        response_raw: 'compact summary',
        request_raw: { contents: 'prompt' },
        media_manifest: [],
      },
    });
  });

  it('renders metrics, deployments, and event previews', async () => {
    render(<GeminiAgentTelemetryPage />);
    expect(await screen.findByRole('heading', { name: 'Gemini Agent Telemetry' })).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('Local Mac')).toBeInTheDocument();
    expect(screen.getByText('summarize this project')).toBeInTheDocument();
  });

  it('reveals raw telemetry from the manual event input', async () => {
    const user = userEvent.setup();
    render(<GeminiAgentTelemetryPage />);
    await screen.findByText('Local Mac');
    await user.type(screen.getByPlaceholderText('event id'), 'event-test-1');
    const revealButtons = screen.getAllByRole('button', { name: /reveal/i });
    await user.click(revealButtons[revealButtons.length - 1]);
    await waitFor(() => expect(revealTelemetryEvent).toHaveBeenCalledWith('event-test-1'));
    expect(await screen.findByText(/compact summary/)).toBeInTheDocument();
  });

  it('shows an error when raw reveal fails', async () => {
    vi.mocked(revealTelemetryEvent).mockRejectedValueOnce(new Error('raw access denied'));
    const user = userEvent.setup();
    render(<GeminiAgentTelemetryPage />);
    await screen.findByText('Local Mac');
    await user.type(screen.getByPlaceholderText('event id'), 'event-test-1');
    const revealButtons = screen.getAllByRole('button', { name: /reveal/i });
    await user.click(revealButtons[revealButtons.length - 1]);
    expect(await screen.findByText('raw access denied')).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Wire route**

Modify `/Users/yhryzy/dev/vulca-platform/wenxin-moyun/src/App.tsx`:

```tsx
const GeminiAgentTelemetryPage = lazy(() => import('./pages/admin/GeminiAgentTelemetryPage'));
```

Import `RequireAdmin`:

```tsx
import RequireAdmin from './components/common/RequireAdmin';
```

Add route inside `<Route element={<Layout />}>`:

```tsx
<Route
  path="/admin/gemini-agent"
  element={
    <RequireAdmin>
      <LazyRoute component={GeminiAgentTelemetryPage} text="Loading Gemini Agent..." />
    </RequireAdmin>
  }
/>
```

- [ ] **Step 7: Run frontend tests and build**

Run:

```bash
cd /Users/yhryzy/dev/vulca-platform/wenxin-moyun
npm test -- src/__tests__/services/geminiAgentTelemetry.service.test.ts src/__tests__/pages/GeminiAgentTelemetryPage.test.tsx
npm run type-check
npm run build
```

Expected: all pass.

- [ ] **Step 8: Commit frontend dashboard**

```bash
cd /Users/yhryzy/dev/vulca-platform
git add wenxin-moyun/src/services/geminiAgentTelemetry.service.ts wenxin-moyun/src/pages/admin/GeminiAgentTelemetryPage.tsx wenxin-moyun/src/App.tsx wenxin-moyun/src/__tests__/services/geminiAgentTelemetry.service.test.ts wenxin-moyun/src/__tests__/pages/GeminiAgentTelemetryPage.test.tsx
git commit -m "feat: add gemini agent telemetry dashboard"
```

### Task 8: Release Validation And Documentation

**Files:**
- Modify: `/Users/yhryzy/dev/gemini-agent/README.md`
- Modify: `/Users/yhryzy/dev/vulca-platform/wenxin-backend/README.md`
- Modify: `/Users/yhryzy/dev/vulca-platform/wenxin-moyun/src/config/version.ts` only if the project requires a visible version bump.
- Optional create: `/Users/yhryzy/dev/gemini-agent/docs/release/gemini-agent-productization.md`

- [ ] **Step 1: Update gemini-agent README commands**

Add these commands under the telemetry section:

```bash
gemini-agent telemetry install-scheduler --target launchd --name gemini-agent-main --schedule daily@09:00 --env-file ~/.gemini-agent/telemetry.env --dry-run
gemini-agent telemetry scheduler-status --target launchd --name gemini-agent-main
gemini-agent telemetry uninstall-scheduler --target launchd --name gemini-agent-main
gemini-agent install-codex-global --mode active --dry-run
gemini-agent install-codex-global --mode active --write
```

Add safety notes:

```markdown
- Scheduler files never store `GEMINI_API_KEY` or telemetry tokens directly.
- macOS launchd activation defaults to `gui/<uid>` and can use `--launchd-domain user` for headless or SSH sessions.
- Non-loopback telemetry endpoints require HTTPS.
- Global active install is dry-run by default and writes a backup before changing global Codex instructions.
- Release validation blocks if the configured allowed model list rejects the active `gemini-3.5-flash` model ID or the provider no longer accepts it.
```

- [ ] **Step 2: Update backend README**

Add:

```markdown
## Gemini Agent Telemetry

The backend exposes `/api/v1/gemini-agent/telemetry` for raw telemetry ingestion and admin governance.

Required environment:

Set `GEMINI_AGENT_TELEMETRY_TOKENS=deployment-id:token`.
Optionally set `GEMINI_AGENT_ALLOWED_MODELS=gemini-3.5-flash`; when omitted, the backend allows only `gemini-3.5-flash`.

Ingest uses deployment bearer tokens. Admin reads and governance actions use normal admin JWT authentication. Raw payload retention defaults to 30 days; metadata retention defaults to 180 days.
```

- [ ] **Step 3: Run cross-repo checks**

Run:

```bash
cd /Users/yhryzy/dev/gemini-agent
npm test

cd /Users/yhryzy/dev/vulca-platform/wenxin-backend
pytest tests/test_gemini_agent_telemetry_api.py -q
alembic upgrade head

cd /Users/yhryzy/dev/vulca-platform/wenxin-moyun
npm run type-check
npm test -- src/__tests__/services/geminiAgentTelemetry.service.test.ts src/__tests__/pages/GeminiAgentTelemetryPage.test.tsx
npm run build
```

Expected: all pass.

- [ ] **Step 4: Run Gemini diff reviews**

Run from each repo:

```bash
cd /Users/yhryzy/dev/gemini-agent
git diff main...HEAD | ./bin/gemini-agent diff-review --stdin

cd /Users/yhryzy/dev/vulca-platform
git diff main...HEAD | /Users/yhryzy/dev/gemini-agent/bin/gemini-agent diff-review --stdin
```

Expected: structured JSON verdict is `pass` or `caution` with no blocking findings. Address blocking findings before release.

- [ ] **Step 5: Commit docs and release validation notes**

```bash
cd /Users/yhryzy/dev/gemini-agent
git add README.md docs/release/gemini-agent-productization.md
git commit -m "docs: document gemini agent productization"

cd /Users/yhryzy/dev/vulca-platform
git add wenxin-backend/README.md wenxin-moyun/src/config/version.ts
git commit -m "docs: document gemini agent telemetry operations"
```

If `docs/release/gemini-agent-productization.md` or `version.ts` was not created or modified, omit that path from `git add`.

## Final Verification

Run:

```bash
cd /Users/yhryzy/dev/gemini-agent
npm test
git status --short

cd /Users/yhryzy/dev/vulca-platform/wenxin-backend
pytest tests/test_gemini_agent_telemetry_api.py -q
alembic upgrade head
git status --short

cd /Users/yhryzy/dev/vulca-platform/wenxin-moyun
npm run type-check
npm test -- src/__tests__/services/geminiAgentTelemetry.service.test.ts src/__tests__/pages/GeminiAgentTelemetryPage.test.tsx
npm run build
git status --short
```

Expected:

- `gemini-agent` tests pass.
- Backend telemetry tests pass.
- Backend migrations are at head.
- Frontend service tests, page tests, type-check, and build pass.
- Only intentional commits remain; no generated `.superpowers/`, `.gemini-agent/`, build output, raw telemetry, or secret files are staged.

## Implementation Notes

- The default allowed model list remains `gemini-3.5-flash` because this is the current project decision. If live validation fails, stop and ask the user for a new model decision instead of silently changing the model.
- Keep `.superpowers/` visual brainstorming files untracked.
- Do not commit telemetry raw data, scheduler env files, backups containing user config, or generated local artifacts.
- Prefer small commits exactly as task boundaries above.
