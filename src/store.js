// Phase 2 + 3: Yjs CRDT state, IndexedDB persistence, WebRTC P2P transport.
import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { WebrtcProvider } from 'y-webrtc'

export const STATUSES = ['todo', 'inprogress', 'done']

const SIGNALING = [
  'wss://signaling.yjs.dev',
  'wss://y-webrtc-signaling-eu.herokuapp.com',
  'wss://y-webrtc-signaling-us.herokuapp.com'
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
    peerOpts: {},
    maxConns: 20 + Math.floor(Math.random() * 15)
  })

  try {
    const me = randomUser()
    provider.awareness.setLocalStateField('user', me)
  } catch {
    // awareness is best-effort; local edits must never throw
  }

  provider.on('peers', () => events.onPeers?.(provider))
  provider.on('connection-close', () => events.onPeers?.(provider))
  provider.on('connection-error', () => events.onPeers?.(provider))

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

  function seedIfEmpty() {
    if (tasks.length > 0) return
    doc.transact(() => {
      const samples = [
        { title: 'Take out recycling', status: 'todo', priority: 'medium', dueDate: '' },
        { title: 'Vacuum living room', status: 'todo', priority: 'high', dueDate: '' },
        { title: 'Water plants', status: 'inprogress', priority: 'low', dueDate: '' }
      ]
      const now = Date.now()
      samples.forEach((s, k) => {
        const m = new Y.Map()
        m.set('id', `seed-${now}-${k}`)
        m.set('title', s.title)
        m.set('status', s.status)
        m.set('dueDate', s.dueDate)
        m.set('priority', s.priority)
        m.set('createdAt', now)
        m.set('updatedAt', now)
        tasks.push([m])
      })
    })
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
    destroy,
    peerCount() {
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
  url.hash = `room=${roomId}`
  return url.toString()
}
