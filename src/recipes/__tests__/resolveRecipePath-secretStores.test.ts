/**
 * The recipe path jail allows the Patchwork home and the workspace, and the
 * runtime keeps its own secret stores inside the Patchwork home. A recipe
 * step (file.read / file.write / file.append) therefore could read or
 * overwrite them: connector client secrets, the encrypted connector tokens
 * and the key that decrypts them, member credentials, the session secret.
 * Agent steps are kept away from the same files by secretPathDenies; the
 * jail must refuse them too, with the same list, so the two cannot drift.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveRecipePath } from "../resolveRecipePath.js";

let home: string;
let workspace: string;

function touch(p: string) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "x");
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "pw-secret-home-"));
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pw-secret-ws-"));
  vi.stubEnv("PATCHWORK_HOME", home);
  vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(home, "claude-config"));
  for (const f of [
    ".secrets.json",
    "tokens/.master.key",
    "tokens/acct-0001.enc",
    "credentials.json",
    ".env",
    "inbox/note.md",
    "recipes/noisy-recipe.yaml",
  ]) {
    touch(path.join(home, f));
  }
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
});

const opts = (write = false) => ({ workspace, write, allowTmp: false });
const code = (fn: () => unknown) => {
  try {
    fn();
    return "allowed";
  } catch (e) {
    return (e as { code?: string }).code ?? "threw";
  }
};

describe("recipe path jail refuses the runtime's secret stores", () => {
  it.each([
    ".secrets.json",
    "tokens/.master.key",
    "tokens/acct-0001.enc",
    "credentials.json",
    ".env",
  ])("refuses reading %s by absolute path", (f) => {
    expect(code(() => resolveRecipePath(path.join(home, f), opts()))).toBe(
      "recipe_path_jail_escape",
    );
  });

  it("refuses the ~/.patchwork form recipes actually use", () => {
    expect(
      code(() => resolveRecipePath("~/.patchwork/.secrets.json", opts())),
    ).toBe("recipe_path_jail_escape");
    expect(
      code(() => resolveRecipePath("~/.patchwork/tokens/.master.key", opts())),
    ).toBe("recipe_path_jail_escape");
  });

  it("refuses writing or appending to a secret store", () => {
    expect(
      code(() =>
        resolveRecipePath(path.join(home, ".secrets.json"), opts(true)),
      ),
    ).toBe("recipe_path_jail_escape");
    expect(
      code(() =>
        resolveRecipePath(path.join(home, "tokens", "new.enc"), opts(true)),
      ),
    ).toBe("recipe_path_jail_escape");
  });

  it("refuses a workspace symlink that points into a secret store", () => {
    const link = path.join(workspace, "innocent.json");
    fs.symlinkSync(path.join(home, ".secrets.json"), link);
    expect(code(() => resolveRecipePath(link, opts()))).toBe(
      "recipe_path_jail_escape",
    );
  });

  it("still allows the rest of the Patchwork home and the workspace", () => {
    expect(
      code(() =>
        resolveRecipePath(path.join(home, "inbox", "note.md"), opts()),
      ),
    ).toBe("allowed");
    expect(
      code(() =>
        resolveRecipePath("~/.patchwork/recipes/noisy-recipe.yaml", opts()),
      ),
    ).toBe("allowed");
    touch(path.join(workspace, "data.json"));
    expect(
      code(() => resolveRecipePath(path.join(workspace, "data.json"), opts())),
    ).toBe("allowed");
    expect(
      code(() =>
        resolveRecipePath(path.join(home, "inbox", "out.md"), opts(true)),
      ),
    ).toBe("allowed");
  });
});
