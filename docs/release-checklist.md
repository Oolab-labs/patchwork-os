# Release Checklist

Steps to complete before tagging a new version. The narrative version — channels,
the publish workflow's jobs, the advisory process — is
[docs/contributing/releasing.md](contributing/releasing.md); this is the tick list.

## Code

- [ ] `npm run build` passes (bridge)
- [ ] `npm test` passes — all four CI cells green (ubuntu + windows × Node 22 + 24; see `.github/workflows/ci.yml`)
- [ ] `npm run typecheck` **and** `npm run typecheck:tests:core` pass (the second is the CI ratchet vitest cannot see)
- [ ] `npx biome check .` passes
- [ ] `cd dashboard && npm run typecheck && npm run lint && npm test` passes
- [ ] `cd vscode-extension && npm run build && npm test` passes (if the extension changed)

## Version numbers

- [ ] `package.json` version bumped — **version line only**; `npm version` rewrites unrelated escapes, so edit the line or revert the rest
- [ ] `package-lock.json` carries the same version (both places)
- [ ] `vscode-extension/package.json` version bumped if the extension changed — a repackaged `.vsix` with the same version is silently reused
- [ ] `CHANGELOG.md` entry written for this version, with a **Security** section first when an advisory is involved

## Doc drift (mechanical — do not count by hand)

Tool, prompt and coverage numbers are gated, not audited by eye:

```bash
node scripts/audit-docs-drift.mjs
```

```bash
node scripts/audit-docs-wired.mjs
```

```bash
node scripts/audit-doc-links.mjs
```

All three run in CI; run them locally after any doc edit. Do not write a current
count into this file — that is exactly the number that goes stale.

## Docs completeness

- [ ] Any new tools added this release are documented in `documents/platform-docs.md`
- [ ] Any new CLI subcommands appear in [docs/guide/cli.md](guide/cli.md) (and in `CLAUDE.md` only if they carry a trap)
- [ ] Any new hook scripts in `claude-ide-bridge-plugin/scripts/` are listed in the hooks table in both `README.md` and `claude-ide-bridge-plugin/README.md`
- [ ] `documents/roadmap.md` updated to reflect what shipped

## Extension (if changed)

- [ ] `npm run package` produces a valid `.vsix`
- [ ] Extension installs and activates in VS Code, Windsurf, and Cursor
- [ ] Bridge health check passes after install (`getBridgeStatus` returns `connected: true`)

## Publish

- [ ] Release PR (`chore(release): bump to X.Y.Z`) merged
- [ ] On `main`: `git pull`, then confirm `git rev-parse HEAD` is the merge commit **and** `package.json` says the new version — only then tag
- [ ] `git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z` on the merge commit — `publish-npm.yml` publishes `beta` (or `alpha`) from the tag with provenance
- [ ] `npm dist-tag add patchwork-os@X.Y.Z latest` by hand — OIDC publish does not cover dist-tags; needs 2FA
- [ ] Extension: `vsce publish` and `ovsx publish` (if changed)
- [ ] Security advisory, if any: set `patched_versions`, publish only once the version is on npm

## After publish

- [ ] Local bridges: `git pull && npm run build && npm run install:global`, restart the LaunchAgents, `patchwork doctor --expect-running N`, `patchwork doctor acceptance`
- [ ] `npm view patchwork-os dist-tags` shows what you expect
