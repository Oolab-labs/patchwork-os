/**
 * resolveRecipePath — recipe-runner path-jail unit tests.
 *
 * Covers G-security F-01 / F-02 / R2 C-1 / R2 C-2 / R2 C-3 / R2 M-4:
 *   - null-byte rejection
 *   - lexical traversal rejection (`..` outside all roots)
 *   - symlink-escape rejection (link target outside roots)
 *   - hardlink-escape rejection on writes
 *   - in-jail paths resolve cleanly
 *   - `/tmp` rejected unless `CLAUDE_IDE_BRIDGE_RECIPE_TMP_JAIL=1`
 *   - error code is `recipe_path_jail_escape` (not message-matched)
 */

import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  resolveRecipePath,
  tryResolveRecipePath,
} from "../resolveRecipePath.js";

// Hermetic test homedir — a fresh dir that holds the .patchwork jail root
// so we never touch the developer's real ~/.
const homeDir = mkdtempSync(path.join(os.tmpdir(), "resolveRecipePath-home-"));
const patchworkDir = path.join(homeDir, ".patchwork");
const inboxDir = path.join(patchworkDir, "inbox");
const workspaceDir = mkdtempSync(
  path.join(os.tmpdir(), "resolveRecipePath-ws-"),
);
const outsideDir = mkdtempSync(
  path.join(os.tmpdir(), "resolveRecipePath-outside-"),
);

beforeAll(() => {
  mkdirSync(inboxDir, { recursive: true });
});

afterAll(() => {
  for (const dir of [homeDir, workspaceDir, outsideDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveRecipePath", () => {
  it("rejects null bytes with err.code === 'recipe_path_jail_escape'", () => {
    expect.assertions(2);
    try {
      resolveRecipePath("~/.patchwork/inbox/foo\x00.txt", { homeDir });
    } catch (err) {
      expect((err as { code?: string }).code).toBe("recipe_path_jail_escape");
      expect(err).toBeInstanceOf(Error);
    }
  });

  it("rejects lexical traversal that escapes all roots", () => {
    expect.assertions(1);
    try {
      // homeDir is itself inside os.tmpdir() in tests, so tmp-jail must be
      // OFF for `..` to actually escape every active root.
      resolveRecipePath("~/.patchwork/inbox/../../../../../etc/passwd", {
        homeDir,
        workspace: workspaceDir,
        allowTmp: false,
      });
    } catch (err) {
      expect((err as { code?: string }).code).toBe("recipe_path_jail_escape");
    }
  });

  it("accepts a path inside ~/.patchwork", () => {
    const result = resolveRecipePath("~/.patchwork/inbox/safe.txt", {
      homeDir,
    });
    expect(result).toBe(path.join(inboxDir, "safe.txt"));
  });

  it("accepts a relative path inside the workspace root", () => {
    const result = resolveRecipePath("notes/a.md", {
      homeDir,
      workspace: workspaceDir,
    });
    expect(result).toBe(path.join(workspaceDir, "notes/a.md"));
  });

  it("rejects /tmp when CLAUDE_IDE_BRIDGE_RECIPE_TMP_JAIL is unset (default)", () => {
    expect.assertions(1);
    try {
      // Pick an /tmp-derived path that's NOT inside our test workspace.
      const tmpTarget = path.join(os.tmpdir(), "definitely-not-in-jail.txt");
      resolveRecipePath(tmpTarget, {
        homeDir,
        workspace: workspaceDir,
        // explicit override to mirror "env var unset" without touching env
        allowTmp: false,
      });
    } catch (err) {
      expect((err as { code?: string }).code).toBe("recipe_path_jail_escape");
    }
  });

  it("accepts /tmp when the opt-in flag is set", () => {
    const tmpTarget = path.join(
      mkdtempSync(path.join(os.tmpdir(), "rrp-allowtmp-")),
      "ok.txt",
    );
    const result = resolveRecipePath(tmpTarget, {
      homeDir,
      workspace: workspaceDir,
      allowTmp: true,
    });
    expect(result).toBe(path.resolve(tmpTarget));
  });

  it("rejects a symlink whose target lives outside the jail", () => {
    const linkPath = path.join(inboxDir, "evil-link");
    // outsideDir is itself in /tmp; with tmp-jail OFF the symlink target
    // escapes every allowed root.
    const target = path.join(outsideDir, "real");
    mkdirSync(target, { recursive: true });
    symlinkSync(target, linkPath);

    expect.assertions(1);
    try {
      resolveRecipePath(linkPath, {
        homeDir,
        workspace: workspaceDir,
        allowTmp: false,
      });
    } catch (err) {
      expect((err as { code?: string }).code).toBe("recipe_path_jail_escape");
    }
  });

  it("rejects a hardlink on writes (nlink > 1)", () => {
    // Create a real file inside the jail, then hardlink it from inside the
    // jail too — the link itself is inside the jail but writes through it
    // mutate the original inode. resolveFilePath uses the same nlink>1
    // heuristic; for this test we just need a file with two hard links.
    const original = path.join(inboxDir, "original.txt");
    writeFileSync(original, "hi");
    const link = path.join(inboxDir, "hardlink.txt");
    linkSync(original, link);

    expect.assertions(1);
    try {
      resolveRecipePath(link, {
        homeDir,
        workspace: workspaceDir,
        write: true,
      });
    } catch (err) {
      expect((err as { code?: string }).code).toBe("recipe_path_jail_escape");
    }
  });

  it("does not throw on hardlinks for read paths", () => {
    const original = path.join(inboxDir, "read-original.txt");
    writeFileSync(original, "hi");
    const link = path.join(inboxDir, "read-hardlink.txt");
    linkSync(original, link);
    expect(() =>
      resolveRecipePath(link, { homeDir, workspace: workspaceDir }),
    ).not.toThrow();
  });

  it("rejects empty strings and non-strings with the jail code", () => {
    expect.assertions(2);
    try {
      resolveRecipePath("", { homeDir });
    } catch (err) {
      expect((err as { code?: string }).code).toBe("recipe_path_jail_escape");
    }
    try {
      resolveRecipePath(null as unknown as string, { homeDir });
    } catch (err) {
      expect((err as { code?: string }).code).toBe("recipe_path_jail_escape");
    }
  });

  it("creates non-existent paths inside the jail without errors (mkdir-style)", () => {
    // The runner often passes a path whose dirname doesn't exist yet —
    // ensureDir then mkdirSync(recursive:true) creates it. The jail must
    // not require the path to already exist.
    const fresh = path.join(inboxDir, "subdir-that-does-not-exist", "x.txt");
    expect(() =>
      resolveRecipePath(fresh, {
        homeDir,
        workspace: workspaceDir,
        write: true,
      }),
    ).not.toThrow();
  });

  // Sanity — guarantee tryResolveRecipePath swallows the throw.
  it("tryResolveRecipePath returns null on jail escape", () => {
    // tmp-jail OFF: `..` from $HOME escapes every allowed root.
    expect(
      tryResolveRecipePath("~/.patchwork/../../../../../../etc/passwd", {
        homeDir,
        workspace: workspaceDir,
        allowTmp: false,
      }),
    ).toBeNull();
  });

  it("tryResolveRecipePath returns the resolved path on success", () => {
    expect(tryResolveRecipePath("~/.patchwork/inbox/ok.txt", { homeDir })).toBe(
      path.join(inboxDir, "ok.txt"),
    );
  });

  // Make sure the helper actually walks ancestor-realpath. We create a
  // symlinked-ancestor scenario where the leaf doesn't exist but a parent
  // is a symlink pointing into outsideDir — the walk must catch that.
  it("rejects a non-existent leaf whose ancestor symlinks outside the jail", () => {
    const linkParent = path.join(inboxDir, "ancestor-link");
    symlinkSync(outsideDir, linkParent);
    const leaf = path.join(linkParent, "still-not-a-file.txt");
    expect.assertions(1);
    try {
      // tmp-jail OFF — outsideDir lives in /tmp.
      resolveRecipePath(leaf, {
        homeDir,
        workspace: workspaceDir,
        allowTmp: false,
      });
    } catch (err) {
      expect((err as { code?: string }).code).toBe("recipe_path_jail_escape");
    }
  });
});
