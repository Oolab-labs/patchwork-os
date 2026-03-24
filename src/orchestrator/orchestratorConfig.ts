import os from "node:os";
import path from "node:path";

export interface OrchestratorConfig {
  port: number;
  bindAddress: string;
  lockDir: string;
  healthIntervalMs: number;
  verbose: boolean;
  jsonl: boolean;
  fixedToken: string | null;
  watch: boolean;
}

const DEFAULT_PORT = 4746;

export function parseOrchestratorArgs(argv: string[]): OrchestratorConfig {
  // argv is process.argv — subcommand is argv[2] = "orchestrator", flags start at argv[3]
  const args = argv.slice(3);

  const config: OrchestratorConfig = {
    port: DEFAULT_PORT,
    bindAddress: "127.0.0.1",
    lockDir: path.join(
      process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"),
      "ide",
    ),
    healthIntervalMs: 10_000,
    verbose: false,
    jsonl: false,
    fixedToken: null,
    watch: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const next = args[i + 1] as string | undefined;

    switch (arg) {
      case "--port": {
        const p = Number.parseInt(next ?? "", 10);
        if (!Number.isFinite(p) || p < 1024 || p > 65535) {
          process.stderr.write(
            "Error: --port must be a number between 1024 and 65535\n",
          );
          process.exit(1);
        }
        config.port = p;
        i++;
        break;
      }
      case "--bind": {
        if (!next) {
          process.stderr.write("Error: --bind requires an address\n");
          process.exit(1);
        }
        config.bindAddress = next;
        i++;
        break;
      }
      case "--lock-dir": {
        if (!next) {
          process.stderr.write("Error: --lock-dir requires a path\n");
          process.exit(1);
        }
        config.lockDir = next;
        i++;
        break;
      }
      case "--health-interval": {
        const ms = Number.parseInt(next ?? "", 10);
        if (!Number.isFinite(ms) || ms < 1000) {
          process.stderr.write("Error: --health-interval must be >= 1000 ms\n");
          process.exit(1);
        }
        config.healthIntervalMs = ms;
        i++;
        break;
      }
      case "--fixed-token": {
        if (!next) {
          process.stderr.write("Error: --fixed-token requires a value\n");
          process.exit(1);
        }
        config.fixedToken = next;
        i++;
        break;
      }
      case "--verbose":
        config.verbose = true;
        break;
      case "--jsonl":
        config.jsonl = true;
        break;
      case "--watch":
        config.watch = true;
        break;
      default:
        if (arg.startsWith("--")) {
          process.stderr.write(`Warning: unknown orchestrator flag: ${arg}\n`);
        }
    }
  }

  return config;
}
