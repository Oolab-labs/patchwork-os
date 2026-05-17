#!/usr/bin/env node
/**
 * IntelliJ ↔ VSCode wire-method parity ratchet.
 *
 * Enumerates the wire methods registered by both extensions and fails CI if
 * the IntelliJ plugin is missing a method the VSCode extension knows about.
 * Stub handlers are fine — they satisfy the wire contract, they just signal
 * "not implemented in this IDE." Missing entirely means a bridge-side tool
 * that calls this method will silently 404 on JetBrains hosts.
 *
 * Method discovery:
 *   VSCode side — wire methods live as quoted `"extension/<name>"` literals
 *     in any of the handler files under `vscode-extension/src/handlers/*.ts`.
 *     Early versions of this script scanned only `index.ts`, which under-
 *     reported the real handler count by ~40% (audit 2026-05-17): methods
 *     registered via factory files like `lsp.ts`, `debug.ts`, `decorations.ts`
 *     fell through and the script emitted false-positive "extra in IJ"
 *     warnings for handlers that IJ correctly mirrored. Now we read every
 *     .ts file in the handlers/ directory.
 *   IntelliJ side — `intellij-plugin/.../bridge/BridgeService.kt` declares
 *     each method via `register("methodName", HandlerClass())` (or a loop
 *     over a stub-method list).
 *
 * Both sides are parsed with cheap regexes (no TS/Kotlin compiler). The
 * discovery regexes are anchored on the patterns already used in those
 * files; if the patterns change, this script needs to be updated alongside.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const VSCODE_HANDLERS_DIR = join(
  repoRoot,
  "vscode-extension",
  "src",
  "handlers",
);
const IJ_BRIDGE_SERVICE = join(
  repoRoot,
  "intellij-plugin",
  "src",
  "main",
  "kotlin",
  "com",
  "patchwork",
  "bridge",
  "BridgeService.kt",
);

function readSrc(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    console.error(`audit-intellij-parity: cannot read ${path}: ${err.message}`);
    process.exit(2);
  }
}

function listHandlerFiles(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
      .map((f) => join(dir, f));
  } catch (err) {
    console.error(`audit-intellij-parity: cannot list ${dir}: ${err.message}`);
    process.exit(2);
  }
}

function extractVsCodeMethods() {
  // Wire methods are namespaced (`extension/getDiagnostics`), so they appear
  // as quoted keys in handler maps. Scan every .ts file in handlers/ for the
  // `"extension/<name>"` literal — the regex `"\s*:` anchor (key-of-object
  // shape) is unambiguous and catches every shape we ship today:
  //   - baseHandlers object map in index.ts
  //   - lsp.ts / debug.ts / decorations.ts factory return values
  //   - Module-level handler maps in fileWatcher.ts, terminal.ts, etc.
  // Files that mention "extension/foo" in a comment or string-but-not-key
  // are tolerated — false positives produce a slightly larger VSCode set,
  // never a smaller one, which keeps the parity check conservative.
  const methods = new Set();
  const files = listHandlerFiles(VSCODE_HANDLERS_DIR);
  // Capture both `"extension/foo":` (object-literal key) and
  // `"extension/foo": handlerFn` shapes uniformly via a trailing `:`.
  const re = /"(extension\/[a-zA-Z][a-zA-Z0-9_]*)"\s*:/g;
  for (const file of files) {
    const src = readSrc(file);
    let m;
    while ((m = re.exec(src)) !== null) {
      methods.add(m[1]);
    }
  }
  if (methods.size === 0) {
    console.error(
      "audit-intellij-parity: could not extract any wire methods from vscode-extension/src/handlers/*.ts — regex out of date?",
    );
    process.exit(2);
  }
  return methods;
}

function extractIjMethods(src) {
  // IJ registers wire methods two ways:
  //   1. Direct: `handlerRegistry.register("extension/foo", FooHandler())`
  //   2. Loop:   `val stubs = listOf("extension/a", "extension/b", ...);
  //                for (m in stubs) handlerRegistry.register(m, stub)`
  // We grab any quoted "extension/..." literal in the file. False positives
  // are unlikely — wire-method strings don't appear in unrelated contexts
  // in BridgeService.kt — and the cost of an extra match is just an extra
  // entry in the IJ side of the diff (which can't fail CI).
  const methods = new Set();
  const re = /"(extension\/[a-zA-Z][a-zA-Z0-9_/]*)"/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    methods.add(m[1]);
  }
  return methods;
}

const ijSrc = readSrc(IJ_BRIDGE_SERVICE);

const vscodeMethods = extractVsCodeMethods();
const ijMethods = extractIjMethods(ijSrc);

const missingInIj = [...vscodeMethods].filter((m) => !ijMethods.has(m)).sort();
const extraInIj = [...ijMethods].filter((m) => !vscodeMethods.has(m)).sort();

console.log(`VSCode wire methods : ${vscodeMethods.size}`);
console.log(`IntelliJ wire methods: ${ijMethods.size}`);

if (missingInIj.length > 0) {
  console.error(
    `\nFAIL: ${missingInIj.length} VSCode wire methods missing in IntelliJ plugin:`,
  );
  for (const m of missingInIj) console.error(`  - ${m}`);
  console.error(
    "\nFix: add a handler (real or stub returning the documented empty shape) in",
  );
  console.error(
    "  intellij-plugin/src/main/kotlin/com/patchwork/bridge/BridgeService.kt registerHandlers().",
  );
  console.error(
    "  Stub handlers are acceptable — they make the wire contract explicit.\n",
  );
  process.exit(1);
}

if (extraInIj.length > 0) {
  console.warn(
    `\nWARN: ${extraInIj.length} methods registered in IntelliJ but not in VSCode (likely VSCode-only or stale):`,
  );
  for (const m of extraInIj) console.warn(`  - ${m}`);
  console.warn(
    "\nNot a CI fail — IntelliJ may have implemented something ahead of VSCode, or the VSCode entry was renamed.",
  );
}

console.log("\nOK: IntelliJ has handlers for every VSCode wire method.");
