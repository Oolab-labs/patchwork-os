import type { ProbeResults } from "../../probe.js";

export type TestStatus = "passed" | "failed" | "skipped" | "errored";

export interface TestResult {
  name: string;
  status: TestStatus;
  file: string;
  line: number;
  column: number;
  duration: number;
  message: string;
  source: string;
}

export interface TestRunner {
  name: string;
  detect(workspace: string, probes: ProbeResults): boolean;
  run(
    cwd: string,
    filter?: string,
    signal?: AbortSignal,
  ): Promise<TestResult[]>;
  cacheTtl: number;
}
