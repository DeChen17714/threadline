import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { initializeApp } from 'firebase-admin/app'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { initializeApp as initializeClientApp, deleteApp } from 'firebase/app'
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth'
import { getFirestore as getClientFirestore, collection, query, where, orderBy, limit, onSnapshot } from 'firebase/firestore'
import { PROJECT_ID, authSignUpUrl, connectTestAuthEmulator, connectTestFirestoreEmulator } from './emulator-test-env.mjs'
const { handleCreateRoom } = await import('../functions/dist/handlers/createRoom.js')
const { handleSendRoomMessage } = await import('../functions/dist/handlers/sendRoomMessage.js')
const { handleEditMessage, handleDeleteMessage } = await import('../functions/dist/handlers/messageMutations.js')
const { handleResumeMaintenance, handleDeleteRoom } = await import('../functions/dist/handlers/maintenance.js')
const { handleGetOperation } = await import('../functions/dist/handlers/getOperation.js')
const { computePayloadHash } = await import('../functions/dist/utils/hash.js')
const { handleAskThreadline, handleRetryAiReply } = await import('../functions/dist/ai/lifecycle.js')
const db = getFirestore(initializeApp({ projectId: PROJECT_ID }, 'mutation-regressions'), 'mutation-regressions')
const credentialsByUid = new Map()

async function account() {
  const credentials = { email: `${randomUUID()}@example.test`, password: randomUUID() }
  const response = await fetch(authSignUpUrl, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...credentials, returnSecureToken: true }),
  })
  if (!response.ok) throw new Error('Isolated Auth emulator required')
  const uid = (await response.json()).localId
  credentialsByUid.set(uid, credentials)
  return uid
}
function createControlledModeration({ verdict = 'allow', onScreen, failScreen } = {}) {
  let screenCalls = 0
  return {
    get screenCalls() { return screenCalls },
    async screen(text, signal) {
      screenCalls++
      if (onScreen) await onScreen(text, signal)
      if (failScreen) throw failScreen
      return {
        verdict,
        policyVersion: 'threadline-moderation-v1',
        reason: verdict === 'block' ? 'policy-blocked' : null,
      }
    },
  }
}
const defaultModeration = createControlledModeration()

async function fixture() {
  const owner = await account(), member = await account(), outsider = await account()
  const { roomId } = await handleCreateRoom(db, owner, 'Owner', randomUUID(), { name: 'Synthetic mutation fixture', description: '' })
  const room = db.collection('rooms').doc(roomId)
  await room.update({ memberIds: FieldValue.arrayUnion(member) })
  const messageId = randomUUID()
  const original = 'Original author text that must not appear in receipts or jobs'
  await handleSendRoomMessage(db, owner, 'Owner', randomUUID(), { roomId, messageId, text: original }, defaultModeration)
  return { owner, member, outsider, roomId, room, messageId, original, message: room.collection('messages').doc(messageId) }
}
const edit = (f, changes = {}, caller = f.owner, requestId = randomUUID(), moderation = defaultModeration) => handleEditMessage(db, caller, requestId,
  { roomId: f.roomId, messageId: f.messageId, expectedVersion: 1, text: 'Revised author text', ...changes }, moderation)
async function finish(f, operationId, caller = f.member) {
  for (let pass = 0; pass < 10; pass++) {
    const result = await handleResumeMaintenance(db, caller, randomUUID(), { operationId })
    if (result.status === 'complete') return result
    assert.equal(result.status, 'pending')
  }
  throw new Error('Bounded fixture maintenance did not finish')
}

test('author edits use optimistic versions, text-free replay and recoverable member-authorized jobs', { timeout: 15000 }, async () => {
  const f = await fixture()
  const requestId = randomUUID()
  const accepted = await edit(f, {}, f.owner, requestId)
  const row = (await f.message.get()).data()
  assert.equal(row.text, 'Revised author text')
  assert.equal(row.version, 2)
  assert.ok(row.editedAt.toMillis() >= row.createdAt.toMillis())
  const jobId = (await f.room.get()).data().maintenanceId
  assert.equal(typeof jobId, 'string')
  const jobBefore = (await db.collection('maintenanceJobs').doc(jobId).get()).data()
  assert.equal(JSON.stringify(jobBefore).includes(f.original), false)
  assert.equal(JSON.stringify(jobBefore).includes('Revised author text'), false)
  const observed = await handleGetOperation(db, f.member, randomUUID(), { operationId: jobId })
  assert.equal(observed.status, 'pending')
  await assert.rejects(handleGetOperation(db, f.outsider, randomUUID(), { operationId: jobId }), error => error?.details?.code === 'forbidden')
  await assert.rejects(handleResumeMaintenance(db, f.outsider, randomUUID(), { operationId: jobId }), error => error?.details?.code === 'forbidden')
  assert.deepEqual((await db.collection('maintenanceJobs').doc(jobId).get()).data(), jobBefore)
  const replay = await edit(f, {}, f.owner, requestId)
  assert.equal(replay.operationId, accepted.operationId)
  assert.equal((await f.message.get()).data().version, 2)
  await assert.rejects(edit(f, { text: 'Different replay text' }, f.owner, requestId), error => error?.details?.code === 'conflict')
  await finish(f, jobId)
  assert.equal((await f.room.get()).data().maintenanceId, null)
  assert.equal((await handleResumeMaintenance(db, f.member, randomUUID(), { operationId: jobId })).status, 'complete')
  await edit(f, { expectedVersion: 2, text: '€'.repeat(4000) })
  assert.equal((await f.message.get()).data().text, '€'.repeat(4000))
  await assert.rejects(edit(f), error => error?.details?.code === 'conflict' || error?.details?.code === 'room-busy')
  const receipts = await db.collection('receipts').where('roomId', '==', f.roomId).get()
  for (const receipt of receipts.docs) {
    assert.equal(JSON.stringify(receipt.data()).includes(f.original), false)
    assert.equal(JSON.stringify(receipt.data()).includes('Revised author text'), false)
  }
})

test('bounded invalidation propagates within and across batches without rewriting unrelated or historical answers', { timeout: 15000 }, async () => {
  const f = await fixture()
  const unrelatedHuman = randomUUID()
  const batch = db.batch()
  batch.create(f.room.collection('messages').doc(unrelatedHuman), { id: unrelatedHuman, roomId: f.roomId, seq: 2,
    kind: 'human', intent: 'room', authorId: f.member, authorLabel: 'Member', text: 'Unrelated context', version: 1, deletedAt: null })
  const chain = []
  let dependency = f.messageId
  for (let index = 0; index < 21; index++) {
    const id = randomUUID()
    chain.push(id)
    batch.create(f.room.collection('messages').doc(id), { id, roomId: f.roomId, seq: index + 3, kind: 'ai', text: `Historical answer ${index}`,
      version: 1, replyToId: index === 0 ? f.messageId : unrelatedHuman, replyToVersion: 1,
      contextState: 'current', contextRefs: [{ id: dependency, version: 1 }], deletedAt: null })
    dependency = id
  }
  const unrelatedAi = randomUUID()
  batch.create(f.room.collection('messages').doc(unrelatedAi), { id: unrelatedAi, roomId: f.roomId, seq: 24, kind: 'ai', text: 'Unrelated historical answer', version: 1,
    replyToId: unrelatedHuman, replyToVersion: 1, contextState: 'current', contextRefs: [{ id: unrelatedHuman, version: 1 }], deletedAt: null })
  batch.update(f.room, { nextSeq: 25 })
  await batch.commit()
  await edit(f)
  const jobId = (await f.room.get()).data().maintenanceId
  const first = await handleResumeMaintenance(db, f.member, randomUUID(), { operationId: jobId })
  assert.equal(first.status, 'pending')
  for (let index = 0; index < 21; index++) {
    const row = (await f.room.collection('messages').doc(chain[index]).get()).data()
    assert.equal(row.contextState, index < 20 ? 'stale' : 'current')
    assert.equal(row.text, `Historical answer ${index}`)
    assert.equal(row.version, 1)
    if (index < 20) assert.equal(row.contextReason, index === 0 ? 'earlier-version' : 'earlier-context-changed')
  }
  // Controlled fixture verifies the captured high-water bound, not a legal send during maintenance.
  const beyondCutoff = randomUUID()
  await f.room.collection('messages').doc(beyondCutoff).set({ id: beyondCutoff, roomId: f.roomId, seq: 25, kind: 'ai', text: 'Outside captured maintenance range', version: 1,
    replyToId: unrelatedHuman, contextState: 'current', contextRefs: [{ id: chain[20], version: 1 }], deletedAt: null })
  await finish(f, jobId)
  assert.equal((await f.room.collection('messages').doc(chain[20]).get()).data().contextState, 'stale')
  assert.equal((await f.room.collection('messages').doc(unrelatedAi).get()).data().contextState, 'current')
  assert.equal((await f.room.collection('messages').doc(unrelatedAi).get()).data().text, 'Unrelated historical answer')
  assert.equal((await f.room.collection('messages').doc(beyondCutoff).get()).data().contextState, 'current')
  const fresh = randomUUID()
  await f.room.collection('messages').doc(fresh).set({ id: fresh, roomId: f.roomId, seq: 26, kind: 'ai', text: 'Fresh answer on corrected context', version: 1,
    replyToId: f.messageId, replyToVersion: 2, contextState: 'current', contextRefs: [{ id: f.messageId, version: 2 }], deletedAt: null })
  await handleResumeMaintenance(db, f.member, randomUUID(), { operationId: jobId })
  assert.equal((await f.room.collection('messages').doc(fresh).get()).data().contextState, 'current')
})

test('foreign, AI, deleted, oversized, conflicting and active-inference edits cannot mutate text', { timeout: 15000 }, async () => {
  for (const reason of ['foreign', 'ai', 'deleted', 'version', 'blank', 'chars', 'active-inference']) {
    const f = await fixture()
    let changes = {}, caller = f.owner
    if (reason === 'foreign') caller = f.member
    else if (reason === 'ai') await f.message.update({ kind: 'ai' })
    else if (reason === 'deleted') await f.message.update({ text: '', deletedAt: FieldValue.serverTimestamp() })
    else if (reason === 'version') changes = { expectedVersion: 2 }
    else if (reason === 'blank') changes = { text: ' \n ' }
    else if (reason === 'chars') changes = { text: 'a'.repeat(4001) }
    else await f.room.update({ activeGenerationId: randomUUID() })
    const before = (await f.message.get()).data()
    await assert.rejects(edit(f, changes, caller), undefined, reason)
    assert.deepEqual((await f.message.get()).data(), before, reason)
    assert.equal((await db.collection('maintenanceJobs').where('roomId', '==', f.roomId).get()).size, 0)
  }
})

test('concurrent edits serialize once and context maintenance pauses new sends, Ask and retry', { timeout: 15000 }, async () => {
  const f = await fixture()
  const outcomes = await Promise.allSettled([edit(f), edit(f, { text: 'Competing revision' })])
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1)
  assert.equal((await f.message.get()).data().version, 2)
  await assert.rejects(handleSendRoomMessage(db, f.member, 'Member', randomUUID(),
    { roomId: f.roomId, messageId: randomUUID(), text: 'Must wait for maintenance' }, defaultModeration), error => error?.details?.code === 'room-busy')
  const provider = { async count() { throw new Error('No provider work permitted') }, async generate() { throw new Error('No provider work permitted') } }
  await assert.rejects(handleAskThreadline(db, f.owner, 'Owner', randomUUID(),
    { roomId: f.roomId, messageId: randomUUID(), text: 'Must wait for maintenance' }, { localDevelopment: true, testerUids: [] }, provider, defaultModeration), error => error?.details?.code === 'room-busy')
  await assert.rejects(handleRetryAiReply(db, f.owner, 'Owner', randomUUID(),
    { roomId: f.roomId, promptMessageId: f.messageId, generationId: randomUUID() }, { localDevelopment: true, testerUids: [] }, provider, defaultModeration), error => error?.details?.code === 'room-busy')
})

test('room deletion preempts context maintenance and superseded workers cannot write transcript state', { timeout: 15000 }, async () => {
  const f = await fixture()
  const aiId = randomUUID()
  await f.room.collection('messages').doc(aiId).set({ id: aiId, roomId: f.roomId, seq: 2, kind: 'ai', text: 'Historical answer before preemption', version: 1,
    replyToId: f.messageId, contextState: 'current', contextRefs: [{ id: f.messageId, version: 1 }], deletedAt: null })
  await f.room.update({ nextSeq: 3 })
  await edit(f)
  const oldJobId = (await f.room.get()).data().maintenanceId
  await handleDeleteRoom(db, f.owner, randomUUID(), { roomId: f.roomId })
  assert.equal((await db.collection('maintenanceJobs').doc(oldJobId).get()).data().status, 'cancelled')
  const before = (await f.room.collection('messages').doc(aiId).get()).data()
  try { await handleResumeMaintenance(db, f.member, randomUUID(), { operationId: oldJobId }) } catch (error) {
    assert.ok(['forbidden', 'conflict', 'room-busy'].includes(error?.details?.code))
  }
  assert.deepEqual((await f.room.collection('messages').doc(aiId).get()).data(), before)
  assert.equal((await f.room.get()).data().state, 'deleting')
})

test('separate messages never reuse a maintenance fence and completed workers cannot advance the next edit', { timeout: 15000 }, async () => {
  const f = await fixture()
  const otherMessageId = randomUUID()
  await handleSendRoomMessage(db, f.owner, 'Owner', randomUUID(),
    { roomId: f.roomId, messageId: otherMessageId, text: 'Second owned message' }, defaultModeration)
  await edit(f)
  const oldJob = (await f.room.get()).data().maintenanceId
  await finish(f, oldJob)
  await edit(f, { messageId: otherMessageId })
  const currentJob = (await f.room.get()).data().maintenanceId
  assert.notEqual(currentJob, oldJob)
  const before = (await db.collection('maintenanceJobs').doc(currentJob).get()).data()
  assert.equal((await handleResumeMaintenance(db, f.member, randomUUID(), { operationId: oldJob })).status, 'complete')
  assert.deepEqual((await db.collection('maintenanceJobs').doc(currentJob).get()).data(), before)
  assert.equal((await f.room.get()).data().maintenanceId, currentJob)
})

test('a transient batch failure leaves a recoverable context fence for another current member', { timeout: 15000 }, async () => {
  const f = await fixture()
  await edit(f)
  const operationId = (await f.room.get()).data().maintenanceId
  let interrupt = true
  const interruptedDb = new Proxy(db, { get(target, property) {
    if (property === 'runTransaction') return async (...args) => {
      if (interrupt) { interrupt = false; throw new Error('Controlled transient database transport interruption') }
      return target.runTransaction(...args)
    }
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  await assert.rejects(handleResumeMaintenance(interruptedDb, f.owner, randomUUID(), { operationId }))
  assert.equal((await f.room.get()).data().maintenanceId, operationId)
  assert.equal((await handleResumeMaintenance(db, f.member, randomUUID(), { operationId })).status, 'complete')
  assert.equal((await f.room.get()).data().maintenanceId, null)
})


test('author deletion erases text but preserves identity and relabels already-stale direct answers', { timeout: 15000 }, async () => {
  const f = await fixture()
  const directId = randomUUID(), indirectId = randomUUID(), unaffectedId = randomUUID()
  const batch = db.batch()
  batch.create(f.room.collection('messages').doc(directId), { id: directId, roomId: f.roomId, seq: 2, kind: 'ai', text: 'Unchanged original answer', version: 1,
    replyToId: f.messageId, replyToVersion: 1, contextState: 'current', contextRefs: [{ id: f.messageId, version: 1 }], deletedAt: null })
  batch.create(f.room.collection('messages').doc(indirectId), { id: indirectId, roomId: f.roomId, seq: 3, kind: 'ai', text: 'Unchanged downstream answer', version: 1,
    replyToId: unaffectedId, contextState: 'current', contextRefs: [{ id: directId, version: 1 }], deletedAt: null })
  batch.create(f.room.collection('messages').doc(unaffectedId), { id: unaffectedId, roomId: f.roomId, seq: 4, kind: 'human', authorId: f.member,
    authorLabel: 'Member', intent: 'room', text: 'Another member keeps this text', version: 1, deletedAt: null })
  batch.update(f.room, { nextSeq: 5 })
  await batch.commit()
  await edit(f)
  await finish(f, (await f.room.get()).data().maintenanceId)
  assert.equal((await f.room.collection('messages').doc(directId).get()).data().contextReason, 'earlier-version')
  const before = (await f.message.get()).data()
  const requestId = randomUUID()
  const input = { roomId: f.roomId, messageId: f.messageId, expectedVersion: 2 }
  const deleted = await handleDeleteMessage(db, f.owner, requestId, input)
  const tombstone = (await f.message.get()).data()
  assert.equal(tombstone.text, '')
  assert.equal(tombstone.version, 3)
  assert.ok(tombstone.deletedAt.toMillis() >= before.createdAt.toMillis())
  for (const key of ['id', 'roomId', 'seq', 'authorId', 'authorLabel', 'intent', 'createdAt', 'editedAt']) assert.deepEqual(tombstone[key], before[key])
  assert.equal((await f.room.get()).data().nextSeq, 5)
  const jobId = (await f.room.get()).data().maintenanceId
  await finish(f, jobId)
  const direct = (await f.room.collection('messages').doc(directId).get()).data()
  const indirect = (await f.room.collection('messages').doc(indirectId).get()).data()
  assert.equal(direct.contextReason, 'deleted-message')
  assert.equal(direct.text, 'Unchanged original answer')
  assert.equal(direct.version, 1)
  assert.equal(indirect.contextReason, 'earlier-context-changed')
  assert.equal(indirect.text, 'Unchanged downstream answer')
  assert.equal((await f.room.collection('messages').doc(unaffectedId).get()).data().text, 'Another member keeps this text')
  assert.equal((await handleDeleteMessage(db, f.owner, requestId, input)).operationId, deleted.operationId)
  assert.equal((await f.message.get()).data().version, 3)
  await assert.rejects(handleDeleteMessage(db, f.owner, randomUUID(), input))
  for (const group of ['receipts', 'maintenanceJobs']) {
    const records = await db.collection(group).where('roomId', '==', f.roomId).get()
    for (const record of records.docs) {
      assert.equal(JSON.stringify(record.data()).includes(f.original), false)
      assert.equal(JSON.stringify(record.data()).includes('Revised author text'), false)
    }
  }
})

test('foreign, AI, active-generation, maintenance and stale-version deletion attempts leave the message intact', { timeout: 15000 }, async () => {
  for (const reason of ['foreign', 'ai', 'active-generation', 'maintenance', 'version']) {
    const f = await fixture()
    let caller = f.owner, expectedVersion = 1
    if (reason === 'foreign') caller = f.member
    else if (reason === 'ai') await f.message.update({ kind: 'ai' })
    else if (reason === 'active-generation') await f.room.update({ activeGenerationId: randomUUID() })
    else if (reason === 'maintenance') await f.room.update({ maintenanceId: randomUUID() })
    else expectedVersion = 2
    const before = (await f.message.get()).data()
    await assert.rejects(handleDeleteMessage(db, caller, randomUUID(), { roomId: f.roomId, messageId: f.messageId, expectedVersion }))
    assert.deepEqual((await f.message.get()).data(), before, reason)
  }
})

test('an authenticated frozen realtime window receives the command tombstone rather than evicting its identity', { timeout: 15000 }, async () => {
  const f = await fixture()
  const app = initializeClientApp({ projectId: PROJECT_ID, apiKey: 'emulator-only', appId: 'frozen-tombstone-proof' }, `frozen-${randomUUID()}`)
  const auth = getAuth(app)
  connectTestAuthEmulator(auth)
  const clientDb = getClientFirestore(app, 'mutation-regressions')
  connectTestFirestoreEmulator(clientDb)
  const credentials = credentialsByUid.get(f.owner)
  await signInWithEmailAndPassword(auth, credentials.email, credentials.password)
  const initial = Promise.withResolvers(), updated = Promise.withResolvers()
  const unsubscribe = onSnapshot(query(collection(clientDb, 'rooms', f.roomId, 'messages'),
    where('seq', '<=', 1), orderBy('seq', 'desc'), limit(50)), { includeMetadataChanges: true }, snapshot => {
      if (snapshot.metadata.fromCache || snapshot.metadata.hasPendingWrites) return
      const rows = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }))
      if (rows[0]?.deletedAt) updated.resolve(rows)
      else initial.resolve(rows)
    }, error => { initial.reject(error); updated.reject(error) })
  try {
    assert.equal((await initial.promise)[0].text, f.original)
    await handleDeleteMessage(db, f.owner, randomUUID(), { roomId: f.roomId, messageId: f.messageId, expectedVersion: 1 })
    const rows = await updated.promise
    assert.deepEqual(rows.map(row => ({ id: row.id, seq: row.seq, text: row.text, version: row.version })), [
      { id: f.messageId, seq: 1, text: '', version: 2 },
    ])
  } finally {
    unsubscribe()
    await deleteApp(app)
  }
})

test('deletion resumes after failure between bounded batches and a failed job is cancelled by room deletion', { timeout: 15000 }, async () => {
  const f = await fixture(), chain = Array.from({ length: 21 }, () => randomUUID())
  const batch = db.batch()
  for (let index = 0; index < chain.length; index++) {
    batch.create(f.room.collection('messages').doc(chain[index]), { id: chain[index], roomId: f.roomId, seq: index + 2,
      kind: 'ai', text: `Historical delete-chain answer ${index}`, version: 1, replyToId: index === 0 ? f.messageId : chain[index - 1],
      contextState: 'current', contextRefs: [{ id: index === 0 ? f.messageId : chain[index - 1], version: 1 }], deletedAt: null })
  }
  batch.update(f.room, { nextSeq: 23 })
  await batch.commit()
  await handleDeleteMessage(db, f.owner, randomUUID(), { roomId: f.roomId, messageId: f.messageId, expectedVersion: 1 })
  const operationId = (await f.room.get()).data().maintenanceId
  assert.equal((await handleResumeMaintenance(db, f.owner, randomUUID(), { operationId })).status, 'pending')
  assert.equal((await f.room.collection('messages').doc(chain[19]).get()).data().contextState, 'stale')
  assert.equal((await f.room.collection('messages').doc(chain[20]).get()).data().contextState, 'current')
  let interrupt = true
  const interruptedDb = new Proxy(db, { get(target, property) {
    if (property === 'runTransaction') return async (...args) => {
      if (interrupt) { interrupt = false; throw new Error('Controlled transient transport interruption between delete batches') }
      return target.runTransaction(...args)
    }
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  await assert.rejects(handleResumeMaintenance(interruptedDb, f.owner, randomUUID(), { operationId }))
  assert.equal((await db.collection('maintenanceJobs').doc(operationId).get()).data().status, 'failed')
  await finish(f, operationId)
  assert.equal((await f.room.collection('messages').doc(chain[0]).get()).data().contextReason, 'deleted-message')
  assert.equal((await f.room.collection('messages').doc(chain[20]).get()).data().contextReason, 'earlier-context-changed')
  assert.equal((await f.room.collection('messages').doc(chain[20]).get()).data().text, 'Historical delete-chain answer 20')

  const preempted = await fixture()
  await handleDeleteMessage(db, preempted.owner, randomUUID(), { roomId: preempted.roomId, messageId: preempted.messageId, expectedVersion: 1 })
  const failedJob = (await preempted.room.get()).data().maintenanceId
  interrupt = true
  await assert.rejects(handleResumeMaintenance(interruptedDb, preempted.owner, randomUUID(), { operationId: failedJob }))
  await handleDeleteRoom(db, preempted.owner, randomUUID(), { roomId: preempted.roomId })
  assert.equal((await db.collection('maintenanceJobs').doc(failedJob).get()).data().status, 'cancelled')
})

test('human send moderation: blocking, unavailable, unknown/exception and zero rate-limit consumption', { timeout: 15000 }, async () => {
  const f = await fixture()
  const blockedMod = createControlledModeration({ verdict: 'block' })
  const unavailableMod = createControlledModeration({ verdict: 'unavailable' })
  const throwingMod = createControlledModeration({ failScreen: new Error('Network failure to moderation service') })

  // 1. Blocked send throws screening-blocked and writes no message
  const blockedMessageId = randomUUID()
  await assert.rejects(
    handleSendRoomMessage(db, f.member, 'Member', randomUUID(), { roomId: f.roomId, messageId: blockedMessageId, text: 'Harmful content' }, blockedMod),
    error => error?.code === 'failed-precondition' && error?.details?.code === 'screening-blocked'
  )
  assert.equal((await f.room.collection('messages').doc(blockedMessageId).get()).exists, false)
  assert.equal(blockedMod.screenCalls, 1)

  // 2. Unavailable send throws screening-unavailable and writes no message
  const unavailMessageId = randomUUID()
  await assert.rejects(
    handleSendRoomMessage(db, f.member, 'Member', randomUUID(), { roomId: f.roomId, messageId: unavailMessageId, text: 'Neutral text' }, unavailableMod),
    error => error?.code === 'unavailable' && error?.details?.code === 'screening-unavailable'
  )
  assert.equal((await f.room.collection('messages').doc(unavailMessageId).get()).exists, false)

  // 3. Throwing moderation treated as screening-unavailable
  const throwingMessageId = randomUUID()
  await assert.rejects(
    handleSendRoomMessage(db, f.member, 'Member', randomUUID(), { roomId: f.roomId, messageId: throwingMessageId, text: 'Neutral text' }, throwingMod),
    error => error?.code === 'unavailable' && error?.details?.code === 'screening-unavailable'
  )
  assert.equal((await f.room.collection('messages').doc(throwingMessageId).get()).exists, false)

  // 4. Rate limit bucket was not incremented for blocked or unavailable sends
  const bucket = (await db.collection('quotaBuckets').doc(`sendRoomMessage_${f.member}`).get()).data()
  assert.equal(bucket?.count ?? 0, 0)
})

test('human edit moderation: blocking preserves prior text, duplicate returns pending, and expired claims fail closed', { timeout: 15000 }, async () => {
  const f = await fixture()
  const blockedMod = createControlledModeration({ verdict: 'block' })
  const unavailMod = createControlledModeration({ verdict: 'unavailable' })

  // 1. Blocked edit preserves prior approved text and version, creates no invalidation job
  await assert.rejects(
    edit(f, { text: 'Blocked replacement text' }, f.owner, randomUUID(), blockedMod),
    error => error?.code === 'failed-precondition' && error?.details?.code === 'screening-blocked'
  )
  const msgAfterBlock = (await f.message.get()).data()
  assert.equal(msgAfterBlock.text, f.original)
  assert.equal(msgAfterBlock.version, 1)
  assert.equal((await db.collection('maintenanceJobs').where('roomId', '==', f.roomId).get()).size, 0)

  // 2. Unavailable edit preserves prior approved text
  await assert.rejects(
    edit(f, { text: 'Unavailable replacement text' }, f.owner, randomUUID(), unavailMod),
    error => error?.code === 'unavailable' && error?.details?.code === 'screening-unavailable'
  )
  assert.equal((await f.message.get()).data().text, f.original)

  // 3. Duplicate in-flight edit returns pending without second screen
  let releaseScreen
  const screenEntered = new Promise(resolve => { releaseScreen = resolve })
  const slowMod = createControlledModeration({
    onScreen: async () => {
      await screenEntered
    },
  })
  const editRequestId = randomUUID()
  const inFlightEdit = edit(f, { text: 'Pending replacement text' }, f.owner, editRequestId, slowMod)

  // Wait for submission claim to be established
  const submissionId = `${f.owner}_editMessage_${editRequestId}`
  let subDoc
  for (let i = 0; i < 20; i++) {
    subDoc = await db.collection('submissions').doc(submissionId).get()
    if (subDoc.exists) break
    await new Promise(r => setTimeout(r, 50))
  }
  assert.equal(subDoc.exists, true)
  assert.equal(subDoc.data().state, 'pending')
  // No raw text in submission document
  assert.equal(JSON.stringify(subDoc.data()).includes('Pending replacement text'), false)

  // Duplicate call with same requestId returns pending without second screen
  const duplicate = await edit(f, { text: 'Pending replacement text' }, f.owner, editRequestId, slowMod)
  assert.equal(duplicate.status, 'pending')
  assert.equal(duplicate.operationId, submissionId)
  assert.equal(slowMod.screenCalls, 1)

  // getOperation on own pending claim returns pending without text
  const opStatus = await handleGetOperation(db, f.owner, randomUUID(), { operationId: submissionId })
  assert.equal(opStatus.status, 'pending')
  assert.equal(JSON.stringify(opStatus).includes('Pending replacement text'), false)

  // getOperation on pending claim by outsider throws forbidden
  await assert.rejects(
    handleGetOperation(db, f.outsider, randomUUID(), { operationId: submissionId }),
    error => error?.details?.code === 'forbidden'
  )

  // Release the in-flight screening
  releaseScreen()
  const completedEdit = await inFlightEdit
  assert.equal(completedEdit.status, 'complete')
  assert.equal((await f.message.get()).data().text, 'Pending replacement text')
  assert.equal((await f.message.get()).data().version, 2)

  // 4. Crashed claim expires fail-closed, never redispatches
  const crashedRequestId = randomUUID()
  const crashedSubmissionId = `${f.owner}_editMessage_${crashedRequestId}`
  // Seed a crashed submission whose lease has already expired
  await db.collection('submissions').doc(crashedSubmissionId).set({
    id: crashedSubmissionId,
    operation: 'editMessage',
    callerUid: f.owner,
    roomId: f.roomId,
    messageId: f.messageId,
    expectedVersion: 2,
    payloadHash: computePayloadHash({ roomId: f.roomId, messageId: f.messageId, expectedVersion: 2, text: 'Crashed revision retry' }),
    state: 'pending',
    leaseExpiresAt: Date.now() - 1000,
  })

  // getOperation marks expired claim as failed screening-unavailable
  const expiredOp = await handleGetOperation(db, f.owner, randomUUID(), { operationId: crashedSubmissionId })
  assert.equal(expiredOp.status, 'failed')
  assert.equal(expiredOp.errorCode, 'screening-unavailable')
  assert.equal((await db.collection('submissions').doc(crashedSubmissionId).get()).exists, false)
  assert.equal((await db.collection('receipts').doc(crashedSubmissionId).get()).data().status, 'failed')

  // Duplicate invocation with the crashed requestId fails closed and never reclaims
  await assert.rejects(
    edit(f, { expectedVersion: 2, text: 'Crashed revision retry' }, f.owner, crashedRequestId, slowMod),
    error => error?.details?.code === 'screening-unavailable'
  )
})

test('room deletion purges room submissions and late publication cannot revive deleted room', { timeout: 15000 }, async () => {
  const f = await fixture()
  const sendRequestId = randomUUID()
  const submissionId = `${f.member}_sendRoomMessage_${sendRequestId}`

  // Seed a pending submission in the room
  await db.collection('submissions').doc(submissionId).set({
    id: submissionId,
    operation: 'sendRoomMessage',
    callerUid: f.member,
    roomId: f.roomId,
    messageId: randomUUID(),
    payloadHash: 'synthetic-hash',
    state: 'pending',
    leaseExpiresAt: Date.now() + 30000,
  })

  // Delete the room
  await handleDeleteRoom(db, f.owner, randomUUID(), { roomId: f.roomId })
  const jobId = `${f.owner}_deleteRoom_${f.roomId}`

  // Finish room deletion maintenance passes
  let deleteRes
  for (let pass = 0; pass < 10; pass++) {
    deleteRes = await handleResumeMaintenance(db, f.owner, randomUUID(), { operationId: jobId })
    if (deleteRes.status === 'complete') break
  }
  assert.equal(deleteRes.status, 'complete')

  // Submissions for this room were drained!
  const drained = await db.collection('submissions').doc(submissionId).get()
  assert.equal(drained.exists, false)

  // Late send attempt cannot publish or revive room
  await assert.rejects(
    handleSendRoomMessage(db, f.member, 'Member', randomUUID(), { roomId: f.roomId, messageId: randomUUID(), text: 'Late send' }, defaultModeration),
    error => error?.details?.code === 'forbidden'
  )
  assert.equal((await f.room.get()).exists, false)
})

for (const operation of ['sendRoomMessage', 'editMessage']) {
  test(`${operation}: expired late allow commits terminal failure and cannot be reclaimed`, { timeout: 15000 }, async () => {
    const f = await fixture(), requestId = randomUUID()
    const operationId = `${f.owner}_${operation}_${requestId}`
    const messageId = operation === 'editMessage' ? f.messageId : randomUUID()
    const input = { roomId: f.roomId, messageId, text: 'Lease-bound approved text',
      ...(operation === 'editMessage' ? { expectedVersion: 1 } : {}) }
    const moderation = createControlledModeration({ onScreen: async () => {
      await db.collection('submissions').doc(operationId).update({ leaseExpiresAt: Date.now() - 1 })
    } })
    const invoke = () => operation === 'editMessage'
      ? handleEditMessage(db, f.owner, requestId, input, moderation)
      : handleSendRoomMessage(db, f.owner, 'Owner', requestId, input, moderation)
    await assert.rejects(invoke(), error => error?.details?.code === 'screening-unavailable')
    assert.equal((await db.collection('receipts').doc(operationId).get()).data().status, 'failed')
    assert.equal((await db.collection('submissions').doc(operationId).get()).exists, false)
    await assert.rejects(invoke(), error => error?.details?.code === 'screening-unavailable')
    assert.equal(moderation.screenCalls, 1)
    assert.equal((await handleGetOperation(db, f.owner, randomUUID(), { operationId })).errorCode, 'screening-unavailable')
    const message = await f.room.collection('messages').doc(messageId).get()
    if (operation === 'editMessage') {
      assert.equal(message.data().text, f.original)
      assert.equal(message.data().version, 1)
      assert.equal((await f.room.get()).data().maintenanceId ?? null, null)
    } else assert.equal(message.exists, false)
  })

  test(`${operation}: revoked pending duplicate and status lookup are denied before replay`, { timeout: 15000 }, async () => {
    const f = await fixture(), requestId = randomUUID()
    const entered = Promise.withResolvers(), release = Promise.withResolvers()
    const operationId = `${f.owner}_${operation}_${requestId}`
    const input = { roomId: f.roomId, messageId: operation === 'editMessage' ? f.messageId : randomUUID(),
      text: 'Must not publish after revocation', ...(operation === 'editMessage' ? { expectedVersion: 1 } : {}) }
    const moderation = createControlledModeration({ onScreen: async () => { entered.resolve(); await release.promise } })
    const invoke = () => operation === 'editMessage'
      ? handleEditMessage(db, f.owner, requestId, input, moderation)
      : handleSendRoomMessage(db, f.owner, 'Owner', requestId, input, moderation)
    const work = invoke()
    const rejected = assert.rejects(work, error => error?.details?.code === 'forbidden')
    try {
      await entered.promise
      await f.room.update({ memberIds: FieldValue.arrayRemove(f.owner) })
      await assert.rejects(invoke(), error => error?.details?.code === 'forbidden')
      await assert.rejects(handleGetOperation(db, f.owner, randomUUID(), { operationId }), error => error?.details?.code === 'forbidden')
    } finally { release.resolve() }
    await rejected
    assert.equal(moderation.screenCalls, 1)
    assert.equal((await db.collection('submissions').doc(operationId).get()).exists, false)
    if (operation === 'editMessage') assert.equal((await f.message.get()).data().version, 1)
    else assert.equal((await f.room.collection('messages').doc(input.messageId).get()).exists, false)
  })
}

for (const verdict of ['allow', 'block', 'unavailable']) {
  test(`room deletion during ${verdict} screening cannot recreate private metadata or publish`, { timeout: 15000 }, async () => {
    const f = await fixture(), requestId = randomUUID(), messageId = randomUUID()
    const operationId = `${f.member}_sendRoomMessage_${requestId}`
    const entered = Promise.withResolvers(), release = Promise.withResolvers()
    const moderation = createControlledModeration({ verdict, onScreen: async () => { entered.resolve(); await release.promise } })
    const work = handleSendRoomMessage(db, f.member, 'Member', requestId,
      { roomId: f.roomId, messageId, text: 'Deleted while screening' }, moderation)
    const rejected = assert.rejects(work, error => error?.details?.code === 'forbidden')
    try {
      await entered.promise
      const deletion = await handleDeleteRoom(db, f.owner, randomUUID(), { roomId: f.roomId })
      await finish(f, deletion.operationId, f.owner)
    } finally { release.resolve() }
    await rejected
    assert.equal((await f.room.get()).exists, false)
    assert.equal((await db.collection('submissions').doc(operationId).get()).exists, false)
    assert.equal((await db.collection('receipts').doc(operationId).get()).exists, false)
    assert.equal((await f.room.collection('messages').doc(messageId).get()).exists, false)
  })
}

test('concurrent status queries and duplicate sends preserve one-screen durable success', { timeout: 15000 }, async () => {
  const f = await fixture(), requestId = randomUUID()
  const input = { roomId: f.roomId, messageId: randomUUID(), text: 'One screened publication' }
  const operationId = `${f.member}_sendRoomMessage_${requestId}`
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const moderation = createControlledModeration({ onScreen: async () => { entered.resolve(); await release.promise } })
  const invoke = () => handleSendRoomMessage(db, f.member, 'Member', requestId, input, moderation)
  const work = invoke()
  await entered.promise
  assert.equal((await invoke()).status, 'pending')
  const queries = Array.from({ length: 8 }, () => handleGetOperation(db, f.member, randomUUID(), { operationId }))
  release.resolve()
  const [accepted, ...statuses] = await Promise.all([work, ...queries])
  assert.equal(accepted.status, 'complete')
  assert.ok(statuses.every(result => result.status === 'pending' || result.status === 'complete'))
  assert.equal((await invoke()).seq, accepted.seq)
  assert.equal((await handleGetOperation(db, f.member, randomUUID(), { operationId })).status, 'complete')
  assert.equal((await db.collection('receipts').doc(operationId).get()).data().status, 'complete')
  assert.equal((await db.collection('submissions').doc(operationId).get()).exists, false)
  assert.equal(moderation.screenCalls, 1)
  assert.equal((await db.collection('quotaBuckets').doc(`sendRoomMessage_${f.member}`).get()).data().count, 1)
})

test('expired status settlement racing late publication remains failed without re-creation', { timeout: 15000 }, async () => {
  const f = await fixture(), requestId = randomUUID(), messageId = randomUUID()
  const operationId = `${f.member}_sendRoomMessage_${requestId}`
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const moderation = createControlledModeration({ onScreen: async () => { entered.resolve(); await release.promise } })
  const work = handleSendRoomMessage(db, f.member, 'Member', requestId, { roomId: f.roomId, messageId, text: 'Too late' }, moderation)
  const rejected = assert.rejects(work, error => error?.details?.code === 'screening-unavailable')
  await entered.promise
  await db.collection('submissions').doc(operationId).update({ leaseExpiresAt: Date.now() - 1 })
  const status = handleGetOperation(db, f.member, randomUUID(), { operationId })
  release.resolve()
  await rejected
  assert.equal((await status).status, 'failed')
  assert.equal((await db.collection('receipts').doc(operationId).get()).data().status, 'failed')
  assert.equal((await db.collection('submissions').doc(operationId).get()).exists, false)
  assert.equal((await f.room.collection('messages').doc(messageId).get()).exists, false)
})

for (const mutation of ['version', 'maintenance']) {
  test(`post-screen edit ${mutation} conflict settles once without overwriting approved text`, { timeout: 15000 }, async () => {
    const f = await fixture(), requestId = randomUUID()
    const operationId = `${f.owner}_editMessage_${requestId}`
    const moderation = createControlledModeration({ onScreen: async () => {
      if (mutation === 'version') await f.message.update({ version: 2, text: 'A different accepted edit' })
      else await f.room.update({ maintenanceId: 'controlled-maintenance' })
    } })
    await assert.rejects(edit(f, {}, f.owner, requestId, moderation),
      error => error?.details?.code === (mutation === 'version' ? 'conflict' : 'room-busy'))
    assert.equal((await f.message.get()).data().text, mutation === 'version' ? 'A different accepted edit' : f.original)
    assert.equal((await db.collection('submissions').doc(operationId).get()).exists, false)
    const status = await handleGetOperation(db, f.owner, randomUUID(), { operationId })
    assert.equal(status.status, 'failed')
    assert.equal(status.version, undefined)
    await assert.rejects(edit(f, {}, f.owner, requestId, moderation), error => error?.details?.code === 'screening-unavailable')
    assert.equal(moderation.screenCalls, 1)
  })
}

test('missing or malformed submission metadata never reports complete or admits another screen', { timeout: 15000 }, async () => {
  const f = await fixture()
  for (const state of ['consumed', 'unexpected', null]) {
    const requestId = randomUUID(), operationId = `${f.owner}_sendRoomMessage_${requestId}`
    const input = { roomId: f.roomId, messageId: randomUUID(), text: 'Unknown claim must not publish' }
    await db.collection('submissions').doc(operationId).set({
      id: operationId, operation: 'sendRoomMessage', callerUid: f.owner, roomId: f.roomId,
      messageId: input.messageId, payloadHash: computePayloadHash(input), state, leaseExpiresAt: Date.now() + 30000,
    })
    const moderation = createControlledModeration()
    await assert.rejects(handleGetOperation(db, f.owner, randomUUID(), { operationId }), error => error?.details?.code === 'conflict')
    await assert.rejects(handleSendRoomMessage(db, f.owner, 'Owner', requestId, input, moderation),
      error => error?.details?.code === 'screening-unavailable')
    assert.equal(moderation.screenCalls, 0)
    assert.equal((await f.room.collection('messages').doc(input.messageId).get()).exists, false)
  }
  const requestId = randomUUID(), operationId = `${f.owner}_sendRoomMessage_${requestId}`
  const input = { roomId: f.roomId, messageId: randomUUID(), text: 'A claim without an expiry is unsafe' }
  await db.collection('submissions').doc(operationId).set({
    id: operationId, operation: 'sendRoomMessage', callerUid: f.owner, roomId: f.roomId,
    messageId: input.messageId, payloadHash: computePayloadHash(input), state: 'pending',
  })
  assert.equal((await handleGetOperation(db, f.owner, randomUUID(), { operationId })).status, 'failed')
  const moderation = createControlledModeration()
  await assert.rejects(handleSendRoomMessage(db, f.owner, 'Owner', requestId, input, moderation),
    error => error?.details?.code === 'screening-unavailable')
  assert.equal(moderation.screenCalls, 0)
  await assert.rejects(handleGetOperation(db, f.owner, randomUUID(), { operationId: randomUUID() }),
    error => error?.details?.code === 'missing')
})

test('pending Ask and Retry operation lookups enforce current hosted allowlist before expiration', { timeout: 15000 }, async () => {
  const f = await fixture()
  for (const operation of ['askThreadline', 'retryAiReply']) {
    const operationId = `${f.owner}_${operation}_${randomUUID()}`
    const claim = db.collection('submissions').doc(operationId)
    await claim.set({ id: operationId, operation, callerUid: f.owner, roomId: f.roomId,
      messageId: f.messageId, payloadHash: 'controlled-private-hash', state: 'pending', leaseExpiresAt: Date.now() - 1 })
    const emulator = process.env.FUNCTIONS_EMULATOR, testers = process.env.AI_TESTER_UIDS
    try {
      process.env.FUNCTIONS_EMULATOR = 'false'
      process.env.AI_TESTER_UIDS = ''
      await assert.rejects(handleGetOperation(db, f.owner, randomUUID(), { operationId }),
        error => error?.details?.code === 'forbidden')
      assert.equal((await claim.get()).data().state, 'pending')
      assert.equal((await db.collection('receipts').doc(operationId).get()).exists, false)
    } finally {
      if (emulator === undefined) delete process.env.FUNCTIONS_EMULATOR
      else process.env.FUNCTIONS_EMULATOR = emulator
      if (testers === undefined) delete process.env.AI_TESTER_UIDS
      else process.env.AI_TESTER_UIDS = testers
    }
  }
})
