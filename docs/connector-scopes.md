# Connector scopes

What each connector asks for, and — more importantly — **who decides**.

Written for the question a security review always reaches: *"if this software
holds a credential for my Google Workspace / Slack / Stripe account, what can it
do with it?"* Read from the connector source, not from provider documentation.

Companion to [THREAT-MODEL.md](../THREAT-MODEL.md) §T3 (connector token scope
and blast radius).

---

## The distinction that matters

There are **two kinds of connector here**, and the difference decides who
controls the blast radius. Both surface a `scopes` field internally, which makes
them look alike in the code and in the dashboard — they are not.

| | **OAuth connectors** | **Token (PAT) connectors** |
|---|---|---|
| How it authenticates | Redirects you to the provider, which shows a consent screen | You paste a token you created yourself |
| Where the scope is decided | **Here** — the connector names the scopes in its authorize URL, and the provider enforces them | **By you**, in the provider's UI, when you create the token |
| What the `scopes` field means | The scopes actually requested | **A label only.** It does not constrain the token |
| To reduce access | Change the scope list and re-authorise | Create a narrower token at the provider |

> **The `scopes` field on a token connector is descriptive, not restrictive.**
> `stripe.ts` reports `scopes: ["read"]` while returning whatever secret key you
> supplied. If that key can issue refunds, so can this software — the string
> `"read"` is a note to the dashboard, not a limit. Reading it as a guarantee is
> the most likely mistake this page exists to prevent.

---

## OAuth connectors — scopes requested by this software

These build an authorize URL and the provider enforces what is granted. Verified
by grepping each file for its authorize-URL construction.

| Connector | Scopes requested | Read / write | Notes |
|---|---|---|---|
| **Gmail** | `gmail.readonly` (+ send scope where drafting is enabled) | Read-first | Read-only by default; the send capability is a separate scope and the recipes that use it queue drafts rather than sending |
| **Google Calendar** | `calendar.readonly` (+ events where writing is enabled) | Read-first | |
| **Google Drive** | `drive.readonly` | Read | |
| **Google Docs** | `documents.readonly` | Read | |
| **Slack** | `chat:write`, `channels:read`, `channels:history`, `users:read` | **Read + write** | `chat:write` posts as the authorising identity. `channels:history` reads message history in channels the app is in |
| **GitHub** | via `mcpOAuth` — see below | Varies | |
| **GitLab** | `read_user`, `read_api`, `read_repository` | **Read only** | Notably narrower than the GitHub path |
| **Airtable** | `data.records:read`, `data.records:write`, `schema.bases:read`, `webhook:manage` | **Read + write** | |
| **Asana** | `default` | **Read + write** | Asana has no read-only scope; `default` grants both. The connector's own header says so, and defence has to live in the recipe-tool layer instead |
| **Discord** | `identify`, `guilds`, `messages.read` | Read | |
| **Monday** | `me:read`, `boards:read`, `boards:write`, `updates:read`, `updates:write`, `users:read`, `tags:read` | **Read + write** | |
| **Salesforce** | `api`, `refresh_token`, `offline_access` | **Broad** | `api` is full API access at the authorising user's permission level — Salesforce does not offer finer OAuth scoping here, so the limit is the user's own profile |
| **Jira** | `read:jira-work`, `write:jira-work` | **Read + write** | |
| **Confluence** | `read:confluence-content.all` (+ write where enabled) | Read-first | |

**GitHub, Linear and Sentry** authenticate through the shared `mcpOAuth` client
rather than their own flows, so their granted scope is whatever their MCP
endpoint's consent screen presents. That is not decided in this repository.

---

## Token connectors — scope is yours to set

For all of these, this software never sees a consent screen and never narrows
anything. **The token you paste is the boundary.** The `scopes` column is what
the connector reports internally; it is a label.

| Connector | Reports | What actually governs access |
|---|---|---|
| Stripe | `read` | Your API key's permissions. A restricted key is the only way to make this read-only |
| HubSpot | `read`, `write` | Your private-app token's scopes |
| Zendesk | `read` | Your API token + the role of the user it belongs to |
| PagerDuty | `read` | Your REST API key (account-level keys are read/write) |
| Intercom | `read` | Your access token's permissions |
| Datadog | — | Your API + application key pair |
| Notion | — | Which pages/databases you shared with the integration |
| Telegram | `send` | The bot token from @BotFather; scope is bot permissions in each chat |
| Linear | — | Your personal API key (falls back here when not using MCP) |
| Sentry | — | Your auth token's scopes |

**Practical guidance:** create a dedicated, least-privilege credential per
connector rather than reusing an admin token. For Stripe specifically, use a
restricted key — a standard secret key can move money, and nothing in this
software prevents that if a recipe asks for it.

---

## What this software does *not* do

Stated plainly because a reviewer will otherwise assume otherwise:

- **It does not narrow provider scopes per recipe or per worker.** Every recipe
  using a connector uses the same grant. There is no down-scoped token exchange.
- **It does not re-prompt for consent** when a recipe starts using a capability
  the grant already allows.
- **It does not detect an over-scoped token.** Paste an admin key and nothing
  warns you.

What *does* limit damage is the layer above: every write passes through
action-class classification and the approval gate, so a broadly-scoped token
still cannot perform a risky action without either earned trust or a human. That
is a real control, and it is not the same thing as scope narrowing — see
[THREAT-MODEL.md](../THREAT-MODEL.md) §T3 for the residual risk.

---

## Keeping this accurate

Scopes are read from constants in `src/connectors/*.ts`. If you change a scope
list, change this table in the same commit — a scope inventory that lags the
code is worse than none, because it is the document a reviewer will trust.

> `TODO(owner):` this table was compiled by reading each connector's scope
> constants. It has not been verified against what each provider's consent
> screen actually displays, which can differ (a provider may grant a broader
> implicit scope, or deprecate one). Worth a pass with real accounts before it
> is cited in a security questionnaire.
