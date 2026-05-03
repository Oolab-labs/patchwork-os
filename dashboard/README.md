# Patchwork Dashboard

Next.js 14 oversight UI for Patchwork OS. Runs locally, talks to the bridge
over Server-Sent Events (`/stream`, `/approvals/stream`) + REST.

## Dev

```bash
cd dashboard
npm install
npm run dev   # http://localhost:3200
```

Expects the bridge on `http://127.0.0.1:<bridge-port>`; the port is auto-discovered from
`~/.claude/ide/*.lock`. Override by setting `PATCHWORK_BRIDGE_PORT=NNNN` in `.env.local`
(copy `.env.example` to get started).

For remote / VPS deploys, set `PATCHWORK_BRIDGE_URL` and `PATCHWORK_BRIDGE_TOKEN`
to skip lock-file discovery.

## Auth

`DASHBOARD_PASSWORD` enables HTTP Basic auth. In `production` builds, leaving
it unset returns 503 unless you explicitly opt in with
`DASHBOARD_ALLOW_UNAUTHENTICATED=1` (e.g. when fronting the dashboard with a
reverse proxy that handles auth).

## Build

```bash
npm run build
npm run start
```

If `npm run build` reports `PageNotFoundError: Cannot find module for page: …`,
the `.next/` cache is stale. Run:

```bash
npm run clean && npm run build
```

## Routes

| Route | Notes |
|---|---|
| `/` | Overview — approvals, tasks, metrics, recipes, connectors |
| `/activity` | Live activity feed (SSE) |
| `/approvals` | Approve / reject pending tool calls (SSE) |
| `/inbox` | Generated artifacts (briefs, summaries, etc.) |
| `/recipes` | Recipe list + run + variable prompt |
| `/recipes/new` | YAML-first recipe authoring |
| `/recipes/[name]/edit` | YAML editor |
| `/recipes/marketplace`, `/marketplace` | Browse + install registry recipes |
| `/runs`, `/runs/[seq]` | Recipe run history + dry-plan |
| `/tasks` | Claude task history |
| `/sessions`, `/sessions/[id]` | Bridge session inspector |
| `/decisions` | Decision log |
| `/traces`, `/metrics`, `/analytics` | OpenTelemetry + Prometheus surfaces |
| `/connections` | Connector OAuth + token management |
| `/settings` | Driver / model / API key / delegation policy |

## Design reference

External UI/UX inspiration to review before committing component patterns:
https://www.adfects.com/.
