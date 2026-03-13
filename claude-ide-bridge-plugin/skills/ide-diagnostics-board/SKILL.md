---
name: ide-diagnostics-board
description: Diagnostic dashboard across the workspace. Calls getDiagnostics, groups results by severity and file, and renders a sortable color-coded HTML table. Opens in the system browser.
argument-hint: "[error|warning|all]"
---

Generate a visual diagnostics dashboard for the workspace and open it in the browser.

## Prerequisites

1. Check if the `getToolCapabilities` MCP tool is available to you.
   - **Available**: call it, check `extensionConnected` → use **IDE Path** below.
   - **Not available** (no MCP tool by that name): use **CLI Path** below.

## Arguments
`$ARGUMENTS` sets the severity filter:
- `error` — errors only
- `warning` — warnings and errors
- `all` (default) — all severities

---

## IDE Path

Use this path when bridge MCP tools are available.

### Phase 1 — Collect diagnostics
1. Determine the severity filter from `$ARGUMENTS` (default: `all`).
2. Call `getDiagnostics` with no URI filter (full workspace scan). Pass the severity param if supported.
3. If no diagnostics found, report "No diagnostics found — workspace is clean." and stop.

### Phase 2 — Summarize
4. Group diagnostics by severity: errors / warnings / info / hints.
5. Group by file: sort files by error count descending.
6. Compute totals: total diagnostic count, count per severity, number of files affected.

### Phase 3 — Generate and open HTML
7. Construct the HTML document (see HTML Template section below).
8. Call `openInBrowser` with the HTML string and filename `diagnostics-<timestamp>.html`.
9. Report: "Opened diagnostics board — N errors, M warnings across K files. Saved to: <path>"

---

## CLI Path

Use this path when bridge MCP tools are NOT available (e.g., remote-control sessions).

### Phase 1 — Detect and run linters
1. Determine the severity filter from `$ARGUMENTS` (default: `all`).
2. Detect which linters are available by checking for config files using **Glob**:
   - `**/tsconfig.json` (not in node_modules) → run via **Bash**: `npx tsc --noEmit 2>&1`
   - `**/biome.json` or `**/biome.jsonc` → run via **Bash**: `npx biome check . --reporter=json 2>&1`
   - `**/.eslintrc*` or `**/eslint.config.*` → run via **Bash**: `npx eslint . --format json 2>&1`
   - `**/pyrightconfig.json` or `**/*.py` → run via **Bash**: `npx pyright --outputjson 2>&1`
   - `**/ruff.toml` or `**/pyproject.toml` → run via **Bash**: `ruff check . --output-format json 2>&1`
   - `**/Cargo.toml` → run via **Bash**: `cargo check --message-format json 2>&1`
3. If no linters detected, report "No linter configuration found in workspace." and stop.

### Phase 2 — Parse linter output
4. Parse each linter's output into a unified list of `{ severity, file, line, col, message, source }`:
   - **tsc**: lines like `file(line,col): error TSxxxx: message` — parse with regex
   - **biome JSON**: `diagnostics` array with `severity`, `location.path`, `location.span`
   - **eslint JSON**: `[{filePath, messages:[{severity,line,column,message,ruleId}]}]`
   - **pyright JSON**: `generalDiagnostics` array with `range.start.line`, `severity`, `message`
   - **ruff JSON**: `[{filename, location:{row,column}, message, code}]`
   - **cargo JSON** (NDJSON): `message.level`, `message.spans[0].file_name`, `message.spans[0].line_start`
5. Apply the severity filter from `$ARGUMENTS`.
6. If no diagnostics after filtering, report "No diagnostics found — workspace is clean." and stop.

### Phase 3 — Summarize and generate HTML
7. Group diagnostics by severity and by file (same as IDE Path).
8. Compute totals.
9. Construct the HTML document (see HTML Template section below).
10. Write the HTML to `diagnostics-<timestamp>.html` in the workspace root using the **Write** tool.
11. Open via **Bash**: `open diagnostics-<timestamp>.html` (macOS) or `xdg-open diagnostics-<timestamp>.html` (Linux).
12. Report: "Opened diagnostics board — N errors, M warnings across K files. Saved to: <path>"

---

## HTML Template

Construct a fully self-contained HTML document (no external URLs — must work from file://) containing:
- A summary bar: "N errors · M warnings · K files affected · generated <timestamp>"
- Color-coded severity badges: error=`#c0392b`, warning=`#e67e22`, info=`#2980b9`, hint=`#27ae60`
- A filter input (plain text, JS filters rows in real time)
- Column header clicks sort the table (vanilla JS, ~60 lines)
- Columns: Severity | File (relative path) | Line:Col | Message | Source
- Row background: `#fee2e2` error, `#fef9c3` warning, `#eff6ff` info, `#f0fdf4` hint
- A "Copy as Markdown" button that copies a plain Markdown table to clipboard
- Page title: "Diagnostics — <project name>"

## HTML constraints
- No external URLs or CDN links
- All CSS in `<style>`, all JS in `<script>`
- Target 300–500 lines of HTML
