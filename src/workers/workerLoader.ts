import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { parseWorker, type WorkerManifest } from "./worker.js";

/**
 * Load worker manifests from a directory of `*.worker.yaml` files. Fail-soft:
 * a malformed worker file is skipped (logged by the caller if a logger is
 * passed), never fatal — one bad manifest must not blind the whole dial.
 */
export function loadWorkersFromDir(
  dir: string,
  log?: (msg: string) => void,
): WorkerManifest[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const workers: WorkerManifest[] = [];
  for (const f of entries) {
    if (!/\.worker\.ya?ml$/i.test(f)) continue;
    try {
      workers.push(
        parseWorker(parseYaml(readFileSync(path.join(dir, f), "utf-8"))),
      );
    } catch (err) {
      log?.(
        `[workers] skipped ${f} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return workers.sort((a, b) => a.id.localeCompare(b.id));
}
