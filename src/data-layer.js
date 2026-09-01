// ============================================================
// KINDNESS REPO — DATA LAYER (rebuilt backend)
// ------------------------------------------------------------
// Firestore is now the SOURCE OF TRUTH, modeled as normalized
// collections (one document per entity) instead of the old design
// that stuffed entire arrays into a single mirror document and used
// localStorage as the authority.
//
//   settings/app                      (single doc, one field per setting)
//   coupons/{couponId}                (field: deck = 'ready' | 'bday')
//   usage/{entryId}                   (one redemption / mission per doc)
//   chat/{messageId}                  (one message per doc)
//   memories/{memoryId}               (one Safe Zone post per doc)
//   memories/{memoryId}/comments/{id} (comments as a subcollection)
//
// Real-time onSnapshot listeners keep an in-browser read cache (the
// existing localStorage keys) continuously in sync, so the UI stays
// instant and every screen reads through the exact same key-based
// facade (sGet / sSet / sDelete / seedSharedKey / pullRemoteKey) that
// the app already used. Only the machinery underneath changed.
//
// Access is gated by Firebase Anonymous Auth so Security Rules can
// require request.auth != null.
// ============================================================
import { db, authReady, auth } from "./firebase.js"
import {
  collection,
  doc,
  getDocs,
  onSnapshot,
  setDoc,
  deleteDoc,
  writeBatch,
} from "firebase/firestore"

// ---- bridges to the classic inline script (localStorage cache + UI) ----
const cacheRead = (key) => (window.localRead ? window.localRead(key) : null)
const cacheWrite = (key, val) => { if (window.localWrite) window.localWrite(key, val) }
const cacheDelete = (key) => { if (window.localDelete) window.localDelete(key) }
const uiRefresh = (key) => {
  try { if (window.refreshVisibleSharedUI) window.refreshVisibleSharedUI(key) } catch (e) {}
}

const USAGE_CAP = 300
const CHAT_CAP = 200

// ---- runtime state -----------------------------------------------------
let firestoreReady = false           // true once anonymous auth succeeded
let listenersStarted = false
let listenersPromise = null
const unsubs = []

// in-memory mirrors of each collection (id -> document data)
const couponCache = new Map()
const usageCache = new Map()
const chatCache = new Map()
const memCache = new Map()
const memCommentsCache = new Map()   // memId -> Map(commentId -> data)
const memCommentUnsubs = new Map()   // memId -> unsubscribe fn
let settingsCache = {}

// first-snapshot signals so seeding/pull can wait for a real read
function makeSignal() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve, done: false }
}
const firstSync = {
  coupons: makeSignal(),
  usage: makeSignal(),
  chat: makeSignal(),
  memories: makeSignal(),
  settings: makeSignal(),
}
function signalReady(name) {
  const s = firstSync[name]
  if (s && !s.done) { s.done = true; s.resolve() }
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise.then(() => true),
    new Promise((r) => setTimeout(() => r(false), ms)),
  ])
}

// ============================================================
// KEY ROUTING — translate the app's string keys to the model
// ============================================================
function keyToTarget(key) {
  if (key === "coupons:ready") return { kind: "couponsDeck", deck: "ready" }
  if (key === "coupons:bday") return { kind: "couponsDeck", deck: "bday" }
  if (key === "usage:log") return { kind: "usage" }
  if (key === "chat:messages") return { kind: "chat" }
  if (key === "safezone:index") return { kind: "memIndex" }
  if (key.startsWith("safezone:post:")) return { kind: "memPost", id: key.slice("safezone:post:".length) }
  if (key.startsWith("settings:")) return { kind: "setting", field: key.slice("settings:".length) }
  return { kind: "unknown" }
}

function stripCouponMeta(data) {
  const { deck, order, ...rest } = data
  return rest
}

// ============================================================
// LISTENERS — Firestore -> read cache -> UI
// ============================================================
function rebuildCoupons() {
  const ready = []
  const bday = []
  couponCache.forEach((data) => {
    if (data.deck === "ready") ready.push(data)
    else if (data.deck === "bday") bday.push(data)
  })
  const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0)
  cacheWrite("coupons:ready", ready.sort(byOrder).map(stripCouponMeta))
  cacheWrite("coupons:bday", bday.sort(byOrder).map(stripCouponMeta))
  uiRefresh("coupons:ready")
  uiRefresh("coupons:bday")
}

function rebuildUsage() {
  const arr = [...usageCache.values()].sort(
    (a, b) => new Date(a.timestamp || a.ts || 0) - new Date(b.timestamp || b.ts || 0),
  )
  cacheWrite("usage:log", arr.slice(-USAGE_CAP))
  uiRefresh("usage:log")
}

function rebuildChat() {
  const arr = [...chatCache.values()].sort(
    (a, b) => new Date(a.ts || 0) - new Date(b.ts || 0),
  )
  cacheWrite("chat:messages", arr.slice(-CHAT_CAP))
  uiRefresh("chat:messages")
}

function rebuildSettings() {
  Object.keys(settingsCache).forEach((field) => {
    if (field === "__ts") return
    cacheWrite("settings:" + field, settingsCache[field])
    uiRefresh("settings:" + field)
  })
}

function commentsArray(memId) {
  const map = memCommentsCache.get(memId)
  if (!map) return []
  return [...map.values()].sort((a, b) => new Date(a.ts || 0) - new Date(b.ts || 0))
}

function rebuildMemoryPost(memId) {
  const m = memCache.get(memId)
  if (!m) return
  cacheWrite("safezone:post:" + memId, {
    type: m.type,
    media: m.media ?? null,
    caption: m.caption ?? "",
    ts: m.ts,
    by: m.by,
    byName: m.byName,
    comments: commentsArray(memId),
  })
}

function rebuildMemIndex() {
  const index = [...memCache.values()].map((m) => ({
    id: m.id,
    ts: m.ts,
    type: m.type,
    caption: (m.caption || "").slice(0, 80),
    by: m.by,
    byName: m.byName,
  }))
  cacheWrite("safezone:index", index)
  uiRefresh("safezone:index")
}

function subscribeComments(memId) {
  if (memCommentUnsubs.has(memId)) return
  const unsub = onSnapshot(
    collection(db, "memories", memId, "comments"),
    (snap) => {
      const map = new Map()
      snap.forEach((d) => map.set(d.id, { id: d.id, ...d.data() }))
      memCommentsCache.set(memId, map)
      rebuildMemoryPost(memId)
      uiRefresh("safezone:post:" + memId)
    },
    (err) => console.warn("[kindness-repo] comments listener:", memId, err),
  )
  memCommentUnsubs.set(memId, unsub)
  unsubs.push(unsub)
}

function attachListeners() {
  // Coupons
  unsubs.push(onSnapshot(collection(db, "coupons"), (snap) => {
    couponCache.clear()
    snap.forEach((d) => couponCache.set(d.id, { id: d.id, ...d.data() }))
    rebuildCoupons()
    signalReady("coupons")
  }, (err) => console.warn("[kindness-repo] coupons listener:", err)))

  // Usage log
  unsubs.push(onSnapshot(collection(db, "usage"), (snap) => {
    usageCache.clear()
    snap.forEach((d) => usageCache.set(d.id, { id: d.id, ...d.data() }))
    rebuildUsage()
    signalReady("usage")
  }, (err) => console.warn("[kindness-repo] usage listener:", err)))

  // Chat
  unsubs.push(onSnapshot(collection(db, "chat"), (snap) => {
    chatCache.clear()
    snap.forEach((d) => chatCache.set(d.id, { id: d.id, ...d.data() }))
    rebuildChat()
    signalReady("chat")
  }, (err) => console.warn("[kindness-repo] chat listener:", err)))

  // Settings (single document)
  unsubs.push(onSnapshot(doc(db, "settings", "app"), (snap) => {
    settingsCache = snap.exists() ? snap.data() : {}
    rebuildSettings()
    signalReady("settings")
  }, (err) => console.warn("[kindness-repo] settings listener:", err)))

  // Memories (posts) + per-post comment subcollections
  unsubs.push(onSnapshot(collection(db, "memories"), (snap) => {
    memCache.clear()
    snap.forEach((d) => memCache.set(d.id, { id: d.id, ...d.data() }))
    memCache.forEach((_, id) => subscribeComments(id))
    memCache.forEach((_, id) => rebuildMemoryPost(id))
    rebuildMemIndex()
    signalReady("memories")
  }, (err) => console.warn("[kindness-repo] memories listener:", err)))
}

async function ensureListeners() {
  if (listenersStarted) return listenersPromise
  listenersStarted = true
  listenersPromise = (async () => {
    const user = await authReady
    firestoreReady = !!(user && auth.currentUser)
    if (!firestoreReady) {
      // No cloud access — release the signals so the app falls back to
      // its built-in defaults instead of hanging on "Loading".
      Object.keys(firstSync).forEach(signalReady)
      return
    }
    attachListeners()
  })()
  return listenersPromise
}

function stopListeners() {
  while (unsubs.length) {
    try { unsubs.pop()() } catch (e) {}
  }
  memCommentUnsubs.clear()
  listenersStarted = false
  listenersPromise = null
}

// ============================================================
// WRITES — normalized, minimal-diff
// ============================================================
async function commitChunked(ops) {
  // ops: array of (batch) => void ; Firestore allows 500 writes/batch
  for (let i = 0; i < ops.length; i += 450) {
    const batch = writeBatch(db)
    ops.slice(i, i + 450).forEach((fn) => fn(batch))
    await batch.commit()
  }
}

async function writeCouponsDeck(deck, arr) {
  const ids = new Set()
  const ops = []
  ;(Array.isArray(arr) ? arr : []).forEach((item, index) => {
    if (!item || !item.id) return
    ids.add(item.id)
    ops.push((b) => b.set(doc(db, "coupons", item.id), { ...stripCouponMeta(item), deck, order: index }))
  })
  couponCache.forEach((data, id) => {
    if (data.deck === deck && !ids.has(id)) ops.push((b) => b.delete(doc(db, "coupons", id)))
  })
  await commitChunked(ops)
}

async function upsertDiff(colName, arr, cacheMap) {
  const ops = []
  ;(Array.isArray(arr) ? arr : []).forEach((item) => {
    if (!item || !item.id) return
    const prev = cacheMap.get(item.id)
    if (!prev || JSON.stringify(stripId(prev)) !== JSON.stringify(stripId(item))) {
      ops.push((b) => b.set(doc(db, colName, item.id), item))
    }
  })
  await commitChunked(ops)
}
function stripId(o) { const { id, ...rest } = o; return rest }

async function writeMemIndexDiff(arr) {
  const ops = []
  ;(Array.isArray(arr) ? arr : []).forEach((item) => {
    if (!item || !item.id) return
    if (!memCache.has(item.id)) {
      ops.push((b) => b.set(doc(db, "memories", item.id), {
        id: item.id, ts: item.ts, type: item.type,
        caption: item.caption, by: item.by, byName: item.byName,
      }, { merge: true }))
    }
  })
  await commitChunked(ops)
}

async function writeMemPost(id, post) {
  const { comments, ...rest } = post || {}
  await setDoc(doc(db, "memories", id), { id, ...rest }, { merge: true })
  const list = Array.isArray(comments) ? comments : []
  const ops = list
    .filter((c) => c && c.id)
    .map((c) => (b) => b.set(doc(db, "memories", id, "comments", c.id), c))
  await commitChunked(ops)
}

async function writeSetting(field, value) {
  await setDoc(doc(db, "settings", "app"), { [field]: value }, { merge: true })
}

// ============================================================
// PUBLIC FACADE (same signatures the UI already calls)
// ============================================================
async function sGet(key, shared) {
  // Reads are always served instantly from the live read cache.
  return cacheRead(key)
}

async function sSet(key, value, shared) {
  if (shared === undefined) shared = true

  // Personal / per-device data never leaves this browser.
  if (!shared) { cacheWrite(key, value); return true }

  // Optimistic local update so the current screen reflects the change now.
  cacheWrite(key, value)

  const t = keyToTarget(key)
  try {
    await ensureListeners()
    if (!firestoreReady) return t.kind !== "memPost" // offline: keep the cache copy
    switch (t.kind) {
      case "couponsDeck": await writeCouponsDeck(t.deck, value); break
      case "usage": await upsertDiff("usage", value, usageCache); break
      case "chat": await upsertDiff("chat", value, chatCache); break
      case "memIndex": await writeMemIndexDiff(value); break
      case "memPost": await writeMemPost(t.id, value); break
      case "setting": await writeSetting(t.field, value); break
      default: break
    }
    return true
  } catch (e) {
    console.warn("[kindness-repo] sSet failed:", key, e)
    // memPost failures are surfaced (e.g. media too large); others stay
    // optimistic and the persistent write queue retries automatically.
    return t.kind !== "memPost"
  }
}

async function sDelete(key, shared) {
  if (shared === undefined) shared = true
  cacheDelete(key)
  if (!shared) return
  const t = keyToTarget(key)
  if (!firestoreReady) return
  try {
    if (t.kind === "memPost") await deleteDoc(doc(db, "memories", t.id))
  } catch (e) {}
}

async function seedSharedKey(key, fallback) {
  await ensureListeners()
  const t = keyToTarget(key)

  // Wait (briefly) for the first real read so we don't double-seed.
  const nameByKind = {
    couponsDeck: "coupons", usage: "usage", chat: "chat",
    memIndex: "memories", memPost: "memories", setting: "settings",
  }
  const signalName = nameByKind[t.kind]
  const online = signalName ? await withTimeout(firstSync[signalName].promise, 4000) : false

  if (!firestoreReady || !online) {
    if (cacheRead(key) === null) cacheWrite(key, fallback)
    return
  }

  if (t.kind === "couponsDeck") {
    const hasDeck = [...couponCache.values()].some((c) => c.deck === t.deck)
    if (!hasDeck && Array.isArray(fallback) && fallback.length) {
      cacheWrite(key, fallback)
      await writeCouponsDeck(t.deck, fallback)
    }
  } else if (t.kind === "setting") {
    if (settingsCache[t.field] === undefined) {
      cacheWrite(key, fallback)
      await writeSetting(t.field, fallback)
    }
  } else {
    // usage / chat / memIndex: empty arrays need no remote seeding.
    if (cacheRead(key) === null) cacheWrite(key, fallback)
  }
}

async function pullRemoteKey(key) {
  await ensureListeners()
  const t = keyToTarget(key)
  const nameByKind = {
    couponsDeck: "coupons", usage: "usage", chat: "chat",
    memIndex: "memories", memPost: "memories", setting: "settings",
  }
  const signalName = nameByKind[t.kind]
  if (signalName) await withTimeout(firstSync[signalName].promise, 3000)
  return true
}

function firestoreAvailable() {
  return firestoreReady
}

function startRealtimeSync() { ensureListeners() }
function stopRealtimeSync() { stopListeners() }
function startBackgroundSync() { ensureListeners() }

// ---- expose the facade to the classic inline app script ----
Object.assign(window, {
  sGet,
  sSet,
  sDelete,
  seedSharedKey,
  pullRemoteKey,
  firestoreAvailable,
  startRealtimeSync,
  stopRealtimeSync,
  startBackgroundSync,
})

// Begin syncing as soon as anonymous auth is ready.
ensureListeners()
