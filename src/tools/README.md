# src/tools

This directory holds every MCP tool implementation the bridge exposes to Claude Code — 177 tools per `documents/platform-docs.md`, spanning file I/O, git, LSP navigation/refactoring, terminal execution, HTTP, debugging, and Claude subprocess orchestration. Each tool is a small module exporting a factory that the registry in `index.ts` wires into the MCP server at startup. Shared cross-cutting concerns (path safety, arg parsing, response shaping) live in a handful of `*-utils.ts` / `utils.ts` files rather than being reimplemented per tool.

## The 5 files that matter and why

- **`utils.ts`** — `resolveFilePath` is the path-traversal jail every tool must route through (rejects null bytes, symlink escapes, paths outside the workspace); also home to shared helpers like `requireString`/`optionalString` arg validation, `hasNestedQuantifier` (ReDoS guard for `searchAndReplace`/`stageEdit`), and response builders (`error`, `successStructuredLarge`).
- **`runCommand.ts`** — smallest file that enforces the command allowlist and argument-splitting defense described in CLAUDE.md's Security Model; read this before touching anything that shells out.
- **`lsp.ts`** — the largest tool file (~1700 lines) and the reference implementation for the LSP tool surface (`goToDefinition`, `findReferences`, `getCallHierarchy`, refactor tools, etc.); most new navigation/refactor tools are modeled on patterns here.
- **`editText.ts`** — representative worked example of a non-trivial factory-pattern tool: arg validation via `utils.ts` helpers, extension round-trip via `ExtensionClient`, structured success/error responses.
- **`index.ts`** — the tool registry; every tool factory gets imported and registered here, so it's the map of "what exists" and the first place to check when adding or auditing a tool.

## Invariants you must not break

- `outputSchema` is mandatory on every tool, enforced per-schema-block (not per-file) by `scripts/audit-lsp-tools.mjs`. Exceptions require a reason in `scripts/audit-output-schema-allowlist.json`; the ratchet gate rejects new entries and stale ones.
- Tool names must match `/^[a-zA-Z0-9_]+$/`.
- Tool execution errors return `isError: true` in the content payload — never a JSON-RPC error. JSON-RPC errors are reserved for protocol-level issues. See [ADR-0004](../../docs/adr/0004-tool-errors-as-content.md).
- Tools that depend on the VS Code extension must set `extensionRequired: true` in their schema.
- All file path resolution must go through `resolveFilePath` in `utils.ts` — never build paths by hand, or the path-traversal guard is bypassed.
- Factory pattern (`createXxxTool(deps)` returning `{ schema, handler }`) and the full security model are documented in the root `CLAUDE.md` ("Architecture Rules" / "Security Model") — consult those rather than re-deriving conventions here.

## How to test it

- Unit tests live in `src/tools/__tests__/`, one suite per tool (or shared concern) using vitest — run `npm test` from the repo root, or scope with `npx vitest run src/tools/__tests__/<name>.test.ts`.
- Beyond unit coverage, CI also runs `scripts/audit-lsp-tools.mjs`, which enforces the `outputSchema` gate and produces the authoritative tool-count Stats line referenced from `CLAUDE.md` — run it locally after adding/removing a tool to catch registration or schema gaps before pushing.
