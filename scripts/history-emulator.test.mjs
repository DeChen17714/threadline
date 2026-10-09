import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { initializeApp, deleteApp } from 'firebase/app'
import { getAuth, connectAuthEmulator, createUserWithEmailAndPassword } from 'firebase/auth'
import { getFirestore, connectFirestoreEmulator, terminate } from 'firebase/firestore'
import { getFunctions, connectFunctionsEmulator } from 'firebase/functions'
import { createFirebaseWorkspace } from '../src/services/firebaseWorkspace.ts'

// Node exposes navigator without the browser's connectivity property.
Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true })

const project = 'demo-threadline'
const database = `projects/${project}/databases/(default)/documents`
const documents = `http://127.0.0.1:8080/v1/${database}`
const headers = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }

async function patch(path, fields) {
  const mask = Object.keys(fields).map((key) => `updateMask.fieldPaths=${key}`).join('&')
  const response = await fetch(`${documents}/${path}?${mask}`, { method: 'PATCH', headers, body: JSON.stringify({ fields }) })
  assert.equal(response.status, 200)
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
  const app = initializeApp({ projectId: project, apiKey: 'emulator-only', appId: 'emulator-only' }, randomUUID())
  const auth = getAuth(app)
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true })
  const credential = await createUserWithEmailAndPassword(auth, `${randomUUID()}@example.test`, randomUUID())
  const db = getFirestore(app)
  connectFirestoreEmulator(db, '127.0.0.1', 8080)
  const functions = getFunctions(app, 'asia-southeast1')
  connectFunctionsEmulator(functions, '127.0.0.1', 5001)
  const user = { uid: credential.user.uid, label: 'History reader', email: credential.user.email }
  const port = createFirebaseWorkspace(db, functions, auth, user)
  const room = await port.createRoom({ name: 'Bounded history regression', description: '' })
  const timestampValue = new Date().toISOString()
  let reader
  let stopRoom
  try {
    for (let start = 1; start <= 1300; start += 250) {
      const writes = []
      for (let seq = start; seq < start + 250 && seq <= 1300; seq++) {
        writes.push({ update: { name: `${database}/rooms/${room.id}/messages/history-${seq}`, fields: {
          roomId: { stringValue: room.id }, seq: { integerValue: String(seq) }, kind: { stringValue: 'human' },
          authorId: { stringValue: user.uid }, authorLabel: { stringValue: user.label }, intent: { stringValue: 'room' },
          text: { stringValue: `History row ${seq}` }, version: { integerValue: '1' }, createdAt: { timestampValue },
          editedAt: { nullValue: null }, deletedAt: { nullValue: null },
        } } })
      }
      const response = await fetch(`${documents}:commit`, { method: 'POST', headers, body: JSON.stringify({ writes }) })
      assert.equal(response.status, 200)
    }
    await patch(`rooms/${room.id}`, { nextSeq: { integerValue: '1301' } })
    reader = readWindow(port, room.id, { upperSeq: null, limit: 50 })
    assertRange(await reader.until((state) => state?.status === 'ready'), 1251, 1300)
    reader.stop()
    reader = readWindow(port, room.id, { upperSeq: 1300, limit: 500 })
    assertRange(await reader.until((state) => state?.status === 'ready'), 801, 1300)
    reader.stop()
    reader = readWindow(port, room.id, { upperSeq: 850, limit: 500 })
    assertRange(await reader.until((state) => state?.status === 'ready'), 351, 850)

    await patch(`rooms/${room.id}/messages/history-800`, { text: { stringValue: 'Visible corrected history' }, version: { integerValue: '2' }, editedAt: { timestampValue } })
    const edited = await reader.until((state) => state?.data?.messages.some((row) => row.seq === 800 && row.text === 'Visible corrected history'))
    assert.equal(edited.data.messages.find((row) => row.seq === 800).version, 2)
    await patch(`rooms/${room.id}/messages/history-801`, { text: { stringValue: '' }, deletedAt: { timestampValue } })
    const deleted = await reader.until((state) => state?.data?.messages.some((row) => row.seq === 801 && row.deletedAt !== null))
    assert.equal(deleted.data.messages.find((row) => row.seq === 801).text, '')
    assertRange(deleted, 351, 850)

    await port.send({ requestId: randomUUID(), roomId: room.id, messageId: randomUUID(), text: 'Outside the frozen history window', intent: 'room' })
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

    await patch(`rooms/${room.id}`, { memberIds: { arrayValue: { values: [] } }, members: { arrayValue: { values: [] } } })
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
  }
})
