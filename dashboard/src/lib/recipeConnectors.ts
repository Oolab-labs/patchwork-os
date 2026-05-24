const TOOL_NAMESPACE_TO_CONNECTOR: Record<string, string> = {
  calendar: "google-calendar",
  gcal: "google-calendar",
  drive: "google-drive",
  gdrive: "google-drive",
  docs: "google-docs",
  gdocs: "google-docs",
  mongo: "mongodb",
  es: "elasticsearch",
};

const KNOWN_CONNECTOR_IDS = new Set([
  "gmail", "google-calendar", "google-drive", "google-docs", "github",
  "linear", "sentry", "slack", "asana", "discord", "gitlab", "notion",
  "confluence", "datadog", "hubspot", "intercom", "jira", "pagerduty",
  "stripe", "zendesk", "postgres", "mongodb", "redis", "elasticsearch",
  "sendgrid", "twilio", "figma", "airtable", "webflow", "monday",
  "salesforce", "shopify", "snowflake",
]);

function namespaceToConnector(ns: string): string | null {
  const lower = ns.toLowerCase();
  const alias = TOOL_NAMESPACE_TO_CONNECTOR[lower];
  if (alias) return alias;
  if (KNOWN_CONNECTOR_IDS.has(lower)) return lower;
  return null;
}

export interface RecipeSummaryForConnectors {
  name: string;
  description?: string;
}

export function detectConnectorsForRecipe(recipe: RecipeSummaryForConnectors): string[] {
  const haystack = `${recipe.name} ${recipe.description ?? ""}`.toLowerCase();
  const found = new Set<string>();
  for (const ns of [
    ...Object.keys(TOOL_NAMESPACE_TO_CONNECTOR),
    ...KNOWN_CONNECTOR_IDS,
  ]) {
    if (haystack.includes(ns.toLowerCase())) {
      const c = namespaceToConnector(ns);
      if (c) found.add(c);
    }
  }
  return Array.from(found).sort();
}

export function detectConnectorsFromYaml(yamlContent: string): string[] {
  const found = new Set<string>();
  const toolRe = /(^|\n)\s*-?\s*tool:\s*["']?([a-zA-Z0-9_-]+)[._]/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex exec loop
  while ((match = toolRe.exec(yamlContent)) !== null) {
    const ns = match[2];
    if (!ns) continue;
    const c = namespaceToConnector(ns);
    if (c) found.add(c);
  }
  return Array.from(found).sort();
}
