# Patchwork OS vs. *

> Honest tradeoffs against the closest alternatives. Pick the right tool — that may not always be Patchwork.

Patchwork OS is a *local-first personal AI runtime* — pluggable model providers, hot-reloadable tools, YAML recipes, a delegation policy with approval queue, and a durable trace memory, all running on your machine. The four sections below contrast it with the categories users most often confuse it for.

---

## Patchwork OS vs. an MCP server

**Short version:** an MCP server exposes tools to one model client. Patchwork is a runtime *around* the tool surface.

| | MCP server | Patchwork OS |
|---|---|---|
| Tool catalogue | Yes | Yes (170+ built-in + plugins) |
| Model providers | One (whatever called you) | Pluggable (Claude, GPT, Gemini, Grok, Ollama) |
| Hot-reload tools | No | `--plugin-watch` re-registers atomically |
| Trigger types | Tool call | Cron, file save, git, test run, webhook, CLI, mobile |
| Policy gate | None | Three risk tiers, four-source precedence |
| Trace log | None | `decision_traces.jsonl` + activity log + run history |
| Distribution | Each server forks separately | Plugins as npm packages |

Pointing an MCP client at a Patchwork bridge gets you all of the above without changing the client. Pointing it at a bare MCP server gets you a tool list. Patchwork *is* an MCP server — and a recipe runner, an approval gate, a trace store, a plugin host, a webhook receiver, and an OAuth provider.

**Pick a plain MCP server when:** you only need to expose 1–10 tools to a single client and have no policy, lifecycle, or audit needs. Forking [@modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk) and shipping is the smaller footprint.

**Pick Patchwork when:** you want any of policy, recipes, traces, hot-reload, multi-model, or webhook triggers without writing them yourself.

---

## Patchwork OS vs. Zapier / Make / n8n

**Short version:** SaaS automation tools host your credentials, your data, and your workflows on their infrastructure. Patchwork runs on your machine.

| | Zapier / Make / n8n cloud | Patchwork OS |
|---|---|---|
| Where credentials live | Their vault | Your OS keychain |
| Where data flows through | Their infrastructure | Your process |
| Pre-built integrations | 5,000+ (Zapier), 1,500+ (Make) | ~19 connectors |
| Authoring UX | Polished GUI workflow builder | YAML files + CLI lint/test loop |
| Trigger types | Webhooks, polling, schedule | Cron, file save, git, test run, webhook, CLI, mobile |
| AI integration | Add-on (Zapier AI, Make AI) | First-class — every recipe step can call a model |
| Pricing | Per-task / per-month | Free; you pay your model provider |
| Audit log | Their dashboard | Your filesystem (JSONL you can grep) |

The trade-off is honest: Zapier has a polished GUI and 5,000+ pre-built integrations; Patchwork has a smaller connector library, a CLI-first authoring loop, and zero data exfiltration. The right answer depends on **who you trust with your tokens** and how much you value the polished UX vs. owning the data flow.

**Pick Zapier-class tools when:** you need the long tail of obscure SaaS connectors and don't want to write any code or YAML. The GUI authoring is genuinely a feature.

**Pick Patchwork when:** you care about data residency, want recipes you can dotfile and version, or need an audit log no third party can rewrite.

---

## Patchwork OS vs. hosted AI assistants (ChatGPT plugins, Claude projects, Copilot Workspace)

**Short version:** hosted assistants give you one model behind their UI with their tool catalogue and their policy. Patchwork inverts every part of that.

| | Hosted assistants | Patchwork OS |
|---|---|---|
| Model | Theirs (one) | Yours (any) |
| Tool catalogue | Theirs | Yours (170+ built-in + plugins) |
| Policy | Theirs | Yours (`--approval-gate`, risk tiers, ccPermissions) |
| Where tools execute | Their sandbox | Your machine |
| Where credentials live | Their vault | Your OS keychain |
| Memory | Their session store | Your `decision_traces.jsonl` + activity log |
| Provider lock-in | Total | None — swap models with a config change |
| Setup cost | Zero | Run `patchwork patchwork-init` |

The cost is setup: you provision the runtime, you write the recipes, you wire the OAuth. The benefit is that swapping model providers is a config change, not a migration.

**Pick a hosted assistant when:** you don't care about provider lock-in, you trust the vendor's policy as defaults, and you'd rather not run anything on your machine.

**Pick Patchwork when:** you want to be able to leave any single model provider on a Tuesday afternoon without losing your tools, recipes, or history.

---

## Patchwork OS vs. local agent frameworks (LangGraph, AutoGPT, CrewAI, Open Interpreter)

**Short version:** local agent frameworks are libraries — you write Python to compose chains. Patchwork is a runtime — you write YAML recipes, declare a policy, and call tools over MCP from any compatible client.

| | LangGraph / AutoGPT / CrewAI / Open Interpreter | Patchwork OS |
|---|---|---|
| Authoring | Python code (or DSL) | YAML recipes + plugin manifests |
| Composition primitive | Graph / chain / crew of agents | Recipes (steps + dependencies + triggers) |
| Approval / policy | DIY (or absent) | Built-in (`--approval-gate`, risk tiers, four-source precedence) |
| Observability | DIY (LangSmith etc. are SaaS add-ons) | Built-in (`decision_traces.jsonl`, dashboard, replay) |
| Tool integration | Library calls inside the agent process | MCP — any compatible client can use the runtime |
| Trigger surface | Whatever you wire | Cron, file save, git, test run, webhook, CLI, mobile |
| Non-developer authoring | None — Python required | Webhook recipes + (planned) conversational builder |

Agent frameworks excel at **programmatic orchestration** — when you need fine-grained control over a multi-step LLM workflow inside a Python service. Patchwork excels at **policy, observability, and access** — giving non-developers (via webhooks, mobile approvals, conversational recipe authoring) a way in without writing Python.

**Pick a local agent framework when:** you're building a software product whose core feature is a complex LLM workflow, and you need code-level control over routing, retries, and state.

**Pick Patchwork when:** the AI is a tool you and a small group use to do work, not a feature you ship to customers — and you want approval, audit, and trigger machinery you don't have to write yourself.

---

## When *not* to use Patchwork

Be honest with yourself if any of these are you:

- **You only need a chat UI.** ChatGPT, Claude.ai, or Copilot Chat will serve you better. Patchwork's leverage is in tools, recipes, and policy — none of which matter for a pure-chat use case.
- **You don't run anything on your machine.** Patchwork is local-first. If you can't or won't run a process on your laptop / VPS, the whole value proposition collapses to "an MCP server you self-host," which is real but smaller.
- **You need 50+ third-party integrations.** Patchwork has ~19 connectors. The plugin model lets you add more, but if you need everything Zapier has on day one, Zapier is the right answer.
- **You're shipping a customer-facing AI product.** Patchwork is a runtime for *you*, not infrastructure to embed in a SaaS. LangGraph, the OpenAI Assistants API, or building on raw model APIs are better starting points.

---

## Where Patchwork is unusual

The architecture choice that distinguishes Patchwork is composing five primitives — tools, recipes, delegation policy, trace memory, OAuth — into one runtime instead of separate boxes. The closest analogues each pick a subset:

- MCP servers ship tools without recipes, policy, or memory.
- Zapier ships recipes and a partial policy without your model choice or your trust boundary.
- Hosted assistants ship a model and tools without your policy, your memory, or your trigger surface.
- Agent frameworks ship the orchestration primitive without the policy, the audit, or the non-developer authoring path.

If you've ever needed two of those at once and ended up gluing them together, Patchwork is the consolidation. If you only ever need one, use the better-specialized alternative.
