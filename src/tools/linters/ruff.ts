import type { ProbeResults } from "../../probe.js";
import { execSafe } from "../utils.js";
import type { LintDiagnostic, LinterRunner } from "./types.js";

export const ruffLinter: LinterRunner = {
  name: "ruff",
  cacheTtl: 3000,

  detect(_workspace: string, probes: ProbeResults): boolean {
    return probes.ruff;
  },

  async run(cwd: string, signal?: AbortSignal): Promise<LintDiagnostic[]> {
    const result = await execSafe(
      "ruff",
      ["check", "--output-format", "json", "."],
      { cwd, timeout: 15000, signal },
    );

    const output = result.stdout.trim();
    if (!output) return [];

    try {
      const entries = JSON.parse(output) as Array<{
        filename: string;
        location: { row: number; column: number };
        code: string;
        message: string;
      }>;

      return entries.map((e) => ({
        file: e.filename,
        line: e.location.row,
        column: e.location.column,
        severity: "warning" as const,
        message: e.message,
        source: "ruff",
        code: e.code,
      }));
    } catch {
      return [];
    }
  },
};
