import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { LEGACY_INIT_BIN, resolveInitTarget } from "../initDispatch.js";

const distIndex = path.resolve(
  import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
  "../../dist/index.js",
);

/**
 * `init --help` is the discriminator: both paths handle it and print
 * distinguishable first lines, without scaffolding ~/.patchwork or touching
 * the developer's real ~/.claude/settings.json.
 */
function initHelp(env: NodeJS.ProcessEnv): string {
  const r = spawnSync(process.execPath, [distIndex, "init", "--help"], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return `${r.stdout}${r.stderr}`;
}

describe("resolveInitTarget", () => {
  it("sends the documented onboarding bins to the Patchwork setup", () => {
    expect(resolveInitTarget("patchwork-os")).toBe("patchwork");
    expect(resolveInitTarget("patchwork")).toBe("patchwork");
  });

  it("keeps the legacy bin on the IDE-bridge installer", () => {
    expect(resolveInitTarget(LEGACY_INIT_BIN)).toBe("bridge");
  });

  /**
   * The regression that broke published onboarding. Under
   * `npx patchwork-os@beta init`, `process.env._` is the parent's value (not
   * the bin), so `invokedBinaryName()` falls through to `basename(argv[1])` —
   * `index`, from `dist/index.js`. Verified empirically against the published
   * 1.1.0-beta.4: it printed `claude-ide-bridge init — One-command setup`.
   */
  it("sends npx/npm shim artifacts to the Patchwork setup, not the legacy path", () => {
    for (const shimName of ["index", "node", "npx", ""]) {
      expect(
        resolveInitTarget(shimName),
        `bin name ${JSON.stringify(shimName)}`,
      ).toBe("patchwork");
    }
  });

  it("matches the legacy bin case- and whitespace-insensitively", () => {
    // Windows shims and shell quirks can vary the casing of argv[1].
    expect(resolveInitTarget("CLAUDE-IDE-BRIDGE")).toBe("bridge");
    expect(resolveInitTarget(" claude-ide-bridge ")).toBe("bridge");
  });
});

/**
 * The unit tests above prove the rule; these prove it is actually WIRED. The
 * shipped bug was not a wrong rule — it was a correct-looking condition in
 * index.ts reading a variable npx does not set.
 */
describe("init dispatch end-to-end", () => {
  beforeAll(() => {
    if (!fs.existsSync(distIndex)) {
      throw new Error("dist/index.js not found — run npm run build first");
    }
  });

  it("reaches the Patchwork setup when env._ is absent (the npx shape)", () => {
    // Reproduces `npx patchwork-os@beta init`, which shipped broken: argv[1]
    // basenames to `index`, so the old `=== "patchwork-os"` check was false.
    const out = initHelp({ _: undefined });

    expect(out).toContain("patchwork-os init — Set up ~/.patchwork");
    expect(out).not.toContain("One-command setup");
  });

  it("reaches the Patchwork setup when invoked as `patchwork`", () => {
    const out = initHelp({ _: "/usr/local/bin/patchwork" });

    expect(out).toContain("patchwork-os init — Set up ~/.patchwork");
  });

  it("still reaches the legacy IDE-bridge installer as `claude-ide-bridge`", () => {
    const out = initHelp({ _: `/usr/local/bin/${LEGACY_INIT_BIN}` });

    expect(out).toContain("claude-ide-bridge init — One-command setup");
    expect(out).not.toContain("Set up ~/.patchwork");
  });

  it("advertises a flag `init` actually accepts", () => {
    // The top-level index promised `init [--workspace <dir>]`, a legacy-only
    // flag, for a command that now takes --with-connectors.
    const r = spawnSync(process.execPath, [distIndex, "--help"], {
      encoding: "utf8",
    });
    const helpLine = `${r.stdout}`
      .split("\n")
      .find((l) => /^\s+init\s/.test(l));

    expect(helpLine).toBeDefined();
    expect(helpLine).toContain("--with-connectors");
  });
});
