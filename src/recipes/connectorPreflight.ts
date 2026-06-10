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
 * Tool-namespace → connector id (matching the IDs returned by
 * `/connections` — see src/connectors/gmail.ts handleConnectionsList).
 * Both `google-calendar` and the dashboard's `googleCalendar` spelling
 * are accepted on the caller side; this map is authoritative for the
 * bridge.
 *
 * Keys are BARE namespace names (no separator). The matcher accepts BOTH
 * dot-form (`slack.post_message`) and underscore-form (`slack_post_message`)
 * tool IDs. Real registry tools use dot-form
 * (e.g. `src/recipes/tools/slack.ts` registers `slack.post_message`); the
 * previous map keyed by `slack_` etc. silently failed every YAML recipe
 * install because `tool.startsWith("slack_")` never matched `slack.post_message`.
 */
export const TOOL_NAMESPACE_TO_CONNECTOR: Record<string, string> = {
  slack: "slack",
  github: "github",
  jira: "jira",
  linear: "linear",
  gmail: "gmail",
  calendar: "google-calendar",
  drive: "google-drive",
  docs: "google-docs",
  intercom: "intercom",
  hubspot: "hubspot",
  datadog: "datadog",
  stripe: "stripe",
  sentry: "sentry",
  zendesk: "zendesk",
  asana: "asana",
  notion: "notion",
  confluence: "confluence",
  discord: "discord",
  gitlab: "gitlab",
  pagerduty: "pagerduty",
  // Wave-2 backfill (audit 2026-06-05): the map previously covered only ~19
  // of the ~45 connector-backed recipe-step namespaces, so recipes using any
  // of the below got NO install-time missing-auth warning and hard-threw on
  // first run. The connector-preflight-parity ratchet keeps this honest.
  airtable: "airtable",
  caldiy: "caldiy",
  circleci: "circleci",
  cloudflare: "cloudflare",
  elasticsearch: "elasticsearch",
  figma: "figma",
  grafana: "grafana",
  monday: "monday",
  obsidian: "obsidian",
  paystack: "paystack",
  pipedrive: "pipedrive",
  mongodb: "mongodb",
  postgres: "postgres",
  posthog: "posthog",
  redis: "redis",
  resend: "resend",
  salesforce: "salesforce",
  sendgrid: "sendgrid",
  shopify: "shopify",
  snowflake: "snowflake",
  supabase: "supabase",
  todoist: "todoist",
  twilio: "twilio",
  vercel: "vercel",
  webflow: "webflow",
  woocommerce: "woocommerce",
};

/**
 * @deprecated Use `TOOL_NAMESPACE_TO_CONNECTOR` instead. Kept as a thin
 * alias derived from the canonical map so legacy callers (and the
 * underscore-suffix tool-name shape) keep working until they migrate.
 */
export const TOOL_PREFIX_TO_CONNECTOR: Record<string, string> =
  Object.fromEntries(
    Object.entries(TOOL_NAMESPACE_TO_CONNECTOR).map(([ns, connector]) => [
      `${ns}_`,
      connector,
    ]),
  );

/**
 * Extract the namespace prefix from a registered tool ID. Tool IDs land
 * in either `namespace.tool_name` (the canonical dot-form used by every
 * registry entry today — see `src/recipes/tools/*.ts`) or the older
 * `namespace_tool_name` underscore-form some tests use. Either form
 * resolves to the bare namespace, lowercased.
 */
function extractNamespace(toolId: string): string | undefined {
  const m = toolId.match(/^([a-z][a-z0-9-]*)[_.]/i);
  return m?.[1]?.toLowerCase();
}

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
}> = Object.entries(TOOL_NAMESPACE_TO_CONNECTOR).map(([prefix, connector]) => ({
  prefix,
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
    // Pull the namespace out of the tool ID — works for both dot-form
    // (the registry's canonical `slack.post_message`) and the legacy
    // underscore-form some tests use (`slack_post_message`).
    for (const tool of toolsOfStep(step)) {
      const ns = extractNamespace(tool);
      if (ns) {
        const connector = TOOL_NAMESPACE_TO_CONNECTOR[ns];
        if (connector) required.add(connector);
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
