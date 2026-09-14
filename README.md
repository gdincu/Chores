# Chores — Local-first PWA chore board

Offline-first Kanban chore tracker (Todo / In Progress / Done) built for GitHub Pages hosting.

**Stack (per plan):**
- **Vite + Vanilla JS** — fast, zero-framework rendering
- **vite-plugin-pwa** — Service Worker + Web App Manifest, boots instantly offline
- **Yjs (CRDT)** + **y-indexeddb** — shared `Y.Doc` / `Y.Array('tasks')`, persisted to IndexedDB across reloads
- **y-webrtc** — serverless WebRTC data channels for browser-to-browser sync (public signaling only for handshake)
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
4. `y-webrtc` streams binary updates over `RTCDataChannel`. The public signaling
   server (`wss://signaling.yjs.dev`) exchanges only session descriptions / ICE
   candidates — chore data flows browser-to-browser.
5. No peers online? The app works 100% locally and queued updates sync when a peer joins.
6. Sample chores auto-seed only in the default `#room=local` board. Shared (QR)
   rooms start empty and pull state from the host — this avoids the duplicate
   seed race. Already-duplicated boards repair themselves on load, or via the
   **Fix duplicates** button.

## Sharing

1. Click **🔗 Share board** → copy link or scan QR.
2. Second device opens `https://<user>.github.io/Chores/#room=<id>`.
3. Keep both tabs open while pairing — state pulls instantly. The header should
   read **Live · synced P2P** with `1 peer` on both sides.
4. If peers never connect: same room ID in both URLs? Both online (not via a
   WebRTC-blocking in-app browser)? Some symmetric-NAT / corporate networks
   need both devices on the same Wi-Fi or a TURN server.

### If the public signaling server is down

`wss://signaling.yjs.dev` is community-run and occasionally unreachable (see
`yjs/y-webrtc#43`). The app keeps working locally regardless — sync resumes
when signaling is reachable. Workarounds without redeploying:

- Append `?signaling=wss://your-server` to the URL on **both** devices
  (the Share button carries it into the QR/link automatically).
- Run your own in one command (from the `y-webrtc` package's bundled server):
  `PORT=4444 node ./node_modules/y-webrtc/bin/server.js`, then use
  `?signaling=ws://<host>:4444`. Any host both devices can reach works —
  same Wi-Fi is enough for testing.

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
vite.config.js        # base './' + VitePWA (manifest, workbox)
public/               # favicon, PWA icons, robots, 404 fallback
.github/workflows/   # Pages deploy
```

## Data model

Task (stored as `Y.Map` inside shared `Y.Array('tasks')`):

```js
{ id, title, status: 'todo'|'inprogress'|'done', dueDate: 'YYYY-MM-DD'|'', priority: 'high'|'medium'|'low', createdAt, updatedAt }
```
