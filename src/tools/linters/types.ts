import type { ProbeResults } from "../../probe.js";

export interface LintDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "information" | "hint";
  message: string;
  source: string;
  code?: string | number;
}

export interface LinterRunner {
  name: string;
  detect(workspace: string, probes: ProbeResults): boolean;
  run(cwd: string, signal?: AbortSignal): Promise<LintDiagnostic[]>;
  cacheTtl: number;
}
