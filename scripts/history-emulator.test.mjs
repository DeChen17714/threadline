import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { initializeApp as initializeAdminApp, deleteApp as deleteAdminApp } from 'firebase-admin/app'
import { getFirestore as getAdminFirestore } from 'firebase-admin/firestore'
import { initializeApp, deleteApp } from 'firebase/app'
import { getAuth, createUserWithEmailAndPassword } from 'firebase/auth'
import { getFirestore, terminate } from 'firebase/firestore'
import { getFunctions } from 'firebase/functions'
import { PROJECT_ID, connectTestAuthEmulator, connectTestFirestoreEmulator, connectTestFunctionsEmulator } from './emulator-test-env.mjs'
import { handleCreateRoom } from '../functions/dist/handlers/createRoom.js'
import { handleSendRoomMessage } from '../functions/dist/handlers/sendRoomMessage.js'
import { createFirebaseWorkspace } from '../src/services/firebaseWorkspace.ts'

const project = PROJECT_ID

// Node exposes navigator without the browser's connectivity property.
Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true })

const databaseId = 'history-regressions'

function createControlledModeration({ verdict = 'allow' } = {}) {
  let screenCalls = 0
  return {
    get screenCalls() { return screenCalls },
    async screen() {
      screenCalls++
      return {
        verdict,
        policyVersion: 'threadline-moderation-v1',
        reason: verdict === 'block' ? 'policy-blocked' : null,
      }
    },
  }
}
function readWindow(port, roomId, window) {
  let current
  const waiting = new Set()
  const stop = port.subscribeConversation(roomId, (state) => {
    current = state
    for (const wake of waiting) wake()
  }, window)
  return {
    stop,
    until(predicate) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiting.delete(check); reject(new Error('History did not reach the expected state')) }, 10_000)
        function check() {
          if (!predicate(current)) return
          clearTimeout(timer)
          waiting.delete(check)
          resolve(current)
        }
        waiting.add(check)
        check()
      })
    },
  }
}

function assertRange(state, first, last) {
  assert.equal(state.status, 'ready')
  assert.deepEqual(state.data.messages.map((row) => row.seq), Array.from({ length: last - first + 1 }, (_, index) => first + index))
}

test('a bounded live/frozen/sliding window retains live edits and tombstones, and clears revoked history', async () => {
  const adminApp = initializeAdminApp({ projectId: project }, `history-admin-${randomUUID()}`)
  const adminDb = getAdminFirestore(adminApp, databaseId)

  const app = initializeApp({ projectId: project, apiKey: 'emulator-only', appId: 'emulator-only' }, randomUUID())
  const auth = getAuth(app)
  connectTestAuthEmulator(auth)
  const credential = await createUserWithEmailAndPassword(auth, `${randomUUID()}@example.test`, randomUUID())
  const db = getFirestore(app, databaseId)
  connectTestFirestoreEmulator(db)
  const functions = getFunctions(app, 'asia-southeast1')
  connectTestFunctionsEmulator(functions)
  const user = { uid: credential.user.uid, label: 'History reader', email: credential.user.email }
  const port = createFirebaseWorkspace(db, functions, auth, user)
  const controlledModeration = createControlledModeration()
  const created = await handleCreateRoom(adminDb, user.uid, user.label, randomUUID(), { name: 'Bounded history regression', description: '' })
  const room = { id: created.roomId }
  const timestamp = new Date()
  let reader
  let stopRoom
  try {
    for (let start = 1; start <= 1300; start += 500) {
      const batch = adminDb.batch()
      for (let seq = start; seq < start + 500 && seq <= 1300; seq++) {
        const ref = adminDb.collection('rooms').doc(room.id).collection('messages').doc(`history-${seq}`)
        batch.set(ref, {
          id: `history-${seq}`,
          roomId: room.id,
          seq,
          kind: 'human',
          authorId: user.uid,
          authorLabel: user.label,
          intent: 'room',
          text: `History row ${seq}`,
          version: 1,
          createdAt: timestamp,
          editedAt: null,
          deletedAt: null,
        })
      }
      await batch.commit()
    }
    await adminDb.collection('rooms').doc(room.id).update({ nextSeq: 1301 })
    reader = readWindow(port, room.id, { upperSeq: null, limit: 50 })
    assertRange(await reader.until((state) => state?.status === 'ready'), 1251, 1300)
    reader.stop()
    reader = readWindow(port, room.id, { upperSeq: 1300, limit: 500 })
    assertRange(await reader.until((state) => state?.status === 'ready'), 801, 1300)
    reader.stop()
    reader = readWindow(port, room.id, { upperSeq: 850, limit: 500 })
    assertRange(await reader.until((state) => state?.status === 'ready'), 351, 850)

    await adminDb.collection('rooms').doc(room.id).collection('messages').doc('history-800').update({
      text: 'Visible corrected history',
      version: 2,
      editedAt: timestamp,
    })
    const edited = await reader.until((state) => state?.data?.messages.some((row) => row.seq === 800 && row.text === 'Visible corrected history'))
    assert.equal(edited.data.messages.find((row) => row.seq === 800).version, 2)

    await adminDb.collection('rooms').doc(room.id).collection('messages').doc('history-801').update({
      text: '',
      deletedAt: timestamp,
    })
    const deleted = await reader.until((state) => state?.data?.messages.some((row) => row.seq === 801 && row.deletedAt !== null))
    assert.equal(deleted.data.messages.find((row) => row.seq === 801).text, '')
    assertRange(deleted, 351, 850)

    await handleSendRoomMessage(
      adminDb,
      user.uid,
      user.label,
      randomUUID(),
      {
        roomId: room.id,
        messageId: randomUUID(),
        text: 'Outside the frozen history window',
      },
      controlledModeration,
    )
    const metadata = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Room metadata did not reach the live tail')), 10_000)
      stopRoom = port.subscribeRoom(room.id, (state) => {
        if (state.status === 'ready' && state.data?.latestSeq === 1301) { clearTimeout(timer); resolve(state.data) }
      })
    })
    assert.equal(metadata.latestSeq, 1301)
    assertRange(await reader.until((state) => state?.status === 'ready'), 351, 850)
    reader.stop()
    reader = readWindow(port, room.id, { upperSeq: null, limit: 50 })
    assertRange(await reader.until((state) => state?.status === 'ready'), 1252, 1301)

    await adminDb.collection('rooms').doc(room.id).update({ memberIds: [], members: [] })
    const revoked = await reader.until((state) => state?.status === 'ready' && state.data.messages.length === 0)
    assert.deepEqual(revoked.data.messages, [])
    reader.stop()
    assert.throws(() => port.subscribeConversation(room.id, () => {}, { upperSeq: null, limit: 501 }), /50 and 500/)
  } finally {
    reader?.stop()
    stopRoom?.()
    port.dispose()
    await terminate(db)
    await deleteApp(app)
    await deleteAdminApp(adminApp).catch(() => {})
  }
})
