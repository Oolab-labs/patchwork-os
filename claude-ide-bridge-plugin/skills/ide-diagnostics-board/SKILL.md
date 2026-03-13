---
name: ide-diagnostics-board
description: Diagnostic dashboard across the workspace. Calls getDiagnostics, groups results by severity and file, and renders a sortable color-coded HTML table. Opens in the system browser.
argument-hint: "[error|warning|all]"
---

Generate a visual diagnostics dashboard for the workspace and open it in the browser.

## Arguments
`$ARGUMENTS` sets the severity filter:
- `error` — errors only
- `warning` — warnings and errors
- `all` (default) — all severities

## Steps

### Phase 1 — Collect diagnostics
1. Determine the severity filter from `$ARGUMENTS` (default: `all`).
2. Call `getDiagnostics` with no URI filter (full workspace scan). Pass the severity param if supported.
3. If no diagnostics found, report "No diagnostics found — workspace is clean." and stop.

### Phase 2 — Summarize
4. Group diagnostics by severity: errors / warnings / info / hints.
5. Group by file: sort files by error count descending.
6. Compute totals: total diagnostic count, count per severity, number of files affected.

### Phase 3 — Generate and open HTML
7. Construct a fully self-contained HTML document (no external URLs — must work from file://) containing:
   - A summary bar: "N errors · M warnings · K files affected · generated <timestamp>"
   - Color-coded severity badges: error=`#c0392b`, warning=`#e67e22`, info=`#2980b9`, hint=`#27ae60`
   - A filter input (plain text, JS filters rows in real time)
   - Column header clicks sort the table (vanilla JS, ~60 lines)
   - Columns: Severity | File (relative path) | Line:Col | Message | Source
   - Row background: `#fee2e2` error, `#fef9c3` warning, `#eff6ff` info, `#f0fdf4` hint
   - A "Copy as Markdown" button that copies a plain Markdown table to clipboard
   - Page title: "Diagnostics — <project name>"
8. Call `openInBrowser` with the HTML string and filename `diagnostics-<timestamp>.html`.
9. Report: "Opened diagnostics board — N errors, M warnings across K files. Saved to: <path>"

## HTML constraints
- No external URLs or CDN links
- All CSS in `<style>`, all JS in `<script>`
- Target 300–500 lines of HTML
