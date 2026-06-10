import { createHash } from "node:crypto";
import { lstat as defaultLstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";

const DEFAULT_PROJECT_ID = "gemini-agent";
const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_CACHE_LIMIT = 256;
const DEFAULT_WORKSPACE_ID = "ws_unknown";
const GENERIC_ROOT_NAMES = new Set([
  "",
  "users",
  "home",
  "desktop",
  "documents",
  "downloads",
  "tmp",
  "var",
  "private",
  "volumes",
]);

let attributionCache = new Map();

export function resetTelemetryAttributionCacheForTests() {
  attributionCache = new Map();
}

export function sanitizeTelemetryDimension(value, fallback = DEFAULT_PROJECT_ID) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || /[^\s@]+@[^\s@]+\.[^\s@]+/.test(text)) return fallback;
  const normalized = text
    .replace(/^@/, "")
    .replace(/[\\/]+/g, "-")
    .replace(/[^A-Za-z0-9._ -]+/g, "-")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 80);
  return normalized || fallback;
}

function sanitizeWorkspaceId(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || /[^\s@]+@[^\s@]+\.[^\s@]+/.test(text)) return "";
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(text)) return "";
  return text;
}

function stableSalt({ installId, deploymentId }) {
  if (typeof installId === "string" && installId.startsWith("install_")) return installId;
  if (typeof deploymentId === "string" && deploymentId.trim() && deploymentId !== "local") {
    return deploymentId;
  }
  return null;
}

function workspaceHash(path, salt) {
  return `ws_${createHash("sha256").update(`${salt}\0${path}`).digest("hex").slice(0, 24)}`;
}

async function defaultReadJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function safeRealpath(path) {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function rootCandidateAt(path, lstat) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return null;
    return info;
  } catch {
    return null;
  }
}

async function findProjectRoot({ cwd, maxDepth, readJson, lstat }) {
  let current = resolve(cwd);
  const filesystemRoot = parse(current).root;
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const packagePath = join(current, "package.json");
    const packageInfo = await rootCandidateAt(packagePath, lstat);
    if (packageInfo?.isFile()) {
      const root = await safeRealpath(current);
      try {
        const pkg = await readJson(packagePath);
        return { root, packageName: pkg?.name, source: "package_json" };
      } catch (error) {
        if (error instanceof SyntaxError) {
          return { root, packageName: null, source: "package_json" };
        }
        throw error;
      }
    }

    const gitInfo = await rootCandidateAt(join(current, ".git"), lstat);
    if (gitInfo?.isDirectory() || gitInfo?.isFile()) {
      return { root: await safeRealpath(current), packageName: null, source: "git_root" };
    }

    const next = dirname(current);
    if (next === current || current === filesystemRoot) break;
    current = next;
  }
  return { root: await safeRealpath(cwd), packageName: null, source: "cwd" };
}

function safeGitBasename(root, homeDir) {
  const name = basename(root);
  const normalized = name.toLowerCase();
  const resolvedHome = typeof homeDir === "string" && homeDir.trim()
    ? resolve(homeDir)
    : resolve(homedir());
  if (resolve(root) === resolvedHome) return null;
  if ([...GENERIC_ROOT_NAMES].some((item) => normalized === item || normalized.startsWith(`${item}-`))) {
    return null;
  }
  return name;
}

function cacheKeyFor(options) {
  return JSON.stringify({
    cwd: resolve(options.cwd ?? process.cwd()),
    projectId: options.projectId ?? null,
    workspaceId: options.context?.workspace_id ?? null,
    envProject: options.env?.GEMINI_AGENT_PROJECT_ID ?? null,
    envWorkspace: options.env?.GEMINI_AGENT_WORKSPACE_ID ?? null,
    installId: options.installId ?? null,
    deploymentId: options.deploymentId ?? null,
    homeDir: options.homeDir ?? null,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
  });
}

function remember(key, promise, cacheLimit) {
  if (attributionCache.size >= cacheLimit && !attributionCache.has(key)) {
    attributionCache.delete(attributionCache.keys().next().value);
  }
  attributionCache.set(key, promise);
  return promise;
}

async function resolveTelemetryAttributionInner(options) {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const context = options.context && typeof options.context === "object" ? options.context : {};
  const explicitProject = sanitizeTelemetryDimension(options.projectId, "");
  const envProject = sanitizeTelemetryDimension(env.GEMINI_AGENT_PROJECT_ID, "");
  const explicitWorkspace = sanitizeWorkspaceId(context.workspace_id);
  const envWorkspace = sanitizeWorkspaceId(env.GEMINI_AGENT_WORKSPACE_ID);
  const readJson = options.fs?.readJson ?? defaultReadJson;
  const lstat = options.fs?.lstat ?? defaultLstat;
  const rootInfo = await findProjectRoot({
    cwd,
    maxDepth: Number.isInteger(options.maxDepth) && options.maxDepth >= 0
      ? options.maxDepth
      : DEFAULT_MAX_DEPTH,
    readJson,
    lstat,
  });

  const packageProject = sanitizeTelemetryDimension(rootInfo.packageName, "");
  const gitProject = rootInfo.source === "git_root"
    ? sanitizeTelemetryDimension(safeGitBasename(rootInfo.root, options.homeDir), "")
    : "";
  const project_id = explicitProject || envProject || packageProject || gitProject || DEFAULT_PROJECT_ID;
  const project_source = explicitProject ? "explicit"
    : envProject ? "env"
      : packageProject ? "package_json"
        : gitProject ? "git_root"
          : "default";

  const salt = stableSalt(options);
  const workspace_id = explicitWorkspace
    || envWorkspace
    || (salt ? workspaceHash(rootInfo.root, salt) : DEFAULT_WORKSPACE_ID);
  const workspace_source = explicitWorkspace ? "explicit"
    : envWorkspace ? "env"
      : salt && rootInfo.source !== "cwd" ? "project_root_hash"
        : salt ? "cwd_hash"
          : "unknown";

  return {
    project_id,
    workspace_id,
    metadata: {
      project_source,
      workspace_source,
    },
  };
}

export async function resolveTelemetryAttribution(options = {}) {
  const cacheLimit = Number.isInteger(options.cacheLimit) && options.cacheLimit > 0
    ? options.cacheLimit
    : DEFAULT_CACHE_LIMIT;
  const key = cacheKeyFor(options);
  if (attributionCache.has(key)) return attributionCache.get(key);
  const promise = resolveTelemetryAttributionInner(options).catch(() => {
    attributionCache.delete(key);
    return {
      project_id: DEFAULT_PROJECT_ID,
      workspace_id: DEFAULT_WORKSPACE_ID,
      metadata: {
        project_source: "default",
        workspace_source: "unknown",
      },
    };
  });
  return remember(key, promise, cacheLimit);
}
