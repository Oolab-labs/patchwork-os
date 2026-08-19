/**
 * A boundary REFUSAL has to name a recipe you can locate, and a remedy you can
 * take.
 *
 * #1469 fixed exactly this on the shadow ledger: `ShadowRow` declared
 * `recipeName`, nothing supplied it, and an operator with 80 installed recipes
 * was handed a count with nothing to act on. Its own commentary said the fix
 * was needed because "the boundary RECEIPT log declares `recipeName` and
 * populates it, so the two records describing the same dispatch disagreed".
 *
 * That reading was half right. `boundaryReceiptLog` DECLARES the field and
 * populates it WHEN GIVEN ONE — and the only supplier,
 * `recordBoundaryDecisionFn` in `yamlRunner`, never passes it. It sits 26 lines
 * below `recordPrivacyShadowFn`, which does. So #1469 attributed the ledger of
 * HYPOTHETICALS and left the ledger of ENFORCED decisions — the one ADR-0021
 * calls the audit record, and the only one that can say why a step actually
 * failed — anonymous.
 *
 * Measured before writing this: nine receipts from four probe runs, three of
 * them LOCAL_ONLY refusals, every one with no `recipeName`.
 *
 * The second half is the refusal TEXT. LOCAL_ONLY reads:
 *
 *     "personal" may not leave the machine; a local destination accepts it
 *
 * — a statement of fact that names a destination the runtime then does not use,
 * and gives the author no way to reach it. The remedy exists and is one line
 * (`driver: local` on the step); the message just never said so. DENY is
 * already honest ("no approval can unlock it") and must NOT acquire a
 * suggestion, because for DENY there is nothing to suggest.
 *
 * Not a payload concern: a recipe name is not the prompt, is already in
 * `runs.jsonl`, and is the attribution metadata #1455 established for evidence
 * records. ADR-0021's "receipts carry no payload field" rule is untouched.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let dir: string;
let home: string;

beforeEach(() => {
  dir = mkdtempSync(join(os.tmpdir(), "receipt-attr-"));
  home = join(dir, "home");
  mkdirSync(home, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * `privacy.destinations` — the ENFORCING key, not `privacy.shadow`. Enabling
 * one must never enable the other, and a test that reached for the shadow key
 * here would prove nothing about the receipt log.
 */
function writeConfig(opts: { withLocal: boolean }): void {
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      privacy: {
        destinations: {
          ...(opts.withLocal
            ? {
                "test-local": {
                  type: "local",
                  classifications: ["public", "internal", "personal"],
                  drivers: ["local"],
                },
              }
            : {}),
          "test-remote": {
            type: "remote",
            classifications: ["public", "internal"],
            drivers: ["claude", "claude-code", "subprocess"],
          },
        },
      },
    }),
  );
}

type Receipt = {
  recipeName?: string;
  decision?: string;
  classification?: string;
};

async function runRecipe(
  name: string,
  step: Record<string, unknown>,
): Promise<{ receipts: Receipt[]; text: string }> {
  const prev = process.env.PATCHWORK_HOME;
  // PATCHWORK_HOME, not a spy on `os.homedir`: a namespace spy misses named
  // imports and has previously let a test write to the developer's real
  // `~/.patchwork`.
  process.env.PATCHWORK_HOME = home;
  try {
    const { runYamlRecipe } = await import("../../recipes/yamlRunner.js");
    const result = await runYamlRecipe(
      {
        name,
        trigger: { type: "manual" },
        steps: [{ id: "think", ...step }],
      } as never,
      {
        testMode: true,
        logDir: dir,
        now: () => new Date("2026-08-19T00:00:00Z"),
        readFile: () => {
          throw new Error("nope");
        },
        writeFile: () => {},
        appendFile: () => {},
        mkdir: () => {},
        gitLogSince: () => "",
        gitStaleBranches: () => "",
        getDiagnostics: () => "",
        claudeFn: async () => "ok",
      } as never,
    );
    let receipts: Receipt[] = [];
    try {
      receipts = readFileSync(join(home, "boundary_receipts.jsonl"), "utf-8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Receipt);
    } catch {
      receipts = [];
    }
    return { receipts, text: JSON.stringify(result) };
  } finally {
    // Restore rather than delete: with PATCHWORK_HOME unset the next reader
    // resolves the developer's real store.
    if (prev === undefined) delete process.env.PATCHWORK_HOME;
    else process.env.PATCHWORK_HOME = prev;
  }
}

describe("a boundary receipt names the recipe that produced it", () => {
  it("attributes a REFUSAL — the row where locating the recipe is the point", async () => {
    writeConfig({ withLocal: true });

    const { receipts } = await runRecipe("personal-to-remote", {
      agent: {
        prompt: "hi",
        driver: "claude-code",
        data_policy: { classification: "personal" },
      },
    });

    const refusal = receipts.find((r) => r.decision === "LOCAL_ONLY");
    expect(refusal).toBeDefined();
    // Without this, an auditor reading the enforcing ledger sees that a
    // `personal` dispatch was stopped and cannot tell which of 80 recipes to go
    // and fix — the exact complaint #1469 fixed one file over.
    expect(refusal?.recipeName).toBe("personal-to-remote");
  });

  it("attributes an ALLOW too, so the ledger is not half-anonymous", async () => {
    writeConfig({ withLocal: true });

    const { receipts } = await runRecipe("personal-stays-home", {
      agent: {
        prompt: "hi",
        driver: "local",
        data_policy: { classification: "personal" },
      },
    });

    const allowed = receipts.find((r) => r.decision === "ALLOW");
    expect(allowed).toBeDefined();
    expect(allowed?.recipeName).toBe("personal-stays-home");
  });
});

describe("a refusal names a remedy only when one exists", () => {
  it("LOCAL_ONLY tells the author how to keep the step on the machine", async () => {
    writeConfig({ withLocal: true });

    const { text } = await runRecipe("needs-pinning", {
      agent: {
        prompt: "hi",
        driver: "claude-code",
        data_policy: { classification: "personal" },
      },
    });

    expect(text).toMatch(/information boundary/);
    // The remedy is one line of YAML and the message never said which line.
    expect(text).toMatch(/driver: local/);
  });

  it("DENY acquires no suggestion, because there is nothing to suggest", async () => {
    // No local destination is registered, so nothing on this machine accepts
    // `personal` and the LOCAL_ONLY branch is unreachable. Telling the author
    // to pin `driver: local` here would send them to configure a destination
    // that does not exist — a remedy that reads as authoritative and fails.
    writeConfig({ withLocal: false });

    const { text } = await runRecipe("nowhere-to-go", {
      agent: {
        prompt: "hi",
        driver: "claude-code",
        data_policy: { classification: "personal" },
      },
    });

    expect(text).toMatch(/information boundary/);
    expect(text).toMatch(/no approval can unlock it/);
    expect(text).not.toMatch(/driver: local/);
  });
});
