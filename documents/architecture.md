# Architecture

> One runtime. Bring your own model. Bring your own triggers. Every action passes through a policy you wrote and a log you own.

The diagram below describes how the seven external surfaces (model providers, triggers, MCP clients, OAuth, dashboard, IDE extensions, external targets) connect to the four internal subsystems of the bridge runtime. Every clause in the [canonical positioning sentence](../README.md) maps to a box on this diagram.

```mermaid
flowchart LR
    %% External left side
    Models["<b>Model Providers</b><br/>Claude · GPT · Gemini · Grok · Ollama<br/><i>Pluggable. Subscriptions or API keys.</i>"]
    Triggers["<b>Triggers</b><br/>Cron · File save · Git event · Test run<br/>Webhook · CLI · Phone (Shortcut/PWA)<br/><i>Anything that can fire.</i>"]
    Extension["<b>VS Code / JetBrains Extension</b><br/>LSP · debugger · editor state"]

    %% MCP clients
    MCPClients["<b>MCP Clients</b><br/>Claude Code CLI<br/>Claude Desktop<br/>claude.ai · Codex CLI<br/>Mobile PWA"]

    %% Bridge runtime — the heart
    subgraph Bridge["Patchwork Bridge Runtime"]
        direction TB
        ToolRegistry["<b>Tool Registry</b><br/>170+ built-in + plugins<br/><i>hot reload via --plugin-watch</i>"]
        RecipeEngine["<b>Recipe Engine</b><br/>RecipeOrchestrator · parser · scheduler"]
        Policy{{"<b>Delegation Policy</b><br/>risk tiers · 4-source precedence<br/>(managed → project-local<br/>→ project → user)<br/>+ approval queue"}}
        Trace[("<b>Trace Memory</b><br/>decision_traces.jsonl<br/>RecipeRunLog · ActivityLog<br/>ctxQueryTraces")]
    end

    %% Right side
    Transports["<b>MCP Transports</b><br/>WebSocket · stdio shim<br/>Streamable HTTP"]
    OAuth["<b>OAuth Surface</b><br/>/.well-known/* · /oauth/*<br/>PKCE S256 · CIMD<br/><i>Optional. Activate with --issuer-url.</i>"]
    Dashboard["<b>Dashboard + Mobile PWA</b><br/>localhost:3100<br/>push approvals"]
    External["<b>External Targets</b><br/>Connectors (Slack, GitHub,<br/>Linear, Gmail, …)<br/>filesystem · terminal"]

    %% Inputs
    Triggers --> RecipeEngine
    MCPClients --> Transports
    Transports --> Bridge
    OAuth -. gates .-> Transports

    %% LLM round-trips
    Models <--> Bridge

    %% Tool dispatch — every outbound call passes through the policy gate
    RecipeEngine --> ToolRegistry
    ToolRegistry --> Policy
    Policy -- approved --> External
    Policy -- needs nod --> Dashboard
    Dashboard -- decision --> Policy

    %% Trace writes
    ToolRegistry --> Trace
    Policy --> Trace
    RecipeEngine --> Trace

    %% Trace reads
    Trace -. session-start digest .-> Bridge

    %% Extension
    Extension <--> Bridge

    classDef external fill:#fef3c7,stroke:#a16207,color:#000
    classDef gate fill:#fee2e2,stroke:#b91c1c,color:#000
    classDef store fill:#dbeafe,stroke:#1e40af,color:#000
    class Models,Triggers,MCPClients,Extension,External,Dashboard,OAuth external
    class Policy gate
    class Trace store
```

## How to read this

The five primitives from the [canonical positioning sentence](../README.md) line up with the four boxes inside the **Patchwork Bridge Runtime** subgraph:

| Sentence clause | Box | Why this box |
|---|---|---|
| *pluggable model providers* | (Model Providers ↔ Bridge) | Bridge is provider-agnostic; arrow direction is bidirectional because LLM round-trips can originate from either side |
| *hot-reloadable tools* | Tool Registry | The `--plugin-watch` flag re-registers atomically on plugin file changes |
| *YAML recipes* | Recipe Engine | RecipeOrchestrator + parser + scheduler |
| *delegation policy with approval queue* | Delegation Policy (gate-shaped) | Every tool dispatch passes through this — it's a structural checkpoint, not a sidecar |
| *durable trace memory* | Trace Memory (cylinder) | Three log files under `~/.patchwork/` plus the activity log under `~/.claude/ide/` |

## Five things to notice

1. **Every outbound action passes through the policy gate.** The arrow from Tool Registry to External Targets does *not* exist as a direct edge — it goes through Delegation Policy first. This is the structural invariant that makes "delegation policy" load-bearing rather than decorative. See [src/approvalHttp.ts](../src/approvalHttp.ts) for the implementation.

2. **Trace Memory is the only multi-source sink.** Tool calls, policy decisions, and recipe runs all write to the same trace store. That's what makes [`patchwork traces export`](../src/commands/tracesExport.ts) a single bundle and what makes the (planned) Decision Replay Debugger possible.

3. **Triggers are inputs, not outputs.** Cron, file save, git, test run, webhook, CLI, and the mobile PWA all enter at the same point — the Recipe Engine. The trigger surface is the *non-developer onboarding* story; recipes don't care which trigger fired them.

4. **OAuth is optional and only gates one transport.** The bridge runs without `--issuer-url` and accepts WebSocket / stdio clients on the loopback interface only. OAuth activates the Streamable HTTP transport for remote MCP clients (claude.ai, the mobile PWA). See [src/oauth.ts](../src/oauth.ts).

5. **The dashboard is a policy reader, not a separate brain.** Approval prompts come *from* the Delegation Policy (when a human nod is required) and decisions flow *back* into the Delegation Policy. The dashboard does not have its own approval state; it is a UI over the bridge's queue. See [src/approvalQueue.ts](../src/approvalQueue.ts) and [dashboard/src/app/approvals/](../dashboard/src/app/approvals/).

## What's not in the diagram

Things that exist but are deliberately omitted to keep the page legible:

- **Per-language LSP fallbacks** (TypeScript LS, ctags, etc.) for when the IDE extension is disconnected.
- **Plugin watcher** as a separate component — folded into Tool Registry.
- **Session checkpoint / handoff** — operates orthogonally to this diagram.
- **Connector OAuth flows** (Gmail, Slack, etc.) — separate from the bridge OAuth surface; lives inside the connector implementations.

For the unabridged tour: [documents/data-reference.md](data-reference.md) and [documents/platform-docs.md](platform-docs.md).

---

## Layered view

If the flowchart above is too dense, the same architecture in three layers:

```mermaid
flowchart TB
    subgraph L1["1. Where requests come from"]
        direction LR
        T1[Triggers]
        T2[MCP Clients]
        T3[IDE Extension]
    end

    subgraph L2["2. The runtime"]
        direction LR
        Tools[Tool Registry]
        Recipes[Recipe Engine]
        Pol{{Delegation Policy}}
        Mem[(Trace Memory)]
    end

    subgraph L3["3. What requests reach"]
        direction LR
        Models[Model Providers]
        Ext[External Targets]
        Dash[Dashboard / PWA]
    end

    L1 --> L2
    L2 --> L3
    L2 -. policy gate .-> L3
```

The compression is honest: every request enters at layer 1, every effect lands at layer 3, and layer 2 — *the runtime* — is the part that distinguishes Patchwork from each of the alternatives in [comparison.md](comparison.md).
