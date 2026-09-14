import './style.css'
import QRCode from 'qrcode'
import {
  createStore,
  parseRoomFromLocation,
  randomRoomId,
  shareUrlFor,
  STATUSES
} from './store.js'

const $ = (sel) => document.querySelector(sel)

const boardEls = {
  todo: $('#col-todo'),
  inprogress: $('#col-inprogress'),
  done: $('#col-done')
}
const countEls = {
  todo: $('#count-todo'),
  inprogress: $('#count-inprogress'),
  done: $('#count-done')
}

let roomId = parseRoomFromLocation() || 'local'
if (!parseRoomFromLocation()) {
  // Keep the URL canonical so refresh / share always resolves to a room.
  history.replaceState(null, '', `#room=${roomId}`)
}

let store = null
let search = ''
let priorityFilter = 'all'
let draggedId = null

// ---------- store lifecycle ----------

function initStore(nextRoom) {
  if (store) store.destroy()
  roomId = nextRoom
  $('#roomIdLabel').textContent = roomId
  // Shared (QR) rooms must NEVER auto-seed: a guest opening the link has an
  // empty local IndexedDB, and seeding before the first WebRTC sync arrives
  // is exactly what produced "duplicated tasks". Only the default 'local'
  // room gets sample chores; shared rooms pull state from the host.
  const isSharedRoom = nextRoom !== 'local'

  store = createStore(roomId, {
    onChange: render,
    onPersisted: () => {
      $('#persistLabel').textContent = 'Saved locally ✓ · IndexedDB'
      // Repair boards duplicated by the old timestamp-seed race, then seed
      // only the local room.
      const removed = store.dedupeSeeds()
      if (removed > 0) toast(`Removed ${removed} duplicate card${removed === 1 ? '' : 's'}`)
      if (!isSharedRoom) store.seedIfEmpty()
      render()
    },
    onPeers: updateNetStatus,
    onSync: () => {
      // First successful sync with a peer: dedupe (guest may have briefly
      // rendered host state + nothing else), then re-render + status.
      const removed = store.dedupeSeeds()
      if (removed > 0) toast(`Removed ${removed} duplicate card${removed === 1 ? '' : 's'}`)
      render()
      updateNetStatus()
    }
  })

  // Local room only: seed quickly for first paint; persistence 'synced'
  // will re-render. Shared rooms intentionally stay empty until host sync.
  setTimeout(() => {
    if (!isSharedRoom && store.tasks.length === 0) store.seedIfEmpty()
    render()
    updateNetStatus()
  }, 50)

  updateNetStatus()
}

function updateNetStatus() {
  const online = navigator.onLine
  const peers = store ? store.peerCount() : 0
  // y-webrtc awareness peers (more accurate when connected)
  let awarenessPeers = 0
  try {
    awarenessPeers = Math.max(0, store.provider.awareness.getStates().size - 1)
  } catch {
    /* ignore */
  }
  const total = Math.max(peers, awarenessPeers)

  const dot = $('#netDot')
  const label = $('#netLabel')
  dot.classList.toggle('online', online && total > 0)
  dot.classList.toggle('offline', !(online && total > 0))
  label.textContent = !online
    ? 'Offline · local only'
    : total > 0
      ? `Live · synced P2P`
      : 'Online · waiting for peers (local first)'
  $('#peerCount').textContent = `${total} peer${total === 1 ? '' : 's'}`
}

window.addEventListener('online', updateNetStatus)
window.addEventListener('offline', updateNetStatus)
window.addEventListener('hashchange', () => {
  const next = parseRoomFromLocation()
  if (next && next !== roomId) {
    initStore(next)
    toast(`Joined room ${next}`)
  }
})
setInterval(updateNetStatus, 4000)

// ---------- rendering ----------

function dueClass(dueDate) {
  if (!dueDate) return ''
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const due = new Date(`${dueDate}T00:00:00`)
  if (Number.isNaN(due.getTime())) return ''
  const diffDays = Math.round((due - today) / 86400000)
  if (diffDays < 0) return 'overdue'
  if (diffDays <= 2) return 'soon'
  return ''
}

function dueLabel(dueDate) {
  if (!dueDate) return 'No due date'
  const cls = dueClass(dueDate)
  if (cls === 'overdue') return `Overdue · ${dueDate}`
  if (cls === 'soon') return `Due soon · ${dueDate}`
  return `Due ${dueDate}`
}

function filteredTasks(all) {
  const q = search.trim().toLowerCase()
  return all.filter((t) => {
    if (priorityFilter !== 'all' && t.priority !== priorityFilter) return false
    if (q && !t.title.toLowerCase().includes(q)) return false
    return true
  })
}

function render() {
  if (!store) return
  const all = store.snapshot()
  const visible = filteredTasks(all)

  for (const status of STATUSES) {
    const list = visible
      .filter((t) => (t.status || 'todo') === status)
      .sort((a, b) => b.createdAt - a.createdAt)
    countEls[status].textContent = String(
      all.filter((t) => (t.status || 'todo') === status).length
    )
    const el = boardEls[status]
    el.innerHTML = ''
    if (list.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'muted small'
      empty.style.margin = '4px'
      empty.textContent = 'No chores here — drag a card or add one.'
      el.appendChild(empty)
      continue
    }
    for (const task of list) el.appendChild(cardNode(task))
  }
}

function cardNode(task) {
  const card = document.createElement('article')
  card.className = 'card'
  card.draggable = true
  card.dataset.id = task.id

  const top = document.createElement('div')
  top.className = 'card-top'
  const title = document.createElement('p')
  title.className = 'card-title' + (task.status === 'done' ? ' done' : '')
  title.textContent = task.title
  const badge = document.createElement('span')
  badge.className = `badge ${task.priority || 'medium'}`
  badge.textContent = task.priority || 'medium'
  top.append(title, badge)

  const meta = document.createElement('div')
  meta.className = 'card-meta'
  const due = document.createElement('span')
  due.className = `due ${dueClass(task.dueDate)}`
  due.textContent = `📅 ${dueLabel(task.dueDate)}`
  meta.appendChild(due)

  const actions = document.createElement('div')
  actions.className = 'card-actions'

  const prevBtn = document.createElement('button')
  prevBtn.className = 'mini'
  prevBtn.type = 'button'
  prevBtn.textContent = '← Prev'
  prevBtn.title = 'Move to previous column'
  prevBtn.disabled = task.status === 'todo'
  prevBtn.onclick = () => stepTask(task, -1)

  const nextBtn = document.createElement('button')
  nextBtn.className = 'mini'
  nextBtn.type = 'button'
  nextBtn.textContent = task.status === 'done' ? '↺ Reopen' : 'Done →'
  nextBtn.title = 'Advance (tap-friendly completion flow)'
  nextBtn.onclick = () => advanceTask(task)

  const editBtn = document.createElement('button')
  editBtn.className = 'mini'
  editBtn.type = 'button'
  editBtn.textContent = 'Edit'
  editBtn.onclick = () => openTaskModal(task)

  const delBtn = document.createElement('button')
  delBtn.className = 'mini danger'
  delBtn.type = 'button'
  delBtn.textContent = 'Delete'
  delBtn.onclick = () => {
    if (confirm(`Delete "${task.title}"?`)) {
      store.removeTask(task.id)
      render()
    }
  }

  actions.append(prevBtn, nextBtn, editBtn, delBtn)
  card.append(top, meta, actions)

  card.addEventListener('dragstart', (e) => {
    draggedId = task.id
    card.classList.add('dragging')
    e.dataTransfer.effectAllowed = 'move'
    try {
      e.dataTransfer.setData('text/plain', task.id)
    } catch {
      /* Safari */
    }
  })
  card.addEventListener('dragend', () => {
    draggedId = null
    card.classList.remove('dragging')
    document.querySelectorAll('.dropzone').forEach((z) => z.classList.remove('dragover'))
  })

  return card
}

function stepTask(task, dir) {
  const i = STATUSES.indexOf(task.status)
  const next = STATUSES[Math.min(STATUSES.length - 1, Math.max(0, i + dir))]
  store.moveTask(task.id, next)
  render()
}

function advanceTask(task) {
  if (task.status === 'todo') store.moveTask(task.id, 'inprogress')
  else if (task.status === 'inprogress') store.moveTask(task.id, 'done')
  else store.moveTask(task.id, 'todo')
  render()
}

// ---------- drag & drop columns ----------

for (const status of STATUSES) {
  const zone = boardEls[status]
  zone.addEventListener('dragover', (e) => {
    e.preventDefault()
    zone.classList.add('dragover')
  })
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'))
  zone.addEventListener('drop', (e) => {
    e.preventDefault()
    zone.classList.remove('dragover')
    let id = draggedId
    try {
      id = id || e.dataTransfer.getData('text/plain')
    } catch {
      /* ignore */
    }
    if (id) {
      store.moveTask(id, status)
      render()
    }
  })
}

// ---------- task modal ----------

const taskModal = $('#taskModal')
const taskForm = $('#taskForm')

function openTaskModal(existing = null, presetStatus = 'todo') {
  $('#taskModalTitle').textContent = existing ? 'Edit chore' : 'Add chore'
  $('#taskId').value = existing?.id ?? ''
  $('#taskTitle').value = existing?.title ?? ''
  $('#taskStatus').value = existing?.status ?? presetStatus
  $('#taskPriority').value = existing?.priority ?? 'medium'
  $('#taskDue').value = existing?.dueDate ?? ''
  taskModal.hidden = false
  setTimeout(() => $('#taskTitle').focus(), 30)
}

function closeTaskModal() {
  taskModal.hidden = true
}

taskForm.addEventListener('submit', (e) => {
  e.preventDefault()
  const id = $('#taskId').value
  const payload = {
    title: $('#taskTitle').value,
    status: $('#taskStatus').value,
    priority: $('#taskPriority').value,
    dueDate: $('#taskDue').value
  }
  if (id) store.updateTask(id, payload)
  else store.addTask(payload)
  closeTaskModal()
  render()
})
$('#taskCancel').addEventListener('click', closeTaskModal)
taskModal.addEventListener('click', (e) => {
  if (e.target === taskModal) closeTaskModal()
})

$('#addBtn').addEventListener('click', () => openTaskModal())
document.querySelectorAll('[data-add]').forEach((b) =>
  b.addEventListener('click', () => openTaskModal(null, b.dataset.add))
)

$('#clearDoneBtn').addEventListener('click', () => {
  if (confirm('Delete all completed chores?')) {
    store.clearDone()
    render()
  }
})

$('#dedupeBtn').addEventListener('click', () => {
  const removed = store.dedupeSeeds()
  render()
  toast(removed > 0 ? `Removed ${removed} duplicate card${removed === 1 ? '' : 's'}` : 'No duplicates found')
})

$('#searchInput').addEventListener('input', (e) => {
  search = e.target.value
  render()
})
$('#priorityFilter').addEventListener('change', (e) => {
  priorityFilter = e.target.value
  render()
})

// ---------- share modal (Phase 4) ----------

const shareModal = $('#shareModal')

async function openShare() {
  const url = shareUrlFor(roomId)
  $('#shareUrl').value = url
  $('#shareRoomId').textContent = roomId
  shareModal.hidden = false
  try {
    $('#qrImg').src = await QRCode.toDataURL(url, { width: 360, margin: 1 })
  } catch {
    $('#qrImg').alt = 'QR generation failed — copy the link instead'
  }
}

$('#shareBtn').addEventListener('click', openShare)
$('#shareClose').addEventListener('click', () => (shareModal.hidden = true))
shareModal.addEventListener('click', (e) => {
  if (e.target === shareModal) shareModal.hidden = true
})

$('#copyLinkBtn').addEventListener('click', async () => {
  const url = $('#shareUrl').value
  try {
    await navigator.clipboard.writeText(url)
    toast('Share link copied ✓')
  } catch {
    $('#shareUrl').select()
    document.execCommand('copy')
    toast('Share link selected — press Ctrl+C')
  }
})

$('#newRoomBtn').addEventListener('click', () => {
  const next = randomRoomId()
  history.pushState(null, '', `#room=${next}`)
  initStore(next)
  shareModal.hidden = true
  openShare()
  toast(`New room ${next} created`)
})

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    taskModal.hidden = true
    shareModal.hidden = true
  }
})

// ---------- toast ----------

let toastTimer = 0
function toast(msg) {
  const el = $('#toast')
  el.textContent = msg
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (el.hidden = true), 2600)
}

// ---------- boot ----------

initStore(roomId)
