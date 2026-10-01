# Architecture tour — the shape, and the mistakes it invites

Start with the two reference documents; this page does not repeat them.

- [documents/architecture.md](../../documents/architecture.md) — the one
  diagram: external surfaces (model providers, triggers, MCP clients, OAuth,
  dashboard, editor extensions, external targets) around four internal
  subsystems (tool registry, recipe engine, delegation policy, trace memory).
- [documents/data-reference.md](../../documents/data-reference.md) — who owns
  which state (`bridge.ts`, the per-connection `AgentSession`, `transport.ts`,
  `extensionClient.ts`, the activity log, the session checkpoint), the auth
  flow, the tool lifecycle and the extension request/response protocol.
- [docs/protocol-spec.md](../protocol-spec.md) — the wire protocol between
  bridge and editor extension.

The [README](README.md) has the directory-level map. What follows is the
short list of things a first change to `src/` gets wrong, and the three
invariants security reviews keep re-finding. Each is a paragraph and a
pointer; the pointer is the authority.

## Six things a first change gets wrong

### 1. A tool is a factory, registered in one place

Every MCP tool is a module exporting `createXxxTool(deps)` that returns
`{ schema, handler }`, and it is registered in `src/tools/index.ts`. A tool
file that is not imported there is orphaned, and `scripts/audit-lsp-tools.mjs`
fails CI on it. Tool names match `/^[a-zA-Z0-9_]+$/`. `outputSchema` is
mandatory, and a tool that declares one must return through the structured
success helpers, or the same gate fails. Follow
[documents/styleguide.md](../../documents/styleguide.md) for the response
shapes, and start from `src/tools/README.md`.

### 2. Tool errors are content, never JSON-RPC errors

A tool that fails returns `isError: true` in its content block with a string
code from `ToolErrorCodes` (`src/errors.ts`). JSON-RPC errors (`ErrorCodes`,
the `-32xxx` range) are for protocol problems only: a malformed request, an
unknown method, a rate limit. Mixing them breaks every client's error handling
in a different way. The reasoning is
[ADR-0004](../adr/0004-tool-errors-as-content.md).

### 3. Every `ws.send()` goes through `safeSend()`

A WebSocket can close between the check and the send. All sends to a client or
extension socket use `safeSend()` from `src/wsUtils.ts`, or an explicit
`readyState` check inside a try/catch. Related: every WebSocket callback
checks the connection generation before touching state, so a stale callback
from a previous connection cannot corrupt the new one
([ADR-0002](../adr/0002-generation-guards-on-reconnect.md)).

### 4. A tool that needs the editor says so

If a tool cannot work without the VS Code / JetBrains extension (LSP,
debugger, editor state), its schema sets `extensionRequired: true`. The
transport uses that to report the right error when no extension is connected
instead of a confusing timeout.

### 5. Extension responses are validated at runtime, not cast

`src/extensionClient.ts` once wrapped extension calls in a blind
`proxy<T>()` TypeScript cast. Eight shape-mismatch bugs across consecutive
patch releases traced to it, and the method has since been removed;
`scripts/audit-shape-safety.mjs` keeps it out. For a new method:

- `tryRequest<T>(method, params, timeout, signal)` when the success path is a
  single shape and the caller does not need to distinguish error paths (it
  unwraps `{error}` and `{success: false}` to `null`);
- `validatedRequest<T>(method, params, validator)` when the success path is an
  object with specific required fields;
- a direct request plus inline unwrap when the handler has a rich
  `{success, data, error}` contract and the caller needs the structured error.

Before choosing, read the handler in `vscode-extension/src/handlers/` and
enumerate **every** return statement, success and error. Test mocks are not
ground truth; the handler file is.

### 6. Automation hooks are a program, not a pile of callbacks

Automation policy JSON compiles through `parsePolicy`
(`src/fp/policyParser.ts`) into an `AutomationProgram` ADT
(`src/fp/automationProgram.ts`) and runs through one interpreter,
`executeAutomationPolicy` (`src/fp/automationInterpreter.ts`). Side effects
sit behind the `Backend` interface (`src/fp/interpreterContext.ts`), with a
`VsCodeBackend` for production and a `TestBackend` collector for tests. All
state is one `AutomationState` value changed by pure functions. To add a hook:
extend the `HookType` union, add a parser case, wire the event source to the
interpreter. Do not add a bespoke callback path beside it; `src/fp/README.md`
explains why.

## Three invariants reviews keep re-finding

These come from the governed profile
([ADR-0026](../adr/0026-governed-profile.md)). Each one has been broken by a
reasonable-looking local change, which is why they are stated as rules rather
than left to be inferred.

### One policy calculation, for the runner and for `policy explain`

`computeEffectivePolicy` in `src/governance/effectivePolicy.ts` is called by
**both** recipe runners at the per-step consult and by
`patchwork policy explain <recipe> [tool]`. A test drives the real flat runner
over a matrix of profile × trigger × tool × opt-out and asserts the runner's
verdict equals the calculation's. If you add a rule to the runner, add it to
the calculation, or the explanation lies to the operator while the test tells
you so.

### The kill switch is read in exactly one way

Read it through `readKillSwitch()` or `assertKillSwitchReleased()` in
`src/governance/killSwitchPolicy.ts`, at every chokepoint: recipe entry,
webhook entry, tool execution, MCP `tools/call` for a write-capable tool, the
orchestrator's pending-to-running transition. The reader carries the
profile-dependent failure mode — governed fails closed when the switch is
unreadable, compat keeps the historical fail-open. **Never call
`isWriteKillSwitchActive` and wrap it in your own `try {} catch {}`.** That is
how four call sites ended up fail-open, each with a comment saying it matched
every other site. Design: [ADR-0013](../adr/0013-kill-switch.md).

### Outbound HTTP has one guard

Anything that fetches a URL supplied by configuration, a recipe or a user goes
through `validateOutboundUrl` / `safeFetch` in `src/ssrfGuard.ts`: lexical
refusal of private ranges including unusual IPv4 notations and IPv4-mapped
IPv6, DNS resolve-once-and-pin, manual redirects re-validated per hop with
credentials dropped cross-origin. `http.post` in recipes and the
`sendHttpRequest` tool both use it. A second fetch path with its own
blocklist is a second place for the next bypass to live.

## Two more that are easy to miss

**Secrets are redacted by value**, not by field name
(`src/governance/secretValues.ts`): env blocks, connector tokens and the bridge
bearer register in a memory-only registry and every log, capture, approval
record and trace substitutes a marker for the value and its encoded forms. If
you introduce a new secret, register it; if you introduce a new sink, pass it
through the redactor.

**Ledgers never backfill absence.** Several JSONL ledgers under the state
directory are hash-chained ([ADR-0027](../adr/0027-tamper-evident-ledgers.md))
and carry a schema-version sentinel so a new field can be told apart from a
field that was never recorded ([ADR-0025](../adr/0025-evidence-spine.md)).
Never add a field to an existing ledger's rows without a sentinel, never
default an actor, and never turn a reader's "ignore unknown kinds" into an
exhaustive switch that throws — a running bridge older than the rows it reads
would strand.
