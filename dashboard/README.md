# Patchwork Dashboard

Next.js 14 oversight UI for Patchwork OS. Runs locally, talks to the bridge
over WebSocket (`/stream`) + REST (`/dashboard/data`, `/approvals`,
`/recipes`, `/metrics`).

## Dev

```bash
cd dashboard
npm install
npm run dev   # http://localhost:3100
```

Expects the bridge on `http://127.0.0.1:<bridge-port>`; the port is read from
`~/.claude/ide/*.lock`. Set `NEXT_PUBLIC_BRIDGE_PORT=NNNN` to override.

## Status

Phase-1 scaffold — routes are stubbed. See `src/app/` for entry points.

| Route | Status |
|---|---|
| `/` | ⇢ redirect to `/activity` |
| `/activity` | **stub** — needs WebSocket client |
| `/approvals` | **stub** — needs `/approvals` + `/approve/:callId` wiring |
| `/recipes` | planned — recipe editor (Monaco + visual builder) |
| `/tasks` | planned — claude task history + resume |
| `/metrics` | planned — OpenTelemetry consumer |
| `/settings` | planned — model selector, API keys |

## Design reference

External UI/UX inspiration to review before committing component patterns:
https://www.adfects.com/.
