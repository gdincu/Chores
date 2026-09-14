# Chores — Local-first PWA chore board

Offline-first Kanban chore tracker (Todo / In Progress / Done) built for GitHub Pages hosting.

**Stack (per plan):**
- **Vite + Vanilla JS** — fast, zero-framework rendering
- **vite-plugin-pwa** — Service Worker + Web App Manifest, boots instantly offline
- **Yjs (CRDT)** + **y-indexeddb** — shared `Y.Doc` / `Y.Array('tasks')`, persisted to IndexedDB across reloads
- **y-webrtc** — WebRTC data channels for browser-to-browser sync on your own
  network (LAN signaling server in `signaling/`, handshake only)
- **GitHub Pages + Actions** — static `dist/` deploy on every push to `main`

## Quick start

```bash
npm install
npm run dev      # local dev
npm run build    # production build -> dist/
npm run preview  # preview the build
```

## How sync works

1. Each board is a **room** (`#room=xyz123` in the URL hash).
2. All edits mutate the shared Yjs document — mathematically mergeable, no conflicts.
3. `y-indexeddb` persists the doc per-room (`chores-board-<roomId>`).
4. `y-webrtc` streams binary updates over `RTCDataChannel`. Peers find each
   other through a signaling server, which exchanges only session descriptions
   / ICE candidates — chore data flows browser-to-browser. This app is
   LAN-only by design: there is no public signaling server (the former
   `wss://signaling.yjs.dev` is dead), so run the bundled one in `signaling/`
   on a machine both devices can reach (see Sharing below).
5. No peers online? The app works 100% locally and queued updates sync when a peer joins.
6. Sample chores auto-seed only in the default `#room=local` board. Shared (QR)
   rooms start empty and pull state from the host — this avoids the duplicate
   seed race. Already-duplicated boards repair themselves on load, or via the
   **Fix duplicates** button.

## Sharing (same Wi-Fi)

1. On one machine on your LAN, start the bundled signaling server:
   `node signaling/server.js` (or `npm start --prefix signaling`, default port
   `4444`; `/health` reports status).
2. Serve the app over LAN HTTP: `npm run dev -- --host` (or
   `npm run build && npm run preview -- --host` for the production build).
3. Click **🔗 Share board** → copy link or scan QR, then add the signaling
   server to the URL on **both** devices, e.g.
   `http://<pc-lan-ip>:5173/?signaling=ws://<pc-lan-ip>:4444#room=<id>`
   (the Share button carries an existing `?signaling=` into the QR/link
   automatically).
4. Keep both tabs open while pairing — state pulls instantly. The header should
   read **Live · synced P2P** with `1 peer` on both sides. Use full
   Chrome/Safari, not a QR-scanner in-app browser (those often block WebRTC).
5. If the second device can't load the page at all, allow Node.js through the
   host firewall. If the page loads but peers never connect, check both URLs
   carry the same room ID and the same `?signaling=` host.

## GitHub Pages setup

1. Push to `main` — `.github/workflows/deploy.yml` builds and deploys `dist/`.
2. Repo → **Settings → Pages** → Source: **GitHub Actions**.
3. App will be live at `https://<user>.github.io/Chores/`.
4. `public/404.html` is the SPA fallback so deep links / reloads resolve cleanly
   (hash room links never hit the server, so they never 404).

## Project layout

```
index.html            # Kanban UI + modals
src/main.js           # rendering, drag-drop, room + share logic
src/store.js          # Yjs doc, y-indexeddb, y-webrtc provider
src/style.css
signaling/            # standalone LAN signaling server (Dockerfile included)
vite.config.js        # base './' + VitePWA (manifest, workbox)
public/               # favicon, PWA icons, robots, 404 fallback
.github/workflows/   # Pages deploy
```

## Data model

Task (stored as `Y.Map` inside shared `Y.Array('tasks')`):

```js
{ id, title, status: 'todo'|'inprogress'|'done', dueDate: 'YYYY-MM-DD'|'', priority: 'high'|'medium'|'low', createdAt, updatedAt }
```
