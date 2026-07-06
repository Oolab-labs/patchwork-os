# dashboard/src

Next.js App Router source for the Patchwork dashboard. It is a password/session-gated,
single-user web UI — almost no business logic lives here, it mostly proxies to the
locally-running bridge process over REST and SSE and renders the result. See
`dashboard/README.md` for how to run/build it; this file covers the code layout.

## The 5 files that matter and why

- **`middleware.ts`** — runs on nearly every request and redirects/401s anything
  without a valid session cookie. `config.matcher` decides what's exempt (must be
  literal syntax for Next's static analyzer); read it directly to see the actual
  public surface, e.g. the OAuth `connections/[name]/callback` page route is
  exempted because the SameSite=Strict cookie doesn't survive that cross-site
  redirect hop.
- **`app/api/bridge/[...path]/route.ts`** — the generic catch-all proxy nearly
  every dashboard page goes through. Handles the `/stream` SSE passthrough
  specially, requires same-origin on mutating verbs, caps request bodies, and
  strips error detail before it reaches the browser.
- **`lib/bridge.ts`** — `bridgeFetch()` / `findBridge()`. Discovers the running
  bridge via `~/.claude/ide/*.lock` (or `PATCHWORK_BRIDGE_URL`/`_TOKEN` for a
  remote VPS deploy) and attaches the bearer token server-side. The browser
  never sees this token.
- **`lib/constantTimeEqual.ts`** — the one shared constant-time compare
  (`constantTimeEqual` / `verifyBearerToken`) for every auth check in this app.
  Extracted after a real bug where a hand-rolled copy skipped the pad-copy on
  oversized input, collapsing to an all-zero buffer compare — see
  `docs/security/register.md` for the incident history. Never reimplement this.
- **`app/page.tsx`** — the Overview deck entry point; the representative
  "biggest page" pulling together most of the SSE + REST calls a typical page
  makes, useful as a template when adding a new page.

## Invariants you must not break

- New API routes under `app/api/bridge/` should use the shared proxy pattern:
  gated by `middleware.ts`'s session check, bridge token attached server-side
  via `lib/bridge.ts` — never hand-roll a fetch with its own auth header.
- Never reimplement auth/token comparison. Use `constantTimeEqual` /
  `verifyBearerToken` from `lib/constantTimeEqual.ts`, always.
- Only add a dedicated proxy route (instead of relying on the `[...path]`
  catch-all) when the generic route would swallow something it can't handle —
  e.g. `recipes/doctor` needs its own route because the dynamic
  `recipes/[...name]` catch-all would otherwise eat the `?recipe=` query
  string (see `CLAUDE.md`, search "doctor"). Special method handling (like the
  SSE-only `/stream` branch) is the other valid reason.
- Mutating verbs (POST/PUT/PATCH/DELETE) must pass `requireSameOrigin` (see
  `lib/csrf.ts`) before touching the bridge. GET/HEAD are exempt by design.
- See `docs/security/register.md` for the historical bugs (timing-safe auth
  bypass, stack-trace leakage) this pattern was built to close — read it
  before touching auth or proxy code.

## How to test it

```bash
cd dashboard
npm run test        # vitest run — unit tests live in **/__tests__/*.test.ts(x), 35 dirs
npm run build        # next build — this is also the closest thing to a typecheck;
                      # there is no standalone `tsc`/`typecheck` script here
```
