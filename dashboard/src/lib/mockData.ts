/**
 * Mock responses for demo mode. Returned by bridgeFetch() when
 * NEXT_PUBLIC_DEMO_MODE=true so the dashboard shows realistic data
 * without a running bridge.
 */

const SESSION_START = Date.now() - 3 * 60 * 60 * 1000; // "started" 3h ago

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function ago(ms: number): number {
  return Date.now() - ms;
}

// ---------------------------------------------------------------------------
// Mock datasets
// ---------------------------------------------------------------------------

const MOCK_APPROVALS = [
  {
    callId: "demo-1",
    toolName: "github.create_pull_request",
    tier: "medium",
    requestedAt: ago(4 * 60 * 1000),
    summary: "Open PR: feat/demo-mode dashboard",
    sessionId: "sess-demo",
  },
  {
    callId: "demo-2",
    toolName: "slack.post_message",
    tier: "low",
    requestedAt: ago(11 * 60 * 1000),
    summary: "Post to #engineering: sprint review prep",
    sessionId: "sess-demo",
  },
  {
    callId: "demo-3",
    toolName: "linear.create_issue",
    tier: "high",
    requestedAt: ago(23 * 60 * 1000),
    summary: "Create issue: Fix bridge status inconsistency",
    sessionId: "sess-demo",
  },
];

const MOCK_RECIPES = [
  {
    name: "morning-brief",
    description: "Daily 6am digest delivered to Slack",
    trigger: "schedule",
    enabled: true,
    lastRun: ago(18 * 60 * 60 * 1000),
    source: "github:patchworkos/recipes/recipes/morning-brief",
  },
  {
    name: "incident-war-room",
    description: "Ops incident response pipeline",
    trigger: "webhook",
    enabled: true,
    lastRun: ago(2 * 24 * 60 * 60 * 1000),
    source: "github:patchworkos/recipes/recipes/incident-war-room",
  },
  {
    name: "sprint-review-prep",
    description: "Pull Linear issues, post to #engineering",
    trigger: "manual",
    enabled: false,
    lastRun: ago(5 * 24 * 60 * 60 * 1000),
    source: "github:patchworkos/recipes/recipes/sprint-review-prep",
  },
];

const MOCK_TASKS = {
  tasks: [
    {
      id: "task-1",
      prompt: "Review open PRs and summarise for standup",
      status: "done",
      driver: "claude",
      startedAt: ago(45 * 60 * 1000),
      finishedAt: ago(41 * 60 * 1000),
      output: "Found 3 open PRs. Summary posted to #engineering.",
    },
    {
      id: "task-2",
      prompt: "Run sprint-review-prep recipe",
      status: "done",
      driver: "claude",
      startedAt: ago(2 * 60 * 60 * 1000),
      finishedAt: ago(118 * 60 * 1000),
      output: "Sprint review digest sent to Slack.",
    },
    {
      id: "task-3",
      prompt: "Check Linear backlog for P0 issues",
      status: "running",
      driver: "claude",
      startedAt: ago(3 * 60 * 1000),
    },
  ],
};

const MOCK_ACTIVITY = {
  events: [
    { id: 1, kind: "tool", tool: "github.list_pull_requests", status: "success", durationMs: 312, at: ago(2 * 60 * 1000) },
    { id: 2, kind: "tool", tool: "slack.post_message", status: "success", durationMs: 88, at: ago(6 * 60 * 1000) },
    { id: 3, kind: "tool", tool: "linear.list_issues", status: "success", durationMs: 204, at: ago(12 * 60 * 1000) },
    { id: 4, kind: "tool", tool: "github.create_pull_request", status: "error", errorMessage: "Awaiting approval", durationMs: 0, at: ago(15 * 60 * 1000) },
    { id: 5, kind: "tool", tool: "linear.create_issue", status: "success", durationMs: 176, at: ago(28 * 60 * 1000) },
    { id: 6, kind: "lifecycle", event: "approval_decision", metadata: { decision: "approve", toolName: "slack.post_message" }, at: ago(35 * 60 * 1000) },
    { id: 7, kind: "tool", tool: "notion.append_block", status: "success", durationMs: 445, at: ago(52 * 60 * 1000) },
    { id: 8, kind: "tool", tool: "gmail.list_messages", status: "success", durationMs: 390, at: ago(70 * 60 * 1000) },
  ],
};

const MOCK_METRICS = `# HELP bridge_uptime_seconds Seconds since bridge start
# TYPE bridge_uptime_seconds gauge
bridge_uptime_seconds ${Math.round((Date.now() - SESSION_START) / 1000)}
# HELP bridge_tool_calls_total Total tool calls handled
# TYPE bridge_tool_calls_total counter
bridge_tool_calls_total{status="success"} 47
bridge_tool_calls_total{status="error"} 3
# HELP bridge_active_sessions Active MCP sessions
# TYPE bridge_active_sessions gauge
bridge_active_sessions 1
`;

const MOCK_STATUS = {
  ok: true,
  port: 3100,
  workspace: "~/projects/patchwork-os",
  approvalGate: "medium",
  uptimeMs: Date.now() - SESSION_START,
  activeSessions: 1,
  extensionConnected: true,
  slim: false,
};

const MOCK_HEALTH = {
  status: "ok",
  uptimeMs: Date.now() - SESSION_START,
  connections: 1,
  extensionConnected: true,
  extensionVersion: "2.46.0",
  activeSessions: 1,
  extensionCircuitBreaker: { suspended: false, suspendedUntil: 0, failures: 0, openCount: 0, lastOpenedAt: null },
  lastDisconnectReason: null,
};

const MOCK_CONNECTORS_STATUS = [
  { name: "github", status: "connected" },
  { name: "slack", status: "connected" },
  { name: "linear", status: "connected" },
  { name: "gmail", status: "disconnected" },
  { name: "notion", status: "disconnected" },
];

const MOCK_TEMPLATES = {
  version: "1",
  updated_at: new Date().toISOString(),
  recipes: [
    {
      name: "@patchworkos/morning-brief",
      version: "1.0.0",
      description: "Daily 6am digest: Gmail unread, Linear assigned issues, Slack DMs, and today's calendar — composed into one Slack message.",
      tags: ["productivity", "morning", "daily"],
      connectors: ["gmail", "linear", "slack", "calendar"],
      install: "github:patchworkos/recipes/recipes/morning-brief",
      downloads: 0,
    },
    {
      name: "@patchworkos/incident-war-room",
      version: "1.0.0",
      description: "Ops incident response: summarize alert, open Linear issue, post to #incidents Slack, then append post-incident summary to Notion.",
      tags: ["ops", "incident", "on-call"],
      connectors: ["linear", "slack", "notion"],
      install: "github:patchworkos/recipes/recipes/incident-war-room",
      downloads: 0,
    },
    {
      name: "@patchworkos/sprint-review-prep",
      version: "1.0.0",
      description: "Pull completed Linear issues for the current sprint, summarize with AI, post digest to #engineering Slack channel.",
      tags: ["engineering", "sprint"],
      connectors: ["linear", "slack"],
      install: "github:patchworkos/recipes/recipes/sprint-review-prep",
      downloads: 0,
    },
    {
      name: "@patchworkos/customer-escalation",
      version: "1.0.0",
      description: "Zendesk ticket escalation pipeline: fetch ticket, create linked Linear issue, alert #support-escalations on Slack.",
      tags: ["support", "escalation"],
      connectors: ["zendesk", "linear", "slack"],
      install: "github:patchworkos/recipes/recipes/customer-escalation",
      downloads: 0,
    },
    {
      name: "@patchworkos/deal-won-celebration",
      version: "1.0.0",
      description: "HubSpot deal closed-won trigger: celebrate in #wins Slack, log deal details to a Notion database.",
      tags: ["sales", "hubspot", "crm"],
      connectors: ["hubspot", "slack", "notion"],
      install: "github:patchworkos/recipes/recipes/deal-won-celebration",
      downloads: 0,
    },
  ],
};

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function mockBridgeResponse(pathname: string, method = "GET"): Response | null {
  // strip query string for matching
  const path = pathname.split("?")[0];

  if (path === "/status")                  return json(MOCK_STATUS);
  if (path === "/health")                  return json(MOCK_HEALTH);
  if (path === "/approvals" && method === "GET") return json(MOCK_APPROVALS);
  if (path === "/recipes" && method === "GET")   return json({ recipes: MOCK_RECIPES });
  if (path === "/tasks" && method === "GET")     return json(MOCK_TASKS);
  if (path === "/activity")               return json(MOCK_ACTIVITY);
  if (path === "/metrics")                return new Response(MOCK_METRICS, { status: 200, headers: { "content-type": "text/plain" } });
  if (path === "/templates")              return json(MOCK_TEMPLATES);
  if (path === "/connectors/status")      return json(MOCK_CONNECTORS_STATUS);
  if (path === "/runs")                   return json({ runs: [] });
  if (path === "/sessions")               return json({ sessions: [] });

  // write operations in demo mode — acknowledge but don't mutate
  if (method === "POST" || method === "PATCH" || method === "PUT" || method === "DELETE") {
    return json({ ok: true, demo: true });
  }

  // unknown GET — return empty so UI degrades gracefully
  return json({});
}
