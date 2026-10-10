import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { initializeApp } from 'firebase-admin/app'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'

import { PROJECT_ID, commandEndpoint, documentsBaseUrl, authSignUpUrl } from './emulator-test-env.mjs'

const { handleCreateRoom } = await import('../functions/dist/handlers/createRoom.js')
const { handleSendRoomMessage } = await import('../functions/dist/handlers/sendRoomMessage.js')
const { handleGetOperation } = await import('../functions/dist/handlers/getOperation.js')

const project = PROJECT_ID
const DB_NAME = 'messages-regressions'
const db = getFirestore(initializeApp({ projectId: project }, DB_NAME), DB_NAME)
const endpoint = commandEndpoint
const documents = documentsBaseUrl(DB_NAME)

async function account() {
  const r = await fetch(authSignUpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${randomUUID()}@example.test`, password: randomUUID(), returnSecureToken: true }),
  })
  assert.equal(r.status, 200)
  return r.json()
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

async function createRoom(owner, name = 'Message test room') {
  const callerUid = typeof owner === 'string' ? owner : owner.localId
  const callerLabel = typeof owner === 'string' ? 'Owner' : (owner.label ?? 'Owner')
  const res = await handleCreateRoom(db, callerUid, callerLabel, randomUUID(), { name, description: 'Test description' })
  return res.roomId
}

async function addMember(roomId, member, label = 'Member') {
  const memberUid = typeof member === 'string' ? member : member.localId
  const memberLabel = typeof member === 'string' ? label : (member.label ?? label)
  await db.collection('rooms').doc(roomId).update({
    memberIds: FieldValue.arrayUnion(memberUid),
    members: FieldValue.arrayUnion({ uid: memberUid, label: memberLabel }),
  })
}

async function invoke(user, operation, input, requestId = randomUUID(), options = {}) {
  const headers = {
    Origin: options.origin ?? 'http://127.0.0.1:5174',
    'Content-Type': 'application/json',
    ...(user ? { Authorization: `Bearer ${user.idToken}` } : {}),
  }
  const r = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ data: { operation, input, requestId } }),
  })
  let body
  try { body = await r.json() } catch { body = {} }
  return { status: r.status, body }
}

async function memberRead(user, path) {
  return fetch(`${documents}/${path}`, {
    headers: { Authorization: `Bearer ${user.idToken}` },
  })
}

test('atomic authorized human message send with monotonic sequence, lost-response replay and conflict detection', async () => {
  const owner = await account(), member = await account()
  const roomId = await createRoom(owner, 'Send room')
  await addMember(roomId, member, 'Member')

  const messageId = randomUUID()
  const requestId = randomUUID()
  const text = 'Hello world message'

  // 1. Initial successful send
  const initial = await handleSendRoomMessage(
    db,
    member.localId,
    'Member',
    requestId,
    { roomId, messageId, text },
    defaultModeration
  )
  assert.equal(initial.operationId, `${member.localId}_sendRoomMessage_${requestId}`)
  assert.equal(initial.status, 'complete')
  assert.equal(initial.roomId, roomId)
  assert.equal(initial.messageId, messageId)
  assert.equal(initial.seq, 1)

  // 2. Firestore stored message document validation
  const msgDocSnap = await db.collection('rooms').doc(roomId).collection('messages').doc(messageId).get()
  assert.equal(msgDocSnap.exists, true)
  const msgDoc = msgDocSnap.data()
  assert.equal(msgDoc.id, messageId)
  assert.equal(msgDoc.roomId, roomId)
  assert.equal(msgDoc.seq, 1)
  assert.equal(msgDoc.text, text)
  assert.equal(msgDoc.kind, 'human')
  assert.equal(msgDoc.authorId, member.localId)
  assert.ok(typeof msgDoc.authorLabel === 'string')
  assert.equal(msgDoc.intent, 'room')
  assert.equal(msgDoc.version, 1)
  assert.ok(msgDoc.createdAt)
  assert.equal(msgDoc.editedAt, null)
  assert.equal(msgDoc.deletedAt, null)

  const roomDoc = (await db.collection('rooms').doc(roomId).get()).data()
  assert.equal(roomDoc.nextSeq, 2)

  // 4. Lost-response / exact duplicate replay
  const replay = await handleSendRoomMessage(
    db,
    member.localId,
    'Member',
    requestId,
    { roomId, messageId, text },
    defaultModeration
  )
  assert.equal(replay.operationId, initial.operationId)
  assert.equal(replay.roomId, initial.roomId)
  assert.equal(replay.messageId, initial.messageId)
  assert.equal(replay.seq, initial.seq)

  const roomDocReplay = (await db.collection('rooms').doc(roomId).get()).data()
  assert.equal(roomDocReplay.nextSeq, 2)

  // 5. Conflicting request ID with different payload
  await assert.rejects(
    handleSendRoomMessage(db, member.localId, 'Member', requestId, { roomId, messageId, text: 'Different text content' }, defaultModeration),
    (error) => error?.code === 'already-exists' && error?.details?.code === 'conflict'
  )

  await assert.rejects(
    handleSendRoomMessage(db, member.localId, 'Member', requestId, { roomId: randomUUID(), messageId, text }, defaultModeration),
    (error) => error?.code === 'permission-denied' && error?.details?.code === 'forbidden'
  )

  await assert.rejects(
    handleSendRoomMessage(db, member.localId, 'Member', requestId, { roomId, messageId: randomUUID(), text }, defaultModeration),
    (error) => error?.code === 'already-exists' && error?.details?.code === 'conflict'
  )

  // 6. Existing messageId without matching receipt (new requestId reusing existing messageId)
  await assert.rejects(
    handleSendRoomMessage(db, member.localId, 'Member', randomUUID(), { roomId, messageId, text }, defaultModeration),
    (error) => error?.code === 'already-exists' && error?.details?.code === 'conflict'
  )

  // 7. Forged extra fields rejected strictly by schema
  for (const forged of [
    { roomId, messageId: randomUUID(), text: 'Forged AI', kind: 'ai' },
    { roomId, messageId: randomUUID(), text: 'Forged author', authorId: owner.localId },
    { roomId, messageId: randomUUID(), text: 'Forged label', authorLabel: 'Administrator' },
    { roomId, messageId: randomUUID(), text: 'Forged intent', intent: 'ask-ai' },
    { roomId, messageId: randomUUID(), text: 'Forged seq', seq: 42 },
    { roomId, messageId: randomUUID(), text: 'Forged version', version: 2 },
  ]) {
    const res = await invoke(member, 'sendRoomMessage', forged)
    assert.equal(res.body.error?.status, 'INVALID_ARGUMENT')
  }
})

test('transaction concurrency allocates strictly monotonic gapless sequence numbers', async () => {
  const owner = await account(), member = await account()
  const roomId = await createRoom(owner, 'Concurrency room')
  await addMember(roomId, member, 'Member')

  const count = 10
  const payloads = Array.from({ length: count }, (_, i) => ({
    user: i % 2 === 0 ? owner : member,
    messageId: randomUUID(),
    text: `Concurrent message ${i + 1}`,
  }))

  const responses = await Promise.all(
    payloads.map((p) => handleSendRoomMessage(
      db,
      p.user.localId,
      p.user.localId === owner.localId ? 'Owner' : 'Member',
      randomUUID(),
      { roomId, messageId: p.messageId, text: p.text },
      defaultModeration
    ))
  )

  assert.equal(responses.length, count)

  const allocatedSeqs = responses.map((r) => r.seq).sort((a, b) => a - b)
  const expectedSeqs = Array.from({ length: count }, (_, i) => i + 1)
  assert.deepEqual(allocatedSeqs, expectedSeqs)

  const roomSnap = await db.collection('rooms').doc(roomId).get()
  assert.equal(roomSnap.data()?.nextSeq, count + 1)

  for (const p of payloads) {
    const m = (await db.collection('rooms').doc(roomId).collection('messages').doc(p.messageId).get()).data()
    assert.ok(m?.seq)
    assert.equal(m?.roomId, roomId)
  }
})

test('outsider isolation, direct client write denial, and deleting/revoked room fences', async () => {
  const owner = await account(), member = await account(), outsider = await account()
  const roomId = await createRoom(owner, 'Isolation room')
  await addMember(roomId, member, 'Member')

  // Initial message sent by member
  const reqId = randomUUID()
  const msgId = randomUUID()
  const sendRes = await handleSendRoomMessage(
    db,
    member.localId,
    'Member',
    reqId,
    { roomId, messageId: msgId, text: 'Member message' },
    defaultModeration
  )
  assert.equal(sendRes.status, 'complete')

  // 1. Outsider cannot send to room
  await assert.rejects(
    handleSendRoomMessage(db, outsider.localId, 'Outsider', randomUUID(), { roomId, messageId: randomUUID(), text: 'Outsider msg' }, defaultModeration),
    (error) => error?.code === 'permission-denied' && error?.details?.code === 'forbidden'
  )

  // 2. Outsider cannot read messages via REST with user token
  const outsiderMsgRead = await memberRead(outsider, `rooms/${roomId}/messages/${msgId}`)
  assert.equal(outsiderMsgRead.status, 403)
  const outsiderMessagesList = await memberRead(outsider, `rooms/${roomId}/messages`)
  assert.equal(outsiderMessagesList.status, 403)

  // Member can read messages via REST with user token
  const memberMsgRead = await memberRead(member, `rooms/${roomId}/messages/${msgId}`)
  assert.equal(memberMsgRead.status, 200)

  // 3. Outsider cannot recover member's operation
  await assert.rejects(
    handleGetOperation(db, outsider.localId, randomUUID(), { operationId: sendRes.operationId }),
    (error) => error?.code === 'permission-denied' && error?.details?.code === 'forbidden'
  )

  // Member can recover their operation
  const memberGetOp = await handleGetOperation(db, member.localId, randomUUID(), { operationId: sendRes.operationId })
  assert.equal(memberGetOp.operationId, sendRes.operationId)
  assert.equal(memberGetOp.status, 'complete')

  // 4. Unauthenticated caller rejected
  const unauthSend = await invoke(null, 'sendRoomMessage', { roomId: randomUUID(), messageId: randomUUID(), text: 'Unauth msg' })
  assert.equal(unauthSend.body.error?.status, 'UNAUTHENTICATED')

  // 5. Disallowed origin rejected
  const badOriginSend = await invoke(member, 'sendRoomMessage', { roomId: randomUUID(), messageId: randomUUID(), text: 'Bad origin' }, randomUUID(), { origin: 'https://evil.example' })
  assert.notEqual(badOriginSend.status, 200)

  // 6. Direct client writes denied by Firestore security rules
  const directMsgWrite = await fetch(`${documents}/rooms/${roomId}/messages/${randomUUID()}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${member.idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { text: { stringValue: 'Forged direct write' } } }),
  })
  assert.equal(directMsgWrite.status, 403)

  const directBucketWrite = await fetch(`${documents}/quotaBuckets/${randomUUID()}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${member.idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { count: { integerValue: '0' } } }),
  })
  assert.equal(directBucketWrite.status, 403)

  const directReceiptWrite = await fetch(`${documents}/receipts/${randomUUID()}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${member.idToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { status: { stringValue: 'complete' } } }),
  })
  assert.equal(directReceiptWrite.status, 403)

  // 7. Deleting room fence: send & recovery rejected
  const deletingRoomId = await createRoom(owner, 'Deleting room')
  await addMember(deletingRoomId, member, 'Member')
  const delMsgId = randomUUID()
  const delReqId = randomUUID()
  const delSendRes = await handleSendRoomMessage(
    db,
    member.localId,
    'Member',
    delReqId,
    { roomId: deletingRoomId, messageId: delMsgId, text: 'Before delete' },
    defaultModeration
  )

  // Patch room to deleting
  await db.collection('rooms').doc(deletingRoomId).update({ state: 'deleting' })

  await assert.rejects(
    handleSendRoomMessage(db, member.localId, 'Member', randomUUID(), { roomId: deletingRoomId, messageId: randomUUID(), text: 'After delete' }, defaultModeration),
    (error) => error?.code === 'permission-denied' && error?.details?.code === 'forbidden'
  )

  await assert.rejects(
    handleSendRoomMessage(db, member.localId, 'Member', delReqId, { roomId: deletingRoomId, messageId: delMsgId, text: 'Before delete' }, defaultModeration),
    (error) => error?.code === 'permission-denied' && error?.details?.code === 'forbidden'
  )

  await assert.rejects(
    handleGetOperation(db, member.localId, randomUUID(), { operationId: delSendRes.operationId }),
    (error) => error?.code === 'permission-denied' && error?.details?.code === 'forbidden'
  )

  // 8. Revoked membership fence: send & recovery rejected
  const revokeRoomId = await createRoom(owner, 'Revoke room')
  await addMember(revokeRoomId, member, 'Member')
  const revMsgId = randomUUID()
  const revReqId = randomUUID()
  const revSendRes = await handleSendRoomMessage(
    db,
    member.localId,
    'Member',
    revReqId,
    { roomId: revokeRoomId, messageId: revMsgId, text: 'Before revoke' },
    defaultModeration
  )

  // Revoke member by updating room memberIds and members
  await db.collection('rooms').doc(revokeRoomId).update({
    memberIds: [owner.localId],
    members: [{ uid: owner.localId, label: 'Owner' }],
  })

  await assert.rejects(
    handleSendRoomMessage(db, member.localId, 'Member', randomUUID(), { roomId: revokeRoomId, messageId: randomUUID(), text: 'After revoke' }, defaultModeration),
    (error) => error?.code === 'permission-denied' && error?.details?.code === 'forbidden'
  )

  await assert.rejects(
    handleSendRoomMessage(db, member.localId, 'Member', revReqId, { roomId: revokeRoomId, messageId: revMsgId, text: 'Before revoke' }, defaultModeration),
    (error) => error?.code === 'permission-denied' && error?.details?.code === 'forbidden'
  )

  await assert.rejects(
    handleGetOperation(db, member.localId, randomUUID(), { operationId: revSendRes.operationId }),
    (error) => error?.code === 'permission-denied' && error?.details?.code === 'forbidden'
  )
})

test('text bounds validation, durable UID-minute cross-room throttling, and replay exemption', async () => {
  const user = await account()
  const roomId = await createRoom(user, 'Room A')

  // 1. Text bounds validation
  await assert.rejects(
    handleSendRoomMessage(db, user.localId, 'User', randomUUID(), { roomId, messageId: randomUUID(), text: '' }, defaultModeration),
    (error) => error?.code === 'invalid-argument' && error?.details?.code === 'validation'
  )

  await assert.rejects(
    handleSendRoomMessage(db, user.localId, 'User', randomUUID(), { roomId, messageId: randomUUID(), text: '   \n \t  ' }, defaultModeration),
    (error) => error?.code === 'invalid-argument' && error?.details?.code === 'validation'
  )

  await assert.rejects(
    handleSendRoomMessage(db, user.localId, 'User', randomUUID(), { roomId, messageId: randomUUID(), text: 'x'.repeat(4001) }, defaultModeration),
    (error) => error?.code === 'invalid-argument' && error?.details?.code === 'validation'
  )

  // Exact 4000 characters (ASCII and multi-byte UTF-8 within 16 KiB limit) are accepted
  const exactly4000Id = randomUUID()
  const exactly4000Res = await handleSendRoomMessage(
    db,
    user.localId,
    'User',
    randomUUID(),
    { roomId, messageId: exactly4000Id, text: 'x'.repeat(4000) },
    defaultModeration
  )
  assert.equal(exactly4000Res.messageId, exactly4000Id)

  const multiByte4000Id = randomUUID()
  const multiByte4000Res = await handleSendRoomMessage(
    db,
    user.localId,
    'User',
    randomUUID(),
    { roomId, messageId: multiByte4000Id, text: '€'.repeat(4000) },
    defaultModeration
  )
  assert.equal(multiByte4000Res.messageId, multiByte4000Id)

  // Invalid IDs format rejected
  await assert.rejects(
    handleSendRoomMessage(db, user.localId, 'User', randomUUID(), { roomId: 'not-a-uuid', messageId: randomUUID(), text: 'Valid text' }, defaultModeration),
    (error) => error?.code === 'invalid-argument' && error?.details?.code === 'validation'
  )

  await assert.rejects(
    handleSendRoomMessage(db, user.localId, 'User', randomUUID(), { roomId, messageId: 'not-a-uuid', text: 'Valid text' }, defaultModeration),
    (error) => error?.code === 'invalid-argument' && error?.details?.code === 'validation'
  )

  // 2. Durable UID-minute cross-room throttling (20 accepted sends per minute)
  const throttleUser = await account()
  const tRoom1 = await createRoom(throttleUser, 'Throttle Room 1')
  const tRoom2 = await createRoom(throttleUser, 'Throttle Room 2')

  const accepted = []
  // 10 sends to room 1
  for (let i = 0; i < 10; i++) {
    const mid = randomUUID()
    const reqId = randomUUID()
    const text = `T1 message ${i}`
    const r = await handleSendRoomMessage(db, throttleUser.localId, 'ThrottleUser', reqId, { roomId: tRoom1, messageId: mid, text }, defaultModeration)
    accepted.push({ roomId: tRoom1, messageId: mid, text, requestId: reqId, operationId: r.operationId })
  }
  // 10 sends to room 2 (cross-room!)
  for (let i = 0; i < 10; i++) {
    const mid = randomUUID()
    const reqId = randomUUID()
    const text = `T2 message ${i}`
    const r = await handleSendRoomMessage(db, throttleUser.localId, 'ThrottleUser', reqId, { roomId: tRoom2, messageId: mid, text }, defaultModeration)
    accepted.push({ roomId: tRoom2, messageId: mid, text, requestId: reqId, operationId: r.operationId })
  }
  assert.equal(accepted.length, 20)

  // Private admin bucket seeding to current minute window avoids minute jump drift
  const currentWindow = Math.floor(Date.now() / 60_000) * 60_000
  await db.collection('quotaBuckets').doc(`sendRoomMessage_${throttleUser.localId}`).set({
    uid: throttleUser.localId,
    windowStartMs: currentWindow,
    count: 20,
  }, { merge: true })

  // 21st send attempt (in either room) MUST be throttled!
  const rejectedMsgId = randomUUID()
  await assert.rejects(
    handleSendRoomMessage(db, throttleUser.localId, 'ThrottleUser', randomUUID(), { roomId: tRoom1, messageId: rejectedMsgId, text: '21st message' }, defaultModeration),
    (error) => {
      assert.equal(error?.code, 'resource-exhausted')
      assert.equal(error?.details?.code, 'throttled')
      assert.equal(typeof error?.details?.retryAt, 'number')
      assert.ok(error?.details?.retryAt > Date.now())
      return true
    }
  )

  // Rejected send did NOT write message doc:
  const rejectedDoc = await db.collection('rooms').doc(tRoom1).collection('messages').doc(rejectedMsgId).get()
  assert.equal(rejectedDoc.exists, false)

  // Replay of an accepted send does NOT consume and is NOT blocked by throttle:
  const firstAccepted = accepted[0]
  const replayRes = await handleSendRoomMessage(
    db,
    throttleUser.localId,
    'ThrottleUser',
    firstAccepted.requestId,
    { roomId: firstAccepted.roomId, messageId: firstAccepted.messageId, text: firstAccepted.text },
    defaultModeration
  )
  assert.equal(replayRes.messageId, firstAccepted.messageId)

  // Clock boundary advance (seeded to past window) allows immediate send and resets window count
  await db.collection('quotaBuckets').doc(`sendRoomMessage_${throttleUser.localId}`).set({
    windowStartMs: currentWindow - 60_000,
    count: 20,
  }, { merge: true })

  const nextWindowMsgId = randomUUID()
  const nextWindowRes = await handleSendRoomMessage(
    db,
    throttleUser.localId,
    'ThrottleUser',
    randomUUID(),
    { roomId: tRoom1, messageId: nextWindowMsgId, text: 'Next window message' },
    defaultModeration
  )
  assert.equal(nextWindowRes.messageId, nextWindowMsgId)
  const bucketAfterReset = (await db.collection('quotaBuckets').doc(`sendRoomMessage_${throttleUser.localId}`).get()).data()
  assert.equal(bucketAfterReset?.count, 1)
})
