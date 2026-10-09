import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import { initializeApp, deleteApp } from 'firebase/app'
import * as firestoreSdk from 'firebase/firestore'
import * as functionsSdk from 'firebase/functions'

const streams = []
mock.module('firebase/firestore', { namedExports: {
  ...firestoreSdk,
  onSnapshot(target, options, next, error) {
    const stream = { target, next: typeof options === 'function' ? options : next,
      error: typeof options === 'function' ? next : error, closed: false }
    streams.push(stream)
    return () => { stream.closed = true }
  },
} })
// Lease recovery has no network in these controlled client-observer regressions.
mock.module('firebase/functions', { namedExports: {
  ...functionsSdk,
  httpsCallable: () => async () => ({ data: { status: 'failed', operationId: 'controlled-recovery' } }),
} })
const { createFirebaseWorkspace } = await import('../src/services/firebaseWorkspace.ts')
const metadata = { fromCache: false, hasPendingWrites: false }
const docSnapshot = data => ({ metadata, exists: () => data !== null, data: () => data })

function fixture(name) {
  streams.length = 0
  const app = initializeApp({ projectId: 'demo-threadline', apiKey: 'emulator-only', appId: 'local-revocation-proof' }, name)
  const db = firestoreSdk.getFirestore(app)
  const uid = 'controlled-reader'
  const roomId = 'controlled-room'
  const port = createFirebaseWorkspace(db, functionsSdk.getFunctions(app, 'asia-southeast1'), { currentUser: { uid } }, { uid, label: 'Reader' })
  const observed = []
  const unsubscribe = port.subscribeConversation(roomId, state => observed.push(state), { upperSeq: 1, limit: 50 })
  const messagesQuery = firestoreSdk.query(firestoreSdk.collection(db, 'rooms', roomId, 'messages'),
    firestoreSdk.where('seq', '<=', 1), firestoreSdk.orderBy('seq', 'desc'), firestoreSdk.limit(50))
  const generationsQuery = firestoreSdk.query(firestoreSdk.collection(db, 'rooms', roomId, 'generations'),
    firestoreSdk.orderBy('startedAt', 'desc'), firestoreSdk.limit(1))
  const queryStream = query => streams.find(stream => stream.target.type === 'query' && firestoreSdk.queryEqual(stream.target, query))
  const documentStream = path => streams.findLast(stream => stream.target.type === 'document' && stream.target.path === path)
  const messages = queryStream(messagesQuery)
  const generation = queryStream(generationsQuery)
  const room = documentStream(`rooms/${roomId}`)
  const messageSnapshot = { metadata, docs: [{ id: 'private-message', data: () => ({ seq: 1, kind: 'human', text: 'Previously authorized private text', version: 1,
    createdAt: firestoreSdk.Timestamp.fromMillis(1), authorId: uid, authorLabel: 'Reader', intent: 'room' }) }] }
  messages.next(messageSnapshot)
  const prompt = id => ({ id, seq: 2, kind: 'human', intent: 'ask-ai', authorId: uid, version: 1, text: 'Synthetic question', deletedAt: null })
  const generationData = (id, promptMessageId, changes = {}) => ({ id, roomId, requesterId: uid, requesterLabel: 'Reader', promptMessageId,
    promptVersion: 1, state: 'failed', expiresAt: Date.now() + 120000, ...changes })
  function publishGeneration(id, promptId, changes = {}) {
    const data = generationData(id, promptId, changes)
    room.next(docSnapshot({ state: 'active', memberIds: [uid], latestGenerationId: id, latestAiPromptId: promptId, activeGenerationId: null }))
    generation.next({ metadata, docs: [{ id, data: () => data }] })
    return documentStream(`rooms/${roomId}/messages/${promptId}`)
  }
  return { uid, roomId, observed, messages, generation, room, messageSnapshot, prompt, publishGeneration,
    async close() { unsubscribe(); port.dispose(); await deleteApp(app) } }
}

for (const denied of ['messages', 'generation', 'room', 'prompt']) {
  test(`revoking ${denied} prevents queued sibling snapshots from restoring private text`, async () => {
    const f = fixture(`revocation-${denied}`)
    try {
      const promptStream = f.publishGeneration('old-generation', 'old-prompt')
      const promptSnapshot = docSnapshot(f.prompt('old-prompt'))
      promptStream.next(promptSnapshot)
      assert.equal(f.observed.at(-1).data.messages[0].text, 'Previously authorized private text')
      const deniedStream = denied === 'prompt' ? promptStream : f[denied]
      deniedStream.error({ code: 'permission-denied' })
      const afterDenial = f.observed.length
      f.messages.next(f.messageSnapshot)
      f.generation.next({ metadata, docs: [] })
      f.room.next(docSnapshot({ state: 'active', memberIds: [f.uid] }))
      promptStream.next(promptSnapshot)
      assert.deepEqual(f.observed.at(-1).data.messages, [])
      assert.equal(f.observed.slice(afterDenial).every(state => !state.data || state.data.messages.length === 0), true)
      assert.equal(streams.every(stream => stream.closed), true)
    } finally { await f.close() }
  })
}

test('a queued old prompt cannot make a deleted newer question eligible for retry outside frozen history', async () => {
  const f = fixture('stale-prompt-target')
  try {
    const oldPrompt = f.publishGeneration('old-generation', 'old-prompt')
    oldPrompt.next(docSnapshot(f.prompt('old-prompt')))
    assert.equal(f.observed.at(-1).data.generation.canRetry, true)
    const newPrompt = f.publishGeneration('new-generation', 'new-prompt')
    newPrompt.next(docSnapshot({ ...f.prompt('new-prompt'), text: '', version: 2, deletedAt: firestoreSdk.Timestamp.fromMillis(1) }))
    assert.equal(f.observed.at(-1).data.generation.canRetry, false)
    oldPrompt.next(docSnapshot(f.prompt('old-prompt')))
    assert.equal(f.observed.at(-1).data.generation.canRetry, false)
    oldPrompt.error({ code: 'permission-denied' })
    assert.equal(f.observed.at(-1).data.messages[0].text, 'Previously authorized private text')
  } finally { await f.close() }
})

test('an expired nonterminal generation is not retryable while independently delivered recovery metadata catches up', async () => {
  const f = fixture('expired-nonterminal')
  try {
    const prompt = f.publishGeneration('expiring-generation', 'original-prompt', { state: 'dispatched', expiresAt: Date.now() - 1 })
    prompt.next(docSnapshot(f.prompt('original-prompt')))
    assert.equal(f.observed.at(-1).data.generation.canRetry, false)
  } finally { await f.close() }
})
