const BASE_PATH = '/dashboard';

const nextConfig = {
  basePath: BASE_PATH,
  output: 'standalone',
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
    ];
  },
};
module.exports = nextConfig;
