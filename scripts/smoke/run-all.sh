#!/usr/bin/env bash
# claude-ide-bridge smoke test suite
# Runs all categories sequentially against a live bridge instance.
# Exit 0 = all pass. Exit 1 = one or more failures.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE="${BRIDGE:-claude-ide-bridge}"
export BRIDGE
PORT=37210
TMPWS="$(mktemp -d)"
CLAUDE_CFG="$(mktemp -d)"
export CLAUDE_CONFIG_DIR="$CLAUDE_CFG"
mkdir -p "$CLAUDE_CFG/ide"

RED='\033[0;31m'; GREEN='\033[0;32m'; RESET='\033[0m'
PASS=0; FAIL=0; FAILED_CATS=()

run_cat() {
  local label="$1"; shift
  if node "$@"; then
    echo -e "${GREEN}[PASS]${RESET} $label"
    ((PASS++)) || true
  else
    echo -e "${RED}[FAIL]${RESET} $label"
    ((FAIL++)) || true
    FAILED_CATS+=("$label")
  fi
}

cleanup() {
  if [[ -n "${BRIDGE_PID:-}" ]]; then
    kill "$BRIDGE_PID" 2>/dev/null || true
  fi
  rm -rf "$TMPWS" "$CLAUDE_CFG"
}
trap cleanup EXIT

echo "Starting bridge on port $PORT..."
"$BRIDGE" --port "$PORT" --workspace "$TMPWS" &
BRIDGE_PID=$!

# Wait for lock file to appear (bridge writes it before accepting connections)
DEADLINE=$(( $(date +%s) + 10 ))
until [[ -f "$CLAUDE_CFG/ide/${PORT}.lock" ]]; do
  if (( $(date +%s) > DEADLINE )); then
    echo "ERROR: bridge lock file not written after 10s"; exit 1
  fi
  sleep 0.1
done
sleep 0.2  # tiny extra buffer for WS listener to bind

TOKEN=$("$BRIDGE" print-token --port "$PORT")
echo "Bridge ready. Token: ${TOKEN:0:8}..."
echo ""

# ── Categories ────────────────────────────────────────────────────────────────

# Cat 2: lock file — also kills the bridge as part of test (2.4)
# Run it last among shared-bridge tests, or skip 2.4 if bridge must stay up.
# We run it against a separate ephemeral bridge so main bridge stays alive.
CAT2_PORT=37211
CAT2_CFG="$(mktemp -d)"; mkdir -p "$CAT2_CFG/ide"
CLAUDE_CONFIG_DIR="$CAT2_CFG" "$BRIDGE" --port "$CAT2_PORT" --workspace "$TMPWS" &
CAT2_PID=$!
DEADLINE2=$(( $(date +%s) + 10 ))
until [[ -f "$CAT2_CFG/ide/${CAT2_PORT}.lock" ]]; do
  if (( $(date +%s) > DEADLINE2 )); then break; fi; sleep 0.1
done
sleep 0.2
CLAUDE_CONFIG_DIR="$CAT2_CFG" run_cat "CAT-2 (lockfile)" \
  "$SCRIPT_DIR/cat2-lockfile.mjs" "$CAT2_PORT" "$CAT2_PID"
rm -rf "$CAT2_CFG"

run_cat "CAT-3 (auth)"        "$SCRIPT_DIR/cat3-auth.mjs"       "$PORT" "$TOKEN"
run_cat "CAT-4 (tools)"       "$SCRIPT_DIR/cat4-tools.mjs"
run_cat "CAT-5 (http)"        "$SCRIPT_DIR/cat5-http.mjs"       "$PORT" "$TOKEN"
run_cat "CAT-6 (oauth)"       "$SCRIPT_DIR/cat6-oauth.mjs"
run_cat "CAT-7 (plugin)"      "$SCRIPT_DIR/cat7-plugin.mjs"
run_cat "CAT-8 (ratelimit)"   "$SCRIPT_DIR/cat8-ratelimit.mjs"  "$PORT" "$TOKEN"
sleep 1  # CAT-8 saturates rate limiter + connection throttle; give bridge 1s to reset
run_cat "CAT-9 (prompts/res)"  "$SCRIPT_DIR/cat9-prompts-resources.mjs" "$PORT" "$TOKEN"
run_cat "CAT-10 (health)"     "$SCRIPT_DIR/cat10-health.mjs"    "$PORT" "$TOKEN"
run_cat "CAT-11 (shutdown)"   "$SCRIPT_DIR/cat11-shutdown.mjs"
run_cat "CAT-12 (automation)" "$SCRIPT_DIR/cat12-automation.mjs"

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════"
TOTAL=$(( PASS + FAIL ))
if (( FAIL == 0 )); then
  echo -e "${GREEN}ALL PASS${RESET} ($PASS/$TOTAL categories)"
else
  echo -e "${RED}FAILURES: $FAIL/$TOTAL categories${RESET}"
  for c in "${FAILED_CATS[@]}"; do echo "  ✗ $c"; done
fi
echo "═══════════════════════════════════"
exit $((FAIL > 0 ? 1 : 0))
