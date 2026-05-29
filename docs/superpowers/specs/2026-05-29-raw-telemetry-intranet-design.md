# Raw Telemetry Intranet Validation Design

## Goal

Build a v1 raw telemetry validation loop for `gemini-agent` that captures raw prompt/response data, stores it locally, actively flushes it to an intranet receiver, and verifies the monitoring data path end to end before any future `vulcaart.art` public endpoint rollout.

## Product Context

`gemini-agent` is now a Gemini-powered coprocessor for Codex. The next product need is to learn how deployed agents are used so the product can improve. For v1, the user requirement is explicit: raw `prompt` and raw `response` must be captured because they are necessary product data.

The first deployment target is intranet/local validation:

```text
http://127.0.0.1:8787/ingest
```

The future public target can reuse the same ingestion protocol behind:

```text
https://vulcaart.art/api/gemini-agent/telemetry/ingest
```

## Non-Negotiable Boundaries

- Raw telemetry mode is explicit. It requires `--level raw` and `--confirm-raw-content`.
- Raw telemetry captures prompt and response text without summarization or semantic rewriting, subject to size caps, truncation metadata, and mandatory masking of obvious credential patterns such as API keys, bearer tokens, and authorization headers.
- v1 does not upload binary image/PDF/video bodies. Multimodal inputs are recorded as metadata: MIME type, byte size, filename basename, and optional content hash.
- v1 is intranet-first. The default receiver endpoint is `http://127.0.0.1:8787/ingest`.
- Plain HTTP is allowed only for loopback endpoints (`127.0.0.1`, `localhost`, `::1`). Any non-loopback endpoint must use HTTPS.
- v1 must not reuse the Gemini API key for telemetry ingestion. Receiver auth uses a separate telemetry token.
- The telemetry capture hook must not await disk or network I/O on the main Gemini call path. It hands the event to an in-memory writer queue, then a background async writer persists the event. Before the CLI process exits, it drains the writer queue with a short bounded timeout so captured events are not silently lost. Capture errors are caught and must not fail the Gemini call.
- The in-memory writer queue is bounded. If it reaches its configured item or byte limit, v1 drops oldest unsaved telemetry events and increments `dropped_memory_count`.
- Time is stored as UTC ISO 8601 strings.
- Public `vulcaart.art` ingestion is out of implementation scope for v1, but the endpoint path and protocol must be compatible.

## Scheduling Semantics

The system records scheduled attempts and delayed delivery, but delivery is best-effort while the sender machine is offline or powered off.

Each batch carries:

- `scheduled_for`: when the agent intended to send the batch.
- `sent_at`: when the sender actually sent it.
- `received_at`: when the receiver accepted it.

If the machine is off, offline, or the receiver is down:

1. The sender leaves events in the local durable queue.
2. The next `telemetry tick`, `telemetry flush`, or scheduled wake attempts delivery again.
3. The receiver stores both original event timestamps and delayed receipt timestamps.

## Architecture

```text
Gemini command / MCP tool
  -> telemetry capture hook
  -> local durable queue
  -> telemetry tick / flush / validate command
  -> POST /ingest on local receiver
  -> receiver JSONL archive
  -> receiver SQLite index
  -> /health, /metrics, /dashboard
```

### Client Components

#### Telemetry Configuration

Stored under:

```text
.gemini-agent/telemetry/config.json
```

Shape:

```json
{
  "enabled": true,
  "level": "raw",
  "endpoint": "http://127.0.0.1:8787/ingest",
  "token_env": "GEMINI_AGENT_TELEMETRY_TOKEN",
  "schedule": "daily@09:00",
  "max_event_bytes": 1048576,
  "max_queue_bytes": 52428800,
  "created_at": "2026-05-29T00:00:00.000Z",
  "updated_at": "2026-05-29T00:00:00.000Z"
}
```

#### Event Capture

`gemini-agent` records events around Gemini calls:

```json
{
  "schema_version": 1,
  "event_id": "evt_...",
  "trace_id": "trace_...",
  "deployment_id": "dep_...",
  "project_id": "gemini-agent",
  "source": "cli",
  "command": "context-pack",
  "model": "gemini-3.5-flash",
  "prompt": "raw prompt text",
  "response": "raw response text",
  "status": "success",
  "error_type": null,
  "latency_ms": 1200,
  "created_at": "2026-05-29T09:00:00.000Z",
  "payload": {
    "prompt_truncated": false,
    "response_truncated": false,
    "multimodal": []
  }
}
```

Capture points:

- `generateText` for `ask`.
- `generateJson` for structured review, context-pack, and artifact-review calls.
- MCP tool calls through the same Gemini client functions.

#### Local Queue

Events are stored as one durable JSON file per event:

```text
.gemini-agent/telemetry/queue/
  pending/
    evt_abc.json
  inflight/
    batch_xyz/
      evt_abc.json
  sent/
    2026-05-29/
      evt_abc.json
```

Queue rules:

- Event writes use temp-file plus atomic rename into `pending/`; there is no shared append file in the client queue.
- Telemetry directories are created with `0700` permissions and event/config files with `0600` permissions.
- `flush` and `tick` acquire a queue lockfile before scanning or claiming pending files.
- The lockfile is created with exclusive create semantics and contains PID plus creation timestamp; stale locks older than the configured timeout can be removed.
- Stale lock recovery uses a conservative CLI timeout, defaulting to 30 seconds, and logs a warning before reclaiming the lock.
- A reclaiming process moves claimed files only after acquiring a fresh lock, so a resumed old process cannot continue claiming files without rechecking ownership.
- `flush` claims events by atomically renaming selected pending files into an `inflight/<batch-id>/` directory while the lock is held.
- A successful receiver ACK moves or deletes sent events according to retention config.
- Receiver failure moves inflight events back to `pending/`.
- `sent/` retention is bounded by default: keep at most 7 days or 100 MB, whichever limit is reached first.
- `max_queue_bytes` protects disk usage. Queue size is tracked in state and reconciled during flush/prune so event writes do not scan the whole queue directory on the main path. When exceeded, v1 drops oldest pending files and increments `dropped_old_count` in state.
- Concurrent `gemini-agent` processes must not corrupt or double-send queue files because event writes are unique-file writes and flush/tick batch claiming is lockfile-protected.

Writer lifecycle rules:

- Normal Gemini commands schedule capture and continue without awaiting the disk write.
- CLI shutdown drains in-memory telemetry writes for up to 2 seconds.
- CLI registers SIGINT and SIGTERM handlers that run the same bounded drain before exiting.
- `telemetry validate` awaits its own validation event write before flushing.
- If the drain timeout expires, the command reports a telemetry warning but preserves the Gemini command result.

#### Sender

Commands:

```bash
gemini-agent telemetry enable \
  --level raw \
  --endpoint http://127.0.0.1:8787/ingest \
  --token-env GEMINI_AGENT_TELEMETRY_TOKEN \
  --schedule daily@09:00 \
  --confirm-raw-content

gemini-agent telemetry status
gemini-agent telemetry preview
gemini-agent telemetry flush
gemini-agent telemetry tick
gemini-agent telemetry validate \
  --endpoint http://127.0.0.1:8787/ingest \
  --confirm-raw-content
gemini-agent telemetry disable
gemini-agent telemetry purge
```

`telemetry tick` is the global scheduler entrypoint. It is the command that `launchd`, `systemd timer`, or `cron` calls. It checks whether the schedule is due and flushes if needed.

`telemetry validate` is the active end-to-end command. It:

1. Ensures raw telemetry config exists for the provided endpoint.
2. Calls Gemini with a fixed validation prompt using `gemini-3.5-flash`.
3. Captures the raw validation prompt and response.
4. Queues the event.
5. Flushes immediately.
6. Calls receiver `/metrics`.
7. Returns non-zero if the receiver did not record the event.

Raw-mode preflight:

- `telemetry enable --level raw` prints a warning that prompts and responses may contain credentials, personal information, source code, customer data, and other sensitive content.
- `--confirm-raw-content` is required to continue.
- Empty `GEMINI_AGENT_TELEMETRY_TOKEN` values are treated as missing.
- Raw mode applies mandatory credential masking before persistence and transmission. It masks obvious Gemini API keys, generic bearer tokens, `Authorization:` header values, and common `*_API_KEY=` / `*_TOKEN=` assignment values.
- Credential masking patterns are versioned and documented in code so they can be audited and extended.

Endpoint validation happens before raw data is read or sent:

- `http://127.0.0.1`, `http://localhost`, and `http://[::1]` are allowed for local validation.
- Any other `http://` endpoint is rejected.
- `https://` endpoints are accepted when a telemetry token is configured.
- Receiver ingestion requires a token by default, including loopback. A loopback receiver can disable auth only with explicit `--allow-unauthenticated-loopback` for throwaway local debugging.

### Receiver Components

Executable:

```bash
gemini-agent-telemetry-receiver \
  --host 127.0.0.1 \
  --port 8787 \
  --storage ./.telemetry-data
```

Routes:

```text
GET  /health
GET  /metrics
GET  /dashboard
GET  /ingest
POST /ingest
```

`GET /ingest` returns a small JSON or HTML help response so a browser opened to the route confirms that the receiver is alive. `POST /ingest` accepts telemetry batches.

Storage:

```text
.telemetry-data/
  raw/
    2026-05-29.jsonl
  telemetry.sqlite
```

The JSONL file is the raw archive. SQLite stores queryable metadata and small text columns for dashboard verification.

Receiver storage limits:

- Rotate raw JSONL files daily.
- Prune raw JSONL files older than 14 days by default.
- Prune or compact SQLite metadata older than 30 days by default.
- Enforce a receiver storage cap, defaulting to 1 GB, and reject new batches with `507 Insufficient Storage` when the cap is reached.

SQLite receiver settings:

- Enable WAL mode.
- Set a busy timeout.
- Use a single small transaction per accepted batch.
- Index `received_at`, `event_id`, `trace_id`, `command`, and `status`.

Clock handling:

- Receiver `received_at` is authoritative for ingestion timing.
- Client `created_at`, `scheduled_for`, and `sent_at` are stored as client-reported timestamps.
- Receiver computes `clock_skew_ms` as `received_at - sent_at` when possible.
- Negative or extreme skew values are preserved but marked with `clock_skew_warning: true` so dashboard metrics do not treat them as normal latency.

## Ingestion Protocol

Request:

```json
{
  "schema_version": 1,
  "batch_id": "batch_...",
  "deployment_id": "dep_...",
  "scheduled_for": "2026-05-29T09:00:00.000Z",
  "sent_at": "2026-05-29T09:00:05.000Z",
  "events": [
    {
      "event_id": "evt_...",
      "trace_id": "trace_...",
      "command": "ask",
      "model": "gemini-3.5-flash",
      "prompt": "raw prompt",
      "response": "raw response",
      "status": "success",
      "latency_ms": 1000,
      "created_at": "2026-05-29T09:00:00.000Z"
    }
  ]
}
```

Headers:

```text
Authorization: Bearer <telemetry-token>
Content-Type: application/json
```

Response:

```json
{
  "ok": true,
  "batch_id": "batch_...",
  "received_count": 1,
  "received_at": "2026-05-29T09:00:06.000Z"
}
```

For local validation, unauthenticated ingestion is available only when both conditions are true: the receiver is bound to `127.0.0.1`, `localhost`, or `::1`, and it was started with `--allow-unauthenticated-loopback`. For all other modes, `Authorization: Bearer <telemetry-token>` is required.

## Dashboard And Metrics

`GET /metrics` returns JSON:

```json
{
  "ok": true,
  "received_events": 12,
  "received_batches": 3,
  "last_received_at": "2026-05-29T09:00:06.000Z",
  "last_batch_id": "batch_...",
  "status_counts": {
    "success": 10,
    "error": 2
  }
}
```

`GET /dashboard` can be minimal HTML in v1. It must show:

- Receiver status.
- Total events.
- Total batches.
- Last received timestamp.
- Latest event command/model/status.
- Whether raw prompt/response are being stored.

## Error Handling

- Receiver unavailable: `flush` exits non-zero, preserves queue, and updates failed counters.
- Receiver 4xx: preserve queue and show exact receiver error.
- Receiver 5xx/network timeout: preserve queue and advise retry.
- Flush requests use a strict timeout, defaulting to 5 seconds.
- Invalid config: command exits before reading raw data.
- Missing telemetry token for non-local endpoint: command exits before sending.
- Missing telemetry token for a token-required receiver: command exits before sending.
- Empty telemetry token environment variable: command exits before sending.
- Non-loopback HTTP endpoint: command exits before reading raw data.
- Oversized event: truncate prompt/response to `max_event_bytes`, mark truncation flags.
- Oversized queue: drop oldest pending files, increment state counter, keep command non-blocking.
- Oversized in-memory writer queue: drop oldest unsaved telemetry events, increment `dropped_memory_count`, keep command non-blocking.
- Receiver storage cap reached: receiver returns `507 Insufficient Storage`; sender preserves the local queue and reports the receiver error.
- Filesystem write failures in the capture hook are caught and do not propagate into Gemini command execution.
- CLI exit drain timeout emits a telemetry warning but does not change the Gemini command result.

## Testing Strategy

Unit tests:

- Telemetry config parse/write.
- Raw event schema validation.
- Prompt/response truncation.
- Mandatory credential masking in raw prompt/response text.
- Versioned credential masking pattern coverage for API keys, bearer tokens, authorization headers, JSON secrets, and multiline headers.
- In-memory writer queue limits and drop-oldest behavior.
- Queue write/read/ack/preserve-on-failure.
- Queue concurrency with parallel event writes and parallel flush attempts.
- Queue lock stale-lock recovery.
- Queue `sent/` retention pruning.
- File permission enforcement for telemetry directories, config, state, and event files.
- Client-side rejection of non-loopback HTTP endpoints.
- Filesystem failures during capture: permission denied, missing directory, and simulated disk write errors.
- Capture hook does not await disk writes in the main Gemini call path.
- CLI drains pending in-memory telemetry writes before process exit with a bounded timeout.
- CLI drains pending in-memory telemetry writes on SIGINT and SIGTERM when the process can exit gracefully.
- Sender batch construction and retry behavior.
- Sender timeout behavior when the receiver accepts a connection but does not respond.
- Receiver `/health`, `GET /ingest`, `POST /ingest`, `/metrics`.
- Receiver token enforcement, explicit `--allow-unauthenticated-loopback`, and dashboard protection.
- Empty or missing telemetry token handling.
- Receiver concurrent ingestion with SQLite WAL and busy timeout.
- Receiver storage cap, JSONL rotation, and pruning.
- Clock skew marking for client timestamps far ahead of or behind receiver time.
- CLI argument parsing for telemetry commands.

Integration tests:

- Start receiver on a random local port.
- Enable raw telemetry against that receiver.
- Run `gemini-agent telemetry validate --confirm-raw-content`.
- Assert receiver metrics increased.
- Assert raw JSONL contains the validation prompt and response.
- Assert SQLite index contains event metadata.
- Stop receiver, queue an event, run `flush`, assert pending data remains.
- Restart receiver, run `flush`, assert pending data is delivered.
- Run a command that records telemetry and exits immediately, assert the exit drain persisted the event.
- Send concurrent batches to the receiver, assert all events are indexed and no `SQLITE_BUSY` response leaks.
- Fill `sent/` beyond retention thresholds, run pruning, and assert old files are removed while pending files are untouched.
- Configure an empty telemetry token env var, run `flush`, and assert nothing is sent.
- Include a fake API key and bearer token in the validation prompt, assert stored telemetry masks those credential-shaped values.
- Generate events faster than disk persistence, assert memory queue limits prevent unbounded growth and increment drop counters.
- Send a batch with a client clock two hours ahead, assert `clock_skew_warning` is present.
- Send SIGTERM to a running command after capture, assert graceful drain persists the pending event.

Manual validation:

```bash
gemini-agent-telemetry-receiver --host 127.0.0.1 --port 8787 --storage ./.telemetry-data
gemini-agent telemetry validate --endpoint http://127.0.0.1:8787/ingest --token-env GEMINI_AGENT_TELEMETRY_TOKEN --confirm-raw-content
open http://127.0.0.1:8787/dashboard
```

## Acceptance Criteria

- `npm test` passes.
- `gemini-agent telemetry validate --endpoint http://127.0.0.1:8787/ingest --token-env GEMINI_AGENT_TELEMETRY_TOKEN --confirm-raw-content` produces one raw prompt/response telemetry event and sends it to the receiver.
- Receiver `/health` returns healthy JSON.
- Receiver `GET /ingest` is browser-readable and explains that `POST /ingest` accepts batches.
- Receiver `/metrics` shows received event and batch counts.
- Receiver `/dashboard` shows latest event metadata.
- Receiver defaults to requiring a telemetry token. Tests may use `--allow-unauthenticated-loopback` only for explicit local throwaway fixtures.
- Raw mode prints a sensitive-content warning and cannot be enabled without `--confirm-raw-content`.
- Raw mode stores prompt/response text but masks obvious credential patterns before local persistence and upload.
- If receiver is down, `flush` preserves queued events.
- If receiver comes back, `flush` delivers preserved events.
- The same ingestion request shape can later be sent to `https://vulcaart.art/api/gemini-agent/telemetry/ingest`.
- Existing Gemini calls still use `gemini-3.5-flash`.
- Existing `context-pack`, `artifact-review`, `diff-review`, and MCP tests still pass.

## Out Of Scope For V1

- Public `vulcaart.art` deployment.
- Multi-tenant hosted auth.
- WAF/rate-limit configuration.
- Remote dashboard accounts.
- Automatic installer for launchd/systemd.
- Binary artifact upload.
- Differential privacy.
- Long-term retention policy enforcement beyond local test storage.

## Locked Decisions

For intranet validation, v1 will use JSONL plus SQLite indexing, localhost receiver defaults, explicit raw enablement, token-required ingestion by default, loopback-only HTTP, HTTPS for non-loopback endpoints, lockfile-protected queue flushing, strict local file permissions, bounded CLI exit draining, SQLite WAL, and a global `telemetry tick` command for scheduler integration.
