import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { appendFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  normalizeTelemetryBatch,
  normalizeTelemetryReceiverAck,
  normalizeTelemetryReceiverMetrics,
} from "./telemetry-schemas.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const DEFAULT_MAX_RAW_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const CLOCK_SKEW_WARNING_MS = 60 * 60 * 1000;
const CORRECTION_COMMAND = "artifact-review-backfill-correction";
const CORRECTION_VERSION_PATTERN = /^[A-Za-z0-9._-]{1,48}$/;
const TOP_CORRECTION_VERSION_LIMIT = 10;

function utcNow() {
  return new Date().toISOString();
}

function jsonResponse(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function textResponse(response, status, value, contentType = "text/plain; charset=utf-8") {
  response.writeHead(status, { "Content-Type": contentType });
  response.end(value);
}

function assertByteLimit(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a nonnegative integer.`);
  }
}

function authMatches(header, token) {
  if (typeof token !== "string" || token.length === 0) return false;
  if (typeof header !== "string") return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  const supplied = header.slice(prefix.length);
  const suppliedBuffer = Buffer.from(supplied);
  const tokenBuffer = Buffer.from(token);
  if (suppliedBuffer.length !== tokenBuffer.length) return false;
  return timingSafeEqual(suppliedBuffer, tokenBuffer);
}

function isLoopbackAddress(address) {
  return address === "127.0.0.1"
    || address === "::1"
    || address === "::ffff:127.0.0.1";
}

function isAuthorized(request, { token, allowUnauthenticatedLoopback }) {
  if (allowUnauthenticatedLoopback && isLoopbackAddress(request.socket.remoteAddress)) return true;
  return authMatches(request.headers.authorization, token);
}

async function readBody(request, maxBodyBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBodyBytes) {
      request.resume();
      const error = new Error(`Request body exceeds ${maxBodyBytes} bytes.`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function openDatabase(storage) {
  try {
    const db = new DatabaseSync(join(storage, "telemetry-receiver.sqlite"));
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec(`
      CREATE TABLE IF NOT EXISTS batches (
        batch_id TEXT PRIMARY KEY,
        deployment_id TEXT NOT NULL,
        received_at TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        event_count INTEGER NOT NULL,
        clock_skew_warning INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,
        received_at TEXT NOT NULL,
        command TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        FOREIGN KEY (batch_id) REFERENCES batches(batch_id)
      );
    `);
    ensureEventColumns(db);
    return db;
  } catch (error) {
    throw new Error(`Failed to initialize telemetry receiver SQLite database in ${storage}: ${error.message}`, {
      cause: error,
    });
  }
}

function ensureEventColumns(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(events)").all().map((column) => column.name));
  const requiredColumns = [
    ["correction_for_event_id", "TEXT"],
    ["correction_version", "TEXT"],
    ["media_item_count", "INTEGER NOT NULL DEFAULT 0"],
    ["media_byte_count", "INTEGER NOT NULL DEFAULT 0"],
    ["media_items_with_mime", "INTEGER NOT NULL DEFAULT 0"],
    ["media_items_with_byte_size", "INTEGER NOT NULL DEFAULT 0"],
  ];
  for (const [name, definition] of requiredColumns) {
    if (!columns.has(name)) {
      db.exec(`ALTER TABLE events ADD COLUMN ${name} ${definition}`);
    }
  }
}

function safeNonnegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function safeCorrectionVersion(value) {
  return typeof value === "string" && CORRECTION_VERSION_PATTERN.test(value) ? value : "unknown";
}

function correctionColumns(event) {
  if (event.command !== CORRECTION_COMMAND) {
    return {
      correction_for_event_id: null,
      correction_version: null,
      media_item_count: 0,
      media_byte_count: 0,
      media_items_with_mime: 0,
      media_items_with_byte_size: 0,
    };
  }

  const multimodal = Array.isArray(event.payload?.multimodal) ? event.payload.multimodal : [];
  const correctionForEventId = typeof event.metadata?.correction_for_event_id === "string"
    && event.metadata.correction_for_event_id.trim()
    ? event.metadata.correction_for_event_id
    : null;
  return {
    correction_for_event_id: correctionForEventId,
    correction_version: safeCorrectionVersion(event.metadata?.correction_version),
    media_item_count: multimodal.length,
    media_byte_count: multimodal.reduce((sum, item) => sum + safeNonnegativeInteger(item?.byte_size), 0),
    media_items_with_mime: multimodal.filter((item) => (
      typeof item?.mime_type === "string" && item.mime_type.trim()
    )).length,
    media_items_with_byte_size: multimodal.filter((item) => (
      Number.isInteger(item?.byte_size) && item.byte_size >= 0
    )).length,
  };
}

function insertBatch(db, batch, receivedAt, clockSkewWarning) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const batchResult = db.prepare(`
      INSERT INTO batches (batch_id, deployment_id, received_at, sent_at, event_count, clock_skew_warning)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(batch_id) DO NOTHING
    `).run(
      batch.batch_id,
      batch.deployment_id,
      receivedAt,
      batch.sent_at,
      batch.events.length,
      clockSkewWarning ? 1 : 0,
    );

    const insertEvent = db.prepare(`
      INSERT INTO events (
        event_id,
        batch_id,
        received_at,
        command,
        model,
        status,
        correction_for_event_id,
        correction_version,
        media_item_count,
        media_byte_count,
        media_items_with_mime,
        media_items_with_byte_size
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(event_id) DO NOTHING
    `);
    let insertedEvents = 0;
    for (const event of batch.events) {
      const correction = correctionColumns(event);
      const eventResult = insertEvent.run(
        event.event_id,
        batch.batch_id,
        receivedAt,
        event.command,
        event.model,
        event.status,
        correction.correction_for_event_id,
        correction.correction_version,
        correction.media_item_count,
        correction.media_byte_count,
        correction.media_items_with_mime,
        correction.media_items_with_byte_size,
      );
      insertedEvents += Number(eventResult.changes);
    }

    if (Number(batchResult.changes) === 1 && insertedEvents === 0) {
      db.prepare("DELETE FROM batches WHERE batch_id = ?").run(batch.batch_id);
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The original insert failure is more useful to callers.
    }
    throw error;
  }
}

async function appendRawBatch(storage, batch, receivedAt) {
  const rawDir = join(storage, "raw");
  await mkdir(rawDir, { recursive: true, mode: 0o700 });
  const date = receivedAt.slice(0, 10);
  await appendFile(join(rawDir, `${date}.jsonl`), `${JSON.stringify(batch)}\n`, { mode: 0o600 });
}

async function rawFiles(storage) {
  const rawDir = join(storage, "raw");
  try {
    const entries = await readdir(rawDir, { withFileTypes: true });
    const files = await Promise.all(entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map(async (entry) => {
        const path = join(rawDir, entry.name);
        const info = await stat(path);
        return { path, size: info.size, mtimeMs: info.mtimeMs, name: entry.name };
      }));
    return files.sort((left, right) => left.name.localeCompare(right.name) || left.mtimeMs - right.mtimeMs);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

async function pruneRawStorage(storage, maxRawBytes) {
  let files = await rawFiles(storage);
  let total = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files) {
    if (total <= maxRawBytes) break;
    await rm(file.path, { force: true });
    total -= file.size;
  }
}

function currentMetrics(db) {
  const totals = db.prepare(`
    SELECT
      COUNT(*) AS received_events,
      COALESCE(SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END), 0) AS success,
      COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS error
    FROM events
  `).get();
  const batches = db.prepare(`
    SELECT
      COUNT(*) AS received_batches,
      MAX(received_at) AS last_received_at,
      SUM(clock_skew_warning) AS clock_skew_warnings
    FROM batches
  `).get();
  const lastBatch = db.prepare(`
    SELECT batch_id FROM batches ORDER BY received_at DESC, rowid DESC LIMIT 1
  `).get();
  const latestEvent = db.prepare(`
    SELECT received_at, batch_id, command, model, status
    FROM events
    ORDER BY received_at DESC, rowid DESC
    LIMIT 1
  `).get();
  const corrections = db.prepare(`
    SELECT
      COUNT(*) AS event_count,
      COUNT(DISTINCT correction_for_event_id) AS corrected_original_event_count,
      COALESCE(SUM(media_item_count), 0) AS media_item_count,
      COALESCE(SUM(media_byte_count), 0) AS media_byte_count,
      COALESCE(SUM(media_items_with_mime), 0) AS media_items_with_mime,
      COALESCE(SUM(media_items_with_byte_size), 0) AS media_items_with_byte_size
    FROM events
    WHERE command = ?
  `).get(CORRECTION_COMMAND);
  const correctionVersions = db.prepare(`
    SELECT
      COALESCE(correction_version, 'unknown') AS correction_version,
      COUNT(*) AS event_count,
      COUNT(DISTINCT correction_for_event_id) AS corrected_original_event_count,
      COALESCE(SUM(media_item_count), 0) AS media_item_count,
      COALESCE(SUM(media_byte_count), 0) AS media_byte_count
    FROM events
    WHERE command = ?
    GROUP BY COALESCE(correction_version, 'unknown')
    ORDER BY event_count DESC, media_item_count DESC, correction_version ASC
    LIMIT ?
  `).all(CORRECTION_COMMAND, TOP_CORRECTION_VERSION_LIMIT);

  return normalizeTelemetryReceiverMetrics({
    ok: true,
    received_events: Number(totals.received_events),
    received_batches: Number(batches.received_batches),
    last_received_at: batches.last_received_at ?? null,
    last_batch_id: lastBatch?.batch_id ?? null,
    latest_event: latestEvent ? {
      received_at: latestEvent.received_at,
      batch_id: latestEvent.batch_id,
      command: latestEvent.command,
      model: latestEvent.model,
      status: latestEvent.status,
    } : null,
    status_counts: {
      success: Number(totals.success),
      error: Number(totals.error),
    },
    clock_skew_warnings: Number(batches.clock_skew_warnings ?? 0),
    corrections: {
      event_count: Number(corrections.event_count),
      corrected_original_event_count: Number(corrections.corrected_original_event_count),
      media_item_count: Number(corrections.media_item_count),
      media_byte_count: Number(corrections.media_byte_count),
      media_items_with_mime: Number(corrections.media_items_with_mime),
      media_items_with_byte_size: Number(corrections.media_items_with_byte_size),
      top_versions: correctionVersions.map((version) => ({
        correction_version: version.correction_version,
        event_count: Number(version.event_count),
        corrected_original_event_count: Number(version.corrected_original_event_count),
        media_item_count: Number(version.media_item_count),
        media_byte_count: Number(version.media_byte_count),
      })),
    },
  });
}

function escapeHtml(value) {
  return `${value}`.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[char]);
}

function dashboardHtml(metrics) {
  const correctionVersionRows = metrics.corrections.top_versions.length
    ? metrics.corrections.top_versions.map((item) => (
      `<li>${escapeHtml(item.correction_version)}: ${item.event_count} events, ${item.media_item_count} media items</li>`
    )).join("")
    : "<li>None</li>";
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Telemetry Receiver</title></head>
<body>
<h1>Telemetry Receiver</h1>
<h2>Corrections</h2>
<ul>
<li>Correction events: ${metrics.corrections.event_count}</li>
<li>Corrected original events: ${metrics.corrections.corrected_original_event_count}</li>
<li>Correction media items: ${metrics.corrections.media_item_count}</li>
${correctionVersionRows}
</ul>
<pre>${escapeHtml(JSON.stringify(metrics, null, 2))}</pre>
</body>
</html>`;
}

export function createTelemetryReceiver({
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  storage,
  token,
  allowUnauthenticatedLoopback = false,
  maxRawBytes = DEFAULT_MAX_RAW_BYTES,
  maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
} = {}) {
  if (typeof storage !== "string" || storage.length === 0) {
    throw new Error("Telemetry receiver storage must be a non-empty path.");
  }
  assertByteLimit(maxRawBytes, "maxRawBytes");
  assertByteLimit(maxBodyBytes, "maxBodyBytes");

  let db;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);

      if (request.method === "GET" && url.pathname === "/health") {
        jsonResponse(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && url.pathname === "/ingest") {
        textResponse(response, 200, "POST /ingest with a strict gemini-agent telemetry batch JSON body.\n");
        return;
      }

      if ((url.pathname === "/metrics" || url.pathname === "/dashboard")
        && !isAuthorized(request, { token, allowUnauthenticatedLoopback })) {
        jsonResponse(response, 401, { ok: false, error: "Unauthorized" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/metrics") {
        jsonResponse(response, 200, currentMetrics(db));
        return;
      }

      if (request.method === "GET" && url.pathname === "/dashboard") {
        textResponse(response, 200, dashboardHtml(currentMetrics(db)), "text/html; charset=utf-8");
        return;
      }

      if (request.method === "POST" && url.pathname === "/ingest") {
        if (!isAuthorized(request, { token, allowUnauthenticatedLoopback })) {
          jsonResponse(response, 401, { ok: false, error: "Unauthorized" });
          return;
        }

        let parsed;
        try {
          parsed = JSON.parse(await readBody(request, maxBodyBytes));
        } catch (error) {
          if (error.statusCode === 413) {
            jsonResponse(response, 413, { ok: false, error: "Request body too large" });
          } else {
            jsonResponse(response, 400, { ok: false, error: "Invalid JSON body" });
          }
          return;
        }

        let batch;
        try {
          batch = normalizeTelemetryBatch(parsed);
        } catch (error) {
          jsonResponse(response, 400, { ok: false, error: `Invalid telemetry batch: ${error.message}` });
          return;
        }

        const receivedAt = utcNow();
        const clockSkewWarning = Math.abs(Date.parse(batch.sent_at) - Date.parse(receivedAt)) > CLOCK_SKEW_WARNING_MS;
        insertBatch(db, batch, receivedAt, clockSkewWarning);
        await appendRawBatch(storage, batch, receivedAt);
        await pruneRawStorage(storage, maxRawBytes);

        jsonResponse(response, 200, normalizeTelemetryReceiverAck({
          ok: true,
          batch_id: batch.batch_id,
          received_count: batch.events.length,
          received_at: receivedAt,
        }));
        return;
      }

      jsonResponse(response, 404, { ok: false, error: "Not found" });
    } catch (error) {
      jsonResponse(response, 500, { ok: false, error: error.message });
    }
  });

  async function start() {
    await mkdir(storage, { recursive: true, mode: 0o700 });
    db = openDatabase(storage);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    return server.address();
  }

  async function stop() {
    await new Promise((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    if (db) {
      db.close();
      db = undefined;
    }
  }

  return { server, start, stop };
}
