/**
 * Unit tests for the connector-preflight helper. The HTTP-level
 * integration (install handler surfaces `missingConnectors` in the
 * response) lives in src/__tests__/recipeRoutes-install.test.ts.
 */

import { describe, expect, it } from "vitest";
import {
  detectRequiredConnectors,
  findMissingConnectors,
  TOOL_PREFIX_TO_CONNECTOR,
} from "../connectorPreflight.js";
import type { Recipe } from "../schema.js";

// Minimal Recipe builder — only the fields the helper actually reads.
function recipe(steps: Recipe["steps"]): Recipe {
  return {
    name: "test",
    version: "1.0.0",
    trigger: { type: "manual" },
    steps,
  };
}

describe("detectRequiredConnectors", () => {
  it("returns empty for recipes with no tool steps", () => {
    expect(
      detectRequiredConnectors(
        recipe([
          { id: "s1", agent: true, prompt: "think", tools: undefined },
        ] as Recipe["steps"]),
      ),
    ).toEqual([]);
  });

  it("detects connectors from agent:false tool fields", () => {
    expect(
      detectRequiredConnectors(
        recipe([
          { id: "s1", agent: false, tool: "slack_chat", params: {} },
          { id: "s2", agent: false, tool: "gmail_send", params: {} },
        ] as Recipe["steps"]),
      ),
    ).toEqual(["gmail", "slack"]);
  });

  it("detects connectors from agent:true tools[] arrays", () => {
    expect(
      detectRequiredConnectors(
        recipe([
          {
            id: "s1",
            agent: true,
            prompt: "compose",
            tools: ["linear_list_issues", "calendar_list_events"],
          },
        ] as Recipe["steps"]),
      ),
    ).toEqual(["google-calendar", "linear"]);
  });

  it("de-duplicates connectors used by multiple steps", () => {
    expect(
      detectRequiredConnectors(
        recipe([
          { id: "s1", agent: false, tool: "slack_chat", params: {} },
          { id: "s2", agent: false, tool: "slack_search", params: {} },
        ] as Recipe["steps"]),
      ),
    ).toEqual(["slack"]);
  });

  it("returns results in sorted order so the response is stable", () => {
    expect(
      detectRequiredConnectors(
        recipe([
          { id: "s1", agent: false, tool: "stripe_charge", params: {} },
          { id: "s2", agent: false, tool: "asana_create_task", params: {} },
          { id: "s3", agent: false, tool: "github_open_pr", params: {} },
        ] as Recipe["steps"]),
      ),
    ).toEqual(["asana", "github", "stripe"]);
  });

  it("ignores tool names that don't match any known prefix", () => {
    expect(
      detectRequiredConnectors(
        recipe([
          { id: "s1", agent: false, tool: "shell.run", params: {} },
          { id: "s2", agent: false, tool: "file.write", params: {} },
        ] as Recipe["steps"]),
      ),
    ).toEqual([]);
  });

  // Regression: every connector tool registered today uses dot-form IDs
  // (`slack.post_message`, `gmail.fetch_unread`, ...). The pre-fix prefix
  // map keyed by `slack_` etc. and used `tool.startsWith(prefix)` →
  // never matched dot-form → every YAML recipe install reported
  // "no connectors needed" regardless of what the recipe actually used.
  it("detects connectors from canonical dot-form tool IDs (registry shape)", () => {
    expect(
      detectRequiredConnectors(
        recipe([
          { id: "s1", agent: false, tool: "slack.post_message", params: {} },
          { id: "s2", agent: false, tool: "gmail.fetch_unread", params: {} },
          { id: "s3", agent: false, tool: "linear.list_issues", params: {} },
          { id: "s4", agent: false, tool: "github.list_prs", params: {} },
        ] as Recipe["steps"]),
      ),
    ).toEqual(["github", "gmail", "linear", "slack"]);
  });

  it("detects connectors from dot-form in agent tools[] arrays", () => {
    expect(
      detectRequiredConnectors(
        recipe([
          {
            id: "s1",
            agent: true,
            prompt: "compose",
            tools: ["hubspot.listContacts", "calendar.list_events"],
          },
        ] as Recipe["steps"]),
      ),
    ).toEqual(["google-calendar", "hubspot"]);
  });

  it("matches every entry in the public prefix map", () => {
    // Sanity: every prefix in the map should match a tool we synthesize
    // from it. Guards against typos that would silently break the map.
    for (const [prefix, connector] of Object.entries(
      TOOL_PREFIX_TO_CONNECTOR,
    )) {
      const detected = detectRequiredConnectors(
        recipe([
          { id: "s", agent: false, tool: `${prefix}example`, params: {} },
        ] as Recipe["steps"]),
      );
      expect(
        detected,
        `prefix '${prefix}' should map to '${connector}'`,
      ).toEqual([connector]);
    }
  });

  // ─── Prompt-body scan (audit 2026-05-17) ───────────────────────────────
  // Agent steps that name a tool inside the `prompt` body without
  // listing it in `tools[]` used to be invisible to the preflight.
  // Now we scan the prompt for known tool prefixes too. Detection is
  // lossy by design — false positives are tolerable, false negatives
  // (silent miss → install panel claims "no connectors needed") are not.
  describe("prompt-body scan", () => {
    it("detects connector named via underscored tool in agent prompt", () => {
      expect(
        detectRequiredConnectors(
          recipe([
            {
              id: "notify",
              agent: true,
              prompt: "Use slack_post_message to send the summary.",
            },
          ] as Recipe["steps"]),
        ),
      ).toEqual(["slack"]);
    });

    it("detects connector named via dotted prose in agent prompt", () => {
      expect(
        detectRequiredConnectors(
          recipe([
            {
              id: "fetch",
              agent: true,
              prompt: "Pull recent issues with linear.search and triage them.",
            },
          ] as Recipe["steps"]),
        ),
      ).toEqual(["linear"]);
    });

    it("merges prompt-named connectors with tools[] entries", () => {
      expect(
        detectRequiredConnectors(
          recipe([
            {
              id: "compose",
              agent: true,
              prompt: "Send the digest via gmail_send_message.",
              tools: ["slack_post_message"],
            },
          ] as Recipe["steps"]),
        ),
      ).toEqual(["gmail", "slack"]);
    });

    it("ignores random words that happen to start with a prefix string", () => {
      // "slacks" is NOT a tool; "calendaring" is NOT a tool. The
      // detector should not flag either.
      expect(
        detectRequiredConnectors(
          recipe([
            {
              id: "x",
              agent: true,
              prompt: "Update the slacks in calendaring documentation.",
            },
          ] as Recipe["steps"]),
        ),
      ).toEqual([]);
    });

    it("ignores prompt of agent:false tool steps (only `tool` field counts)", () => {
      // Tool steps have a strict `tool` field — they don't get the
      // permissive prompt scan.
      expect(
        detectRequiredConnectors(
          recipe([
            {
              id: "x",
              agent: false,
              tool: "Read",
              params: { _comment: "this would mention slack_post but doesn't" },
            },
          ] as Recipe["steps"]),
        ),
      ).toEqual([]);
    });
  });
});

describe("findMissingConnectors", () => {
  it("returns required ids that aren't in the connected set", () => {
    expect(
      findMissingConnectors(
        ["slack", "gmail", "linear"],
        [
          { id: "slack", status: "connected" },
          { id: "gmail", status: "disconnected" },
          // linear: absent from the list entirely
        ],
      ),
    ).toEqual(["gmail", "linear"]);
  });

  it("treats only status === 'connected' as connected", () => {
    // Defensive: any other status string ("error", "expired", "reauth",
    // "disconnected", undefined) means the recipe can't currently use
    // the connector, so it should show up as missing.
    expect(
      findMissingConnectors(["slack"], [{ id: "slack", status: "expired" }]),
    ).toEqual(["slack"]);
  });

  it("preserves the input order of `required` in the output", () => {
    // The install handler relies on `detectRequiredConnectors` for the
    // sort; this layer must NOT re-sort the input.
    expect(
      findMissingConnectors(
        ["zendesk", "asana", "github"],
        [{ id: "asana", status: "connected" }],
      ),
    ).toEqual(["zendesk", "github"]);
  });

  it("returns [] when all required connectors are connected", () => {
    expect(
      findMissingConnectors(
        ["slack", "gmail"],
        [
          { id: "slack", status: "connected" },
          { id: "gmail", status: "connected" },
          { id: "linear", status: "connected" },
        ],
      ),
    ).toEqual([]);
  });

  it("tolerates malformed entries (missing id or status)", () => {
    expect(
      findMissingConnectors(
        ["slack"],
        [
          { id: undefined, status: "connected" } as never,
          { status: "connected" } as never,
          { id: "slack" }, // status missing — treated as not connected
        ],
      ),
    ).toEqual(["slack"]);
  });
});
