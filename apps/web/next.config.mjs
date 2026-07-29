/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // @intoto/shared ships TypeScript source through the workspace symlink; Next must
  // compile it rather than treat it as a prebuilt CommonJS dependency.
  transpilePackages: ['@intoto/shared'],

  images: {
    // Product photography and supplier documents come from S3 in production.
    remotePatterns: [
      { protocol: 'https', hostname: '*.amazonaws.com' },
      { protocol: 'http', hostname: 'localhost' },
    ],
    formats: ['image/avif', 'image/webp'],
  },

  experimental: {
    // three.js and its helpers are large; tree-shaking them per-import keeps the
    // dashboard bundle from dominating first paint.
    optimizePackageImports: ['lucide-react', '@react-three/drei', 'recharts'],
  },

  /**
   * Proxy API calls through this server.
   *
   * Next bakes NEXT_PUBLIC_* variables into the bundle at build time, so the browser
   * cannot be told the backend's address by an environment variable set after the image
   * is built — which is exactly the situation on any host that assigns URLs during
   * deployment. Rewrites are evaluated by the running server instead, so the address can
   * arrive at boot. The browser then only ever calls its own origin, which also means
   * there is no cross-origin request to configure and no CORS to get wrong.
   *
   * Unset in local development, where the API is reached directly on port 4000.
   */
  async rewrites() {
    const upstream = process.env.API_INTERNAL_URL;
    if (!upstream) return [];
    const base = upstream.startsWith('http') ? upstream : `https://${upstream}`;
    return [{ source: '/api/:path*', destination: `${base}/api/:path*` }];
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
