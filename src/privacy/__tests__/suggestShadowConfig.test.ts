/**
 * `patchwork privacy suggest` (ADR-0021).
 *
 * The risk in a "starter config" is not that it is wrong — it is that it looks
 * authoritative. An operator who pastes it is entitled to assume it reflects
 * what was measured, so the tests below are mostly about what the output must
 * REFUSE to imply.
 */
import { describe, expect, it } from "vitest";

import {
  formatSuggestion,
  suggestShadowConfig,
} from "../suggestShadowConfig.js";

describe("destinations are derived from evidence", () => {
  it("splits local-family drivers from everything else", () => {
    const r = suggestShadowConfig({
      drivers: [
        { driver: "claude-code", count: 36 },
        { driver: "local", count: 7 },
        { driver: "ollama", count: 1 },
      ],
    });
    expect(r.config.destinations["candidate-local"]?.drivers).toEqual([
      "local",
      "ollama",
    ]);
    // `claude-code` runs the CLI on this machine but the DATA leaves it, which
    // is the only sense that matters to an information boundary.
    expect(r.config.destinations["candidate-remote"]?.drivers).toEqual([
      "claude-code",
    ]);
  });

  it("reports steps with no declared driver instead of folding them in", () => {
    const r = suggestShadowConfig({
      drivers: [{ driver: "local", count: 2 }],
      unspecified: 28,
    });
    // Those steps dispatch somewhere too. Omitting them would under-enumerate
    // the exact surface this command claims to enumerate — and silently, since
    // the block would look complete.
    expect(r.notes.join(" ")).toContain("28 agent step(s) declare no driver");
  });
});

describe("the output refuses to look authoritative", () => {
  it("always says the classifications are not advice", () => {
    const r = suggestShadowConfig({
      drivers: [{ driver: "claude-code", count: 1 }],
    });
    // ADR-0019: curated policy content is regulatory material and belongs in
    // the control plane. A suggestion that read as guidance would ship that
    // liability from an MIT repo.
    const notes = r.notes.join(" ");
    expect(notes).toContain("NOT advice about your obligations");
    expect(notes).toContain("measured");
  });

  it("warns that an all-local workspace will show few crossings", () => {
    const r = suggestShadowConfig({ drivers: [{ driver: "local", count: 3 }] });
    // Otherwise a near-empty shadow report reads as a clean bill of health
    // when it is really a property of the workspace.
    expect(r.notes.join(" ")).toContain("not a clean bill of health");
  });

  it("says so when there is nothing to suggest", () => {
    const r = suggestShadowConfig({ drivers: [] });
    expect(Object.keys(r.config.destinations)).toHaveLength(0);
    expect(r.notes.join(" ")).toContain("No drivers found at all");
  });
});

describe("it can never turn on enforcement", () => {
  it("emits privacy.shadow only, never privacy.destinations", () => {
    const out = formatSuggestion(
      suggestShadowConfig({ drivers: [{ driver: "claude-code", count: 1 }] }),
    );
    const parsed = JSON.parse(
      out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1),
    );
    expect(parsed.privacy.shadow).toBeDefined();
    // The enforcing key must not appear anywhere in a pasteable block. Someone
    // following the instructions must not be able to switch enforcement on by
    // accident — that is the whole reason the two keys are separate.
    expect(parsed.privacy.destinations).toBeUndefined();
    expect(out).toContain("never enforces");
  });
});
