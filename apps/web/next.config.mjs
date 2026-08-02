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

  // API calls are proxied to the backend by src/app/api/[...path]/route.ts, NOT by a
  // rewrite here. `rewrites()` is evaluated during `next build` and its result is baked
  // into routes-manifest.json, so on a host that assigns service addresses at deploy time
  // it produced an empty rewrite list and every API call 404'd. A route handler reads the
  // environment per request, so the address can arrive at boot.

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
