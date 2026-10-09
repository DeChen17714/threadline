import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const project = 'demo-threadline'
const endpoint = `http://127.0.0.1:5001/${project}/asia-southeast1/command`
const database = `projects/${project}/databases/(default)`
const documents = `http://127.0.0.1:8080/v1/${database}/documents`
const adminHeaders = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }

async function account() {
  const r = await fetch('http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=emulator-only', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${randomUUID()}@example.test`, password: randomUUID(), returnSecureToken: true }),
  })
  assert.equal(r.status, 200)
  return r.json()
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

function success(r) {
  assert.equal(r.status, 200)
  assert.equal(r.body.error, undefined)
  return r.body.result
}

async function createRoom(owner, name = 'Message test room') {
  return success(await invoke(owner, 'createRoom', { name, description: 'Test description' })).roomId
}

async function addMember(owner, member, roomId) {
  const invite = success(await invoke(owner, 'issueInvite', { roomId }))
  success(await invoke(member, 'joinRoom', { token: invite.token }))
}

async function adminRead(path) {
  return fetch(`${documents}/${path}`, { headers: adminHeaders })
}

async function adminPatch(path, fields) {
  const query = Object.keys(fields).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&')
  const r = await fetch(`${documents}/${path}?${query}`, {
    method: 'PATCH',
    headers: adminHeaders,
    body: JSON.stringify({ fields }),
  })
  assert.equal(r.status, 200)
}

async function memberRead(user, path) {
  return fetch(`${documents}/${path}`, {
    headers: { Authorization: `Bearer ${user.idToken}` },
  })
}

test('atomic authorized human message send with monotonic sequence, lost-response replay and conflict detection', async () => {
  const owner = await account(), member = await account()
  const roomId = await createRoom(owner, 'Send room')
  await addMember(owner, member, roomId)

  const messageId = randomUUID()
  const requestId = randomUUID()
  const text = 'Hello world message'

  // 1. Initial successful send
  const initial = success(await invoke(member, 'sendRoomMessage', { roomId, messageId, text }, requestId))
  assert.equal(initial.operationId, `${member.localId}_sendRoomMessage_${requestId}`)
  assert.equal(initial.status, 'complete')
  assert.equal(initial.roomId, roomId)
  assert.equal(initial.messageId, messageId)
  assert.equal(initial.seq, 1)

  // 2. Firestore stored message document validation
  const msgDocRes = await adminRead(`rooms/${roomId}/messages/${messageId}`)
  assert.equal(msgDocRes.status, 200)
  const msgDoc = await msgDocRes.json()
  assert.equal(msgDoc.fields.id?.stringValue, messageId)
  assert.equal(msgDoc.fields.roomId?.stringValue, roomId)
  assert.equal(msgDoc.fields.seq?.integerValue, '1')
  assert.equal(msgDoc.fields.text?.stringValue, text)
  assert.equal(msgDoc.fields.kind?.stringValue, 'human')
  assert.equal(msgDoc.fields.authorId?.stringValue, member.localId)
  assert.ok(typeof msgDoc.fields.authorLabel?.stringValue === 'string')
  assert.equal(msgDoc.fields.intent?.stringValue, 'room')
  assert.equal(msgDoc.fields.version?.integerValue, '1')
  assert.ok(msgDoc.fields.createdAt?.timestampValue)
  assert.equal(msgDoc.fields.editedAt?.nullValue, null)
  assert.equal(msgDoc.fields.deletedAt?.nullValue, null)

  const roomDocRes = await adminRead(`rooms/${roomId}`)
  const roomDoc = await roomDocRes.json()
  assert.equal(roomDoc.fields.nextSeq?.integerValue, '2')

  // 4. Lost-response / exact duplicate replay
  const replay = success(await invoke(member, 'sendRoomMessage', { roomId, messageId, text }, requestId))
  assert.equal(replay.operationId, initial.operationId)
  assert.equal(replay.roomId, initial.roomId)
  assert.equal(replay.messageId, initial.messageId)
  assert.equal(replay.seq, initial.seq)

  const roomDocReplay = await (await adminRead(`rooms/${roomId}`)).json()
  assert.equal(roomDocReplay.fields.nextSeq?.integerValue, '2')

  // 5. Conflicting request ID with different payload
  const diffText = await invoke(member, 'sendRoomMessage', { roomId, messageId, text: 'Different text content' }, requestId)
  assert.equal(diffText.body.error?.status, 'ALREADY_EXISTS')

  const diffRoom = await invoke(member, 'sendRoomMessage', { roomId: randomUUID(), messageId, text }, requestId)
  assert.equal(diffRoom.body.error?.status, 'ALREADY_EXISTS')

  const diffMsgId = await invoke(member, 'sendRoomMessage', { roomId, messageId: randomUUID(), text }, requestId)
  assert.equal(diffMsgId.body.error?.status, 'ALREADY_EXISTS')

  // 6. Existing messageId without matching receipt (new requestId reusing existing messageId)
  const diffReqSameMsg = await invoke(member, 'sendRoomMessage', { roomId, messageId, text }, randomUUID())
  assert.equal(diffReqSameMsg.body.error?.status, 'ALREADY_EXISTS')

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
  await addMember(owner, member, roomId)

  const count = 10
  const payloads = Array.from({ length: count }, (_, i) => ({
    user: i % 2 === 0 ? owner : member,
    messageId: randomUUID(),
    text: `Concurrent message ${i + 1}`,
  }))

  const responses = await Promise.all(
    payloads.map((p) => invoke(p.user, 'sendRoomMessage', { roomId, messageId: p.messageId, text: p.text }))
  )

  const results = responses.map((r) => success(r))
  assert.equal(results.length, count)

  const allocatedSeqs = results.map((r) => r.seq).sort((a, b) => a - b)
  const expectedSeqs = Array.from({ length: count }, (_, i) => i + 1)
  assert.deepEqual(allocatedSeqs, expectedSeqs)

  const roomSnap = await (await adminRead(`rooms/${roomId}`)).json()
  assert.equal(roomSnap.fields.nextSeq?.integerValue, String(count + 1))

  for (const p of payloads) {
    const m = await (await adminRead(`rooms/${roomId}/messages/${p.messageId}`)).json()
    assert.ok(m.fields.seq?.integerValue)
    assert.equal(m.fields.roomId?.stringValue, roomId)
  }
})

test('outsider isolation, direct client write denial, and deleting/revoked room fences', async () => {
  const owner = await account(), member = await account(), outsider = await account()
  const roomId = await createRoom(owner, 'Isolation room')
  await addMember(owner, member, roomId)

  // Initial message sent by member
  const reqId = randomUUID()
  const msgId = randomUUID()
  const sendRes = success(await invoke(member, 'sendRoomMessage', { roomId, messageId: msgId, text: 'Member message' }, reqId))

  // 1. Outsider cannot send to room
  const outsiderSend = await invoke(outsider, 'sendRoomMessage', { roomId, messageId: randomUUID(), text: 'Outsider msg' })
  assert.equal(outsiderSend.body.error?.status, 'PERMISSION_DENIED')

  // 2. Outsider cannot read messages via REST with user token
  const outsiderMsgRead = await memberRead(outsider, `rooms/${roomId}/messages/${msgId}`)
  assert.equal(outsiderMsgRead.status, 403)
  const outsiderMessagesList = await memberRead(outsider, `rooms/${roomId}/messages`)
  assert.equal(outsiderMessagesList.status, 403)

  // 3. Outsider cannot recover member's operation
  const outsiderGetOp = await invoke(outsider, 'getOperation', { operationId: sendRes.operationId })
  assert.equal(outsiderGetOp.body.error?.status, 'PERMISSION_DENIED')

  // 4. Unauthenticated caller rejected
  const unauthSend = await invoke(null, 'sendRoomMessage', { roomId, messageId: randomUUID(), text: 'Unauth msg' })
  assert.equal(unauthSend.body.error?.status, 'UNAUTHENTICATED')

  // 5. Disallowed origin rejected
  const badOriginSend = await invoke(member, 'sendRoomMessage', { roomId, messageId: randomUUID(), text: 'Bad origin' }, randomUUID(), { origin: 'https://evil.example' })
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
  await addMember(owner, member, deletingRoomId)
  const delMsgId = randomUUID()
  const delReqId = randomUUID()
  const delSendRes = success(await invoke(member, 'sendRoomMessage', { roomId: deletingRoomId, messageId: delMsgId, text: 'Before delete' }, delReqId))

  // Patch room to deleting
  await adminPatch(`rooms/${deletingRoomId}`, { state: { stringValue: 'deleting' } })

  const sendDeleting = await invoke(member, 'sendRoomMessage', { roomId: deletingRoomId, messageId: randomUUID(), text: 'After delete' })
  assert.equal(sendDeleting.body.error?.status, 'PERMISSION_DENIED')

  const replayDeleting = await invoke(member, 'sendRoomMessage', { roomId: deletingRoomId, messageId: delMsgId, text: 'Before delete' }, delReqId)
  assert.equal(replayDeleting.body.error?.status, 'PERMISSION_DENIED')

  const getOpDeleting = await invoke(member, 'getOperation', { operationId: delSendRes.operationId })
  assert.equal(getOpDeleting.body.error?.status, 'PERMISSION_DENIED')

  // 8. Revoked membership fence: send & recovery rejected
  const revokeRoomId = await createRoom(owner, 'Revoke room')
  await addMember(owner, member, revokeRoomId)
  const revMsgId = randomUUID()
  const revReqId = randomUUID()
  const revSendRes = success(await invoke(member, 'sendRoomMessage', { roomId: revokeRoomId, messageId: revMsgId, text: 'Before revoke' }, revReqId))

  // Revoke member by updating room memberIds and members
  await adminPatch(`rooms/${revokeRoomId}`, {
    memberIds: { arrayValue: { values: [{ stringValue: owner.localId }] } },
    members: { arrayValue: { values: [{ mapValue: { fields: { uid: { stringValue: owner.localId }, label: { stringValue: 'Owner' } } } }] } },
  })

  const sendRevoked = await invoke(member, 'sendRoomMessage', { roomId: revokeRoomId, messageId: randomUUID(), text: 'After revoke' })
  assert.equal(sendRevoked.body.error?.status, 'PERMISSION_DENIED')

  const replayRevoked = await invoke(member, 'sendRoomMessage', { roomId: revokeRoomId, messageId: revMsgId, text: 'Before revoke' }, revReqId)
  assert.equal(replayRevoked.body.error?.status, 'PERMISSION_DENIED')

  const getOpRevoked = await invoke(member, 'getOperation', { operationId: revSendRes.operationId })
  assert.equal(getOpRevoked.body.error?.status, 'PERMISSION_DENIED')
})

test('text bounds validation, durable UID-minute cross-room throttling, and replay exemption', async () => {
  const user = await account()
  const roomA = await createRoom(user, 'Room A')

  // 1. Text bounds validation
  const emptyRes = await invoke(user, 'sendRoomMessage', { roomId: roomA, messageId: randomUUID(), text: '' })
  assert.equal(emptyRes.body.error?.status, 'INVALID_ARGUMENT')

  const wsRes = await invoke(user, 'sendRoomMessage', { roomId: roomA, messageId: randomUUID(), text: '   \n \t  ' })
  assert.equal(wsRes.body.error?.status, 'INVALID_ARGUMENT')

  const over4000 = await invoke(user, 'sendRoomMessage', { roomId: roomA, messageId: randomUUID(), text: 'x'.repeat(4001) })
  assert.equal(over4000.body.error?.status, 'INVALID_ARGUMENT')

  // Exact 4000 characters is accepted
  const exactly4000Id = randomUUID()
  const exactly4000Res = success(await invoke(user, 'sendRoomMessage', { roomId: roomA, messageId: exactly4000Id, text: 'x'.repeat(4000) }))
  assert.equal(exactly4000Res.messageId, exactly4000Id)

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
    const r = success(await invoke(throttleUser, 'sendRoomMessage', { roomId: tRoom1, messageId: mid, text }, reqId))
    accepted.push({ roomId: tRoom1, messageId: mid, text, requestId: reqId, operationId: r.operationId })
  }
  // 10 sends to room 2 (cross-room!)
  for (let i = 0; i < 10; i++) {
    const mid = randomUUID()
    const reqId = randomUUID()
    const text = `T2 message ${i}`
    const r = success(await invoke(throttleUser, 'sendRoomMessage', { roomId: tRoom2, messageId: mid, text }, reqId))
    accepted.push({ roomId: tRoom2, messageId: mid, text, requestId: reqId, operationId: r.operationId })
  }
  assert.equal(accepted.length, 20)

  // 21st send attempt (in either room) MUST be throttled!
  const rejectedMsgId = randomUUID()
  const throttledRes = await invoke(throttleUser, 'sendRoomMessage', { roomId: tRoom1, messageId: rejectedMsgId, text: '21st message' })
  assert.equal(throttledRes.body.error?.status, 'RESOURCE_EXHAUSTED')
  assert.equal(throttledRes.body.error?.details?.code, 'throttled')
  assert.ok(typeof throttledRes.body.error?.details?.retryAt === 'number')
  assert.ok(throttledRes.body.error?.details?.retryAt > Date.now())

  // Rejected send did NOT write message doc:
  const rejectedDoc = await adminRead(`rooms/${tRoom1}/messages/${rejectedMsgId}`)
  assert.equal(rejectedDoc.status, 404)

  // Replay of an accepted send does NOT consume and is NOT blocked by throttle:
  const firstAccepted = accepted[0]
  const replayRes = success(await invoke(throttleUser, 'sendRoomMessage', { roomId: firstAccepted.roomId, messageId: firstAccepted.messageId, text: firstAccepted.text }, firstAccepted.requestId))
  assert.equal(replayRes.messageId, firstAccepted.messageId)
})

test('private text-free receipts and preservation of active AI fences and accounting', async () => {
  const owner = await account()
  const roomId = await createRoom(owner, 'Receipt and AI Room')

  // Set AI fence and maintenance fields on room doc
  await adminPatch(`rooms/${roomId}`, {
    maintenanceId: { stringValue: 'maint-active-fence-99' },
    aiFence: { stringValue: 'active' },
    generation: { mapValue: { fields: { state: { stringValue: 'pending' }, promptMessageId: { stringValue: randomUUID() } } } },
    aiBudgetReserved: { integerValue: '250' },
  })

  const secretText = 'CONFIDENTIAL-PLAIN-TEXT-DO-NOT-LEAK-IN-RECEIPT'
  const messageId = randomUUID()
  const requestId = randomUUID()

  // Human send succeeds despite active AI fence and maintenance
  const sendRes = success(await invoke(owner, 'sendRoomMessage', { roomId, messageId, text: secretText }, requestId))
  assert.equal(sendRes.messageId, messageId)

  // 1. Text-free receipt verification via admin read
  const receiptResponse = await adminRead(`receipts/${sendRes.operationId}`)
  assert.equal(receiptResponse.status, 200)
  const receiptText = await receiptResponse.text()
  assert.equal(receiptText.includes(secretText), false)

  const receiptDoc = JSON.parse(receiptText)
  assert.equal(receiptDoc.fields.operationId?.stringValue, sendRes.operationId)
  assert.equal(receiptDoc.fields.roomId?.stringValue, roomId)
  assert.equal(receiptDoc.fields.messageId?.stringValue, messageId)
  assert.ok(receiptDoc.fields.seq?.integerValue)
  assert.ok(receiptDoc.fields.payloadHash?.stringValue)
  assert.equal(receiptDoc.fields.text, undefined)

  // 2. Recovery via getOperation projects messageId/seq without text
  const recovered = success(await invoke(owner, 'getOperation', { operationId: sendRes.operationId }))
  assert.equal(recovered.operationId, sendRes.operationId)
  assert.equal(recovered.status, 'complete')
  assert.equal(recovered.roomId, roomId)
  assert.equal(recovered.messageId, messageId)
  assert.equal(recovered.seq, sendRes.seq)
  assert.equal(recovered.text, undefined)
  assert.equal(JSON.stringify(recovered).includes(secretText), false)

  // 3. AI fence and maintenance fields on room doc are completely untouched
  const roomDocAfter = await (await adminRead(`rooms/${roomId}`)).json()
  assert.equal(roomDocAfter.fields.maintenanceId?.stringValue, 'maint-active-fence-99')
  assert.equal(roomDocAfter.fields.aiFence?.stringValue, 'active')
  assert.equal(roomDocAfter.fields.generation?.mapValue?.fields?.state?.stringValue, 'pending')
  assert.equal(roomDocAfter.fields.aiBudgetReserved?.integerValue, '250')
  assert.equal(roomDocAfter.fields.nextSeq?.integerValue, '2')

  // 4. Budgets and generations collections are untouched
  const budgetsRes = await adminRead('budgets')
  const budgetsData = await budgetsRes.json()
  assert.equal(budgetsData.documents, undefined)

  const generationsRes = await adminRead(`rooms/${roomId}/generations`)
  const generationsData = await generationsRes.json()
  assert.equal(generationsData.documents, undefined)
})
