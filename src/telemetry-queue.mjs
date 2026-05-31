import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_MAX_QUEUE_BYTES,
  normalizeTelemetryEvent,
} from "./telemetry-schemas.mjs";

const TELEMETRY_ROOT = ".gemini-agent/telemetry";
const QUEUE_DIR = "queue";
const STATE_FILE = "state.json";
const LOCK_FILE = "lock";
const LOCK_GUARD_FILE = "lock.guard";
const SECURE_DIR_MODE = 0o700;
const SECURE_FILE_MODE = 0o600;
const DAY_MS = 24 * 60 * 60 * 1000;
const LOCK_GUARD_RETRIES = 500;
const LOCK_GUARD_RETRY_DELAY_MS = 2;

const DEFAULT_STATE = Object.freeze({
  dropped_old_count: 0,
  dropped_memory_count: 0,
  queue_bytes: 0,
  sent_success_count: 0,
  sent_failure_count: 0,
  last_sent_at: null,
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function utcDay(value) {
  return value.toISOString().slice(0, 10);
}

function assertNonnegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a nonnegative integer.`);
  }
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer.`);
  }
}

function normalizeState(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Telemetry queue state must be an object.");
  }
  const droppedOldCount = value.dropped_old_count ?? DEFAULT_STATE.dropped_old_count;
  const droppedMemoryCount = value.dropped_memory_count ?? DEFAULT_STATE.dropped_memory_count;
  const queueBytes = value.queue_bytes ?? DEFAULT_STATE.queue_bytes;
  const sentSuccessCount = value.sent_success_count ?? DEFAULT_STATE.sent_success_count;
  const sentFailureCount = value.sent_failure_count ?? DEFAULT_STATE.sent_failure_count;
  const nonRetryableFailureCount = value.non_retryable_failure_count ?? 0;
  const lastFailureReason = value.last_failure_reason ?? null;
  const lastSentAt = value.last_sent_at ?? DEFAULT_STATE.last_sent_at;

  assertNonnegativeInteger(droppedOldCount, "dropped_old_count");
  assertNonnegativeInteger(droppedMemoryCount, "dropped_memory_count");
  assertNonnegativeInteger(queueBytes, "queue_bytes");
  assertNonnegativeInteger(sentSuccessCount, "sent_success_count");
  assertNonnegativeInteger(sentFailureCount, "sent_failure_count");
  assertNonnegativeInteger(nonRetryableFailureCount, "non_retryable_failure_count");
  if (lastFailureReason !== null && typeof lastFailureReason !== "string") {
    throw new Error("last_failure_reason must be null or a string.");
  }
  if (lastSentAt !== null && typeof lastSentAt !== "string") {
    throw new Error("last_sent_at must be null or an ISO timestamp string.");
  }

  const normalized = {
    dropped_old_count: droppedOldCount,
    dropped_memory_count: droppedMemoryCount,
    queue_bytes: queueBytes,
    sent_success_count: sentSuccessCount,
    sent_failure_count: sentFailureCount,
  };
  if (nonRetryableFailureCount > 0 || Object.hasOwn(value, "non_retryable_failure_count")) {
    normalized.non_retryable_failure_count = nonRetryableFailureCount;
  }
  if (lastFailureReason !== null || Object.hasOwn(value, "last_failure_reason")) {
    normalized.last_failure_reason = lastFailureReason;
  }
  normalized.last_sent_at = lastSentAt;
  return normalized;
}

function assertSafeBatchId(batchId) {
  if (typeof batchId !== "string" || !/^batch_[A-Za-z0-9_.-]+$/.test(batchId)) {
    throw new Error("Telemetry batch id is invalid.");
  }
}

function queueFileName(prefix) {
  const millis = `${Date.now()}`.padStart(13, "0");
  const monotonic = `${process.hrtime.bigint()}`.padStart(20, "0");
  return `${prefix}_${millis}_${monotonic}_${randomUUID()}.json`;
}

export function telemetryQueueDirs(cwd = process.cwd()) {
  const root = join(cwd, TELEMETRY_ROOT);
  const queue = join(root, QUEUE_DIR);
  return {
    root,
    queue,
    pending: join(queue, "pending"),
    inflight: join(queue, "inflight"),
    sent: join(queue, "sent"),
    failed: join(queue, "failed"),
    tmp: join(queue, "tmp"),
    lock: join(queue, LOCK_FILE),
    state: join(queue, STATE_FILE),
  };
}

async function secureMkdir(path) {
  await mkdir(path, { recursive: true, mode: SECURE_DIR_MODE });
  await chmod(path, SECURE_DIR_MODE);
}

async function ensureQueueDirs(cwd) {
  const dirs = telemetryQueueDirs(cwd);
  for (const dir of [dirs.root, dirs.queue, dirs.pending, dirs.inflight, dirs.sent, dirs.failed, dirs.tmp]) {
    await secureMkdir(dir);
  }
  return dirs;
}

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function regularFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(dir, entry.name);
    const itemStat = await stat(path);
    files.push({
      name: entry.name,
      path,
      size: itemStat.size,
      mtimeMs: itemStat.mtimeMs,
    });
  }
  return files.sort((left, right) => (
    left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name)
  ));
}

async function sumFileSizes(files) {
  return files.reduce((sum, file) => sum + file.size, 0);
}

async function readJsonFile(path, label) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${label} is not valid JSON: ${path}`);
    }
    throw error;
  }
}

async function writeSecureJsonFile(cwd, path, value) {
  const dirs = await ensureQueueDirs(cwd);
  const tmpPath = join(dirs.tmp, `${queueFileName("tmp")}.tmp`);
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, { mode: SECURE_FILE_MODE });
  await chmod(tmpPath, SECURE_FILE_MODE);
  await rename(tmpPath, path);
  await chmod(path, SECURE_FILE_MODE);
}

async function loadStateFromPath(path) {
  const state = await readJsonFile(path, "Telemetry queue state");
  if (!state) return { ...DEFAULT_STATE };
  return normalizeState(state);
}

async function saveState(cwd, state) {
  const dirs = telemetryQueueDirs(cwd);
  await writeSecureJsonFile(cwd, dirs.state, normalizeState(state));
}

async function pendingQueueBytes(cwd) {
  const dirs = telemetryQueueDirs(cwd);
  return sumFileSizes(await regularFiles(dirs.pending));
}

function parseLockToken(raw) {
  try {
    const lock = JSON.parse(raw);
    if (!lock || typeof lock !== "object" || typeof lock.token !== "string") return null;
    return lock.token;
  } catch {
    return null;
  }
}

function sameLockIdentity(left, right) {
  return left !== null
    && right !== null
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs
    && left.raw === right.raw;
}

async function readLockIdentity(path) {
  let lockStat;
  let raw;
  try {
    raw = await readFile(path, "utf8");
    lockStat = await stat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }

  return {
    token: parseLockToken(raw),
    raw,
    dev: lockStat.dev,
    ino: lockStat.ino,
    size: lockStat.size,
    mtimeMs: lockStat.mtimeMs,
    ctimeMs: lockStat.ctimeMs,
  };
}

async function readLockToken(path) {
  return (await readLockIdentity(path))?.token ?? null;
}

function lockGuardPath(dirs) {
  return join(dirs.queue, LOCK_GUARD_FILE);
}

async function tryAcquireGuard(dirs, token) {
  const handle = await open(
    lockGuardPath(dirs),
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    SECURE_FILE_MODE,
  );
  try {
    await handle.writeFile(`${JSON.stringify({
      token,
      pid: process.pid,
      created_at: new Date().toISOString(),
    })}\n`, "utf8");
  } finally {
    await handle.close();
  }
  await chmod(lockGuardPath(dirs), SECURE_FILE_MODE);
}

async function releaseGuard(dirs, token) {
  let currentToken;
  try {
    currentToken = await readLockToken(lockGuardPath(dirs));
  } catch {
    return;
  }
  if (currentToken !== token) return;
  try {
    await unlink(lockGuardPath(dirs));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function maybeReclaimStaleGuard(dirs, staleMs) {
  const guardPath = lockGuardPath(dirs);
  const staleIdentity = await readLockIdentity(guardPath);
  if (!staleIdentity) return false;

  if (Date.now() - staleIdentity.mtimeMs < staleMs) return false;
  const currentIdentity = await readLockIdentity(guardPath);
  if (!sameLockIdentity(staleIdentity, currentIdentity)) return false;
  if (Date.now() - currentIdentity.mtimeMs < staleMs) return false;

  try {
    await unlink(guardPath);
    return true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return true;
  }
}

async function withLockUnlinkGuard(dirs, staleMs, fn) {
  const token = randomUUID();
  let lastError;
  let acquired = false;

  for (let attempt = 0; attempt <= LOCK_GUARD_RETRIES; attempt += 1) {
    try {
      await tryAcquireGuard(dirs, token);
      acquired = true;
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      lastError = error;
      if (await maybeReclaimStaleGuard(dirs, staleMs)) continue;
      if (attempt < LOCK_GUARD_RETRIES) await sleep(LOCK_GUARD_RETRY_DELAY_MS);
    }
  }

  if (acquired) {
    try {
      return await fn();
    } finally {
      await releaseGuard(dirs, token);
    }
  }

  const error = new Error(`Telemetry queue lock guard could not be acquired: ${lockGuardPath(dirs)}`);
  error.cause = lastError;
  throw error;
}

async function tryAcquireLock(dirs, token) {
  const lock = {
    token,
    pid: process.pid,
    created_at: new Date().toISOString(),
  };
  const handle = await open(dirs.lock, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, SECURE_FILE_MODE);
  try {
    await handle.writeFile(`${JSON.stringify(lock)}\n`, "utf8");
  } finally {
    await handle.close();
  }
  await chmod(dirs.lock, SECURE_FILE_MODE);
}

async function maybeReclaimStaleLock(dirs, staleMs) {
  const staleIdentity = await readLockIdentity(dirs.lock);
  if (!staleIdentity) return false;

  if (Date.now() - staleIdentity.mtimeMs < staleMs) return false;
  return withLockUnlinkGuard(dirs, staleMs, async () => {
    const currentIdentity = await readLockIdentity(dirs.lock);
    if (!sameLockIdentity(staleIdentity, currentIdentity)) return false;
    if (Date.now() - currentIdentity.mtimeMs < staleMs) return false;
    try {
      await unlink(dirs.lock);
      return true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return true;
    }
  });
}

async function releaseLock(dirs, token, staleMs) {
  await withLockUnlinkGuard(dirs, staleMs, async () => {
    let currentToken;
    try {
      currentToken = await readLockToken(dirs.lock);
    } catch {
      return;
    }
    if (currentToken !== token) return;
    try {
      await unlink(dirs.lock);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  });
}

export async function loadTelemetryState({ cwd = process.cwd() } = {}) {
  const dirs = telemetryQueueDirs(cwd);
  return loadStateFromPath(dirs.state);
}

export async function purgeTelemetryData({ cwd = process.cwd() } = {}) {
  const dirs = telemetryQueueDirs(cwd);
  await rm(dirs.root, { recursive: true, force: true });
  return { purged: true };
}

export async function withTelemetryQueueLock({
  cwd = process.cwd(),
  staleMs = 30_000,
  retries = 20,
  retryDelayMs = 25,
} = {}, fn) {
  if (typeof fn !== "function") {
    throw new TypeError("withTelemetryQueueLock requires a callback.");
  }
  assertPositiveInteger(staleMs, "staleMs");
  assertNonnegativeInteger(retries, "retries");
  assertNonnegativeInteger(retryDelayMs, "retryDelayMs");

  const dirs = await ensureQueueDirs(cwd);
  const token = randomUUID();
  let lastError;
  let attempts = 0;
  let acquired = false;

  while (attempts <= retries) {
    try {
      await tryAcquireLock(dirs, token);
      acquired = true;
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      lastError = error;
      if (await maybeReclaimStaleLock(dirs, staleMs)) continue;
      if (attempts === retries) break;
      attempts += 1;
      await sleep(retryDelayMs);
    }
  }

  if (acquired) {
    try {
      return await fn();
    } finally {
      await releaseLock(dirs, token, staleMs);
    }
  }

  const message = `Telemetry queue lock could not be acquired: ${dirs.lock}`;
  const error = new Error(message);
  error.cause = lastError;
  throw error;
}

async function enforceQueueLimit(cwd, state, maxQueueBytes) {
  const dirs = telemetryQueueDirs(cwd);
  const pendingFiles = await regularFiles(dirs.pending);
  let queueBytes = await sumFileSizes(pendingFiles);
  let dropped = 0;

  for (const file of pendingFiles) {
    if (queueBytes <= maxQueueBytes) break;
    try {
      await unlink(file.path);
      queueBytes -= file.size;
      dropped += 1;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  return {
    ...state,
    queue_bytes: queueBytes,
    dropped_old_count: state.dropped_old_count + dropped,
  };
}

export async function appendTelemetryEvent({
  cwd = process.cwd(),
  event,
  maxQueueBytes = DEFAULT_MAX_QUEUE_BYTES,
} = {}) {
  assertPositiveInteger(maxQueueBytes, "maxQueueBytes");
  const normalizedEvent = normalizeTelemetryEvent(event);

  return withTelemetryQueueLock({ cwd }, async () => {
    const dirs = await ensureQueueDirs(cwd);
    const state = await loadStateFromPath(dirs.state);
    const fileName = queueFileName("event");
    const tmpPath = join(dirs.tmp, `${fileName}.tmp`);
    const pendingPath = join(dirs.pending, fileName);

    await writeFile(tmpPath, `${JSON.stringify(normalizedEvent)}\n`, { mode: SECURE_FILE_MODE });
    await chmod(tmpPath, SECURE_FILE_MODE);
    await rename(tmpPath, pendingPath);
    await chmod(pendingPath, SECURE_FILE_MODE);

    const nextState = await enforceQueueLimit(cwd, state, maxQueueBytes);
    await saveState(cwd, nextState);
    return normalizedEvent;
  });
}

export async function claimTelemetryBatch({
  cwd = process.cwd(),
  batchSize,
  now = new Date(),
} = {}) {
  assertPositiveInteger(batchSize, "batchSize");

  return withTelemetryQueueLock({ cwd }, async () => {
    const dirs = await ensureQueueDirs(cwd);
    const pendingFiles = (await regularFiles(dirs.pending)).slice(0, batchSize);
    if (pendingFiles.length === 0) {
      return { batchId: null, batchDir: null, events: [] };
    }

    const batchId = `batch_${utcDay(now).replaceAll("-", "")}_${Date.now()}_${randomUUID()}`;
    const batchDir = join(dirs.inflight, batchId);
    await secureMkdir(batchDir);

    const movedFiles = [];
    try {
      for (const file of pendingFiles) {
        const destination = join(batchDir, file.name);
        await rename(file.path, destination);
        await chmod(destination, SECURE_FILE_MODE);
        movedFiles.push({ ...file, path: destination });
      }
    } catch (error) {
      for (const file of movedFiles.reverse()) {
        try {
          await rename(file.path, join(dirs.pending, file.name));
        } catch {
          // Keep the original error. A later fail/retry can recover any moved files.
        }
      }
      throw error;
    }

    const events = [];
    for (const file of movedFiles) {
      events.push(normalizeTelemetryEvent(await readJsonFile(file.path, "Telemetry queue event")));
    }

    const state = await loadStateFromPath(dirs.state);
    await saveState(cwd, {
      ...state,
      queue_bytes: await pendingQueueBytes(cwd),
    });

    return { batchId, batchDir, events };
  });
}

export async function completeTelemetryBatch({
  cwd = process.cwd(),
  batchId,
  now = new Date(),
} = {}) {
  assertSafeBatchId(batchId);

  return withTelemetryQueueLock({ cwd }, async () => {
    const dirs = await ensureQueueDirs(cwd);
    const batchDir = join(dirs.inflight, batchId);
    if (!await fileExists(batchDir)) return 0;

    const sentDayDir = join(dirs.sent, utcDay(now));
    await secureMkdir(sentDayDir);
    const files = await regularFiles(batchDir);
    let moved = 0;

    for (const file of files) {
      const destination = join(sentDayDir, file.name);
      await rename(file.path, destination);
      await chmod(destination, SECURE_FILE_MODE);
      moved += 1;
    }
    await rm(batchDir, { recursive: true, force: true });

    const state = await loadStateFromPath(dirs.state);
    await saveState(cwd, {
      ...state,
      sent_success_count: state.sent_success_count + moved,
      last_sent_at: now.toISOString(),
    });
    return moved;
  });
}

export async function failTelemetryBatch({
  cwd = process.cwd(),
  batchId,
  retryable = true,
  reason = "receiver_error",
} = {}) {
  assertSafeBatchId(batchId);
  if (typeof retryable !== "boolean") {
    throw new TypeError("retryable must be a boolean.");
  }
  if (typeof reason !== "string" || !reason.trim()) {
    throw new Error("Telemetry failure reason must be a non-empty string.");
  }

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
      await rm(batchDir, { recursive: true, force: true });
    } else {
      const failedBatchDir = join(dirs.failed, batchId);
      await secureMkdir(failedBatchDir);
      for (const file of files) {
        const destination = join(failedBatchDir, file.name);
        await rename(file.path, destination);
        await chmod(destination, SECURE_FILE_MODE);
        moved += 1;
      }
      await writeSecureJsonFile(cwd, join(failedBatchDir, "reason.json"), {
        batch_id: batchId,
        reason,
        retryable: false,
        failed_at: new Date().toISOString(),
      });
      await rm(batchDir, { recursive: true, force: true });
    }

    const state = await loadStateFromPath(dirs.state);
    await saveState(cwd, {
      ...state,
      queue_bytes: await pendingQueueBytes(cwd),
      sent_failure_count: state.sent_failure_count + moved,
      non_retryable_failure_count: retryable
        ? (state.non_retryable_failure_count ?? 0)
        : (state.non_retryable_failure_count ?? 0) + moved,
      last_failure_reason: reason,
    });
    return moved;
  });
}

async function sentDayDirs(sentDir) {
  let entries;
  try {
    entries = await readdir(sentDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }

  const dirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
    const path = join(sentDir, entry.name);
    const dayMs = Date.parse(`${entry.name}T00:00:00.000Z`);
    if (Number.isNaN(dayMs)) continue;
    const files = await regularFiles(path);
    dirs.push({
      name: entry.name,
      path,
      dayMs,
      bytes: await sumFileSizes(files),
      count: files.length,
    });
  }
  return dirs.sort((left, right) => left.dayMs - right.dayMs || left.name.localeCompare(right.name));
}

export async function pruneSentTelemetry({
  cwd = process.cwd(),
  now = new Date(),
  keepDays,
  maxSentBytes = Number.POSITIVE_INFINITY,
} = {}) {
  assertNonnegativeInteger(keepDays, "keepDays");
  if (maxSentBytes !== Number.POSITIVE_INFINITY) {
    assertNonnegativeInteger(maxSentBytes, "maxSentBytes");
  }

  return withTelemetryQueueLock({ cwd }, async () => {
    const dirs = await ensureQueueDirs(cwd);
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const cutoff = today - (keepDays * DAY_MS);
    let dayDirs = await sentDayDirs(dirs.sent);
    let removed = 0;

    for (const dayDir of dayDirs) {
      if (dayDir.dayMs >= cutoff) continue;
      await rm(dayDir.path, { recursive: true, force: true });
      removed += dayDir.count;
    }

    dayDirs = (await sentDayDirs(dirs.sent)).sort((left, right) => (
      left.dayMs - right.dayMs || left.name.localeCompare(right.name)
    ));
    let sentBytes = dayDirs.reduce((sum, dayDir) => sum + dayDir.bytes, 0);
    for (const dayDir of dayDirs) {
      if (sentBytes <= maxSentBytes) break;
      await rm(dayDir.path, { recursive: true, force: true });
      sentBytes -= dayDir.bytes;
      removed += dayDir.count;
    }

    return removed;
  });
}
