import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
  uid: 501,
};

function assertNoSecrets(text) {
  assert.doesNotMatch(text, /GEMINI_API_KEY/);
  assert.doesNotMatch(text, /GEMINI_AGENT_TELEMETRY_TOKEN/);
  assert.doesNotMatch(text, /secret-token-value/);
}

test("normalizes scheduler options and validates unsafe input", () => {
  const options = normalizeSchedulerOptions(base);
  assert.equal(options.name, "gemini-agent-test");
  assert.equal(options.schedule, "hourly");
  assert.equal(options.launchdDomain, "gui");
  assert.equal(
    normalizeSchedulerOptions({ name: "default-schedule", cwd: "/tmp/project", bin: "gemini-agent", uid: 501 }).schedule,
    "daily@09:00",
  );

  assert.throws(() => normalizeSchedulerOptions({ ...base, uid: 0 }), /must not run as root/);
  assert.throws(() => normalizeSchedulerOptions({ ...base, name: "bad/name" }), /only letters, numbers, dot, underscore, or dash/);
  assert.throws(() => normalizeSchedulerOptions({ ...base, schedule: "weekly" }), /Unsupported scheduler schedule/);
});

test("rejects scheduler text injection inputs before artifact generation", () => {
  assert.throws(
    () => generateSystemdService({ ...base, cwd: "/tmp/project\nExecStart=/bin/false" }),
    /cwd must not contain/,
  );
  assert.throws(
    () => generateSystemdService({ ...base, envFile: "/tmp/env\nEnvironment=LEAK=1" }),
    /envFile must not contain/,
  );
  assert.throws(
    () => generateLaunchdPlist({ ...base, bin: "/usr/local/bin/gemini-agent\r/bin/false" }),
    /bin must not contain/,
  );
  assert.throws(
    () => generateCronEntry({ ...base, cwd: "/tmp/project%stdin" }),
    /cwd must not contain %/,
  );
  assert.throws(
    () => generateCronEntry({ ...base, envFile: "/tmp/env%token" }),
    /envFile must not contain %/,
  );
});

test("launchd plist escapes XML metacharacters", () => {
  const plist = generateLaunchdPlist({
    ...base,
    cwd: "/tmp/project&quote's",
    envFile: "/tmp/env<unsafe>",
  });

  assert.match(plist, /\/tmp\/project&amp;quote&apos;s/);
  assert.match(plist, /\/tmp\/env&lt;unsafe&gt;/);
});

test("generates launchd plist without inline secrets", () => {
  const plist = generateLaunchdPlist(base);
  assert.match(plist, /com\.gemini-agent\.gemini-agent-test/);
  assert.match(plist, /telemetry/);
  assert.match(plist, /tick/);
  assert.match(plist, /StartInterval/);
  assert.match(plist, /\/tmp\/project\/\.gemini-agent\/telemetry\/env/);
  assertNoSecrets(plist);
});

test("generates cron entry with managed marker and without inline secrets", () => {
  const cron = generateCronEntry(base);
  assert.match(cron, /^0 \* \* \* \*/);
  assert.match(cron, /cd \/tmp\/project/);
  assert.match(cron, /telemetry tick/);
  assert.match(cron, /# gemini-agent:gemini-agent-test/);
  assertNoSecrets(cron);
});

test("generates systemd service and timer without inline secrets", () => {
  const service = generateSystemdService(base);
  const timer = generateSystemdTimer({ ...base, schedule: "daily@09:30" });

  assert.match(service, /ExecStart=\/usr\/local\/bin\/gemini-agent telemetry tick/);
  assert.match(service, /EnvironmentFile=\/tmp\/project\/\.gemini-agent\/telemetry\/env/);
  assert.match(timer, /OnCalendar=\*-\*-\* 09:30:00/);
  assertNoSecrets(service);
  assertNoSecrets(timer);
});

test("rejects systemd parser-sensitive service fields", () => {
  assert.throws(
    () => generateSystemdService({ ...base, bin: "/tmp/my agent" }),
    /bin must be an absolute path without systemd parser metacharacters/,
  );
  assert.throws(
    () => generateSystemdService({ ...base, bin: "-/tmp/gemini-agent" }),
    /bin must not start with a systemd ExecStart prefix/,
  );
  assert.throws(
    () => generateSystemdService({ ...base, bin: "+/tmp/gemini-agent" }),
    /bin must not start with a systemd ExecStart prefix/,
  );
  assert.throws(
    () => generateSystemdService({ ...base, envFile: "-/tmp/env" }),
    /envFile must not start with -/,
  );
  assert.throws(
    () => generateSystemdService({ ...base, cwd: "-/tmp/project" }),
    /cwd must not start with -/,
  );
  assert.match(generateSystemdService(base), /WorkingDirectory=\/tmp\/project/);
});

test("rejects group or other readable env files when installing", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-agent-scheduler-"));
  const envFile = join(home, "env");
  await writeFile(envFile, "GEMINI_AGENT_TELEMETRY_TOKEN=secret-token-value\n", { mode: 0o644 });
  await chmod(envFile, 0o644);

  try {
    await assert.rejects(
      installScheduler({
        ...base,
        target: "cron",
        cwd: home,
        home,
        envFile,
      }),
      /must not be readable by group or others/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("rejects missing env files when installing", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-agent-scheduler-"));

  try {
    await assert.rejects(
      installScheduler({
        ...base,
        target: "systemd",
        cwd: home,
        home,
        envFile: join(home, "missing.env"),
      }),
      /Scheduler env file does not exist/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("dry run returns artifacts and does not invoke the runner", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-agent-scheduler-"));
  try {
    const result = await installScheduler({
      ...base,
      target: "systemd",
      home,
      cwd: home,
      envFile: null,
      runner: async () => {
        throw new Error("runner should not be called");
      },
    });

    assert.equal(result.dry_run, true);
    assert.equal(result.changed, false);
    assert.equal(result.files.length, 2);
    assert.match(result.files[0].content, /gemini-agent telemetry tick/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("writes and activates launchd with the provided uid and domain", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-agent-scheduler-"));
  const envFile = join(home, "env");
  await writeFile(envFile, "GEMINI_AGENT_TELEMETRY_TOKEN=secret-token-value\n", { mode: 0o600 });
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, args]);
    if (args[0] === "bootout") throw new Error("not bootstrapped");
    return { stdout: "" };
  };

  try {
    const result = await installScheduler({
      ...base,
      target: "launchd",
      write: true,
      home,
      envFile,
      launchdDomain: "user",
      runner,
    });
    const plist = await readFile(result.files[0].path, "utf8");

    assert.equal(result.changed, true);
    assert.equal((await stat(result.files[0].path)).mode & 0o777, 0o600);
    assert.deepEqual(calls[0], ["launchctl", ["bootout", "user/501", result.files[0].path]]);
    assert.deepEqual(calls[1], ["launchctl", ["bootstrap", "user/501", result.files[0].path]]);
    assertNoSecrets(plist);
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
    throw new Error(`unexpected command: ${command}`);
  };

  try {
    await installScheduler({
      ...base,
      target: "cron",
      write: true,
      cwd: home,
      home,
      envFile: null,
      runner,
    });
    assert.match(installed, /15 7 \* \* \* \/usr\/bin\/true/);
    assert.match(installed, /# BEGIN gemini-agent:gemini-agent-test/);
    assert.match(installed, /# END gemini-agent:gemini-agent-test/);
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
      const error = new Error("no crontab for user");
      error.stderr = "no crontab for user";
      throw error;
    }
    if (command === "crontab") {
      installed = await readFile(args[0], "utf8");
      return { stdout: "" };
    }
    throw new Error(`unexpected command: ${command}`);
  };

  try {
    await installScheduler({
      ...base,
      target: "cron",
      write: true,
      cwd: home,
      home,
      envFile: null,
      runner,
    });
    assert.doesNotMatch(installed, /undefined/);
    assert.match(installed, /# BEGIN gemini-agent:gemini-agent-test/);
    assert.match(installed, /gemini-agent telemetry tick/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("systemd write path activates the timer with a fake runner", async () => {
  const home = await mkdtemp(join(tmpdir(), "gemini-agent-scheduler-"));
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, args]);
    return { stdout: "" };
  };

  try {
    const result = await installScheduler({
      ...base,
      target: "systemd",
      write: true,
      cwd: home,
      home,
      envFile: null,
      runner,
    });
    assert.equal(result.files.length, 2);
    assert.deepEqual(calls[0], ["systemctl", ["--user", "daemon-reload"]]);
    assert.deepEqual(calls[1], ["systemctl", ["--user", "enable", "--now", "gemini-agent-gemini-agent-test.timer"]]);
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
      target: "systemd",
      write: true,
      cwd: home,
      home,
      envFile: null,
      runner,
    });
    const before = await schedulerStatus({ target: "systemd", name: base.name, cwd: home, home, uid: 501 });
    assert.equal(before.files.every((file) => file.exists), true);

    const removed = await uninstallScheduler({ target: "systemd", name: base.name, cwd: home, home, uid: 501, runner });
    assert.equal(removed.ok, true);

    const after = await schedulerStatus({ target: "systemd", name: base.name, cwd: home, home, uid: 501 });
    assert.equal(after.files.every((file) => !file.exists), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
