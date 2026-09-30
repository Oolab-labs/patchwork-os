const path = require('node:path');

const BASE_PATH = '/dashboard';

/**
 * Security headers, set at the app so every deployment shape carries them.
 *
 * Until these existed the dashboard shipped none of its own: the only such
 * headers in the repo were on the BRIDGE nginx server block, which does not
 * serve the dashboard, and `deploy/deploy-dashboard.sh` adds only
 * `X-Accel-Buffering` (an `add_header` inside a location also suppresses any
 * server-level ones for that location). So a default local install and any
 * non-nginx deploy got nothing, and clickjacking of the approve / reject /
 * kill-switch controls was mitigated by `SameSite=Strict` alone.
 *
 * `Content-Security-Policy` carries ONLY `frame-ancestors`. A script/style
 * policy needs per-request nonces threaded through middleware and the
 * layout's inline scripts, which is its own change with its own blast
 * radius; `frame-ancestors` does not interact with anything on the page and
 * is the directive `X-Frame-Options` cannot express for modern browsers.
 */
const SECURITY_HEADERS = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), payment=()',
  },
];

const nextConfig = {
  basePath: BASE_PATH,
  output: 'standalone',
  poweredByHeader: false,
  async headers() {
    return [{ source: '/(.*)', headers: SECURITY_HEADERS }];
  },
  // Pin Next.js's workspace-root inference to this dashboard dir.
  // Without this, the multi-lockfile heuristic picks /Users/<you>/ (or any
  // ancestor with package-lock.json), and `output: 'standalone'` builds
  // server.js at .next/standalone/<relative-path-from-inferred-root>/...
  // which breaks every deploy script that expects .next/standalone/server.js
  // at the root. Always set this when shipping standalone alongside other
  // npm projects in the same parent tree.
  outputFileTracingRoot: path.join(__dirname),
  // Surface basePath at runtime so client-side helpers (e.g. apiPath in
  // src/lib/api.ts) can prefix bridge-API URLs correctly. Without this,
  // every fetch goes to bare `/api/bridge/*` which 404s — the routes are
  // mounted under basePath. Single source of truth: this file.
  env: {
    NEXT_PUBLIC_BASE_PATH: BASE_PATH,
  },
  // Let webpack resolve the bridge's ESM-style `./foo.js` specifiers onto the
  // `./foo.ts` sources they actually name.
  //
  // The dashboard has imported from `../src/` for a long time, but only ever
  // `connectorRegistry.ts` — a LEAF with no imports of its own, so this never
  // came up. `src/identity/*` is the first cross-package import with an import
  // graph, and the bridge compiles as ESM: it writes `./credentials.js` for
  // `credentials.ts`, which is correct there and unresolvable here.
  //
  // Vitest resolves those specifiers on its own and reported everything green;
  // `next build` is what caught this. Worth remembering — the in-process test
  // could not see it.
  //
  // `.js` stays LAST in the list so a genuine `.js` file imported as `.js`
  // still resolves exactly as before; this only adds candidates ahead of it.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
  async redirects() {
    return [
      {
        source: '/',
        destination: BASE_PATH,
        permanent: false,
        basePath: false,
      },
      // IA reorg (2026-05-12): /metrics was folded into /analytics.
      // Permanent 308 so external bookmarks + cached search results
      // funnel cleanly into the surviving page.
      {
        source: '/metrics',
        destination: '/analytics',
        permanent: true,
      },
      {
        source: '/metrics/:path*',
        destination: '/analytics',
        permanent: true,
      },
      // /recipes/marketplace was a vestigial redirect page (a 5-line
      // Next route that called `redirect("/marketplace")`). Replaced
      // here so the request never enters React.
      {
        source: '/recipes/marketplace',
        destination: '/marketplace',
        permanent: true,
      },
    ];
  },
};
module.exports = nextConfig;
