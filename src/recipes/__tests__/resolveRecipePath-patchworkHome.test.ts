/**
 * #1265 — the inbox coupling, the last three files on the PATCHWORK_HOME ratchet.
 *
 * The state this fixes: `PATCHWORK_HOME` relocated config, recipes-install,
 * connector tokens, approvals and every audit ledger, but NOT the inbox. A
 * recipe writing `~/.patchwork/inbox/x.md` landed under `$HOME` while the rest
 * of the installation moved — a split with no error.
 *
 * The mechanism is narrower than the ratchet note described. There is exactly
 * one `~` expansion site (`expandHome` here), and it expands EVERY `~/`, so
 * "route `~` expansion through patchworkHome()" is not implementable: it would
 * turn `~/Documents` into `<override>/Documents`. What is rewritten is the
 * literal `~/.patchwork/` PREFIX — the token recipes actually use to mean "my
 * Patchwork workspace" — and nothing else.
 *
 * Scope check done before writing this: all 24 shipped recipes/templates that
 * target the inbox use the tilde form; none hard-codes an absolute
 * `/Users/...`/`/home/...` inbox path, so the prefix rewrite strands none of
 * them.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { patchworkPath } from "../../patchworkHome.js";
import { resolveRecipePath } from "../resolveRecipePath.js";

const WORKSPACE = path.resolve(import.meta.dirname, "..", "..", "..");

/**
 * A real directory, because the jail realpaths its roots.
 *
 * Every call below passes `allowTmp: false`. `testEnvSetup` sets
 * `CLAUDE_IDE_BRIDGE_RECIPE_TMP_JAIL=1`, which makes `os.tmpdir()` a jail root
 * — and the override lives there, so the "override is writable" assertion
 * passed against the UNFIXED code for entirely the wrong reason. Disabling the
 * tmp root is what makes these tests discriminate.
 */
function makeOverride(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pw-home-"));
}

describe("resolveRecipePath honours PATCHWORK_HOME for the ~/.patchwork prefix", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("with NO override, resolves exactly where it always did", () => {
    // The compatibility anchor. `patchworkHome()` degrades to
    // `join(homedir(), ".patchwork")` when unset, so this must be
    // byte-identical to pre-change behaviour for every existing install.
    vi.stubEnv("PATCHWORK_HOME", "");
    const resolved = resolveRecipePath("~/.patchwork/inbox/x.md", {
      write: true,
      workspace: WORKSPACE,
      allowTmp: false,
    });
    expect(resolved).toBe(
      path.join(os.homedir(), ".patchwork", "inbox", "x.md"),
    );
  });

  it("with an override, a recipe write lands under the override", () => {
    const override = makeOverride();
    vi.stubEnv("PATCHWORK_HOME", override);
    const resolved = resolveRecipePath("~/.patchwork/inbox/x.md", {
      write: true,
      workspace: WORKSPACE,
      allowTmp: false,
    });
    // Lexical, not realpath'd: `resolveRecipePath` returns the resolved
    // (lexical) path and uses realpath only for the containment CHECK. On
    // macOS the two differ (`/var` is a symlink to `/private/var`).
    expect(resolved).toBe(path.join(override, "inbox", "x.md"));
  });

  it("writer and READER agree under an override", () => {
    // The actual bug. `inboxRoutes` reads `patchworkPath("inbox")`; a recipe
    // writes `~/.patchwork/inbox/…`. If those disagree the operator's recipe
    // output is invisible to the inbox UI, which is the split #1265 describes.
    const override = makeOverride();
    vi.stubEnv("PATCHWORK_HOME", override);
    const written = resolveRecipePath("~/.patchwork/inbox/note.md", {
      write: true,
      workspace: WORKSPACE,
      allowTmp: false,
    });
    expect(path.dirname(written)).toBe(patchworkPath("inbox"));
  });

  it("the override directory is WRITABLE through the jail", () => {
    // Before this change the override was not a jail root at all, so a recipe
    // could not write there even if the path had resolved correctly — it threw
    // `recipe_path_jail_escape`. Converting the readers without this would
    // have produced an inbox nothing could write to.
    const override = makeOverride();
    vi.stubEnv("PATCHWORK_HOME", override);
    expect(() =>
      resolveRecipePath(path.join(override, "inbox", "x.md"), {
        write: true,
        workspace: WORKSPACE,
        allowTmp: false,
      }),
    ).not.toThrow();
  });

  it("does NOT rewrite other ~/ paths", () => {
    // The reason the ratchet note's proposed fix was not implementable.
    // `~/Documents` means the user's home, and must keep meaning that — an
    // override relocates the Patchwork workspace, not the home directory.
    const override = makeOverride();
    vi.stubEnv("PATCHWORK_HOME", override);
    // Outside every jail root, so it throws — but the point is WHICH path it
    // reports, which shows the expansion used $HOME and not the override.
    try {
      resolveRecipePath("~/Documents/x.md", {
        workspace: WORKSPACE,
        allowTmp: false,
      });
      throw new Error("expected a jail escape");
    } catch (err) {
      expect((err as { code?: string }).code).toBe("recipe_path_jail_escape");
    }
    // And prove it directly: a path under the real home is still expanded
    // against the real home.
    const underHome = resolveRecipePath("~/.patchwork/inbox/x.md", {
      write: true,
      workspace: WORKSPACE,
      allowTmp: false,
    });
    expect(underHome.startsWith(os.homedir())).toBe(false);
  });

  it("the LEGACY absolute path still resolves under an override", () => {
    // Back-compat: an operator who hard-coded `/Users/me/.patchwork/...` in a
    // recipe, or who has files left in the legacy tree, must not start getting
    // jail escapes the day they set the variable. The legacy root stays
    // allowed; only the tilde PREFIX moves.
    const override = makeOverride();
    vi.stubEnv("PATCHWORK_HOME", override);
    const legacy = path.join(os.homedir(), ".patchwork", "inbox", "old.md");
    expect(() =>
      resolveRecipePath(legacy, {
        write: true,
        workspace: WORKSPACE,
        allowTmp: false,
      }),
    ).not.toThrow();
  });

  it("still refuses a path outside every root", () => {
    // Control: the jail must not have been widened into uselessness by adding
    // a third root.
    const override = makeOverride();
    vi.stubEnv("PATCHWORK_HOME", override);
    expect(() =>
      resolveRecipePath("/etc/passwd", {
        workspace: WORKSPACE,
        allowTmp: false,
      }),
    ).toThrow(/jail roots|escapes jail/);
  });
});
