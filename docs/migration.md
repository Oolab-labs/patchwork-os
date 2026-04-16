# Migration Guide

## v2.x → v2.30 (current)

### Breaking Changes
None. All changes in v2.x are additive.

### New in v2.30
- **Tools**: `findRelatedTests`, `screenshotAndAnnotate`, `getSymbolHistory` (v2.30.0)
- **Hook**: `onDebugSessionEnd` automation hook
- **Companions**: `claude-ide-bridge install <companion>` command
- **Headless LSP fallback**: `goToDefinition`, `findReferences`, `getTypeSignature` now work without VS Code via `typescript-language-server`

### New in v2.29
- **Marketplace CLI**: `claude-ide-bridge marketplace list/search/install`
- **Docker**: Official image at `ghcr.io/oolab-labs/claude-ide-bridge`; `docker-compose.yml` included
- **Alpine Docker**: `ctags` package (was `universal-ctags`)

### New in v2.28
- **Automation conditions**: `when` field on hook policies (`minDiagnosticCount`, `diagnosticsMinSeverity`, `testRunnerLastStatus`)
- **Retry**: `retryCount` + `retryDelayMs` on all hook policies
- **Tool deny list**: `X-Bridge-Deny-Tools` HTTP header
- **Schema audit**: `npm run schema:check` / `schema:update`

### New in v2.27
- **Dashboard**: `GET /dashboard` (HTML), `GET /dashboard/data` (JSON)
- **Ctags fallback**: `searchWorkspaceSymbols` → Universal Ctags when extension absent
- **OAuth 2.0**: `--issuer-url` activates PKCE OAuth for remote claude.ai connectors

### New in v2.26
- **Progress streaming**: `runCommand` and `runTests` stream output line-by-line via `notifications/progress`
- **Smoke suite**: `npm run test:smoke`
- **Bridge auto-repair**: stale `bridge-tools.md` repaired at startup

### New in v2.25
- **Automation overhaul**: 12 hooks, subprocess driver, loop guards, CC hook wiring
- **Composite tools**: `formatAndSave`, `jumpToFirstError`, `navigateToSymbolByName`
- **outputSchema**: 59 tools emit structured output (now 92)
- **Shape-mismatch prevention**: `tryRequest<T>()`, `validatedRequest<T>()`, `proxy<T>()` deprecated

---

## Upgrading Steps

### npm (global install)
```bash
npm update -g claude-ide-bridge
```
Always use `@latest` — `npm update -g` may not fetch the latest if the semver range is already satisfied:
```bash
npm install -g claude-ide-bridge@latest
```

### VS Code Extension
The extension updates automatically via VS Code Marketplace. To force an update: Extensions panel → claude-ide-bridge → Update.

Check version compatibility: bridge `getBridgeStatus` reports `extensionPackageVersion`. Extension v1.3.x works with bridge v2.25+.

### Docker
```bash
docker pull ghcr.io/oolab-labs/claude-ide-bridge:latest
```
Pin to a tag for stability:
```bash
docker pull ghcr.io/oolab-labs/claude-ide-bridge:v2.30.1
```

---

## v1.x → v2.x

### Breaking Changes

**Lock file format**: v2 adds `isBridge: true` to distinguish bridge-owned lock files from IDE-owned files. Old lock files without this field are ignored. Delete stale lock files:
```bash
rm ~/.claude/ide/*.lock
```

**Auth token**: v2 rotates the token on every start unless `--fixed-token` is set. Update any hardcoded tokens in scripts.

**Tool names**: Several tools were renamed in v2.0:

| v1 name | v2 name |
|---|---|
| `executeCommand` | `runCommand` |
| `readFile` | `getBufferContent` |
| `writeFile` | `editText` |
| `listFiles` | `getFileTree` |

**Slim mode**: v2 introduced slim mode (default in v2.0–v2.42). **v2.43.0 flipped the default back to full mode** — all ~140 tools are now registered by default. Pass `--slim` to opt into the IDE-exclusive subset. The `--full` flag is retained as a no-op for backward compatibility with older start commands.

**MCP config**: Regenerate after upgrade:
```bash
claude-ide-bridge gen-mcp-config > ~/.claude/mcp-config.json
```

### Migration Steps (v1 → v2)
1. `npm install -g claude-ide-bridge@latest`
2. `rm ~/.claude/ide/*.lock` — clear stale lock files
3. Update start command: drop `--full` (now the default); add `--slim` only if you want the IDE-exclusive subset
4. Regenerate MCP config: `claude-ide-bridge gen-mcp-config`
5. Re-install VS Code extension (v2 extension required; v1 extension is incompatible)
6. Update any tool names in scripts (see table above)

---

## Automation Policy Migration

### v2.25 → v2.28: `when` conditions
Old policies without a `when` field continue to work — `when` is optional.

To use the new condition fields, add a `when` block to any hook entry:
```json
{
  "type": "onDiagnosticsError",
  "when": {
    "minDiagnosticCount": 3,
    "diagnosticsMinSeverity": "error"
  },
  "prompt": "Fix the errors in {{file}}"
}
```

Supported condition fields:
- `minDiagnosticCount` — minimum number of diagnostics before hook fires
- `diagnosticsMinSeverity` — `"error"` or `"warning"`
- `testRunnerLastStatus` — `"failed"` or `"passed"`

### v2.23 → v2.25: CC hook wiring format
Claude Code requires hooks in a nested `{matcher, hooks:[...]}` format. Old flat format:
```json
"PostCompact": [{ "type": "command", "command": "..." }]
```
New nested format:
```json
"PostCompact": [{ "matcher": "", "hooks": [{ "type": "command", "command": "..." }] }]
```
Run `claude-ide-bridge init` to auto-migrate existing `~/.claude/settings.json` entries.

### v2.22 → v2.23: `notify` subcommand
The `notifyPostCompact` and `notifyInstructionsLoaded` MCP tools were removed in v2.25. Replace any calls to those tools in scripts with the `notify` subcommand:
```bash
claude-ide-bridge notify PostCompact
claude-ide-bridge notify InstructionsLoaded
```
The `notify` subcommand reads the bridge lock file, resolves the running port and auth token, and POSTs to the `/notify` HTTP endpoint. The bridge must be running.

Full list of supported events:
```bash
claude-ide-bridge notify PostCompact
claude-ide-bridge notify InstructionsLoaded
claude-ide-bridge notify TaskCreated --taskId $TASK_ID --prompt $PROMPT
claude-ide-bridge notify PermissionDenied --tool $TOOL --reason $REASON
claude-ide-bridge notify CwdChanged --cwd $CWD
```

---

## Common Issues After Upgrading

### Bridge reports wrong extension version
`getBridgeStatus` now reports two version fields: `extensionVersion` (wire protocol, `"1.1.0"`) and `extensionPackageVersion` (npm, e.g. `"1.3.2"`). The log line `version=1.1.0` refers to the wire protocol — this is expected and does not mean the extension is stale.

### Tools missing after upgrade
Run `getToolCapabilities` to see which tools are available in the current mode. Since v2.43.0 full mode is the default — if tools you expect are missing, check that your start command does NOT pass `--slim` and that `claude-ide-bridge.config.json` does not set `"fullMode": false`.

### `goToDefinition` / `findReferences` not working headlessly
These tools now have a headless LSP fallback via `typescript-language-server`. If the fallback is not triggering, confirm `typescript-language-server` is installed:
```bash
npm install -g typescript-language-server typescript
```
Check `getBridgeStatus.toolAvailability` — tools with `extensionFallback: true` support both paths.

### Automation hooks not firing
1. Confirm the bridge started with `--automation --automation-policy <path>`.
2. Run `getBridgeStatus` and check `unwiredEnabledHooks`. Any hooks listed there need entries in `~/.claude/settings.json`.
3. Run `claude-ide-bridge init` to auto-wire CC hooks.
4. Check cooldown — minimum 5 seconds between triggers for the same file/event.

### Lock file conflict on startup
If the bridge fails to start with a lock file error, a previous instance may not have cleaned up:
```bash
rm ~/.claude/ide/*.lock
```
Then restart. Lock files are created with `O_EXCL` to prevent concurrent bridge instances on the same port.

### Docker: extension tools unavailable
The Docker image runs the bridge in headless mode — VS Code extension tools require a connected VS Code instance. CLI-only tools (file I/O, git, terminal, LSP fallback) work fully headless. See `documents/headless-quickstart.md` for what works without VS Code.

---

## Version Compatibility Matrix

| Bridge version | Extension version | Claude Code minimum |
|---|---|---|
| v2.30.x | v1.3.x | v2.1.84+ (for TaskCreated hook) |
| v2.29.x | v1.3.x | v2.1.77+ |
| v2.28.x | v1.3.x | v2.1.77+ |
| v2.25.x | v1.3.x | v2.1.77+ |
| v2.23.x | v1.2.x | v2.1.0+ |
| v2.x | v1.0.x | any |
| v1.x | v1.0.x | any |

Extension v1.3.x is backward-compatible with bridge v2.25+. If `getBridgeStatus` reports the extension as disconnected after upgrade, uninstall and reinstall the extension from the VS Code Marketplace.
