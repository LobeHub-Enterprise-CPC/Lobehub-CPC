import { existsSync } from 'node:fs';
import path from 'node:path';

import { defineConfig } from './src/libs/next/config/define-config';

const isVercel = !!process.env.VERCEL_ENV;

const vercelConfig = {
  // Vercel serverless optimization: exclude musl binaries from all routes
  // Vercel uses Amazon Linux (glibc), not Alpine Linux (musl)
  // This saves ~16MB (sharp-musl) per serverless function
  outputFileTracingExcludes: {
    '*': [
      'node_modules/.pnpm/@img+sharp-libvips-*musl*',
      // Exclude SPA/desktop/mobile build artifacts from serverless functions
      'public/_spa/**',
      'dist/desktop/**',
      'dist/mobile/**',
      'apps/desktop/**',
      'packages/database/migrations/**',
    ],
  },
};
const nextConfig = defineConfig({
  // Enterprise distributions install dependencies in the enclosing workspace.
  // Turbopack must include that root to follow pnpm's package symlinks.
  turbopack: {
    root: existsSync(path.resolve(__dirname, '../pnpm-workspace.yaml'))
      ? path.resolve(__dirname, '..')
      : __dirname,
  },
  ...(isVercel ? vercelConfig : {}),
});

export default nextConfig;
