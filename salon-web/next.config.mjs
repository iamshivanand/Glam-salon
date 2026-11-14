/** @type {import('next').NextConfig} */
const nextConfig = {
  // The Docker image builds with NEXT_STANDALONE=true to produce
  // .next/standalone. Local `npm run build && npm start` keeps the default
  // output, because `next start` refuses to run a standalone build.
  ...(process.env.NEXT_STANDALONE === 'true' ? { output: 'standalone' } : {}),
  images: { remotePatterns: [{ protocol: 'https', hostname: '**' }] },
};
export default nextConfig;
