import fs from "node:fs";
import path from "node:path";
import type { ProbeResults } from "../../probe.js";
import { execSafe } from "../utils.js";
import type { LintDiagnostic, LinterRunner } from "./types.js";

const CONFIG_FILES = [
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.yml",
  ".eslintrc.yaml",
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
];

export const eslintLinter: LinterRunner = {
  name: "eslint",
  cacheTtl: 5000,

  detect(workspace: string, probes: ProbeResults): boolean {
    if (!probes.eslint) return false;
    return CONFIG_FILES.some((f) => fs.existsSync(path.join(workspace, f)));
  },

  async run(cwd: string, signal?: AbortSignal): Promise<LintDiagnostic[]> {
    // Prefer local binary over npx to avoid arbitrary package execution
    const localBin = path.join(cwd, "node_modules", ".bin", "eslint");
    const cmd = fs.existsSync(localBin) ? localBin : "eslint";
    const result = await execSafe(cmd, ["--format", "json", "."], {
      cwd,
      timeout: 30000,
      signal,
    });

    const output = result.stdout.trim();
    if (!output) return [];

    try {
      const entries = JSON.parse(output) as Array<{
        filePath: string;
        messages: Array<{
          line: number;
          column: number;
          severity: number;
          message: string;
          ruleId: string | null;
        }>;
      }>;

      const diagnostics: LintDiagnostic[] = [];
      for (const entry of entries) {
        for (const msg of entry.messages) {
          diagnostics.push({
            file: entry.filePath,
            line: msg.line,
            column: msg.column,
            severity: msg.severity === 2 ? "error" : "warning",
            message: msg.message,
            source: "eslint",
            code: msg.ruleId ?? undefined,
          });
        }
      }
      return diagnostics;
    } catch {
      return [];
    }
  },
};
