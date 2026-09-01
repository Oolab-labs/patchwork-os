/**
 * Plugin policy — pure verdicts, integrity, and the installed-recipe scan.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  evaluatePluginSpec,
  explainPluginPolicy,
  normalisePluginSpec,
  pluginNotAllowlistedError,
  pluginSpecsOfYaml,
  scanInstalledRecipePlugins,
  verifyPluginIntegrity,
} from "../pluginPolicy.js";
import { COMPAT_PROFILE, GOVERNED_PROFILE } from "../profile.js";

const CWD = path.resolve(os.tmpdir(), "pp-cwd");

describe("evaluatePluginSpec", () => {
  it("compat: always allowed, with the stated reason", () => {
    const v = evaluatePluginSpec("./anything", {
      profile: COMPAT_PROFILE,
      allow: [],
    });
    expect(v.allowed).toBe(true);
    expect(v.reason).toBe("compat profile: open");
  });

  it("governed + empty allowlist: refused, reason names the empty list", () => {
    const v = evaluatePluginSpec("./x", {
      profile: GOVERNED_PROFILE,
      allow: [],
    });
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/plugins\.allow is empty/);
  });

  it("governed + undefined allowlist: refused", () => {
    expect(
      evaluatePluginSpec("some-pkg", {
        profile: GOVERNED_PROFILE,
        allow: undefined,
      }).allowed,
    ).toBe(false);
  });

  it("governed: exact package match allowed, sibling refused", () => {
    const allow = [{ spec: "@acme/plugin", integrity: "sha256-abc" }];
    const ok = evaluatePluginSpec("@acme/plugin", {
      profile: GOVERNED_PROFILE,
      allow,
    });
    expect(ok.allowed).toBe(true);
    expect(ok.entry?.integrity).toBe("sha256-abc");
    expect(
      evaluatePluginSpec("@acme/plugin-evil", {
        profile: GOVERNED_PROFILE,
        allow,
      }).allowed,
    ).toBe(false);
    // No prefix matching either way.
    expect(
      evaluatePluginSpec("@acme", { profile: GOVERNED_PROFILE, allow }).allowed,
    ).toBe(false);
  });

  it("path normalisation: ./x, ./x/ and the absolute path agree", () => {
    const allow = [{ spec: "./plugins/x" }];
    for (const spec of [
      "./plugins/x",
      "./plugins/x/",
      " ./plugins/x ",
      path.join(CWD, "plugins", "x"),
      "./plugins/../plugins/x",
    ]) {
      expect(
        evaluatePluginSpec(spec, { profile: GOVERNED_PROFILE, allow }, CWD)
          .allowed,
        spec,
      ).toBe(true);
    }
    expect(
      evaluatePluginSpec(
        "./plugins/y",
        { profile: GOVERNED_PROFILE, allow },
        CWD,
      ).allowed,
    ).toBe(false);
    expect(normalisePluginSpec("pkg ", CWD)).toBe("pkg");
  });

  it("a package spec never matches a path entry of the same name", () => {
    expect(
      evaluatePluginSpec(
        "x",
        { profile: GOVERNED_PROFILE, allow: [{ spec: "./x" }] },
        CWD,
      ).allowed,
    ).toBe(false);
  });

  it("explainPluginPolicy returns one verdict per spec in order", () => {
    const out = explainPluginPolicy(["a", "b"], {
      profile: GOVERNED_PROFILE,
      allow: [{ spec: "b" }],
    });
    expect(out.map((v) => [v.spec, v.allowed])).toEqual([
      ["a", false],
      ["b", true],
    ]);
  });

  it("pluginNotAllowlistedError carries a stable code and the specs", () => {
    const err = pluginNotAllowlistedError([
      { spec: "./nope", allowed: false, reason: "r" },
    ]);
    expect(err.code).toBe("plugin_not_allowlisted");
    expect(err.name).toBe("PluginPolicyError");
    expect(err.specs).toEqual(["./nope"]);
    expect(err.message).toContain('"./nope"');
  });
});

describe("verifyPluginIntegrity", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-integrity-"));
    file = path.join(dir, "index.mjs");
    fs.writeFileSync(
      file,
      "export function register() { return { tools: [] }; }\n",
    );
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const hashOf = (p: string) =>
    `sha256-${createHash("sha256").update(fs.readFileSync(p)).digest("base64")}`;

  it("absent integrity is skipped, not failed", () => {
    const r = verifyPluginIntegrity(file, undefined);
    expect(r.ok).toBe(true);
    expect(r.status).toBe("skipped");
  });

  it("matching hash verifies", () => {
    const r = verifyPluginIntegrity(file, hashOf(file));
    expect(r).toMatchObject({ ok: true, status: "verified" });
  });

  it("mismatching hash refuses and reports the actual digest", () => {
    const good = hashOf(file);
    fs.appendFileSync(file, "// tampered\n");
    const r = verifyPluginIntegrity(file, good);
    expect(r.ok).toBe(false);
    expect(r.status).toBe("mismatch");
    expect(r.actual).toBe(hashOf(file));
    expect(r.actual).not.toBe(good);
  });

  it("malformed integrity string refuses", () => {
    expect(verifyPluginIntegrity(file, "md5-zzz").status).toBe("malformed");
  });

  it("unreadable entrypoint refuses", () => {
    expect(
      verifyPluginIntegrity(path.join(dir, "missing.mjs"), "sha256-AAAA")
        .status,
    ).toBe("unreadable");
  });
});

describe("scanInstalledRecipePlugins", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-scan-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("reports verdicts per recipe and counts the denominator", () => {
    fs.writeFileSync(
      path.join(dir, "with-plugin.yaml"),
      "name: with-plugin\nservers:\n  - ./allowed\n  - ./nope\nsteps: []\n",
    );
    fs.writeFileSync(path.join(dir, "plain.yaml"), "name: plain\nsteps: []\n");
    fs.mkdirSync(path.join(dir, "nested"));
    fs.writeFileSync(
      path.join(dir, "nested", "r.json"),
      JSON.stringify({ name: "nested-r", servers: ["pkg-a"] }),
    );
    fs.writeFileSync(path.join(dir, "broken.yaml"), "name: [\n");

    const scan = scanInstalledRecipePlugins(
      dir,
      {
        profile: GOVERNED_PROFILE,
        allow: [{ spec: "./allowed" }, { spec: "pkg-a" }],
      },
      dir,
    );
    expect(scan.recipesScanned).toBe(4);
    expect(scan.recipesWithPlugins).toBe(2);
    expect(scan.refusedSpecs).toBe(1);
    const row = scan.rows.find((r) => r.name === "with-plugin");
    expect(row?.file).toBe("with-plugin.yaml");
    expect(row?.verdicts.map((v) => v.allowed)).toEqual([true, false]);
  });

  it("missing directory reports zero scanned rather than throwing", () => {
    const scan = scanInstalledRecipePlugins(path.join(dir, "absent"), {
      profile: GOVERNED_PROFILE,
      allow: [],
    });
    expect(scan.recipesScanned).toBe(0);
    expect(scan.rows).toEqual([]);
  });

  it("pluginSpecsOfYaml ignores non-string entries and unparseable text", () => {
    expect(pluginSpecsOfYaml("servers:\n  - a\n  - 3\n")).toEqual(["a"]);
    expect(pluginSpecsOfYaml("name: [")).toEqual([]);
  });
});
