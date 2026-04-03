# Release Checklist

Steps to complete before tagging a new version.

## Code

- [ ] `npm run build` passes (bridge)
- [ ] `npm test` passes — all tests green on Node 20 + 22
- [ ] `npm run typecheck` passes — zero type errors
- [ ] `npx biome check .` passes — zero lint errors
- [ ] `cd vscode-extension && npm run build && npm test` passes

## Version numbers

- [ ] `package.json` version bumped
- [ ] `vscode-extension/package.json` version bumped (if extension changed)
- [ ] `CHANGELOG.md` entry written for this version

## Hardcoded count audit (catches doc drift)

Run this before every release to find stale numbers in docs:

```bash
# Find hardcoded counts that may have drifted
grep -rn "\b[0-9]\+ tools\b\|\b[0-9]\+ hook\|\b[0-9]\+ skill\|\b[0-9]\+ test\|\b[0-9]\+ subagent" \
  README.md claude-ide-bridge-plugin/README.md documents/ \
  --include="*.md"
```

Verify each number found against actual code:

- [ ] Slim tool count (`SLIM_TOOL_NAMES.size`) — currently **32**
- [ ] Full mode tool count — currently **~103**
- [ ] Hook event count (keys in `claude-ide-bridge-plugin/hooks/hooks.json`) — currently **16**
- [ ] Plugin skill count (entries in `claude-ide-bridge-plugin/skills/`) — currently **9**
- [ ] Plugin subagent count (entries in `claude-ide-bridge-plugin/agents/`) — currently **3**
- [ ] Test count (run `npm test` and read the summary line)

## Docs completeness

- [ ] Any new tools added this release are documented in `documents/platform-docs.md`
- [ ] Any new hook scripts in `claude-ide-bridge-plugin/scripts/` are listed in the hooks table in both `README.md` and `claude-ide-bridge-plugin/README.md`
- [ ] Any new CLI subcommands are listed in `README.md` and `CLAUDE.md`
- [ ] `documents/roadmap.md` updated to reflect what shipped

## Extension (if changed)

- [ ] `npm run package` produces a valid `.vsix`
- [ ] Extension installs and activates in VS Code, Windsurf, and Cursor
- [ ] Bridge health check passes after install (`getBridgeStatus` returns `connected: true`)

## Publish

- [ ] `npm publish` (bridge)
- [ ] `vsce publish` (VS Code Marketplace)
- [ ] `ovsx publish` (Open VSX)
- [ ] Git tag pushed: `git tag vX.Y.Z && git push --tags`
