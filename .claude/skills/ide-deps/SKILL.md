---
name: ide-deps
description: Dependency graph for a file or symbol. Calls getCallHierarchy and findReferences, builds a directed graph, and renders an interactive HTML force-directed graph. Opens in the system browser.
effort: low
argument-hint: "<file path> [symbol name]"
---

## Prerequisites

1. Check if the `getToolCapabilities` MCP tool is available to you.
   - **Not available** (no MCP tool by that name): stop and tell the user:
     "This skill requires the Claude IDE Bridge with a connected VS Code extension. It uses LSP tools (call hierarchy, references, document symbols) that have no CLI equivalent.

     To use this skill:
     1. Start the bridge: `npm run start-all` (in claude-ide-bridge/)
     2. Ensure the Claude IDE Bridge extension is installed in your IDE
     3. Use the `claude --ide` session (not remote-control)

     Alternative: `/ide-diagnostics-board` works without the bridge for diagnostics."
   - **Available**: call it. If `extensionConnected` is `false`: show the same message. If `true`: proceed.

Generate an interactive dependency graph for the given file or symbol and open it in the browser.

## Arguments
`$ARGUMENTS` may be:
- A file path: `src/bridge.ts`
- A file + symbol: `src/bridge.ts:handleConnection`

If no arguments provided, call `getOpenEditors` and use the first active editor's file path.

## Steps

### Phase 1 — Identify target
1. Parse `$ARGUMENTS` to extract the file path and optional symbol name.
2. Call `openFile` on the resolved path to ensure it is loaded.
3. Call `getDocumentSymbols` on the file to list all exported functions and classes.
4. If a symbol name was specified, filter to that symbol only. Otherwise use all exported symbols (cap at 20 symbols to keep the graph readable).

### Phase 2 — Build graph data
5. For each target symbol, call `getCallHierarchy` with direction `"outgoing"` to get what it calls.
6. For each target symbol, call `getCallHierarchy` with direction `"incoming"` to get what calls it.
7. Call `findReferences` on each target symbol to get the reference count.
8. Build a deduplicated graph:
   - Nodes: `{ id, label, file, kind, refCount }`
   - Edges: `{ from, to, direction }` — direction is "outgoing" or "incoming"
   - Cap total nodes at 80. If exceeded, keep only the direct neighbors of the primary symbol.

### Phase 3 — Generate and open HTML
9. Construct a fully self-contained HTML document (no external URLs, no CDN — must work from file://) containing:
   - The graph data embedded as a `const graphData = {...}` JSON literal in a `<script>` block
   - A vanilla JS SVG force-directed graph renderer (~120 lines): nodes as circles, edges as lines, spring simulation via `requestAnimationFrame`
   - Color coding: entry point symbols = `#4A90D9`, internal = `#888`, external deps = `#E8844A`
   - Node labels shown on hover via `<title>` tooltip
   - A search input that highlights matching nodes
   - A sidebar showing selected node's file path and reference count on click
   - The file/symbol name as the page `<title>` and an `<h2>` header
10. Call `openInBrowser` with the HTML string and filename `deps-<basename>.html`.
11. Report: "Opened dependency graph — N nodes, M edges. Saved to: <path>"

## HTML constraints
- No `<script src="...">`, no `<link href="...">` to external resources
- All CSS in a `<style>` block, all JS in a `<script>` block
- Target 300–500 lines of HTML total
