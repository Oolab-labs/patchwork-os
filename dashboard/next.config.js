const path = require('node:path');

const BASE_PATH = '/dashboard';

const nextConfig = {
  basePath: BASE_PATH,
  output: 'standalone',
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
