import fs from "node:fs";
import path from "node:path";
import type { ProbeResults } from "../../probe.js";
import { execSafe } from "../utils.js";
import type { LintDiagnostic, LinterRunner } from "./types.js";

export const typescriptLinter: LinterRunner = {
  name: "typescript",
  cacheTtl: 5000,

  detect(workspace: string, probes: ProbeResults): boolean {
    return probes.tsc && fs.existsSync(path.join(workspace, "tsconfig.json"));
  },

  async run(cwd: string, signal?: AbortSignal): Promise<LintDiagnostic[]> {
    const result = await execSafe("tsc", ["--noEmit", "--pretty", "false"], {
      cwd,
      timeout: 30000,
      signal,
    });

    const output = result.stderr || result.stdout;
    if (!output) return [];

    const diagnostics: LintDiagnostic[] = [];
    const regex =
      /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm;
    let match = regex.exec(output);
    while (match !== null) {
      const file = match[1] ?? "";
      diagnostics.push({
        file,
        line: Number.parseInt(match[2] ?? "1", 10),
        column: Number.parseInt(match[3] ?? "1", 10),
        severity: match[4] === "error" ? "error" : "warning",
        message: match[6] ?? "",
        source: "typescript",
        code: match[5],
      });
      match = regex.exec(output);
    }
    return diagnostics;
  },
};
