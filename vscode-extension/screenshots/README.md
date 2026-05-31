# Patchwork OS — Dashboard Screenshots

Captured via Playwright against the local Next.js dashboard (`http://localhost:3200/dashboard`) in `NEXT_PUBLIC_DEMO_MODE=true` so the data shown is sample data, not real workspace state.

Viewport: 1440 × 900 (Retina @ 2×), full-page captures.

| File | Page | Purpose |
|---|---|---|
| `01-overview.png` | `/dashboard` (Overview) | Daily summary, telemetry tiles, activity thread, top recipes |
| `02-recipes.png` | `/dashboard/recipes` | Installed recipes with triggers, run history sparkline, on/off toggle |
| `03-approvals.png` | `/dashboard/approvals` | Pending tool-call approvals with risk badges + keyboard hints |
| `04-inbox.png` | `/dashboard/inbox` | AI-authored briefs / summaries / agent reports |
| `05-traces.png` | `/dashboard/traces` | Cross-session memory entries (approvals, enrichment, recipe runs) |
| `06-settings-killswitch.png` | `/dashboard/settings` | Bridge / AI drivers / approval policy / **Safety (kill-switch)** / mobile / telemetry |
| `07-marketplace.png` | `/dashboard/marketplace` | Curated recipes from `github.com/Oolab-labs/patchwork-os` |
| `08-connections.png` | `/dashboard/connections` | OAuth connector grid (Linear, Slack, GitHub connected; others available) |

## Hero image

The above-the-fold hero used by the root README, the extension README, and the plugin README lives at **`docs/images/dashboard-overview.png`** (1440 × 900). Unlike the demo-mode shots below, it was captured against a **live, connected bridge** so the header shows the online state, telemetry sparklines, and the real recipe library — not sample data.

## Re-capture

**Demo-mode shots (`01`–`08` below):** sample data, no bridge required.

```bash
cd dashboard
DASHBOARD_ALLOW_UNAUTHENTICATED=1 NEXT_PUBLIC_DEMO_MODE=true PORT=3200 npm run dev
# then via Playwright (any driver):
#   viewport 1440x900, fullPage screenshots of each /dashboard/<route>
```

**Connected-state hero (`docs/images/dashboard-overview.png`):** point the dashboard at a running bridge so the offline banners clear.

```bash
cd dashboard
# find the live bridge's port + token from its lock file (~/.claude/ide/<port>.lock),
# then point the dashboard at it and restart:
#   PATCHWORK_BRIDGE_URL=http://127.0.0.1:<port>
#   PATCHWORK_BRIDGE_TOKEN=<authToken from the lock file>
DASHBOARD_ALLOW_UNAUTHENTICATED=1 PORT=3200 npm run dev
# then Playwright: viewport 1440x900, screenshot http://localhost:3200/dashboard
```

## Use in marketing copy

- **README.md** (root) — uses `docs/images/dashboard-overview.png` as the above-the-fold hero.
- **vscode-extension/README.md** — leads with the same hero, then a three-up row of `02-recipes.png`, `03-approvals.png`, `05-traces.png`.
- **claude-ide-bridge-plugin/README.md** — reuses the hero near the top.

> **Gotcha:** this `screenshots/` directory is **gitignored** (see `.gitignore`), so its PNGs are NOT on `main`. Any image used in a published README must live in a **tracked** path — copy it into `docs/images/` first. The hero and the three promoted shots above already live there; the `raw.githubusercontent.com/Oolab-labs/patchwork-os/main/docs/images/<file>` URLs resolve only because of that. Relative paths and `vscode-extension/screenshots/...` URLs 404 on the Marketplace.
