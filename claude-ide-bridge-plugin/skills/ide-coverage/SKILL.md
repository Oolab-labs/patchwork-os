---
name: ide-coverage
description: Test coverage heatmap from lcov or JSON coverage data. Finds coverage reports, parses line coverage per file, and renders a color-coded file-tree heatmap as HTML. Opens in the system browser.
argument-hint: "[path to coverage file or directory]"
---

Generate a visual test coverage heatmap and open it in the browser.

This skill uses only built-in tools (Glob, Read, Write, Bash) and works in both IDE-connected and remote sessions.

## Arguments
`$ARGUMENTS` can be:
- A path to a specific coverage file (`coverage/lcov.info`, `coverage/coverage-summary.json`)
- A directory to search within (`coverage/`)
- Empty — auto-discover coverage files in the workspace

## Steps

### Phase 1 — Locate coverage data
1. If `$ARGUMENTS` is a specific file path, use it directly.
2. Otherwise use the **Glob** tool with patterns: `**/lcov.info`, `**/coverage-summary.json`, `**/coverage-final.json` (exclude `node_modules`).
3. If multiple candidates found, prefer `lcov.info` > `coverage-summary.json` > `coverage-final.json`. If still ambiguous (multiple projects), list them and ask the user to specify.
4. If no coverage file found: report "No coverage data found. Run `npm test -- --coverage` (or equivalent) first." and stop.

### Phase 2 — Parse coverage
5. Use the **Read** tool to read the located coverage file.
6. Parse based on format:
   - **lcov.info**: iterate `SF:` (source file), `LF:` (lines found), `LH:` (lines hit) records → `{ file, totalLines, hitLines, pct }`
   - **coverage-summary.json** (Istanbul/NYC): each key is a file path with `{ lines: { pct, total, covered } }`
   - **coverage-final.json**: compute line pct from statement map `s` and statement map `statementMap`
7. Build a list: `{ file: string (relative), pct: number, hitLines: number, totalLines: number }[]`
8. Group files by directory for the tree layout. Compute directory-level aggregate coverage.

### Phase 3 — Generate and open HTML
9. Construct a fully self-contained HTML document (no external URLs — must work from file://) containing:
   - A summary header: "Overall coverage: N% · M / K lines covered · P files"
   - Color scale: ≥80% = `#22c55e` (green), ≥50% = `#eab308` (yellow), <50% = `#ef4444` (red), no data = `#94a3b8` (grey)
   - A collapsible directory tree using `<details>`/`<summary>` HTML elements (no JS needed for expand/collapse)
   - Each file as a row: `[coverage bar] filename  N%  (hitLines/totalLines)`
   - The coverage bar is an inline `<span>` with a CSS `width: N%` background — no canvas needed
   - Directory rows show aggregate coverage for the subtree
   - A legend at the top showing the color key
   - Clicking a file's name copies its relative path to clipboard (single JS event listener, ~10 lines)
   - Page title: "Coverage — <project name>"
10. Write the HTML to `coverage-<timestamp>.html` in the workspace root using the **Write** tool.
11. Open via **Bash**: `open coverage-<timestamp>.html` (macOS) or `xdg-open` (Linux). If `openInBrowser` MCP tool is available, use that instead.
12. Report: "Opened coverage heatmap — overall N% line coverage across M files. Saved to: <path>"

## HTML constraints
- No external URLs or CDN links
- All CSS in `<style>`, JS limited to the clipboard copy handler
- Target 250–400 lines of HTML
