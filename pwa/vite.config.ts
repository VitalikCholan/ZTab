import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    tailwindcss(),
    process.env.VITE_HTTPS === '1' ? basicSsl() : null,
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'ZTab',
        short_name: 'ZTab',
        description: 'Split bills privately on shielded Zcash.',
        display: 'standalone',
        start_url: '/',
        theme_color: '#111827',
        background_color: '#111827',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      // Precache build assets only. No runtimeCaching: API responses are never cached.
      workbox: {
        navigateFallbackDenylist: [/^\/t\//],
      },
    }),
  ],
  build: {
    modulePreload: { polyfill: false },
    // Vite 8 minifies with Oxc (the `esbuild.drop` option is not respected): strip console and debugger.
    rolldownOptions:
      mode === 'production'
        ? { output: { minify: { compress: { dropConsole: true, dropDebugger: true } } } }
        : {},
  },
}));
