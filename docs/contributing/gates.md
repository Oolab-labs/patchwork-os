# Audit gates — the checks vitest cannot see

Every `scripts/audit-*.mjs` is a check that runs **outside** vitest and
outside `tsc`. A green test suite plus a green typecheck tells you nothing
about them, and one of them turning red has turned every CI cell red more than
once. This page lists each one: what it checks, whether it gates CI, and how
an exception is recorded.

Run any of them from the repository root:

```bash
node scripts/audit-doc-links.mjs
```

Two conventions hold across the family:

- **Allowlists carry a reason.** Where a gate has a JSON allowlist, each entry
  is an object with a `reason` a reviewer can check. Unused entries are
  reported so they can be deleted, not silently kept.
- **Ratchets only shrink.** Several gates compare against a list of *known
  bugs*, not approved exceptions. You may remove entries as you fix them; you
  may not add one. A stale entry (the bug is fixed but the exemption remains)
  fails the gate too, because an unfinished change is not a clean run.

"Gates CI" below means the script is a step in `.github/workflows/ci.yml`.
The header comment of each script carries the incident that motivated it; read
it before arguing with the gate.

## Documentation gates

| Script | Checks | Gates CI | Exceptions |
|---|---|---|---|
| `audit-doc-links.mjs` | Every relative link in every tracked `.md` resolves to an existing file or directory (fragments stripped, URLs skipped). | Yes | `audit-doc-links-allowlist.json` — for links that cannot resolve inside the repo by design (a template rendered elsewhere). |
| `audit-docs-drift.mjs` | Numeric claims in **every** tracked `.md` — a registered-tool count, the coverage thresholds — against the built registry and `vitest.config.ts`. Also that plugin docs describe the real plugin API. | Yes | None. Fix the number or, better, stop hardcoding it and point at the source of truth. |
| `audit-docs-wired.mjs` | "Documented ⇒ wired": the documented prompt count matches `src/prompts.ts`; every CLI subcommand documented in `CLAUDE.md` dispatches in `src/index.ts`; every automation hook key the docs present is accepted by the policy loader. | Yes | None; it prints the value to set. |
| `audit-version-drift.mjs` | Version strings in the four reader-facing documents (`README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `docs/privacy-policy.md`) agree with `package.json`. | Yes | `audit-version-drift-allowlist.json` — deliberate historical mentions. |
| `audit-business-content.mjs` | Tracked markdown contains no commercial-strategy vocabulary (pricing tiers, revenue metrics, named plans, open-core packaging). ADR-0019 forbids it; this is the control that does not depend on memory. | Yes | `audit-business-content-allowlist.json` — legitimate engineering uses (the cost router documents provider pricing). |
| `audit-cli-commands.mjs` | Every `patchwork <verb>` quoted in tracked docs is a verb the CLI dispatches. | Yes | None. |
| `audit-in-flight.mjs` | No **Active** entry in `docs/in-flight.md` names a branch whose PR is merged or closed. Calls GitHub via `gh`, so it does not run offline. | Yes | None — retire your entry in your own PR ([README](README.md)). |

## Privacy and leak gates

| Script | Checks | Gates CI | Exceptions |
|---|---|---|---|
| `audit-private-identifiers.mjs` | The staged diff, the branch name and the commit message against an operator denylist at `~/.patchwork/private-identifiers.txt`. Prints the entry *number* that matched, never the string. | **No** — runs from `.husky/pre-commit` and `.husky/commit-msg` only. CI has no denylist and must not have one. | None. The denylist is the configuration; see [privacy-rules.md](privacy-rules.md) for its three limits. |
| `audit-shipped-identifiers.mjs` | `templates/` and `examples/` contain no real-world identifiers by **shape** — Slack channel ids (requiring a digit, so ordinary capitalised words do not match) and `/Users/<name>` paths. Fails on a scan of zero files. Does not judge domains or emails; that is a knowledge question, not a shape one. | Yes | None. |
| `audit-real-ips.mjs` | No routable public IPv4 literal in any tracked file. Reserved, private and RFC 5737 documentation ranges are allowed. | Yes | `audit-real-ips-allowlist.json` — prefer an env var or a documentation address over an entry. |
| `audit-pack-tracked.mjs` | Nothing enters the npm tarball that git does not track (`dist/` aside). Reports a count, never a filename. | **No** — wired into `prepublishOnly` and `npm run audit:pack`. A clean clone can never fail it, so a CI step would be noise. | None. |
| `audit-connector-test-isolation.mjs` | Connector tests that can reach a disconnect/clear path set `PATCHWORK_HOME`, so a test cannot unlink a developer's real credential. | Yes | `audit-connector-test-isolation-allowlist.json` — **ratchet**, known hazards only. |
| `audit-patchwork-home.mjs` | Non-test files resolve the state directory through `src/patchworkHome.ts`, not `path.join(os.homedir(), ".patchwork")`, so `PATCHWORK_HOME` relocates *all* state rather than some of it. | Yes | `audit-patchwork-home-allowlist.json` — **ratchet**, known bugs only. |

## Code-shape gates

| Script | Checks | Gates CI | Exceptions |
|---|---|---|---|
| `audit-lsp-tools.mjs` | The tool registry: slim-mode names are registered, LSP tool lists agree, every tool with `outputSchema` uses the structured success helpers and vice versa, every `create*Tool` factory is imported in `src/tools/index.ts`, descriptions stay short. Its *Stats* line is the authoritative tool count. Reads `dist/`, so build first. | Yes | `audit-output-schema-allowlist.json` — **ratchet** for tools without `outputSchema`; new entries and stale entries both fail. |
| `audit-schema-changes.mjs` | Current tool schemas against `documents/tool-schemas-snapshot.json`; fails on a removed tool, a removed required parameter or a changed required list. Additive changes pass. | Yes (own job, after build) | `npm run schema:update` regenerates the baseline — then record the change in `documents/tool-schema-changelog.md`. |
| `audit-generated-schemas.mjs` | The committed JSON schemas under `schemas/` and `dashboard/public/schema/` match what `src/recipes/schemaGenerator.ts` produces, compared as **parsed content** (a byte comparison would demand exactly the formatting biome rejects). | Yes | None. Regenerate, run `biome check --write` on the output, commit. |
| `audit-shape-safety.mjs` | No method in `src/extensionClient.ts` uses a blind `proxy<T>()` cast; new methods use `tryRequest<T>()` or `validatedRequest<T>()`. | Yes | `audit-shape-safety-allowlist.json` — grandfathered sites; currently empty, and `proxy<T>` itself has been removed, so the gate now prevents reintroduction. |
| `audit-intellij-parity.mjs` | Every wire method the VS Code extension registers under `vscode-extension/src/handlers/` exists in the IntelliJ plugin (a stub is fine; missing is a silent 404 on JetBrains hosts). | Yes | None. |
| `audit-parity-xfails.mjs` | The number of `it.fails` markers in the flat-vs-chained runner parity test may only decrease. The baseline constant is in the script and is currently zero. | Yes | Lower the baseline when you close a gap; never raise it. |
| `audit-tool-classification.mjs` | Every registered recipe tool id is classified in `DOMAIN_BY_TOOL` (`src/workers/actionClass.ts`) rather than falling through to the conservative `other` default. | Yes | `audit-tool-classification-allowlist.json` — **ratchet**. |
| `audit-skill-parity.mjs` | Same-named `SKILL.md` files under `.claude/skills/` and `claude-ide-bridge-plugin/skills/` are identical; they are copies, not symlinks. Reads `dist/`. | Yes | None — sync the copies. |
| `audit-test-fixtures.mjs` | Test hygiene: no hardcoded `/tmp/`, no `process.env` mutation without restore, `vi.spyOn` paired with a restore. See [testing.md](testing.md). | Yes (in the main job, before build) | `audit-test-fixtures-allowlist.json` — **ratchet**. |

## Supply-chain gates

| Script | Checks | Gates CI | Exceptions |
|---|---|---|---|
| `audit-production-cves.mjs` | `npm audit --omit=dev` against **every** tracked lockfile (root, dashboard, push relay, extension); fails on high or critical. Needs the network. | Yes | `audit-production-cves-allowlist.json` — each entry must say what would have to change for it to be removed. |
| `audit-third-party-licenses.mjs` | `LICENSE-THIRD-PARTY.md` matches the production dependency set of every lockfile and no dependency carries an unacceptable licence. `--write` regenerates the file. | Yes | `audit-third-party-licenses-allow.json`. |
| `audit-companion-pins.mjs` | Companion MCP-server version pins in `src/companions/registry.ts` are within a few versions of npm latest. Needs the network. | **No** — runs weekly from `.github/workflows/companion-audit.yml`. | `audit-companion-pins-holdback.json` — pins deliberately held back, with a reason. |

## When a gate fails on your PR

1. Read the script's output; most print the exact value to set or the exact
   file to edit.
2. Read the script's header comment. It names the incident the gate exists
   for, which usually makes the right fix obvious.
3. If the gate has an allowlist and your case is genuinely legitimate, add an
   entry **with a reason**. If the gate is a ratchet, the answer is to fix the
   underlying issue, not to extend the list.
4. Never silence a gate by editing its pattern to stop matching your change.
   A gate that fires on normal content gets silenced; a gate that has been
   silenced is how the next real warning gets ignored.

A gate that is wrong is a bug in the gate; fix it in its own PR with the
reasoning in the header comment, so the next person does not repeat the
argument.
