import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    resolve: { alias: { '@xmcl/core/utils': resolve('packages/runtime-node/src/xmcl-compat.ts') } },
    build: {
      externalizeDeps: {
        exclude: [
          '@hunaumcl/application',
          '@hunaumcl/contracts',
          '@hunaumcl/domain',
          '@hunaumcl/runtime-node',
          '@xmcl/installer',
        ],
      },
      rollupOptions: {
        input: resolve('apps/desktop/src/main/index.ts'),
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
      rollupOptions: {
        input: resolve('apps/desktop/src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    root: resolve('apps/desktop/src/renderer'),
    plugins: [
      react(),
      {
        name: 'hunaumcl-content-policy',
        transformIndexHtml(html, context) {
          const script = context.server ? "'self' 'unsafe-inline'" : "'self'";
          const style = context.server ? "'self' 'unsafe-inline'" : "'self'";
          const connect = context.server ? "'self' ws://localhost:* ws://127.0.0.1:*" : "'self'";
          return html.replace(
            '__HUNAUMCL_CSP__',
            `default-src 'none'; script-src ${script}; style-src ${style}; img-src 'self' data:; font-src 'self'; connect-src ${connect}; base-uri 'none'; form-action 'none'`,
          );
        },
      },
    ],
    build: { rollupOptions: { input: resolve('apps/desktop/src/renderer/index.html') } },
  },
});
