# Releasing

The step-by-step checklist is [docs/release-checklist.md](../release-checklist.md).
This page explains the channels, the publish workflow, the sequence that keeps
a tag honest, and the two things that are manual.

## Channels

| Channel | How it is cut | Who installs it |
|---|---|---|
| `latest` | Manual: `npm dist-tag add` after a stable version is on npm. | Default `npm install -g patchwork-os`. |
| `beta` | A `chore(release):` PR bumps the version; after merge, a `v*-beta*` tag on the merge commit triggers the publish workflow. The active channel. | Operators who want the curated line. |
| `alpha` | Same shape with a `v*-alpha*` tag. | Early testers. |
| `canary` | **Automatic** on every green `main` merge. Version shape `<base>.canary.<runNumber>`. | `npm install -g patchwork-os@canary` tracks `main`. Never default-installed. |

`package.json` is the single source of truth for the version, and
`scripts/audit-version-drift.mjs` fails CI when a reader-facing document
quotes a version line that no longer agrees with it.

## The publish workflow

Everything publishes from **one** file, `.github/workflows/publish-npm.yml`,
because npm trusted publishing allows a single trusted-publisher entry per
package, matched by exact workflow filename. It has three triggers — a tag push
matching `v*-alpha*` or `v*-beta*`, a `workflow_run` completion of the `CI`
workflow on `main`, and a manual `workflow_dispatch` with a bump type — and
four jobs:

| Job | Runs when | Publishes |
|---|---|---|
| `publish-alpha` | tag contains `-alpha` | `npm publish --tag alpha` |
| `publish-beta` | tag contains `-beta` | `npm publish --tag beta` |
| `publish` | `workflow_dispatch` only | stable `npm publish` plus a GitHub Release with generated notes. Guarded so an alpha tag cannot reach it. |
| `publish-canary` | `workflow_run` of CI, conclusion `success`, head branch `main` | checks out the CI run's `head_sha`, rewrites `package.json` to `<base>.canary.<run_number>`, `npm publish --tag canary` |

Every job first asks npm whether that exact version already exists and skips
the publish if so, so a retry cannot fail with a conflict. `prepublishOnly`
runs the tracked-files pack gate, the build, a `--help` smoke, schema
publishing and the fresh-install smoke before anything leaves the machine.

## The sequence for a `beta` release

1. **Bump the version in `package.json` only**, with a targeted edit, and
   let `npm install` update `package-lock.json`. Do not run a tool that
   rewrites unrelated fields.
2. **Write the `CHANGELOG.md` entry.** Run the hardcoded-count audit from the
   release checklist and fix any stale number it finds; the docs-drift gate
   will catch the ones about tool counts, but not everything.
3. **Open the PR** titled `chore(release): bump to <version>`. CI must be
   green on all cells. To wait for that from a script rather than by eye:

   ```bash
   node scripts/wait-pr-checks.mjs <pr-number> && gh pr merge <pr-number> --squash
   ```

   It exits 0 only when every check has completed and passed; an in-progress
   check with an empty `conclusion` is pending, not failed — the mistake a
   hand-written `jq` filter makes.
4. **Merge.** Then, locally:

   ```bash
   git checkout main && git pull
   ```

5. **Verify before tagging.** `HEAD` must be the merge commit of the release
   PR, and `package.json` on `HEAD` must carry the version you are about to
   tag. A tag created before the pull, or on a feature branch, publishes the
   wrong tree under the right name and cannot be recalled from npm.

   ```bash
   node -p "require('./package.json').version"
   ```

6. **Tag the merge commit and push the tag.**

   ```bash
   git tag v1.2.3-beta.4 && git push origin v1.2.3-beta.4
   ```

7. Watch the `Publish to npm` run. When it finishes, confirm the version is on
   npm under the `beta` dist-tag.

Never install a release from a feature branch, and never push to `main`
directly — the release PR is the review.

## What is manual

**`latest` is a manual dist-tag.** Trusted publishing covers `npm publish`; it
does not cover `npm dist-tag`. Moving `latest` requires a maintainer with 2FA
on the package:

```bash
npm dist-tag add patchwork-os@1.2.3 latest
```

**The extension has its own version and its own rule.** VS Code forks cache a
`.vsix` by its version number and silently reuse the old bundle if the number
has not changed. **Always bump `vscode-extension/package.json` before
`npm run package`.** A patch bump is enough. Never repackage without bumping;
the person installing it will see no change and conclude the fix did not work.
The extension's wire protocol version is separate from its package version
([ADR-0001](../adr/0001-dual-version-numbers.md)) and changes rarely.

**Publishing the extension** is `vsce publish` to the Marketplace and
`ovsx publish` to Open VSX; both are in the checklist.

## Security advisories

Vulnerabilities are reported privately through the repository's security
advisory form ([SECURITY.md](../../SECURITY.md)). The release side of a fix:

1. Open a GitHub Security Advisory (GHSA) on the repository as a draft. Record
   the vulnerable version range and the patched version. Work on the fix in a
   normal PR; the PR text must not describe where the vulnerability is in
   terms that are themselves an exploit — see
   [privacy-rules.md](privacy-rules.md) on where sensitive findings go.
2. Merge the fix, cut the release that contains it as above, and confirm the
   patched version is on npm under the channel the advisory names.
3. Publish the advisory **after** the patched version is installable. An
   advisory that names a fix nobody can install yet is a disclosure with no
   remedy.
4. Update `SECURITY.md`'s supported-versions section if the supported line
   changed; the version-drift gate checks it.

Credit the reporter in the advisory unless they prefer otherwise.

## After the release

- Confirm the deployed bridges run the installed code. `patchwork doctor`
  compares each running bridge's start time against the installed build;
  `patchwork doctor acceptance` exercises the runtime paths. A merge is not
  the end of a fix.
- Update `documents/roadmap.md` for what shipped (it is on the checklist).
