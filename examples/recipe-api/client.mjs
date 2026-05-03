/**
 * Patchwork OS — minimal Node.js recipe API client.
 *
 * Usage:
 *   BRIDGE_TOKEN=$(patchwork print-token) node client.mjs
 *
 * Or inline:
 *   BRIDGE_TOKEN=<token> node client.mjs
 */

const BRIDGE_URL = process.env.BRIDGE_URL ?? "http://localhost:3100";
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;

if (!BRIDGE_TOKEN) {
  console.error(
    "Set BRIDGE_TOKEN env var. Run: BRIDGE_TOKEN=$(patchwork print-token) node client.mjs",
  );
  process.exit(1);
}

/** Authenticated fetch wrapper. */
async function bridgeFetch(path, init = {}) {
  const res = await fetch(`${BRIDGE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${BRIDGE_TOKEN}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `Bridge ${init.method ?? "GET"} ${path} → ${res.status}: ${text}`,
    );
  }
  return res.json();
}

// ── List recipes ─────────────────────────────────────────────────────────────

const { recipes } = await bridgeFetch("/recipes");
console.log(
  "Installed recipes:",
  recipes.map((r) => r.name),
);

// ── Run a recipe ─────────────────────────────────────────────────────────────

const runResult = await bridgeFetch("/recipes/run", {
  method: "POST",
  body: JSON.stringify({ name: "morning-brief" }),
});
console.log("Run result:", runResult);

// Run with variables
const runWithVars = await bridgeFetch("/recipes/run", {
  method: "POST",
  body: JSON.stringify({
    name: "capture-thought",
    vars: { thought: "Add dark mode to the dashboard" },
  }),
});
console.log("Run with vars:", runWithVars);

// ── Check recent runs ─────────────────────────────────────────────────────────

const runs = await bridgeFetch("/runs?limit=5");
console.log(
  "Recent runs:",
  runs.map((r) => ({ seq: r.seq, recipe: r.recipe, status: r.status })),
);

// ── Check pending approvals ───────────────────────────────────────────────────

const approvals = await bridgeFetch("/approvals");
console.log("Pending approvals:", approvals.length);

if (approvals.length > 0) {
  const first = approvals[0];
  console.log("First pending:", {
    id: first.id,
    tool: first.tool,
    specifier: first.specifier,
  });

  // Allow it programmatically
  // const decision = await bridgeFetch(`/approvals/${first.id}`, {
  //   method: "POST",
  //   body: JSON.stringify({ decision: "allow" }),
  // });
  // console.log("Decision:", decision);
}

// ── Poll until a recipe run completes ────────────────────────────────────────

async function runAndWait(name, vars, timeoutMs = 60_000) {
  const { seq } = await bridgeFetch("/recipes/run", {
    method: "POST",
    body: JSON.stringify({ name, vars }),
  });
  if (!seq) return null;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const run = await bridgeFetch(`/runs/${seq}`);
    if (run.status === "done") return run;
    if (run.status === "error")
      throw new Error(`Recipe failed: ${run.error ?? "unknown"}`);
    if (run.status === "awaiting_approval") {
      console.log("Waiting for human approval...");
    }
  }
  throw new Error(`Timed out waiting for run #${seq}`);
}

// Uncomment to use:
// const result = await runAndWait("morning-brief");
// console.log("Output:", result.output);
