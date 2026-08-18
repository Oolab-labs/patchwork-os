/**
 * Incremental vitest progress reporter (#1365).
 *
 * The problem it exists for: on windows-latest the Test/Coverage step has
 * repeatedly been KILLED at its `timeout-minutes` cap rather than failing. A
 * SIGTERM'd vitest flushes no summary, so the log simply stops — and "the run
 * ended without finishing" is then indistinguishable from a quiet pass, because
 * absence of output is exactly what a dying process produces. Every remedy so
 * far (5 -> 10 minute bump) was chosen without knowing which test was in flight,
 * because that information only ever existed inside the process being killed.
 *
 * Every other reporter writes its result at the END, which is precisely the
 * moment that never arrives. So this one appends synchronously as it goes:
 * whatever has happened is already on disk before the kill lands. Modules with
 * a `module-start` and no `module-end` are what was in flight.
 *
 * Module-level, not case-level, deliberately: 733 modules costs ~1.5k appends,
 * where 10k cases would add sync I/O to the hot path on the very platform whose
 * I/O is already the suspect.
 *
 * Never allowed to break a run. A diagnostic that can fail the suite it is
 * diagnosing is worse than no diagnostic, so every write is swallowed.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const OUT = resolve(
  process.env.VITEST_PROGRESS_FILE ?? "vitest-progress.jsonl",
);

export default class VitestProgressReporter {
  #write(event) {
    try {
      appendFileSync(OUT, `${JSON.stringify({ t: Date.now(), ...event })}\n`);
    } catch {
      // A diagnostic must never fail the run it is diagnosing.
    }
  }

  onInit() {
    try {
      mkdirSync(dirname(OUT), { recursive: true });
    } catch {
      // best-effort
    }
    this.#write({
      ev: "run-start",
      pid: process.pid,
      platform: process.platform,
      node: process.version,
      step: process.env.npm_lifecycle_event ?? "unknown",
    });
  }

  onTestModuleStart(m) {
    this.#write({ ev: "module-start", file: m?.moduleId });
  }

  onTestModuleEnd(m) {
    let state;
    try {
      state = typeof m?.state === "function" ? m.state() : undefined;
    } catch {
      state = undefined;
    }
    this.#write({ ev: "module-end", file: m?.moduleId, state });
  }

  onTestRunEnd(_modules, _errors, reason) {
    // Reaching this line at all is the signal: the run finished on its own
    // terms. Its ABSENCE from the file is what identifies a killed run.
    this.#write({ ev: "run-end", reason });
  }
}
