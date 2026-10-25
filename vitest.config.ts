import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@xmcl/core/utils': resolve('packages/runtime-node/src/xmcl-compat.ts'),
      '@xmcl/installer': resolve('node_modules/@xmcl/installer/dist/index.mjs'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 15_000,
    server: { deps: { inline: ['@xmcl/installer'] } },
  },
});
