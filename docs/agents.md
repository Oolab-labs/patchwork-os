# Working in this repository as a coding agent

This is the contract for any coding agent — Claude Code, or another tool —
working in `patchwork-os`. It is short on purpose: it tells you what you must
do, what you must never do, and where everything else lives. Project lore (the
traps, the measured numbers, the decisions that look wrong and are not) is in
[`CLAUDE.md`](../CLAUDE.md); read the section for the subsystem you touch
before you touch it.

## What this repository is

The single-tenant Patchwork OS runtime: a local MCP bridge, a YAML recipe
engine with an approval gate, a worker autonomy gate, a governed profile, an
information boundary, and the evidence ledgers under `~/.patchwork`. MIT, public,
permanently. The multi-tenant SaaS and the commercial control plane are
**separate repositories** — never add tenant, control-plane or organisation
policy code here ([ADR-0019](adr/0019-open-core-boundary.md)).

Orientation: [docs index](README.md) → [operator guide](guide/README.md) for
what the product does → [contributor guide](contributing/README.md) for how the
repository works.

## Before you change anything

1. **Investigate, then scope, then build.** A claim you cannot cite a file and
   line for is a hypothesis. State what you will change, what you will not, and
   wait on anything with a blast radius (runners, gate, bridge startup, wire
   formats, ledgers, CLAUDE.md itself).
2. **Check [`docs/in-flight.md`](in-flight.md)** before non-trivial work; add
   an entry; retire it in your own PR, never leave it Active at merge.
3. **Bug reports are test-first.** Write the failing test, then the fix. A fix
   without a test that failed before it is not done.
4. **Read the privacy rules**: [contributing/privacy-rules.md](contributing/privacy-rules.md).
   Never commit ledger contents, real third-party names, real hostnames, user
   paths or secrets — in code, tests, docs, commit messages, PR bodies or
   branch names. Synthetic examples only.

## How to verify

- `npm run build` · `npm test` · `npm run typecheck` **and**
  `npm run typecheck:tests:core` (the CI ratchet vitest cannot see) · `biome
  check --write` on changed files before staging.
- **The audit gates run outside vitest and tsc** — a green suite is not a green
  CI. Run the relevant `scripts/audit-*.mjs` before pushing;
  [contributing/gates.md](contributing/gates.md) lists them. Docs changes: the
  link, drift and wired gates. Templates or examples: the shipped-identifier
  gate.
- Dashboard changes: `cd dashboard && npm run typecheck && npm run lint && npm test`.
- **Verify the artefact, not the absence of an error.** Ask whether a broken
  version would have failed the check you just ran.

## Git and GitHub

- Never push to `main`. Branch, PR, CI green, merge. Squash-merge is the norm;
  do not stack PRs (a squash loses the stacked content).
- Explicit paths on `git add`; never `-A` or `.` — the working tree often has
  someone's WIP.
- Commit messages and PR bodies are public forever and cannot be edited after
  merge: scan them like code.
- Sensitive findings (an exposure, a leaked identifier) go to the private
  tracker or a security advisory, never a public issue — the pointer is the
  disclosure.

## Deploy is not merge

Merged → installed → running are three states. After a merge that must reach
the local bridges: `git pull`, `npm run build`, `npm run install:global`
(never `npm install -g .` on macOS), restart the LaunchAgents, then
`patchwork doctor --expect-running N` and `patchwork doctor acceptance`. See
[guide/operations.md](guide/operations.md).

## Tools

When the Patchwork bridge MCP server is connected, prefer its tools for
workspace operations (search, diagnostics, git, tests) over shell equivalents;
`CLAUDE.md` carries the substitution table. When it is not connected, the
native tools are correct, not a fallback.

## Where things are

| Need | Go to |
|---|---|
| What a command does | [guide/cli.md](guide/cli.md) |
| Config keys and environment variables | [guide/configuration.md](guide/configuration.md) |
| The mental model (recipes, gate, workers, profile, boundary, ledgers) | [guide/concepts.md](guide/concepts.md) |
| Repo layout and module responsibilities | [contributing/README.md](contributing/README.md) |
| Why a decision was made | [adr/README.md](adr/README.md) |
| The traps, the measured numbers, what not to "fix" | [`CLAUDE.md`](../CLAUDE.md) |
| Tool and prompt reference | [documents/platform-docs.md](../documents/platform-docs.md) |
