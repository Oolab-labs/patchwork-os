/**
 * Phase 0β — yamlRunner inbox provenance.
 *
 * A recipe whose `file.write` targets `~/.patchwork/inbox/<name>.md` must:
 *   1. Prepend a YAML frontmatter block to the written content (recipe
 *      name, trigger, deliveredAt — plus runSeq when set).
 *   2. Record the delivered filename onto an `inboxOutputs` array
 *      surfaced via the result + the run-log row.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../patchworkConfig.js", async () => {
  const actual = await vi.importActual<typeof import("../patchworkConfig.js")>(
    "../patchworkConfig.js",
  );
  return { ...actual, loadConfig: vi.fn(() => ({})) };
});

import {
  isInboxPathFor,
  runYamlRecipe,
  type YamlRecipe,
} from "../recipes/yamlRunner.js";

let fakeHome = "";
let realHome: string | undefined;

beforeEach(() => {
  fakeHome = mkdtempSync(path.join(os.tmpdir(), "yaml-inbox-prov-"));
  realHome = process.env.HOME;
  process.env.HOME = fakeHome;
});
afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  if (fakeHome) rmSync(fakeHome, { recursive: true, force: true });
});

describe("isInboxPathFor — separator-agnostic detection (Windows regression)", () => {
  // PR #742 follow-up: the original literal-`/` prefix never matched on
  // Windows because `os.homedir()` returns `C:\Users\…` and resolved
  // recipe paths use `\` separators. This unit drives both POSIX and
  // Win32 path semantics by injecting the path module — no real
  // filesystem touched, so the test is cross-platform.
  it("matches a direct child under the POSIX inbox dir", () => {
    expect(
      isInboxPathFor(
        "/home/u/.patchwork/inbox/brief.md",
        "/home/u/.patchwork/inbox",
        path.posix,
      ),
    ).toBe(true);
  });
  it("matches a direct child under a Win32 inbox dir with `\\` separators", () => {
    expect(
      isInboxPathFor(
        "C:\\Users\\u\\.patchwork\\inbox\\brief.md",
        "C:\\Users\\u\\.patchwork\\inbox",
        path.win32,
      ),
    ).toBe(true);
  });
  it("rejects dotfiles + the .archive subnamespace", () => {
    expect(
      isInboxPathFor(
        "/home/u/.patchwork/inbox/.archive",
        "/home/u/.patchwork/inbox",
        path.posix,
      ),
    ).toBe(false);
  });
  it("rejects nested children (inbox/sub/foo.md)", () => {
    expect(
      isInboxPathFor(
        "/home/u/.patchwork/inbox/sub/foo.md",
        "/home/u/.patchwork/inbox",
        path.posix,
      ),
    ).toBe(false);
    expect(
      isInboxPathFor(
        "C:\\Users\\u\\.patchwork\\inbox\\sub\\foo.md",
        "C:\\Users\\u\\.patchwork\\inbox",
        path.win32,
      ),
    ).toBe(false);
  });
  it("rejects paths outside the inbox dir (`..` escape)", () => {
    expect(
      isInboxPathFor(
        "/home/u/.patchwork/other/foo.md",
        "/home/u/.patchwork/inbox",
        path.posix,
      ),
    ).toBe(false);
  });
  it("rejects the inbox dir itself", () => {
    expect(
      isInboxPathFor(
        "/home/u/.patchwork/inbox",
        "/home/u/.patchwork/inbox",
        path.posix,
      ),
    ).toBe(false);
  });
});

describe("yamlRunner — inbox provenance", () => {
  it("prepends frontmatter on file.write to ~/.patchwork/inbox/ and records inboxOutputs", async () => {
    const written: Record<string, string> = {};
    const recipe: YamlRecipe = {
      name: "morning-brief",
      trigger: { type: "manual" },
      steps: [
        {
          tool: "file.write",
          path: "~/.patchwork/inbox/brief.md",
          content: "# Brief\n\nbody\n",
        },
      ],
    } as YamlRecipe;

    const result = await runYamlRecipe(recipe, {
      now: () => new Date("2026-05-20T08:00:00Z"),
      logDir: fakeHome,
      readFile: () => {
        throw new Error("not found");
      },
      writeFile: (p, c) => {
        written[p] = c;
      },
      appendFile: () => {},
      mkdir: () => {},
      gitLogSince: () => "",
      gitStaleBranches: () => "",
      getDiagnostics: () => "",
    });

    expect(result.stepsRun).toBe(1);
    const writtenPaths = Object.keys(written);
    expect(writtenPaths).toHaveLength(1);
    const content = written[writtenPaths[0] as string] as string;
    expect(content).toMatch(/^---\nrecipe: morning-brief\n/);
    // yamlRunner normalises trigger kinds outside {cron,webhook,recipe}
    // to "recipe" for the run-log; the frontmatter mirrors that.
    expect(content).toContain("trigger: recipe");
    expect(content).toContain("deliveredAt:");
    expect(content).toContain("# Brief");
    // Closing delimiter present + a blank line before body.
    expect(content).toMatch(/---\n\n/);
  });

  it("non-inbox paths pass through unchanged", async () => {
    const written: Record<string, string> = {};
    const tmp = mkdtempSync(path.join(os.tmpdir(), "non-inbox-"));
    const target = path.join(tmp, "out.md");
    const recipe: YamlRecipe = {
      name: "plain",
      trigger: { type: "manual" },
      steps: [{ tool: "file.write", path: target, content: "raw\n" }],
    } as YamlRecipe;

    await runYamlRecipe(recipe, {
      now: () => new Date("2026-05-20T08:00:00Z"),
      logDir: fakeHome,
      readFile: () => "",
      writeFile: (p, c) => {
        written[p] = c;
      },
      appendFile: () => {},
      mkdir: () => {},
      gitLogSince: () => "",
      gitStaleBranches: () => "",
      getDiagnostics: () => "",
    });
    expect(written[target]).toBe("raw\n");
    rmSync(tmp, { recursive: true, force: true });
  });
});
