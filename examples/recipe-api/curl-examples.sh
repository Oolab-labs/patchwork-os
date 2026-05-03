#!/usr/bin/env bash
# Patchwork OS — Recipe API curl examples
#
# Prerequisites:
#   1. Bridge running:  claude-ide-bridge --full
#   2. Token:          BRIDGE_TOKEN=$(patchwork print-token)
#
# All endpoints require:
#   Authorization: Bearer <token>
#   Content-Type: application/json  (for POST requests)

set -euo pipefail

BRIDGE_URL="${BRIDGE_URL:-http://localhost:3100}"
BRIDGE_TOKEN="${BRIDGE_TOKEN:-$(patchwork print-token 2>/dev/null || echo 'SET_YOUR_TOKEN_HERE')}"

AUTH=(-H "Authorization: Bearer $BRIDGE_TOKEN")

# ── List installed recipes ────────────────────────────────────────────────────

echo "=== List recipes ==="
curl -s "${AUTH[@]}" "$BRIDGE_URL/recipes" | jq '.recipes[].name'

# ── Run a recipe ─────────────────────────────────────────────────────────────

echo "=== Run morning-brief ==="
curl -s -X POST "${AUTH[@]}" \
  -H "Content-Type: application/json" \
  -d '{"name": "morning-brief"}' \
  "$BRIDGE_URL/recipes/run" | jq .

# Run a recipe with variables
echo "=== Run a recipe with variables ==="
curl -s -X POST "${AUTH[@]}" \
  -H "Content-Type: application/json" \
  -d '{"name": "capture-thought", "vars": {"thought": "Add dark mode to the dashboard"}}' \
  "$BRIDGE_URL/recipes/run" | jq .

# ── Check recent runs ─────────────────────────────────────────────────────────

echo "=== Recent runs (last 10) ==="
curl -s "${AUTH[@]}" "$BRIDGE_URL/runs?limit=10" | jq '.[] | {seq, recipe, status, triggeredAt}'

# Filter runs by recipe name
echo "=== Runs for morning-brief ==="
curl -s "${AUTH[@]}" "$BRIDGE_URL/runs?recipe=morning-brief&limit=5" | jq '.[].status'

# Filter by status
echo "=== Failed runs ==="
curl -s "${AUTH[@]}" "$BRIDGE_URL/runs?status=error&limit=5" | jq '.[].recipe'

# ── Fetch a single run ────────────────────────────────────────────────────────

echo "=== Fetch run #1 ==="
curl -s "${AUTH[@]}" "$BRIDGE_URL/runs/1" | jq '{seq, recipe, status, steps: (.steps | length)}'

# ── Check pending approvals ───────────────────────────────────────────────────

echo "=== Pending approvals ==="
curl -s "${AUTH[@]}" "$BRIDGE_URL/approvals" | jq '.[] | {id, tool, specifier}'

# Allow a pending approval (replace ID with real value)
# curl -s -X POST "${AUTH[@]}" \
#   -H "Content-Type: application/json" \
#   -d '{"decision": "allow"}' \
#   "$BRIDGE_URL/approvals/<approval-id>"

# ── Send a test webhook ───────────────────────────────────────────────────────

echo "=== POST to a webhook-triggered recipe ==="
# Recipe must have trigger.type: webhook  and  trigger.path: /my-recipe
curl -s -X POST "${AUTH[@]}" \
  -H "Content-Type: application/json" \
  -d '{"source": "my-app", "event": "user.signup", "userId": "u_123"}' \
  "$BRIDGE_URL/hooks/my-recipe" | jq .

# ── Stream approval events (SSE) ─────────────────────────────────────────────

echo "=== Stream approvals (Ctrl-C to stop) ==="
# curl -sN "${AUTH[@]}" "$BRIDGE_URL/approvals/stream"
