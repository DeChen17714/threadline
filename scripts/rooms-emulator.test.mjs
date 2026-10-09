import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { initializeApp, deleteApp } from 'firebase/app'
import { getAuth, connectAuthEmulator, createUserWithEmailAndPassword } from 'firebase/auth'
import { getFirestore, connectFirestoreEmulator, collection, query, where, orderBy, limit, getDocs, getDoc, doc, setDoc, terminate } from 'firebase/firestore'

const origin = 'http://127.0.0.1:5174'
const project = 'demo-threadline'
async function identity() {
  const app = initializeApp({ projectId: project, apiKey: 'emulator-only', appId: 'emulator-only' }, randomUUID())
  const auth = getAuth(app)
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  const db = getFirestore(app)
  connectFirestoreEmulator(db, '127.0.0.1', 8080)
  await createUserWithEmailAndPassword(auth, `${randomUUID()}@example.test`, randomUUID())
  return { app, auth, db }
}
async function call(client, data, options = {}) {
  const headers = { 'Content-Type': 'application/json', Origin: options.origin ?? origin }
  if (client) headers.Authorization = `Bearer ${await client.auth.currentUser.getIdToken()}`
  const response = await fetch(`http://127.0.0.1:5001/${project}/asia-southeast1/command`, { method: 'POST', headers, body: JSON.stringify({ data }) })
  let body
  try { body = await response.json() } catch { body = {} }
  return { response, body }
}
function request(name = 'Private room') { return { requestId: randomUUID(), operation: 'createRoom', input: { name, description: '' } } }
function result(reply) { assert.equal(reply.response.status, 200); assert.ok(!reply.body.error); return reply.body.result }
async function close(client) { await terminate(client.db); await deleteApp(client.app) }

test('strict authenticated room creation is payload-bound, private and caller-owned', async () => {
  const a = await identity(), b = await identity()
  try {
    const input = request('  Valid private room  ')
    const first = result(await call(a, input))
    const replay = result(await call(a, input))
    assert.equal(replay.operationId, first.operationId)
    assert.equal(replay.roomId, first.roomId)
    assert.equal(first.status, 'complete')
    assert.match(first.roomId, /^[0-9a-f-]{36}$/)
    const room = (await getDoc(doc(a.db, 'rooms', first.roomId))).data()
    assert.equal(room.name, 'Valid private room')
    assert.equal(room.creatorId, a.auth.currentUser.uid)
    assert.deepEqual(room.memberIds, [a.auth.currentUser.uid])
    assert.equal(room.state, 'active')
    const changed = await call(a, { ...input, input: { ...input.input, name: 'Different' } })
    assert.equal(changed.body.error.status, 'ALREADY_EXISTS')
    for (const invalid of [
      { ...request(), uid: b.auth.currentUser.uid },
      { ...request(), input: { name: 'Room', description: '', creatorId: b.auth.currentUser.uid } },
      request(' '), request('x'.repeat(81)),
      { ...request(), input: { name: 'Room', description: 'x'.repeat(501) } },
      { ...request(), operation: 'unknown' },
    ]) assert.equal((await call(a, invalid)).body.error.status, 'INVALID_ARGUMENT')
    assert.equal((await call(null, request())).body.error.status, 'UNAUTHENTICATED')
    assert.notEqual((await call(a, request(), { origin: 'https://untrusted.example' })).response.status, 200)
    await assert.rejects(getDoc(doc(b.db, 'rooms', first.roomId)), (e) => e.code === 'permission-denied')
    await assert.rejects(setDoc(doc(a.db, 'rooms', first.roomId), { name: 'Forged' }), (e) => e.code === 'permission-denied')
    for (const name of ['receipts', 'invites', 'maintenanceJobs', 'budgets']) await assert.rejects(getDocs(collection(a.db, name)), (e) => e.code === 'permission-denied')
    const ownQuery = query(collection(a.db, 'rooms'), where('memberIds', 'array-contains', a.auth.currentUser.uid), where('state', '==', 'active'), orderBy('createdAt', 'desc'), orderBy('__name__', 'desc'), limit(25))
    assert.deepEqual((await getDocs(ownQuery)).docs.map((d) => d.id), [first.roomId])
    const outsiderQuery = query(collection(b.db, 'rooms'), where('memberIds', 'array-contains', b.auth.currentUser.uid), where('state', '==', 'active'), orderBy('createdAt', 'desc'), orderBy('__name__', 'desc'), limit(25))
    assert.equal((await getDocs(outsiderQuery)).size, 0)
    const lookup = { requestId: randomUUID(), operation: 'getOperation', input: { operationId: first.operationId } }
    assert.equal(result(await call(a, lookup)).roomId, first.roomId)
    assert.notEqual((await call(b, lookup)).response.status, 200)
    // Administrative fixtures are confined to the disposable loopback emulator.
    const fixtureUrl = `http://127.0.0.1:8080/v1/projects/${project}/databases/(default)/documents`
    const fixtureHeaders = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }
    const receipt = await fetch(`${fixtureUrl}/receipts/${first.operationId}`, { headers: fixtureHeaders }).then((r) => r.json())
    assert.equal(JSON.stringify(receipt).includes('Valid private room'), false)
    const fence = await fetch(`${fixtureUrl}/rooms/${first.roomId}?updateMask.fieldPaths=state`, { method: 'PATCH', headers: fixtureHeaders, body: JSON.stringify({ fields: { state: { stringValue: 'deleting' } } }) })
    assert.equal(fence.status, 200)
    await assert.rejects(getDoc(doc(a.db, 'rooms', first.roomId)), (e) => e.code === 'permission-denied')
    assert.equal((await call(a, input)).body.error.status, 'PERMISSION_DENIED')
    assert.equal((await call(a, lookup)).body.error.status, 'PERMISSION_DENIED')
  } finally { await close(a); await close(b) }
})

test('growing authorized prefixes retain every room with a concurrent new arrival', async () => {
  const a = await identity()
  try {
    const expected = new Set()
    for (let i = 0; i < 28; i++) expected.add(result(await call(a, request(`Page room ${i}`))).roomId)
    const prefix = (n) => query(collection(a.db, 'rooms'), where('memberIds', 'array-contains', a.auth.currentUser.uid), where('state', '==', 'active'), orderBy('createdAt', 'desc'), orderBy('__name__', 'desc'), limit(n))
    assert.equal((await getDocs(prefix(25))).size, 25)
    expected.add(result(await call(a, request('Concurrent arrival'))).roomId)
    const expanded = (await getDocs(prefix(50))).docs.map((d) => d.id)
    assert.equal(new Set(expanded).size, expanded.length)
    assert.deepEqual(new Set(expanded), expected)
  } finally { await close(a) }
})
