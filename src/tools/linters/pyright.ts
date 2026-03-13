import type { ProbeResults } from "../../probe.js";
import { execSafe } from "../utils.js";
import type { LintDiagnostic, LinterRunner } from "./types.js";

export const pyrightLinter: LinterRunner = {
  name: "pyright",
  cacheTtl: 10000,

  detect(_workspace: string, probes: ProbeResults): boolean {
    return probes.pyright;
  },

  async run(cwd: string, signal?: AbortSignal): Promise<LintDiagnostic[]> {
    const result = await execSafe("pyright", ["--outputjson"], {
      cwd,
      timeout: 30000,
      signal,
    });

    const output = result.stdout.trim();
    if (!output) return [];

    try {
      const data = JSON.parse(output) as {
        generalDiagnostics: Array<{
          file: string;
          range: { start: { line: number; character: number } };
          severity: string;
          message: string;
          rule?: string;
        }>;
      };

      return (data.generalDiagnostics ?? []).map((d) => ({
        file: d.file,
        line: (d.range?.start?.line ?? 0) + 1,
        column: (d.range?.start?.character ?? 0) + 1,
        severity: d.severity === "error" ? "error" : "warning",
        message: d.message,
        source: "pyright",
        code: d.rule,
      }));
    } catch (err) {
      throw new Error(
        `pyright: failed to parse output — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
};
