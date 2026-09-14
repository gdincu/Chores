// Phase 2 + 3: Yjs CRDT state, IndexedDB persistence, WebRTC P2P transport.
import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { WebrtcProvider } from 'y-webrtc'

export const STATUSES = ['todo', 'inprogress', 'done']

// NOTE: the old y-webrtc Heroku signaling servers have been dead since the
// Heroku free-tier shutdown (Nov 2022). Listing dead servers only slows down
// the handshake and makes sync look broken, so use the live community server.
// Public y-webrtc signaling is community-run and occasionally unreachable
// (see yjs/y-webrtc#43). Allow override without redeploying:
//   https://<user>.github.io/Chores/?signaling=wss://your-server#room=xyz
// or comma-separated for several. The override is preserved in share links.
function signalingServers(fallback) {
  try {
    if (typeof window !== 'undefined') {
      const q = new URLSearchParams(window.location.search).get('signaling')
      if (q) {
        const list = q
          .split(',')
          .map((s) => s.trim())
          .filter((s) => /^wss?:\/\/.+/.test(s))
        if (list.length > 0) return list
      }
    }
  } catch {
    /* ignore malformed query strings */
  }
  return fallback
}
const SIGNALING = signalingServers(['wss://signaling.yjs.dev'])

// Explicit STUN servers so host/candidate gathering works even if the
// y-webrtc defaults change. (No TURN here — symmetric-NAT pairs may still
// need both tabs on the same network or a TURN server.)
const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:global.stun.twilio.com:3478'] }
]

function randomUser() {
  const names = ['Fox', 'Owl', 'Bear', 'Ant', 'Bee', 'Wren', 'Oak', 'Fern']
  const colors = ['#4f46e5', '#059669', '#d97706', '#db2777', '#0891b2', '#65a30d']
  const pick = (a) => a[Math.floor(Math.random() * a.length)]
  return { name: `${pick(names)}-${Math.floor(Math.random() * 90 + 10)}`, color: pick(colors) }
}

/**
 * Create a local-first synced store for one board / room.
 * - `doc` is the shared Yjs document (Phase 2)
 * - `tasks` is the shared Y.Array of Y.Map (mathematically mergeable updates)
 * - IndexeddbPersistence keeps it across reloads (Phase 2)
 * - WebrtcProvider streams binary updates over RTCDataChannel (Phase 3),
 *   falling back to pure-local operation when no peers are online.
 */
export function createStore(roomId, events = {}) {
  const doc = new Y.Doc()
  const tasks = doc.getArray('tasks')

  const persistence = new IndexeddbPersistence(`chores-board-${roomId}`, doc)
  persistence.on('synced', () => events.onPersisted?.())

  const provider = new WebrtcProvider(`chores-${roomId}`, doc, {
    signaling: SIGNALING,
    peerOpts: { config: { iceServers: ICE_SERVERS } },
    maxConns: 20,
    // Keep BroadcastChannel enabled (same-browser tabs sync instantly) AND
    // WebRTC (cross-device). Filtering BC conns off would break tab sync.
    filterBcConns: false
  })

  try {
    const me = randomUser()
    provider.awareness.setLocalStateField('user', me)
  } catch {
    // awareness is best-effort; local edits must never throw
  }

  // 'peers' fires on join/leave; awareness 'change' is a second signal.
  // y-webrtc versions differ on sync events ('synced' vs 'sync'), so listen
  // to both when available. All handlers are best-effort.
  const notifyPeers = () => events.onPeers?.(provider)
  const notifySync = (synced) => events.onSync?.(synced, provider)
  try {
    provider.on('peers', notifyPeers)
    provider.on('connection-close', notifyPeers)
    provider.on('connection-error', notifyPeers)
    provider.on('synced', notifySync)
    provider.on('sync', notifySync)
    provider.awareness?.on?.('change', notifyPeers)
  } catch {
    /* older/newer y-webrtc without one of these events */
  }

  tasks.observeDeep(() => events.onChange?.(snapshot()))

  function toPlain(ymap) {
    return {
      id: ymap.get('id'),
      title: ymap.get('title') ?? '',
      status: ymap.get('status') ?? 'todo',
      dueDate: ymap.get('dueDate') ?? '',
      priority: ymap.get('priority') ?? 'medium',
      createdAt: ymap.get('createdAt') ?? Date.now(),
      updatedAt: ymap.get('updatedAt') ?? Date.now()
    }
  }

  function snapshot() {
    return tasks.toArray().map(toPlain)
  }

  function indexOf(id) {
    return tasks.toArray().findIndex((t) => t.get('id') === id)
  }

  function normalizeStatus(s) {
    return STATUSES.includes(s) ? s : 'todo'
  }

  function addTask({ title, status = 'todo', dueDate = '', priority = 'medium' }) {
    const clean = (title || '').trim()
    if (!clean) return null
    const now = Date.now()
    const id =
      typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : `id-${now}-${Math.random().toString(36).slice(2, 10)}`
    const m = new Y.Map()
    m.set('id', id)
    m.set('title', clean.slice(0, 140))
    m.set('status', normalizeStatus(status))
    m.set('dueDate', dueDate || '')
    m.set('priority', ['high', 'medium', 'low'].includes(priority) ? priority : 'medium')
    m.set('createdAt', now)
    m.set('updatedAt', now)
    doc.transact(() => tasks.push([m]))
    return id
  }

  function updateTask(id, patch = {}) {
    const i = indexOf(id)
    if (i < 0) return false
    const m = tasks.get(i)
    doc.transact(() => {
      if (patch.title !== undefined) m.set('title', String(patch.title).slice(0, 140))
      if (patch.status !== undefined) m.set('status', normalizeStatus(patch.status))
      if (patch.dueDate !== undefined) m.set('dueDate', patch.dueDate || '')
      if (patch.priority !== undefined) m.set('priority', patch.priority)
      m.set('updatedAt', Date.now())
    })
    return true
  }

  function moveTask(id, status) {
    return updateTask(id, { status })
  }

  function removeTask(id) {
    const i = indexOf(id)
    if (i < 0) return false
    doc.transact(() => tasks.delete(i, 1))
    return true
  }

  function clearDone() {
    doc.transact(() => {
      for (let i = tasks.length - 1; i >= 0; i--) {
        if (tasks.get(i).get('status') === 'done') tasks.delete(i, 1)
      }
    })
  }

  // Seed exactly once per room. The `meta/seeded` flag itself syncs via Yjs,
  // so even if two tabs call this concurrently before connecting, the second
  // one's transaction is a no-op once the flag arrives. Seed IDs are fixed
  // slugs (not timestamps) so retries never create new identities.
  // Callers must still avoid racing the initial WebRTC sync: only auto-seed
  // the default 'local' room; shared (QR) rooms start empty and pull state
  // from the host. See initStore in main.js.
  function seedIfEmpty() {
    const meta = doc.getMap('meta')
    if (meta.get('seeded')) return false
    if (tasks.length > 0) return false
    doc.transact(() => {
      if (meta.get('seeded') || tasks.length > 0) return
      const now = Date.now()
      const samples = [
        { id: 'seed-recycling', title: 'Take out recycling', status: 'todo', priority: 'medium' },
        { id: 'seed-vacuum', title: 'Vacuum living room', status: 'todo', priority: 'high' },
        { id: 'seed-plants', title: 'Water plants', status: 'inprogress', priority: 'low' }
      ]
      for (const s of samples) {
        const m = new Y.Map()
        m.set('id', s.id)
        m.set('title', s.title)
        m.set('status', s.status)
        m.set('dueDate', '')
        m.set('priority', s.priority)
        m.set('createdAt', now)
        m.set('updatedAt', now)
        tasks.push([m])
      }
      meta.set('seeded', true)
    })
    return true
  }

  // One-time repair for boards duplicated by the old timestamp-seed race
  // (seed-<Date.now()>-<k> on both host and guest → 6 tasks instead of 3).
  // Collapses tasks with identical normalized titles, keeping the oldest.
  // Returns the number of removed cards.
  function dedupeSeeds() {
    const arr = tasks.toArray()
    if (arr.length < 2) return 0
    const seen = new Map() // normalized title -> index to keep
    const removeIdx = []
    arr.forEach((t, i) => {
      const title = String(t.get('title') ?? '').trim().toLowerCase()
      if (!title) return
      if (!seen.has(title)) {
        seen.set(title, i)
        return
      }
      const keepIdx = seen.get(title)
      const keep = arr[keepIdx]
      const cur = t
      // Keep the oldest; on tie keep the first-seen.
      const keepTime = keep.get('createdAt') ?? 0
      const curTime = cur.get('createdAt') ?? 0
      if (curTime < keepTime) {
        removeIdx.push(keepIdx)
        seen.set(title, i)
      } else {
        removeIdx.push(i)
      }
    })
    if (removeIdx.length === 0) return 0
    doc.transact(() => {
      for (const i of [...removeIdx].sort((a, b) => b - a)) {
        try {
          tasks.delete(i, 1)
        } catch {
          /* index shifted by a concurrent delete — safe to skip */
        }
      }
    })
    return removeIdx.length
  }

  function destroy() {
    try {
      provider.disconnect()
      provider.destroy()
    } catch {
      /* best effort */
    }
    try {
      persistence.destroy()
    } catch {
      /* best effort */
    }
    try {
      doc.destroy()
    } catch {
      /* best effort */
    }
  }

  return {
    doc,
    tasks,
    provider,
    persistence,
    snapshot,
    addTask,
    updateTask,
    moveTask,
    removeTask,
    clearDone,
    seedIfEmpty,
    dedupeSeeds,
    destroy,
    peerCount() {
      // NOTE: bcConns counts same-browser BroadcastChannel tabs, NOT network
      // peers — using it made the UI show "0 peers" while connected. Prefer
      // real WebRTC connections, fall back to awareness states.
      try {
        const rtc = provider.room?.webrtcConns?.size
        if (typeof rtc === 'number' && rtc > 0) return rtc
      } catch {
        /* ignore */
      }
      try {
        const aware = provider.awareness?.getStates?.().size
        if (typeof aware === 'number' && aware > 1) return aware - 1
      } catch {
        /* ignore */
      }
      try {
        return provider.room?.bcConns?.size ?? 0
      } catch {
        return 0
      }
    }
  }
}

export function parseRoomFromLocation(loc = window.location) {
  // Supports #room=xyz123, #/room/xyz123, and ?room=xyz123
  const hash = loc.hash || ''
  let m = hash.match(/room=([A-Za-z0-9_-]{3,64})/)
  if (m) return m[1]
  m = hash.match(/^#\/?([A-Za-z0-9_-]{6,64})\/?$/)
  if (m && m[1] !== 'room') return m[1]
  try {
    const q = new URLSearchParams(loc.search).get('room')
    if (q && /^[A-Za-z0-9_-]{3,64}$/.test(q)) return q
  } catch {
    /* ignore */
  }
  return null
}

export function randomRoomId(length = 10) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes =
    typeof crypto !== 'undefined' && crypto.getRandomValues
      ? crypto.getRandomValues(new Uint8Array(length))
      : Array.from({ length }, () => Math.floor(Math.random() * 256))
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}

export function shareUrlFor(roomId, loc = window.location) {
  const url = new URL(loc.href.split('#')[0])
  // Carry a custom ?signaling= override into the share link so the guest
  // uses the same signaling server as the host.
  try {
    const sig = new URLSearchParams(loc.search).get('signaling')
    if (sig) url.searchParams.set('signaling', sig)
  } catch {
    /* ignore */
  }
  url.hash = `room=${roomId}`
  return url.toString()
}
