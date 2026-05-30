import { join } from "node:path";
import { createTelemetryReceiver } from "./telemetry-receiver.mjs";

const DEFAULT_TOKEN_ENV = "GEMINI_AGENT_TELEMETRY_TOKEN";

function usage() {
  return `Usage: gemini-agent-telemetry-receiver [options]

Options:
  --host <host>                         Host to bind (default: 127.0.0.1)
  --port <port>                         Port to bind (default: 8787)
  --storage <path>                      Storage directory (default: ./.gemini-agent/telemetry/receiver)
  --token-env <name>                    Environment variable containing bearer token (default: GEMINI_AGENT_TELEMETRY_TOKEN)
  --allow-unauthenticated-loopback      Disable auth for local loopback testing
  --help                                Show this help
`;
}

function readOption(args, index, name) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function parseArgs(args) {
  const options = {
    host: "127.0.0.1",
    port: 8787,
    storage: join(process.cwd(), ".gemini-agent", "telemetry", "receiver"),
    tokenEnv: DEFAULT_TOKEN_ENV,
    allowUnauthenticatedLoopback: false,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--host") {
      options.host = readOption(args, index, arg);
      index += 1;
    } else if (arg === "--port") {
      const port = Number(readOption(args, index, arg));
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error("--port must be an integer from 0 to 65535.");
      }
      options.port = port;
      index += 1;
    } else if (arg === "--storage") {
      options.storage = readOption(args, index, arg);
      index += 1;
    } else if (arg === "--token-env") {
      options.tokenEnv = readOption(args, index, arg);
      index += 1;
    } else if (arg === "--allow-unauthenticated-loopback") {
      options.allowUnauthenticatedLoopback = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  const token = process.env[options.tokenEnv];
  if (!options.allowUnauthenticatedLoopback && (typeof token !== "string" || !token.trim())) {
    throw new Error(
      `Telemetry receiver authentication requires ${options.tokenEnv} to be set to a non-empty bearer token.`,
    );
  }

  const receiver = createTelemetryReceiver({
    host: options.host,
    port: options.port,
    storage: options.storage,
    token,
    allowUnauthenticatedLoopback: options.allowUnauthenticatedLoopback,
  });

  const address = await receiver.start();
  const host = address.address.includes(":") ? `[${address.address}]` : address.address;
  process.stderr.write(`Telemetry receiver listening on http://${host}:${address.port}\n`);

  const stop = async () => {
    try {
      await receiver.stop();
      process.exit(0);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
