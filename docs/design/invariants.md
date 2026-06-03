# Cross-Layer Parity Invariants

> Status: Draft
> Owner: openclaw-misaka10004 (whitehat-bot)
> Companion issue: [#850](https://github.com/Oolab-labs/patchwork-os/issues/850)
> Related ADR: [ADR-0007 (multi-bridge JSONL concurrency)](../adr/0007-multi-bridge-jsonl-concurrency.md)

## Why this doc

The 2026-06-02 codebase audit surfaced a recurring failure mode:

> Almost none of the findings were local logic errors. They were **seam/consistency bugs** between layers that must move together but drifted.

The pattern repeats across every layer boundary in the runtime:

- Registry ↔ bridge route ↔ dashboard allowlist
- Dispatch entry points ↔ deny-list / validation guards
- Documentation ↔ registered/handled CLI subcommands
- Default-config ↔ "standard full-mode" tool surface

Fixing each individual bug does not stop the next batch. The fix is to **encode the cross-layer contracts as cheap, executable invariants** so drift fails CI instead of shipping.

This document is a design proposal for the four invariants the issue proposes. It is intentionally **implementation-agnostic** — each invariant section lists:

1. **What the contract says** (the seam it pins down)
2. **What "drift" looks like** (the failure mode it catches)
3. **How to test it** (the shape of the executable check)

A follow-up PR series can land the test files in `src/__tests__/invariants/` one invariant at a time. This doc is the **roadmap**; the tests are the **mile markers**.

## Invariant 1: Connector parity

### Contract

For every connector registered in `src/connectors/registry.ts`:

| Layer | Must have |
|---|---|
| Registry | `supports.connect / test / delete` declared (or explicit `null` for unsupported) |
| Bridge route | A route handler in `src/transport.ts` (or the equivalent dispatch table) |
| Dashboard | A row in `dashboard/src/data/supported.ts` (or the `SUPPORTED` set) |
| Dashboard modal | Configurable in the connection modal (`dashboard/src/app/connections/[connector]/`) |

### Drift it catches

- 13 connectors were registry-declared + dashboard-surfaced but had **no bridge routes** (404 end-to-end).
- Jira had working routes but **empty registry flags** (dashboard never reached them).
- Drift happens in **both** directions.

### Test shape

```ts
// src/__tests__/invariants/connector-parity.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { glob } from "tinyglobby";

describe("connector parity (registry ↔ bridge route ↔ dashboard)", () => {
  it("every registry connector has a matching bridge route handler", () => {
    const registry = parseRegistryFlags();
    const routes = parseBridgeRoutes();
    for (const id of Object.keys(registry)) {
      expect(routes).toContain(id);
    }
  });

  it("every registry connector is in dashboard SUPPORTED set", () => {
    const registry = parseRegistryFlags();
    const supported = parseDashboardSupported();
    for (const id of Object.keys(registry)) {
      expect(supported).toContain(id);
    }
  });

  it("every dashboard SUPPORTED connector has a bridge route", () => {
    // catches the "dashboard-only" drift case
  });

  it("no orphan bridge routes (route exists but registry empty)", () => {
    // catches the "Jira route but no registry flag" case
  });
});
```

### Status

The **registry ↔ bridge route** half was shipped in #848. This invariant extends it to the dashboard `SUPPORTED` set and modal config.

## Invariant 2: Guard coverage (deny-list + validation)

### Contract

Every tool-dispatch entry point in the runtime runs through:

- The shared **deny-list** (see `src/security/denyList.ts` or equivalent)
- The shared **input-validation guards** (length caps, null-byte stripping, scope enforcement)

The "dispatch entry point" set includes:

- The registered tool path (`src/tools/registry.ts`)
- The dynamic-dispatch path (recipe step tool calls)

### Drift it catches

- ReDoS guard in `searchAndReplace` but **not** in `applySearchReplace`.
- Deny-list enforced for registered tools but **not** the dynamic-dispatch path.
- SSRF guard on the driver path but **not** the recipe-local path.
- Null-byte / scope / length caps applied inconsistently across sibling code paths.

### Test shape

```ts
// src/__tests__/invariants/guard-coverage.test.ts
describe("guard coverage (deny-list + validation across all dispatch paths)", () => {
  it("every tool in src/tools/registry.ts wraps callTool with the deny-list helper", () => {
    // AST scan: every exported tool's body must call denyList.check(...)
  });

  it("every dynamic-dispatch path also runs the deny-list", () => {
    // AST scan: dynamic dispatch (recipe-local) must share the guard helper
  });

  it("input-validation guards are uniformly applied", () => {
    // For each guard helper (stripNullBytes, enforceLength, enforceScope),
    // assert it is called at every dispatch entry point that takes external input
  });
});
```

The AST scan can use a lightweight pattern match against the compiled JS, or a TypeScript compiler API visitor. The point is to make the **shape** of the contract executable.

## Invariant 3: Documented ⇒ wired

### Contract

Anything the documentation **asserts** (a count, a flag, a CLI subcommand, an automation hook) must be **actually registered/handled** in the corresponding code.

| Documented in | Asserted thing | Must exist in |
|---|---|---|
| `CLAUDE.md` | Tool count | `src/tools/registry.ts` |
| `CLAUDE.md` | Prompt count | `src/prompts/registry.ts` |
| `documents/platform-docs.md` | CLI subcommands | `src/cli.ts` |
| `documents/platform-docs.md` | Automation hooks | `src/automation/hooks.ts` |

### Drift it catches

- Tools / flags / CLI subcommands documented (or commented "wired in X") that were **stubbed, dead, or unregistered** on the default config.

### Test shape

```ts
// src/__tests__/invariants/documented-wired.test.ts
describe("documented ⇒ wired (docs claims match code reality)", () => {
  it("CLAUDE.md tool count matches registered tools on default config", () => {
    const claimed = parseClaimedToolCount("CLAUDE.md");
    const actual = listRegisteredTools({ driver: "none" });
    expect(actual.length).toBe(claimed);
  });

  it("platform-docs.md CLI subcommands all dispatch to a handler", () => {
    const claimed = parseClaimedSubcommands("documents/platform-docs.md");
    const actual = listCliHandlers();
    for (const cmd of claimed) expect(actual).toContain(cmd);
  });

  // ... similar for prompt count, automation hooks
});
```

The existing `scripts/audit-lsp-tools.mjs` is a partial precedent for the tool-count half; the test formalizes it.

## Invariant 4: Default-config availability

### Contract

The tools the docs call "**standard full-mode**" must register on the default `driver=none` bridge (i.e., the config a fresh user gets).

### Drift it catches

The ctx-platform tools (recipe, decision-trace, commit-link, run-log) regressed exactly here — they were documented as default-available but required a non-default driver.

### Test shape

```ts
// src/__tests__/invariants/default-availability.test.ts
describe("default-config availability (standard tools register on driver=none)", () => {
  it("the four ctx tools (recipe / decision-trace / commit-link / run-log) register on default config", () => {
    const tools = listRegisteredTools({ driver: "none" });
    expect(tools).toContain("recipe");
    expect(tools).toContain("decision-trace");
    expect(tools).toContain("commit-link");
    expect(tools).toContain("run-log");
  });
});
```

## Implementation roadmap

This document is intentionally **not** the PR — the PRs are the four test files (one per invariant), landed in this order:

| Order | Invariant | Why first |
|---|---|---|
| 1 | **Connector parity** (extend #848 to dashboard) | The template already exists. Smallest delta. |
| 2 | **Default-config availability** | Pure runtime check, no AST. Ships fast. |
| 3 | **Guard coverage** | Needs AST tooling; slightly higher complexity. |
| 4 | **Documented ⇒ wired** | The most powerful, but the docs-parse step takes iteration. |

Each PR should:

- Land **one** new test file under `src/__tests__/invariants/`
- Update the corresponding `docs/adr/0XXX-*.md` only if a new decision is made
- Cross-link to this design doc in the PR description

## Non-goals

- **Cross-host** invariant checks (different scale; out of scope).
- **Behavioral** invariants (e.g. "approval queue must be enforced before tool call") — those are runtime tests, not layer-parity tests. They belong in `src/__tests__/behavior/` and are not covered here.
- **Migrating legacy data** (covered separately by ADR-0007's migration plan).

## Open questions

1. **Where should the AST scan live for Invariant 2?** The TypeScript compiler API is the canonical source, but a `ts-morph`-style library might be lighter. Open to maintainer preference.
2. **For Invariant 3, do we parse Markdown counts or expose a stable assertion file?** Parsing Markdown is brittle; an alternative is `documents/assertions.toml` that both the docs and the tests read from.
3. **For Invariant 4, is the "default config" canonical? `config.schema.json` has a `default` block — should the test source from there or from a hardcoded fixture?**

## Acceptance

- [ ] This design doc merged
- [ ] Invariant 1 (connector parity extended to dashboard) — PR
- [ ] Invariant 2 (guard coverage AST scan) — PR
- [ ] Invariant 3 (documented ⇒ wired) — PR
- [ ] Invariant 4 (default-config availability) — PR

---

_Opened from issue #850. Implementation feedback welcome — happy to iterate on the test-shape sketches or split the PRs differently._

_(Posted from an AI agent account — happy to revise tone or scope if maintainer prefers human-only ideation docs.)_
