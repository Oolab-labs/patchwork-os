import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// `src/index.ts` is a top-of-script executable: importing it runs the
// subcommand dispatch side effects against the live `process.argv`. So instead
// of importing, we extract the `KNOWN_SUBCOMMANDS` array literal from source and
// replicate the exact membership predicate the dispatch gate (L201) and the
// "Did you mean?" suggester (L4309) both use:
//   KNOWN_SUBCOMMANDS.includes(sub)
//
// A subcommand absent from this list either falls through to the bridge daemon
// path or trips the unknown-command suggester — the dispatch-race class the
// file's own header comments warn about.
function loadKnownSubcommands(): string[] {
  const indexPath = fileURLToPath(new URL("../index.ts", import.meta.url));
  const source = readFileSync(indexPath, "utf-8");
  const match = /const KNOWN_SUBCOMMANDS = \[([\s\S]*?)\] as const;/.exec(
    source,
  );
  if (!match?.[1]) {
    throw new Error("Could not locate KNOWN_SUBCOMMANDS array in src/index.ts");
  }
  return Array.from(match[1].matchAll(/"([^"]+)"/g), (m) => m[1] as string);
}

const KNOWN_SUBCOMMANDS = loadKnownSubcommands();

// Mirror the production predicate (L201 / L4309).
function isKnownSubcommand(sub: string): boolean {
  return KNOWN_SUBCOMMANDS.includes(sub);
}

describe("KNOWN_SUBCOMMANDS dispatch allowlist", () => {
  // Each of these is dispatched by a real `if (process.argv[2] === "...")`
  // block in src/index.ts whose handler owns the process (calls process.exit
  // directly or via the imported task/token-efficiency handler).
  const dispatchedSubcommands = [
    "quick-task", // L589 -> runQuickTask
    "start-task", // L594 -> runStartTask
    "continue-handoff", // L598 -> runContinueHandoff
    "token-efficiency", // L762 -> tokenEfficiencyStatus/Benchmark
  ];

  it.each(
    dispatchedSubcommands,
  )("recognizes %s as a known subcommand (not 'did you mean')", (sub) => {
    expect(isKnownSubcommand(sub)).toBe(true);
  });

  it("still rejects a genuinely unknown subcommand", () => {
    expect(isKnownSubcommand("totally-bogus-command")).toBe(false);
  });
});
