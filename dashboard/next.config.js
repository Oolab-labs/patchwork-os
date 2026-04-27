const nextConfig = {
  basePath: '/dashboard',
  output: 'standalone',
  async redirects() {
    return [
      {
        source: '/',
        destination: '/dashboard',
        permanent: false,
        basePath: false,
      },
    ];
  },
};
module.exports = nextConfig;
