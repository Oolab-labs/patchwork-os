import os from "node:os";
import path from "node:path";
/**
 * `plugin-not-allowlisted` lint rule — ERROR under governed, WARNING under
 * compat describing what governed would refuse.
 */

import { describe, expect, it } from "vitest";
import { COMPAT_PROFILE, GOVERNED_PROFILE } from "../../governance/profile.js";
import { validateRecipeDefinition } from "../validation.js";

const recipe = (servers: unknown[]) => ({
  name: "plugin-lint-fixture",
  version: "1.0.0",
  trigger: { type: "manual" },
  servers,
  steps: [
    {
      id: "s1",
      tool: "file.write",
      params: { path: path.join(os.tmpdir(), "x"), content: "y" },
    },
  ],
});

const byCode = (r: ReturnType<typeof validateRecipeDefinition>) =>
  r.issues.filter((i) => i.code === "plugin-not-allowlisted");

describe("lint: plugin-not-allowlisted", () => {
  it("governed + not allowlisted ⇒ error, recipe invalid, path names the entry", () => {
    const r = validateRecipeDefinition(recipe(["./ok", "./nope"]), {
      pluginPolicy: { profile: GOVERNED_PROFILE, allow: [{ spec: "./ok" }] },
    });
    const issues = byCode(r);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ level: "error", path: "servers.1" });
    expect(issues[0]?.message).toContain('"./nope"');
    expect(r.valid).toBe(false);
  });

  it("governed + allowlisted ⇒ no issue", () => {
    const r = validateRecipeDefinition(recipe(["./ok"]), {
      pluginPolicy: { profile: GOVERNED_PROFILE, allow: [{ spec: "./ok" }] },
    });
    expect(byCode(r)).toHaveLength(0);
  });

  it("compat ⇒ warning with the 'would be refused' wording, recipe still valid", () => {
    const r = validateRecipeDefinition(recipe(["./nope"]), {
      pluginPolicy: { profile: COMPAT_PROFILE, allow: [] },
    });
    const issues = byCode(r);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.level).toBe("warning");
    expect(issues[0]?.message).toContain(
      'plugin "./nope" would be refused under the governed profile',
    );
    expect(r.valid).toBe(true);
  });

  it("compat + spec present in plugins.allow ⇒ silent", () => {
    const r = validateRecipeDefinition(recipe(["./ok"]), {
      pluginPolicy: { profile: COMPAT_PROFILE, allow: [{ spec: "./ok" }] },
    });
    expect(byCode(r)).toHaveLength(0);
  });

  it("no servers ⇒ rule does not fire in either profile", () => {
    for (const profile of [COMPAT_PROFILE, GOVERNED_PROFILE]) {
      const { servers: _s, ...rest } = recipe([]);
      const r = validateRecipeDefinition(rest, {
        pluginPolicy: { profile, allow: [] },
      });
      expect(byCode(r)).toHaveLength(0);
    }
  });
});
