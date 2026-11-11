import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const backend = 'http://localhost:3001';
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig(({ mode }) => {
  // Vite does not put .env into process.env, and it loads .env only after the
  // config is resolved — so config-time values have to be read explicitly.
  // The '' prefix means "load every var", not just VITE_-prefixed ones.
  const env = loadEnv(mode, repoRoot, '');
  const tunnelHost = env.TUNNEL_HOST || process.env.TUNNEL_HOST;

  // The client always requests /.proxy/... (see src/paths.ts). Discord may
  // forward that prefix to us or strip it before forwarding, depending on how
  // the URL mapping resolves, so accept both forms and normalise here.
  // ponytail: four near-identical entries beats guessing which form arrives.
  const toBackend = {
    target: backend,
    ws: true,
    rewrite: (path: string) => path.replace(/^\/\.proxy/, ''),
  };

  const proxy = {
    '/.proxy/api': toBackend,
    '/.proxy/ws': toBackend,
    '/api': toBackend,
    '/ws': toBackend,
  };

  const allowedHosts = [
    ...(tunnelHost ? [tunnelHost] : []),
    // Leading dots allow any subdomain, so a fresh quick-tunnel hostname works
    // without editing .env first. Dev server only.
    '.trycloudflare.com',
    '.ngrok-free.app',
    '.ngrok.io',
  ];

  return {
    plugins: [react()],
    // One .env at the repo root feeds both workspaces.
    envDir: repoRoot,
    resolve: {
      alias: { '@shared': fileURLToPath(new URL('../shared', import.meta.url)) },
    },
    server: {
      port: 3000,
      allowedHosts,
      // Through a tunnel the browser reaches us on 443 over TLS, not on :3000.
      hmr: tunnelHost ? { protocol: 'wss', host: tunnelHost, clientPort: 443 } : undefined,
      proxy,
    },
    // `npm run serve` serves the built bundle here instead. Discord's iframe CSP
    // blocks the eval and inline scripts Vite's dev server uses for HMR, so
    // in-Discord testing generally has to run against a real build.
    preview: {
      port: 3000,
      allowedHosts,
      proxy,
    },
  };
});
