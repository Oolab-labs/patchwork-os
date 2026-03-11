---
name: ide-monitor
description: Continuous IDE monitoring using bridge tools. Checks diagnostics, test results, or terminal output. Designed for use with /loop for recurring checks.
disable-model-invocation: true
argument-hint: "diagnostics | tests [filter] | terminal <name>"
---

# IDE Monitor

Monitor your IDE workspace continuously. Use with `/loop` for recurring checks.

## Usage patterns

```
/loop 5m /claude-ide-bridge:ide-monitor diagnostics
/loop 10m /claude-ide-bridge:ide-monitor tests
/loop 2m /claude-ide-bridge:ide-monitor terminal dev-server
```

Or run once:
```
/claude-ide-bridge:ide-monitor diagnostics
```

## Modes

Parse `$ARGUMENTS` to determine the monitoring mode:

### Mode: `diagnostics` (default if no argument)

1. Use `getDiagnostics` to get all current errors and warnings
2. Compare with the previous check (if this is a recurring loop):
   - Report **new** errors since last check
   - Report **resolved** errors since last check
3. If there are critical errors, summarize them prominently
4. If everything is clean, report "No issues found"

### Mode: `tests [filter]`

1. Use `runTests` with the optional filter from the argument
2. Report:
   - Total pass/fail counts
   - Any **new** failures (tests that were passing before)
   - Test duration for performance tracking
3. If tests fail, suggest running `/claude-ide-bridge:ide-debug` to investigate

### Mode: `terminal <name>`

1. Use `getTerminalOutput` with the terminal name from the argument
2. Check for:
   - Error patterns in recent output (stack traces, "Error:", "FATAL")
   - Whether the process is still running (use `listTerminals`)
3. If the terminal has died, report it and suggest restarting
4. If errors are found, summarize the most recent ones

## Output format

Keep output concise for recurring checks:
- One-line summary for "all clear" results
- Bullet list for issues found
- Include timestamps so the user can track when issues appeared
