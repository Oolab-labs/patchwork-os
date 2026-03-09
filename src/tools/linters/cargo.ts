import fs from "node:fs";
import path from "node:path";
import type { ProbeResults } from "../../probe.js";
import { execSafe } from "../utils.js";
import type { LintDiagnostic, LinterRunner } from "./types.js";

export const cargoLinter: LinterRunner = {
  name: "cargo",
  cacheTtl: 15000,

  detect(workspace: string, probes: ProbeResults): boolean {
    return probes.cargo && fs.existsSync(path.join(workspace, "Cargo.toml"));
  },

  async run(cwd: string, signal?: AbortSignal): Promise<LintDiagnostic[]> {
    const result = await execSafe("cargo", ["check", "--message-format=json"], {
      cwd,
      timeout: 60000,
      signal,
    });

    const diagnostics: LintDiagnostic[] = [];
    for (const line of result.stdout.split("\n")) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.reason !== "compiler-message") continue;
        const m = msg.message;
        if (!m?.spans?.[0]) continue;
        const span = m.spans[0];
        diagnostics.push({
          file: span.file_name ?? "",
          line: span.line_start ?? 1,
          column: span.column_start ?? 1,
          severity: m.level === "error" ? "error" : "warning",
          message: m.message ?? "",
          source: "cargo",
          code: m.code?.code,
        });
      } catch {
        /* skip */
      }
    }
    return diagnostics;
  },
};
