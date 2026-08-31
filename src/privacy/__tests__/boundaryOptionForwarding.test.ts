/**
 * If you resolved a destination, forward what the resolver told you.
 *
 * `resolveDestination` returns `{ destination, localDestinationAccepts }`, and
 * `decideBoundary` can only offer `LOCAL_ONLY` — "a local destination accepts
 * it" — when it is handed that second value. A caller that resolves and then
 * passes only the destination silently converts every `LOCAL_ONLY` into a
 * `DENY`.
 *
 * That happened. #1554 wired orchestrator enforcement and dropped the flag at
 * both of its call sites, so the same registry and the same classification gave
 * `LOCAL_ONLY` on the recipe path and `DENY` on the orchestrator path. It
 * survived its own unit tests because they asserted the dispatch was REFUSED,
 * and it was — only the operator-facing reason was wrong, and nothing asserted
 * on reasons. It was found by running the installed build after a deploy.
 *
 * ## Why a source guard and not a required parameter
 *
 * Making the third argument mandatory would be the stronger enforcement and is
 * the wrong trade: 14 test call sites legitimately omit it, because "no local
 * destination accepts this" is a real and readable default. Requiring it would
 * push `{ localDestinationAccepts: undefined }` into all of them to defend
 * against two sites that had the value in hand and dropped it.
 *
 * So the rule pinned here is the narrow, accurate one: a PRODUCTION file that
 * calls both functions must forward the flag. A file that never resolves has
 * nothing to forward and is not covered — deliberately, because widening this
 * to "every call must pass it" would re-create the bad trade above in test form.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

/** Production files that pair the resolver with the decision. */
const PAIRED_FILES = ["claudeOrchestrator.ts", "recipes/agentExecutor.ts"];

function read(rel: string): string {
  return readFileSync(path.join(SRC, rel), "utf-8");
}

/**
 * The argument text of each `name(...)` call, by balanced parentheses.
 *
 * NOT a count of how often the identifier appears in the file. The first
 * version of this guard did exactly that and could not fail: the explanatory
 * comment beside the fix mentions `localDestinationAccepts` several times, so
 * deleting a real forward left the tally above the threshold. Probed by
 * removing one, watching it stay green, and rewriting — the same trap this
 * repository has now recorded three times.
 */
function callArgumentsOf(src: string, name: string): string[] {
  const out: string[] = [];
  const needle = `${name}(`;
  let from = 0;
  for (;;) {
    const at = src.indexOf(needle, from);
    if (at === -1) break;
    let depth = 0;
    let i = at + needle.length - 1;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(src.slice(at + needle.length, i));
    from = i + 1;
  }
  return out;
}

describe("decideBoundary callers forward localDestinationAccepts", () => {
  for (const rel of PAIRED_FILES) {
    it(`${rel} forwards it at every decideBoundary call`, () => {
      const src = read(rel);
      // Only meaningful for a file that actually resolves a destination.
      expect(
        src.includes("resolveDestination("),
        `${rel} no longer calls resolveDestination — this guard's premise is ` +
          "gone and the file list needs revisiting, not the assertion",
      ).toBe(true);

      const calls = callArgumentsOf(src, "decideBoundary");
      expect(calls.length).toBeGreaterThan(0);
      calls.forEach((args, i) => {
        expect(
          args.includes("localDestinationAccepts"),
          `${rel}: decideBoundary call #${i + 1} does not forward ` +
            "localDestinationAccepts. A caller that resolved a destination and " +
            "did not forward the flag turns every LOCAL_ONLY into a DENY — the " +
            "refusal still happens, so nothing fails, but the operator is told " +
            "no approval can unlock data a local destination would accept.",
        ).toBe(true);
      });
    });
  }

  it("covers every production file that pairs them (no fourth site)", () => {
    // The list above is hand-maintained, which is exactly how a fourth call
    // site escapes a guard like this. #1554's own defect was two of three
    // sites; a guard that only knows about the sites someone remembered is the
    // same failure one layer up.
    const orchestrator = read("claudeOrchestrator.ts");
    const executor = read("recipes/agentExecutor.ts");
    const known = orchestrator + executor;
    const totalCalls = callArgumentsOf(known, "decideBoundary").length;
    // 2 in the orchestrator + 1 in the executor. If this changes, a call site
    // was added or moved and the list above must be revisited deliberately.
    expect(totalCalls).toBe(3);
  });
});
