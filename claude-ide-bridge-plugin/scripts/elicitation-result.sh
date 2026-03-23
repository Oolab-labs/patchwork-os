#!/bin/bash
# ElicitationResult hook: Log when a user responds to an MCP elicitation dialog.
#
# Fires after the user provides (or cancels) a structured input requested by an
# MCP server via elicitation/create. Useful for understanding what the user
# answered and whether the dialog was cancelled.
#
# Input:  JSON on stdin — { elicitation_id, action, result, ... }
#         action: "submit" | "cancel" | "timeout"
#         result: the submitted values (present when action="submit")
# Output: exit 0 (informational only — no hookSpecificOutput needed)

set -euo pipefail

INPUT=$(cat)
ACTION=$(echo "$INPUT" | jq -r '.action // ""' 2>/dev/null)
ELICITATION_ID=$(echo "$INPUT" | jq -r '.elicitation_id // ""' 2>/dev/null)

if [ -z "$ACTION" ]; then
  exit 0
fi

# Only surface non-submit outcomes (cancel/timeout) — submit is expected normal flow
if [ "$ACTION" = "submit" ]; then
  exit 0
fi

jq -n \
  --arg action "$ACTION" \
  --arg id "$ELICITATION_ID" \
  '{
    hookSpecificOutput: {
      hookEventName: "ElicitationResult",
      message: ("Elicitation " + (if $id != "" then $id + " " else "" end) + $action + "ed — user did not provide input")
    }
  }'
