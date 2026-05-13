/**
 * Detect which connectors a recipe depends on by inspecting its tool
 * names. Used as a *soft* preflight after install — the route returns
 * a `missingConnectors` warning array so the dashboard can prompt the
 * user to authorise the missing services without blocking the install
 * itself.
 *
 * Why soft (warning, not 400):
 *   - Users may install a recipe with the intent to authorise later.
 *   - The bridge has no way to know whether a missing connector is
 *     "the user forgot" or "the user uses this recipe only via the
 *     manual code path that doesn't need auth".
 *   - First-run discovery (today's behaviour) is the worst UX, but
 *     blocking install entirely overcorrects.
 *
 * Detection is deliberately lossy. We match the FIRST underscore-
 * separated namespace of each step's tool name against a known prefix
 * map (slack_chat, gmail_send, linear_create_issue, …). Recipes that
 * use shell tools wrapping curl to call a service won't be detected —
 * but such recipes also don't go through the Patchwork connector
 * store anyway.
 */
import type { Recipe, Step } from "./schema.js";

/**
 * Tool-name prefix → connector id (matching the IDs returned by
 * `/connections` — see src/connectors/gmail.ts handleConnectionsList).
 * Both `google-calendar` and the dashboard's `googleCalendar` spelling
 * are accepted on the caller side; this map is authoritative for the
 * bridge.
 */
export const TOOL_PREFIX_TO_CONNECTOR: Record<string, string> = {
  slack_: "slack",
  github_: "github",
  jira_: "jira",
  linear_: "linear",
  gmail_: "gmail",
  calendar_: "google-calendar",
  drive_: "google-drive",
  intercom_: "intercom",
  hubspot_: "hubspot",
  datadog_: "datadog",
  stripe_: "stripe",
  sentry_: "sentry",
  zendesk_: "zendesk",
  asana_: "asana",
  notion_: "notion",
  confluence_: "confluence",
  discord_: "discord",
  gitlab_: "gitlab",
  pagerduty_: "pagerduty",
};

function toolsOfStep(step: Step): string[] {
  // agent: false steps carry a single `tool` field. agent: true steps
  // optionally list permitted tools in `tools[]`. Other shapes (nested
  // recipe calls, sub-agents) are not first-class in the schema today.
  if (step.agent === false) {
    return [step.tool];
  }
  if (step.agent === true && Array.isArray(step.tools)) {
    return step.tools;
  }
  return [];
}

/**
 * Walk a recipe's steps and return the connector ids it likely needs.
 * Stable order (sorted) so the response is deterministic.
 */
export function detectRequiredConnectors(recipe: Recipe): string[] {
  const required = new Set<string>();
  for (const step of recipe.steps) {
    for (const tool of toolsOfStep(step)) {
      for (const [prefix, connector] of Object.entries(
        TOOL_PREFIX_TO_CONNECTOR,
      )) {
        if (tool.startsWith(prefix)) {
          required.add(connector);
        }
      }
    }
  }
  return [...required].sort();
}

interface ConnectorStatusEntry {
  id?: string;
  status?: string;
}

/**
 * Compare required connectors against the bridge's `/connections`
 * payload. Returns the ids of connectors the recipe needs but the
 * user hasn't connected (or whose status is not "connected").
 *
 * Lenient on input shape — the live `/connections` response has a
 * stable contract, but tests + future surfaces may pass in something
 * shaped slightly differently. Anything we can't classify is treated
 * as "not connected" so a malformed connections payload doesn't
 * silently make every recipe look healthy.
 */
export function findMissingConnectors(
  required: ReadonlyArray<string>,
  connections: ReadonlyArray<ConnectorStatusEntry>,
): string[] {
  const connectedSet = new Set<string>();
  for (const c of connections) {
    if (typeof c?.id !== "string") continue;
    if (c.status === "connected") connectedSet.add(c.id);
  }
  return required.filter((id) => !connectedSet.has(id));
}
