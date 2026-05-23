# Distribution Channel Policy

## Channel Table

| Surface | URL / Handle | Pin to | Update cadence | Owner |
|---|---|---|---|---|
| npm `latest` | npmjs.com/package/patchwork-os | stable semver tag | auto — `publish-npm.yml` on `v*` (non-prerelease) | CI |
| npm `beta` | same package, `beta` tag | `v*-beta*` tag | auto — `publish-npm.yml` on `v*-beta*` | CI |
| npm `canary` | same package, `canary` tag | `<base>.canary.<run>` | auto — `publish-canary.yml` on every green main merge | CI |
| Docker (ghcr.io) | ghcr.io/oolab-labs/patchwork-os | `:latest` / `:beta` / `:rc` | auto — `publish-docker.yml` on `v*` tags | CI |
| Smithery | (TBD — not yet submitted) | `@latest` stable npm tag | on each stable release | maintainer |
| mcp.so | (TBD — not yet submitted) | latest stable npm tag | on each stable release | maintainer |
| awesome-mcp-servers | punkpeye/awesome-mcp-servers | PR-based (no pin) | after every 5 stable releases; earliest 2026-06-01 | maintainer |
| .dxt bundle | (TBD — not yet built) | versioned artifact | on each stable release | maintainer |
| OpenWebUI gallery | (TBD — not yet submitted) | versioned | on each stable release | maintainer |
| n8n | (TBD — not yet submitted) | versioned | on each stable release | maintainer |

> **Canary is never listed on any external registry.** It is for internal dogfooding only. Do not submit `@canary` to Smithery, mcp.so, or any other external surface.

---

## Pre-Submission Checklist

Before creating or updating any external registry listing:

- [ ] Docker smoke test passes (see acceptance criteria below)
- [ ] `npm pack --dry-run` clean — no secrets, no `.env` files, no large binaries
- [ ] `package.json` keywords include `model-context-protocol` and `mcp-server`; plugin packages also include `claude-ide-bridge-plugin`
- [ ] README badge links resolve (npm badge, license badge)
- [ ] Version being listed is a stable semver (no `-alpha`, `-beta`, `-rc`, `-canary` suffix)
- [ ] `GET /ping` tested manually against the version being listed

---

## Docker Smoke Test Acceptance Criteria

CI must pass all four checks before a Docker-backed listing is updated:

1. **Startup** — container starts and `/ping` is reachable within 15 s
2. **Health** — `GET /ping` returns HTTP 200
3. **Tool discovery** — `POST /mcp` with `{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}` returns at least 1 tool in the result
4. **Clean shutdown** — container exits cleanly on `SIGTERM` within 5 s (tini handles signal forwarding)

Default port: `18765` (env `PORT` overrides).

---

## Stale Listing Policy

If any external listing points to a version more than **2 stable releases** behind the current `latest`, update it within **7 calendar days** of discovering the drift.

Track version-at-last-update in `docs/listings.md`.
