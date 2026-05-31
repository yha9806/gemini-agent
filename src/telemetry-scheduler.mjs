import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const DEFAULT_SCHEDULE = "daily@09:00";
const MANAGED_START_PREFIX = "# BEGIN gemini-agent:";
const MANAGED_END_PREFIX = "# END gemini-agent:";
const SYSTEMD_ABSOLUTE_PATH_PATTERN = /^\/[A-Za-z0-9_./:@=,-]+$/;
const SYSTEMD_EXEC_PREFIX_PATTERN = /^[@\-:+!]/;

function assertName(name) {
  if (!NAME_PATTERN.test(name || "")) {
    throw new Error("Scheduler name must contain only letters, numbers, dot, underscore, or dash.");
  }
}

function assertTarget(target) {
  if (!["launchd", "cron", "systemd"].includes(target)) {
    throw new Error("Scheduler target must be launchd, cron, or systemd.");
  }
}

function parseSchedule(schedule) {
  if (schedule === "hourly") {
    return {
      kind: "hourly",
      cron: "0 * * * *",
      systemd: "hourly",
      launchd: "<key>StartInterval</key>\n<integer>3600</integer>",
    };
  }

  const match = /^daily@([01]\d|2[0-3]):([0-5]\d)$/.exec(schedule || "");
  if (!match) throw new Error(`Unsupported scheduler schedule: ${schedule}`);

  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return {
    kind: "daily",
    hour,
    minute,
    cron: `${minute} ${hour} * * *`,
    systemd: `*-*-* ${match[1]}:${match[2]}:00`,
    launchd: [
      "<key>StartCalendarInterval</key>",
      "<dict>",
      "<key>Hour</key>",
      `<integer>${hour}</integer>`,
      "<key>Minute</key>",
      `<integer>${minute}</integer>`,
      "</dict>",
    ].join("\n"),
  };
}

function schedulerHome() {
  return process.env.HOME || homedir();
}

function assertSchedulerText(value, field, { required = false, rejectPercent = false } = {}) {
  if (value == null || value === "") {
    if (required) throw new Error(`Scheduler ${field} is required.`);
    return null;
  }
  if (typeof value !== "string") throw new Error(`Scheduler ${field} must be a string.`);
  if (/[\0\r\n]/.test(value)) {
    throw new Error(`${field} must not contain NUL, carriage return, or newline.`);
  }
  if (rejectPercent && value.includes("%")) {
    throw new Error(`${field} must not contain %.`);
  }
  return value;
}

function shellWord(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function launchdLabel(name) {
  return `com.gemini-agent.${name}`;
}

function launchdPath({ home, name }) {
  return join(home, "Library", "LaunchAgents", `${launchdLabel(name)}.plist`);
}

function cronPath({ cwd, name }) {
  return join(cwd, ".gemini-agent", "telemetry", `cron.${name}`);
}

function systemdServiceName(name) {
  return `gemini-agent-${name}.service`;
}

function systemdTimerName(name) {
  return `gemini-agent-${name}.timer`;
}

function systemdDir(home) {
  return join(home, ".config", "systemd", "user");
}

function schedulerArtifactPaths({ target, name, home, cwd }) {
  if (target === "launchd") {
    return [launchdPath({ home, name })];
  }
  if (target === "cron") {
    return [cronPath({ cwd, name })];
  }
  if (target === "systemd") {
    return [
      join(systemdDir(home), systemdServiceName(name)),
      join(systemdDir(home), systemdTimerName(name)),
    ];
  }
  assertTarget(target);
  return [];
}

function managedStart(name) {
  return `${MANAGED_START_PREFIX}${name}`;
}

function managedEnd(name) {
  return `${MANAGED_END_PREFIX}${name}`;
}

function buildTickCommand({ cwd, bin, envFile }) {
  const sourceEnv = envFile ? `set -a; . ${shellWord(envFile)}; set +a; ` : "";
  return `${sourceEnv}cd ${shellWord(cwd)} && exec ${shellWord(bin)} telemetry tick`;
}

function currentUid() {
  return typeof process.getuid === "function" ? process.getuid() : 1;
}

function assertSystemdUnitPath(value, field, { executable = false } = {}) {
  if (executable && SYSTEMD_EXEC_PREFIX_PATTERN.test(value)) {
    throw new Error(`${field} must not start with a systemd ExecStart prefix.`);
  }
  if (!executable && value.startsWith("-")) {
    throw new Error(`${field} must not start with -.`);
  }
  if (!value.startsWith("/")) {
    throw new Error(`${field} must be an absolute path for systemd scheduler units.`);
  }
  if (!SYSTEMD_ABSOLUTE_PATH_PATTERN.test(value)) {
    throw new Error(`${field} must be an absolute path without systemd parser metacharacters.`);
  }
}

function assertSystemdServiceOptions(options) {
  assertSystemdUnitPath(options.cwd, "cwd");
  assertSystemdUnitPath(options.bin, "bin", { executable: true });
  if (options.envFile) assertSystemdUnitPath(options.envFile, "envFile");
}

export function normalizeSchedulerOptions({
  name,
  schedule = DEFAULT_SCHEDULE,
  cwd = process.cwd(),
  bin = "gemini-agent",
  envFile = null,
  home = schedulerHome(),
  uid = currentUid(),
  launchdDomain = "gui",
} = {}) {
  assertName(name);
  parseSchedule(schedule);
  const safeHome = assertSchedulerText(home, "home directory", { required: true });
  const safeCwd = assertSchedulerText(cwd, "cwd", { required: true, rejectPercent: true });
  const safeBin = assertSchedulerText(bin, "bin", { required: true, rejectPercent: true });
  const safeEnvFile = assertSchedulerText(envFile, "envFile", { rejectPercent: true });
  if (uid === 0) throw new Error("Scheduler must not run as root.");
  if (!["gui", "user"].includes(launchdDomain)) {
    throw new Error("launchdDomain must be gui or user.");
  }
  return {
    name,
    schedule,
    cwd: safeCwd,
    bin: safeBin,
    envFile: safeEnvFile,
    home: safeHome,
    uid,
    launchdDomain,
  };
}

export function generateLaunchdPlist(input) {
  const options = normalizeSchedulerOptions(input);
  const schedule = parseSchedule(options.schedule);
  const command = buildTickCommand(options);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(launchdLabel(options.name))}</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(options.cwd)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-lc</string>
    <string>${xmlEscape(command)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  ${schedule.launchd}
</dict>
</plist>
`;
}

export function generateCronEntry(input) {
  const options = normalizeSchedulerOptions(input);
  const schedule = parseSchedule(options.schedule);
  const sourceEnv = options.envFile ? `. ${shellWord(options.envFile)} && ` : "";
  return `${schedule.cron} cd ${shellWord(options.cwd)} && ${sourceEnv}${shellWord(options.bin)} telemetry tick # gemini-agent:${options.name}`;
}

export function generateSystemdService(input) {
  const options = normalizeSchedulerOptions(input);
  assertSystemdServiceOptions(options);
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
  const schedule = parseSchedule(options.schedule);
  return `[Unit]
Description=Gemini Agent telemetry timer ${options.name}

[Timer]
OnCalendar=${schedule.systemd}
Persistent=true

[Install]
WantedBy=timers.target
`;
}

export function schedulerArtifact({ target, ...input } = {}) {
  assertTarget(target);
  const options = normalizeSchedulerOptions(input);
  const paths = schedulerArtifactPaths({ target, ...options });

  if (target === "launchd") {
    return {
      target,
      name: options.name,
      files: [{
        path: paths[0],
        content: generateLaunchdPlist(options),
      }],
    };
  }

  if (target === "cron") {
    return {
      target,
      name: options.name,
      files: [{
        path: paths[0],
        content: `${generateCronEntry(options)}\n`,
      }],
    };
  }

  return {
    target,
    name: options.name,
    files: [
      {
        path: paths[0],
        content: generateSystemdService(options),
      },
      {
        path: paths[1],
        content: generateSystemdTimer(options),
      },
    ],
  };
}

async function assertEnvFileSecure(path) {
  if (!path) return;
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Scheduler env file does not exist: ${path}`);
    throw error;
  }
  if (!info.isFile()) throw new Error("Scheduler env file must be a regular file.");
  if ((info.mode & 0o077) !== 0) {
    throw new Error("Scheduler env file must not be readable by group or others.");
  }
}

function stripManagedCronBlock(crontab, name) {
  const lines = String(crontab || "").split(/\r?\n/);
  const stripped = [];
  let inManagedBlock = false;
  for (const line of lines) {
    if (line === managedStart(name)) {
      inManagedBlock = true;
      continue;
    }
    if (line === managedEnd(name)) {
      inManagedBlock = false;
      continue;
    }
    if (!inManagedBlock) stripped.push(line);
  }
  return stripped.join("\n").trim();
}

async function readCurrentCrontab(runner) {
  try {
    const result = await runner("crontab", ["-l"]);
    return result.stdout || "";
  } catch {
    return "";
  }
}

async function writeCrontab(contents, runner) {
  const dir = await mkdtemp(join(tmpdir(), "gemini-agent-cron-"));
  try {
    const path = join(dir, "crontab");
    await writeFile(path, contents, { mode: 0o600 });
    await chmod(path, 0o600);
    await runner("crontab", [path]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function installCron({ name, files, runner }) {
  const current = await readCurrentCrontab(runner);
  const preserved = stripManagedCronBlock(current, name);
  const managed = [
    managedStart(name),
    ...files.map((file) => file.content.trim()).filter(Boolean),
    managedEnd(name),
  ].join("\n");
  const next = [preserved, managed].filter(Boolean).join("\n") + "\n";
  await writeCrontab(next, runner);
}

async function uninstallCron({ name, runner }) {
  const current = await readCurrentCrontab(runner);
  const next = stripManagedCronBlock(current, name);
  await writeCrontab(next ? `${next}\n` : "", runner);
}

async function activateScheduler({ target, name, files, uid, launchdDomain, runner }) {
  if (target === "launchd") {
    const domain = `${launchdDomain}/${uid}`;
    await runner("launchctl", ["bootout", domain, files[0].path]).catch(() => undefined);
    await runner("launchctl", ["bootstrap", domain, files[0].path]);
    return;
  }

  if (target === "cron") {
    await installCron({ name, files, runner });
    return;
  }

  if (target === "systemd") {
    const timer = files.find((file) => file.path.endsWith(".timer"));
    await runner("systemctl", ["--user", "daemon-reload"]);
    await runner("systemctl", ["--user", "enable", "--now", basename(timer.path)]);
    return;
  }

  assertTarget(target);
}

async function deactivateScheduler({ target, name, files, uid, launchdDomain, runner }) {
  if (target === "launchd") {
    await runner("launchctl", ["bootout", `${launchdDomain}/${uid}`, files[0].path]).catch(() => undefined);
    return;
  }

  if (target === "cron") {
    await uninstallCron({ name, runner });
    return;
  }

  if (target === "systemd") {
    const timer = files.find((file) => file.path.endsWith(".timer"));
    await runner("systemctl", ["--user", "disable", "--now", basename(timer.path)]).catch(() => undefined);
    await runner("systemctl", ["--user", "daemon-reload"]).catch(() => undefined);
    return;
  }

  assertTarget(target);
}

export async function installScheduler({
  target,
  write = false,
  home = schedulerHome(),
  runner = execFile,
  ...input
} = {}) {
  assertTarget(target);
  const options = normalizeSchedulerOptions({ ...input, home });
  const artifact = schedulerArtifact({ target, ...options });
  await assertEnvFileSecure(options.envFile);

  if (!write) {
    return {
      ok: true,
      changed: false,
      dry_run: true,
      ...artifact,
    };
  }

  for (const file of artifact.files) {
    await mkdir(dirname(file.path), { recursive: true, mode: 0o700 });
    await writeFile(file.path, file.content, { mode: 0o600 });
    await chmod(file.path, 0o600);
  }

  await activateScheduler({
    target,
    name: options.name,
    files: artifact.files,
    uid: options.uid,
    launchdDomain: options.launchdDomain,
    runner,
  });

  return {
    ok: true,
    changed: true,
    dry_run: false,
    ...artifact,
  };
}

export async function schedulerStatus({
  target,
  name,
  home = schedulerHome(),
  cwd = process.cwd(),
  uid = currentUid(),
  launchdDomain = "gui",
  runner = null,
} = {}) {
  assertTarget(target);
  const options = normalizeSchedulerOptions({
    target,
    name,
    schedule: DEFAULT_SCHEDULE,
    cwd,
    bin: "/usr/bin/gemini-agent",
    home,
    uid,
    launchdDomain,
  });
  const artifact = {
    files: schedulerArtifactPaths({ target, ...options }).map((path) => ({ path })),
  };
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

  let active = null;
  if (runner && target === "cron") {
    const current = await readCurrentCrontab(runner);
    active = current.includes(managedStart(name)) && current.includes(managedEnd(name));
  }

  return {
    ok: true,
    target,
    name,
    active,
    files,
  };
}

export async function uninstallScheduler({
  target,
  name,
  home = schedulerHome(),
  cwd = process.cwd(),
  uid = currentUid(),
  launchdDomain = "gui",
  runner = execFile,
} = {}) {
  assertTarget(target);
  const options = normalizeSchedulerOptions({
    target,
    name,
    schedule: DEFAULT_SCHEDULE,
    cwd,
    bin: "/usr/bin/gemini-agent",
    home,
    uid,
    launchdDomain,
  });
  const artifact = {
    files: schedulerArtifactPaths({ target, ...options }).map((path) => ({ path })),
  };

  await deactivateScheduler({
    target,
    name,
    files: artifact.files,
    uid: options.uid,
    launchdDomain: options.launchdDomain,
    runner,
  });

  for (const file of artifact.files) {
    await rm(file.path, { force: true });
  }

  return {
    ok: true,
    removed: artifact.files.map((file) => file.path),
  };
}
