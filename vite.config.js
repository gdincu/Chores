import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// GitHub Pages project site (gdincu.github.io/Chores) works with a
// relative base so the same build runs locally, in preview, and on Pages.
export default defineConfig({
  base: './',
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'robots.txt', '404.html'],
      manifest: {
        name: 'Chores — Local-first chore board',
        short_name: 'Chores',
        description:
          'Offline-first Kanban chore tracker with peer-to-peer sync. No account, no server.',
        theme_color: '#4f46e5',
        background_color: '#eef2ff',
        display: 'standalone',
        orientation: 'any',
        scope: './',
        start_url: './',
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      },
      workbox: {
        // Cache static assets so the app boots instantly offline (Phase 1).
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // Hash-based room links (#room=xyz) never hit the network, but keep
        // a navigate fallback so reloads / deep links still resolve offline.
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/_/]
      }
    })
  ]
})
