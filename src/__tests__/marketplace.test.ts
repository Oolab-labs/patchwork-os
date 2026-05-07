import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMarketplace } from "../commands/marketplace.js";

/**
 * The `marketplace` subcommand is deprecated as of 0.2.0-beta.0 — see
 * issue #279 and the doc-comment at the top of src/commands/marketplace.ts.
 * The only remaining contract is that any invocation prints a migration
 * notice and exits 0; this test suite locks that behaviour in.
 */
describe("runMarketplace (deprecated stub)", () => {
  let stdoutOutput: string[];

  beforeEach(() => {
    stdoutOutput = [];
    vi.spyOn(console, "log").mockImplementation((...args) => {
      stdoutOutput.push(args.join(" "));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const argv of [
    [],
    ["list"],
    ["search", "anything"],
    ["install", "tdd-loop"],
    ["badcmd"],
    ["--help"],
  ]) {
    it(`prints deprecation notice for: marketplace ${argv.join(" ") || "(no args)"}`, async () => {
      await runMarketplace(argv);
      const out = stdoutOutput.join("\n");
      expect(out).toContain("deprecated");
      expect(out).toContain("recipe install");
      expect(out).toContain("#279");
    });
  }

  it("returns normally (no throw, no process.exit) for any argv", async () => {
    await expect(runMarketplace(["whatever"])).resolves.toBeUndefined();
  });
});
