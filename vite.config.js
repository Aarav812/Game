import { defineConfig } from 'vite';

/**
 * Dev-server configuration.
 *
 * Two things previously made the dev server feel like it was constantly
 * restarting:
 *
 *  1. `dist/` was being watched, so every `npm run build` triggered a full page
 *     reload in the browser. Scratch asset downloads under `tools/.tmp-*` were
 *     also watched, which produced EBUSY watcher errors on locked files.
 *  2. Without `strictPort`, a stale server left on 5173 pushed each new one to
 *     the next free port, so the URL kept changing.
 *
 * The watcher ignore list below keeps HMR to `src/` and `index.html` only.
 */
export default defineConfig({
  server: {
    port: 5173,
    strictPort: true, // fail loudly instead of silently drifting to another port
    watch: {
      ignored: [
        '**/dist/**',
        '**/tools/.tmp-*/**',
        '**/public/__harness.html',
      ],
    },
  },
  // `dist` is build output; never treat it as a source directory.
  build: {
    emptyOutDir: true,
  },
});
