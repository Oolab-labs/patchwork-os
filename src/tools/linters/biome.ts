import fs from "node:fs";
import path from "node:path";
import type { ProbeResults } from "../../probe.js";
import { execSafe } from "../utils.js";
import type { LintDiagnostic, LinterRunner } from "./types.js";

const CONFIG_FILES = ["biome.json", "biome.jsonc"];

export const biomeLinter: LinterRunner = {
  name: "biome",
  cacheTtl: 3000,

  detect(workspace: string, probes: ProbeResults): boolean {
    if (!probes.biome) return false;
    return CONFIG_FILES.some((f) => fs.existsSync(path.join(workspace, f)));
  },

  async run(cwd: string, signal?: AbortSignal): Promise<LintDiagnostic[]> {
    // Prefer local binary over npx to avoid arbitrary package execution
    const localBin = path.join(cwd, "node_modules", ".bin", "biome");
    const cmd = fs.existsSync(localBin) ? localBin : "biome";
    const result = await execSafe(cmd, ["check", "--reporter", "json", "."], {
      cwd,
      timeout: 15000,
      signal,
    });

    const output = result.stdout.trim();
    if (!output) return [];

    try {
      const data = JSON.parse(output) as {
        diagnostics?: Array<{
          path?: { file?: string };
          span?: { start?: number };
          severity?: string;
          description?: string;
          category?: string;
        }>;
      };

      return (data.diagnostics ?? []).map((d) => ({
        file: d.path?.file ?? "",
        line: 1,
        column: 1,
        severity:
          d.severity === "error" || d.severity === "fatal"
            ? ("error" as const)
            : ("warning" as const),
        message: d.description ?? "",
        source: "biome",
        code: d.category,
      }));
    } catch (err) {
      throw new Error(
        `biome: failed to parse output — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
};
