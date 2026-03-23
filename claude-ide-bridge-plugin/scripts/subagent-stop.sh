#!/bin/bash
# SubagentStop hook: Log subagent completion with final response summary.
#
# Fires when a subagent (spawned via the Agent tool) finishes. Uses the
# last_assistant_message field (added in Claude Code 2.1.47) to surface
# what the subagent concluded, making it easier for the parent agent to
# act on the result without re-reading the full transcript.
#
# Input:  JSON on stdin — { agent_id, agent_type, agent_name,
#                           last_assistant_message, stop_reason, ... }
# Output: JSON on stdout — hookSpecificOutput with subagent summary

set -euo pipefail

INPUT=$(cat)
AGENT_ID=$(echo "$INPUT" | jq -r '.agent_id // ""' 2>/dev/null)
AGENT_NAME=$(echo "$INPUT" | jq -r '.agent_name // ""' 2>/dev/null)
AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // ""' 2>/dev/null)
LAST_MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // ""' 2>/dev/null)
STOP_REASON=$(echo "$INPUT" | jq -r '.stop_reason // ""' 2>/dev/null)

LABEL="${AGENT_NAME:-${AGENT_TYPE:-${AGENT_ID:-subagent}}}"

if [ -z "$LAST_MSG" ] && [ -z "$STOP_REASON" ]; then
  exit 0
fi

# Truncate summary
if [ ${#LAST_MSG} -gt 300 ]; then
  LAST_MSG="${LAST_MSG:0:297}..."
fi

jq -n \
  --arg label "$LABEL" \
  --arg msg "$LAST_MSG" \
  --arg reason "$STOP_REASON" \
  '{
    hookSpecificOutput: {
      hookEventName: "SubagentStop",
      message: ("Subagent " + $label + " stopped" + (if $reason != "" then " (" + $reason + ")" else "" end) + "." + (if $msg != "" then " Final response: " + $msg else "" end))
    }
  }'
