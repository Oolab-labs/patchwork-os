import fs from "node:fs";
import path from "node:path";
import type { ProbeResults } from "../../probe.js";
import { execSafe } from "../utils.js";
import type { LintDiagnostic, LinterRunner } from "./types.js";

export const govetLinter: LinterRunner = {
  name: "govet",
  cacheTtl: 5000,

  detect(workspace: string, probes: ProbeResults): boolean {
    return probes.go && fs.existsSync(path.join(workspace, "go.mod"));
  },

  async run(cwd: string, signal?: AbortSignal): Promise<LintDiagnostic[]> {
    const result = await execSafe("go", ["vet", "./..."], {
      cwd,
      timeout: 30000,
      signal,
    });

    const output = result.stderr || result.stdout;
    if (!output) return [];

    const diagnostics: LintDiagnostic[] = [];
    // go vet output: file.go:line:col: message
    const regex = /^(.+?):(\d+):(\d+):\s+(.+)$/gm;
    let match = regex.exec(output);
    while (match !== null) {
      diagnostics.push({
        file: match[1] ?? "",
        line: Number.parseInt(match[2] ?? "1", 10),
        column: Number.parseInt(match[3] ?? "1", 10),
        severity: "warning",
        message: match[4] ?? "",
        source: "govet",
      });
      match = regex.exec(output);
    }
    return diagnostics;
  },
};
