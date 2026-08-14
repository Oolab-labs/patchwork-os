import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveRecipeList } from "../recipeList.js";

const LOCK = { port: 4242, authToken: "tok" };

function bridgeReturning(recipes: unknown[]): typeof globalThis.fetch {
  return (async () =>
    new Response(JSON.stringify({ recipes }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof globalThis.fetch;
}

const dirs: string[] = [];
function tempRecipesDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pw-recipelist-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length)
    rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("resolveRecipeList — provenance is never silent", () => {
  it("prefers a running bridge and says so", async () => {
    const res = await resolveRecipeList({
      findBridge: () => LOCK,
      fetch: bridgeReturning([
        { name: "alpha", enabled: true, trigger: "cron" },
        { name: "beta", enabled: false },
      ]),
    });
    expect(res.source).toBe("bridge");
    expect(res.port).toBe(4242);
    expect(res.rows.map((r) => r.name)).toEqual(["alpha", "beta"]);
    expect(res.rows[1]?.enabled).toBe(false);
  });

  it("falls back to a local scan with a STATED reason when no bridge is running", async () => {
    const res = await resolveRecipeList({
      findBridge: () => null,
      localScan: () => [{ name: "local-only", enabled: true }],
    });
    expect(res.source).toBe("local");
    expect(res.fallbackReason).toMatch(/no running bridge/i);
    expect(res.rows.map((r) => r.name)).toEqual(["local-only"]);
  });

  it("names the port and status when the bridge answers non-2xx", async () => {
    const res = await resolveRecipeList({
      findBridge: () => LOCK,
      fetch: (async () => new Response("nope", { status: 503 })) as never,
      localScan: () => [],
    });
    expect(res.source).toBe("local");
    // The operator must be able to tell "bridge said no" from "no bridge".
    expect(res.fallbackReason).toContain("4242");
    expect(res.fallbackReason).toContain("503");
  });

  it("does not throw when the bridge is unreachable mid-request", async () => {
    const res = await resolveRecipeList({
      findBridge: () => LOCK,
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as never,
      localScan: () => [{ name: "fallback", enabled: true }],
    });
    expect(res.source).toBe("local");
    expect(res.fallbackReason).toContain("ECONNREFUSED");
    expect(res.rows).toHaveLength(1);
  });

  it("survives a bridge that discovery itself throws on", async () => {
    const res = await resolveRecipeList({
      findBridge: () => {
        throw new Error("unreadable lock dir");
      },
      localScan: () => [],
    });
    expect(res.source).toBe("local");
  });
});

describe("local fallback uses the two-pass scanner (#1360)", () => {
  it("lists FLAT recipe files, which the directory-only scanner discarded", async () => {
    // The whole defect: `commands/recipeInstall.listInstalledRecipes` does
    // `if (!statSync(itemPath).isDirectory()) continue;`, so a flat recipe file
    // — the majority format — was invisible to `recipe list`.
    const dir = tempRecipesDir();
    writeFileSync(
      path.join(dir, "flat-one.yaml"),
      "name: flat-one\ndescription: a top-level recipe file\nsteps: []\n",
    );
    writeFileSync(
      path.join(dir, "flat-two.yaml"),
      "name: flat-two\nsteps: []\n",
    );

    const res = await resolveRecipeList({
      findBridge: () => null,
      recipesDir: dir,
    });

    expect(res.source).toBe("local");
    expect(res.rows.map((r) => r.name).sort()).toEqual([
      "flat-one",
      "flat-two",
    ]);
  });

  it("does not print a directory with no valid entrypoint as a recipe", async () => {
    // The other half: the old scanner printed any directory containing a
    // `.yaml` as an installed recipe, so its output was part omission and part
    // phantom. A bare directory must contribute nothing.
    const dir = tempRecipesDir();
    writeFileSync(path.join(dir, "real.yaml"), "name: real\nsteps: []\n");
    mkdirSync(path.join(dir, ".archive"));
    writeFileSync(
      path.join(dir, ".archive", "stashed.yaml"),
      "name: stashed\nsteps: []\n",
    );

    const res = await resolveRecipeList({
      findBridge: () => null,
      recipesDir: dir,
    });

    const names = res.rows.map((r) => r.name);
    expect(names).toContain("real");
    expect(names).not.toContain(".archive");
  });
});

describe("printRecipeList", () => {
  it("flattens a multi-line description so it cannot break column alignment", async () => {
    const { printRecipeList } = await import("../recipeList.js");
    const lines: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.join(" "));
    };
    try {
      printRecipeList({
        source: "bridge",
        port: 1,
        rows: [
          {
            name: "wrapped",
            enabled: true,
            description: "first line\nsecond line\n  third",
          },
        ],
      });
    } finally {
      console.log = orig;
    }
    // Every emitted line is one row. A raw newline in a description would
    // split one row across several and misalign every row after it.
    const rowLine = lines.find((l) => l.startsWith("wrapped"));
    expect(rowLine).toBeDefined();
    expect(rowLine).toContain("first line second line third");
    expect(rowLine).not.toContain("\n");
  });
});
