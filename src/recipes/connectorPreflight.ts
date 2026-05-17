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
 * Compiled list of tool-name prefixes (without the trailing underscore)
 * used by `promptMentionsConnector`. Built once at module load — the
 * source map is small and stable, so caching this avoids regex churn
 * inside the per-step loop.
 */
const PROMPT_PREFIX_PATTERNS: ReadonlyArray<{
  prefix: string;
  connector: string;
}> = Object.entries(TOOL_PREFIX_TO_CONNECTOR).map(([prefix, connector]) => ({
  // Strip trailing underscore — when the prompt mentions a tool name like
  // `slack_post_message` the underscore is part of the literal we look
  // for, but when an agent prompt is more conversational ("post to slack
  // using slack.post_message"), we want to match the prefix without the
  // separator too.
  prefix: prefix.replace(/_$/, ""),
  connector,
}));

/**
 * Inspect an agent step's `prompt` for references to tool names from
 * known connectors. Catches the common case where the LLM is told
 * which tool to call inside the prompt body rather than via the
 * `tools[]` allowlist — e.g.:
 *
 *   - id: notify
 *     agent:
 *       prompt: Use slack_post_message to send "{{summary}}" to #ops.
 *
 * That prompt previously fell through `toolsOfStep` entirely (no
 * `tool`, empty `tools[]`) and the install panel told the user "no
 * connectors needed" despite the recipe relying on Slack at runtime.
 *
 * Detection is deliberately lossy — we match `<prefix>_` followed by a
 * word char (the literal tool-name shape `slack_post_message`) and we
 * also match `<prefix>.` to catch prose like "use slack.fetch". False
 * positives are tolerable: surfacing one extra "you may want to
 * authorise X" hint is strictly better than the pre-fix silent miss.
 *
 * Audit 2026-05-17.
 */
function promptMentionsConnectors(prompt: string): string[] {
  const found = new Set<string>();
  // Only look at the prompt body — vars / outputs / context refs go
  // through `{{...}}` interpolation which the runtime resolves later.
  for (const { prefix, connector } of PROMPT_PREFIX_PATTERNS) {
    // Anchor on a word boundary so `unrelated_slack_word` doesn't
    // match (\\bslack[_.]\\w would also match `slack_alert`, which is
    // the intended target).
    const re = new RegExp(`\\b${escapeForRegex(prefix)}[_.]\\w`, "i");
    if (re.test(prompt)) found.add(connector);
  }
  return [...found];
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Walk a recipe's steps and return the connector ids it likely needs.
 * Stable order (sorted) so the response is deterministic.
 */
export function detectRequiredConnectors(recipe: Recipe): string[] {
  const required = new Set<string>();
  for (const step of recipe.steps) {
    // Explicit `tool` / `tools[]` fields (canonical detection path).
    for (const tool of toolsOfStep(step)) {
      for (const [prefix, connector] of Object.entries(
        TOOL_PREFIX_TO_CONNECTOR,
      )) {
        if (tool.startsWith(prefix)) {
          required.add(connector);
        }
      }
    }
    // Prompt body scan for agent-mode steps — catches recipes that
    // tell the LLM which tool to call inline (e.g. "Use slack_post_message
    // to ...") without listing it in `tools[]`. See
    // `promptMentionsConnectors` above for the rationale.
    if (step.agent === true && typeof step.prompt === "string") {
      for (const connector of promptMentionsConnectors(step.prompt)) {
        required.add(connector);
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
