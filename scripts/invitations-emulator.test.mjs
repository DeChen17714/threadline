import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { initializeApp } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'

import { PROJECT_ID, commandEndpoint, documentsBaseUrl, authSignUpUrl } from './emulator-test-env.mjs'

const project = PROJECT_ID
const endpoint = commandEndpoint
const dataUrl = documentsBaseUrl('(default)')
const adminHeaders = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' }

const { handleCreateRoom } = await import('../functions/dist/handlers/createRoom.js')
const {
  handleIssueInvite,
  handleRevokeInvite,
  handleRequestJoin,
  handleDecideJoin,
} = await import('../functions/dist/handlers/invitations.js')

async function account() {
  const r = await fetch(authSignUpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: `${randomUUID()}@example.test`, password: randomUUID(), returnSecureToken: true }),
  })
  assert.equal(r.status, 200)
  return r.json()
}

async function invoke(user, operation, input, requestId = randomUUID()) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'http://127.0.0.1:5174',
      ...(user ? { Authorization: `Bearer ${user.idToken}` } : {}),
    },
    body: JSON.stringify({ data: { operation, input, requestId } }),
  })
  return { status: response.status, body: await response.json() }
}

function success(r) {
  assert.equal(r.status, 200)
  assert.ok(!r.body.error)
  return r.body.result
}

async function room(owner) {
  return success(await invoke(owner, 'createRoom', { name: 'Invitation privacy room', description: 'Private description' })).roomId
}

async function read(user, roomId) {
  return fetch(`${dataUrl}/rooms/${roomId}`, { headers: { Authorization: `Bearer ${user.idToken}` } })
}

async function patch(path, fields) {
  const keys = Object.keys(fields).map((k) => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&')
  const r = await fetch(`${dataUrl}/${path}?${keys}`, { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ fields }) })
  assert.equal(r.status, 200)
}

test('once-only hash invitation admission, request/approval lifecycle, rotation/revoke replay and privacy', async () => {
  const owner = await account(), member = await account(), otherApplicant = await account(), outsider = await account()
  const roomId = await room(owner)
  const requestId = randomUUID()
  const issued = success(await invoke(owner, 'issueInvite', { roomId }, requestId))
  assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/)
  assert.equal(Buffer.from(issued.token, 'base64url').length, 32)
  assert.ok(issued.expiresAt > Date.now() + 23 * 60 * 60 * 1000 && issued.expiresAt <= Date.now() + 24 * 60 * 60 * 1000)

  const hash = createHash('sha256').update(issued.token).digest('hex')
  const stored = await fetch(`${dataUrl}/invites/${hash}`, { headers: adminHeaders }).then((r) => r.json())
  assert.ok(stored.fields)
  assert.equal(JSON.stringify(stored).includes(issued.token), false)

  const replay = success(await invoke(owner, 'issueInvite', { roomId }, requestId))
  assert.equal(replay.token, undefined)
  assert.equal(replay.tokenUnavailable, true)
  assert.equal(replay.operationId, issued.operationId)

  const metadata = success(await invoke(owner, 'getOperation', { operationId: issued.operationId }))
  assert.equal(metadata.token, undefined)
  assert.equal(metadata.tokenUnavailable, true)
  assert.notEqual((await invoke(outsider, 'getOperation', { operationId: issued.operationId })).status, 200)

  const receipt = await fetch(`${dataUrl}/receipts/${issued.operationId}`, { headers: adminHeaders }).then((r) => r.json())
  assert.equal(JSON.stringify(receipt).includes(issued.token), false)

  assert.notEqual((await invoke(outsider, 'issueInvite', { roomId })).status, 200)
  assert.notEqual((await invoke(outsider, 'revokeInvite', { roomId })).status, 200)
  assert.notEqual((await invoke(null, 'requestJoin', { token: issued.token })).status, 200)

  // 6.3-AC5: Keep obsolete preview/join tests AUTHENTICATED to prove routes are removed
  for (const authUser of [member, outsider]) {
    for (const action of ['previewInvite', 'joinRoom']) {
      const denied = await invoke(authUser, action, { token: issued.token })
      assert.notEqual(denied.status, 200)
      assert.equal(denied.body.result, undefined)
      assert.equal(JSON.stringify(denied.body).includes('Private description'), false)
    }
  }

  // 6.3-AC1: Pre-admission outsider 403
  assert.equal((await read(member, roomId)).status, 403)

  // 6.3-AC1: Authenticated applicant requests access; pending discloses no room name/description/members/transcript
  const memberRequestId = randomUUID()
  const requested = success(await invoke(member, 'requestJoin', { token: issued.token }, memberRequestId))
  assert.equal(requested.joinRequestId, memberRequestId)
  assert.equal(requested.joinStatus, 'pending')
  assert.equal(requested.roomId, undefined)
  assert.equal((await read(member, roomId)).status, 403)

  // 6.3-AC1, 6.3-AC2: Firestore Security Rules 403 for applicant AND owner reading private joinRequests directly
  assert.equal((await fetch(`${dataUrl}/joinRequests/${memberRequestId}`, { headers: { Authorization: `Bearer ${member.idToken}` } })).status, 403)
  assert.equal((await fetch(`${dataUrl}/joinRequests/${memberRequestId}`, { headers: { Authorization: `Bearer ${owner.idToken}` } })).status, 403)
  assert.equal((await fetch(`${dataUrl}/joinRequests/${memberRequestId}`, { headers: { Authorization: `Bearer ${outsider.idToken}` } })).status, 403)
  assert.equal((await fetch(`${dataUrl}/joinRequests`, { headers: { Authorization: `Bearer ${member.idToken}` } })).status, 403)
  assert.equal((await fetch(`${dataUrl}/joinRequests`, { headers: { Authorization: `Bearer ${owner.idToken}` } })).status, 403)
  assert.equal((await fetch(`${dataUrl}/joinQueues/${roomId}`, { headers: { Authorization: `Bearer ${member.idToken}` } })).status, 403)
  assert.equal((await fetch(`${dataUrl}/joinQueues/${roomId}`, { headers: { Authorization: `Bearer ${owner.idToken}` } })).status, 403)

  // Server-side private joinRequest document does not store raw token
  const reqDoc = await fetch(`${dataUrl}/joinRequests/${memberRequestId}`, { headers: adminHeaders }).then((r) => r.json())
  assert.ok(reqDoc.fields)
  assert.equal(JSON.stringify(reqDoc).includes(issued.token), false)
  assert.equal(reqDoc.fields.applicantUid.stringValue, member.localId)
  assert.equal(reqDoc.fields.status.stringValue, 'pending')

  // 6.3-AC2: Applicant reload retrieves only their own status, without room metadata
  const ownStatus = success(await invoke(member, 'getJoinStatus', { joinRequestId: memberRequestId }))
  assert.equal(ownStatus.joinRequestId, memberRequestId)
  assert.equal(ownStatus.joinStatus, 'pending')
  assert.equal(ownStatus.roomId, undefined)

  // 6.3-AC2: Another applicant or outsider cannot view status, list, or decide
  const otherStatus = await invoke(otherApplicant, 'getJoinStatus', { joinRequestId: memberRequestId })
  assert.notEqual(otherStatus.status, 200)
  assert.equal(otherStatus.body.error?.details?.code, 'forbidden')

  const outsiderStatus = await invoke(outsider, 'getJoinStatus', { joinRequestId: memberRequestId })
  assert.notEqual(outsiderStatus.status, 200)
  assert.equal(outsiderStatus.body.error?.details?.code, 'forbidden')

  const memberList = await invoke(member, 'listJoinRequests', { roomId })
  assert.notEqual(memberList.status, 200)
  assert.equal(memberList.body.error?.details?.code, 'forbidden')

  const otherList = await invoke(otherApplicant, 'listJoinRequests', { roomId })
  assert.notEqual(otherList.status, 200)
  assert.equal(otherList.body.error?.details?.code, 'forbidden')

  const otherDecide = await invoke(otherApplicant, 'decideJoin', { roomId, joinRequestId: memberRequestId, decision: 'approve' })
  assert.notEqual(otherDecide.status, 200)
  assert.equal(otherDecide.body.error?.details?.code, 'forbidden')

  const outsiderDecide = await invoke(outsider, 'decideJoin', { roomId, joinRequestId: memberRequestId, decision: 'approve' })
  assert.notEqual(outsiderDecide.status, 200)
  assert.equal(outsiderDecide.body.error?.details?.code, 'forbidden')

  // 6.3-AC2: Creator viewing bounded request list has applicant UID, label, expiry
  const list = success(await invoke(owner, 'listJoinRequests', { roomId }))
  const entry = list.joinRequests.find((r) => r.joinRequestId === memberRequestId)
  assert.ok(entry)
  assert.equal(entry.applicantUid, member.localId)
  assert.ok(entry.expiresAt > Date.now())

  // 6.3-AC3: Creator approves request atomically
  const approved = success(await invoke(owner, 'decideJoin', { roomId, joinRequestId: memberRequestId, decision: 'approve' }))
  assert.equal(approved.joinRequestId, memberRequestId)
  assert.equal(approved.joinStatus, 'approved')

  // 6.3-AC3: Duplicate approval adds membership at most once (idempotent)
  const dupApproved = success(await invoke(owner, 'decideJoin', { roomId, joinRequestId: memberRequestId, decision: 'approve' }))
  assert.equal(dupApproved.joinStatus, 'approved')

  // Approved member status now yields roomId and read access
  const memberApprovedStatus = success(await invoke(member, 'getJoinStatus', { joinRequestId: memberRequestId }))
  assert.equal(memberApprovedStatus.joinStatus, 'approved')
  assert.equal(memberApprovedStatus.roomId, roomId)
  assert.equal((await read(member, roomId)).status, 200)

  const current = await fetch(`${dataUrl}/rooms/${roomId}`, { headers: adminHeaders }).then((r) => r.json())
  assert.equal(current.fields.memberIds.arrayValue.values.filter((x) => x.stringValue === member.localId).length, 1)

  const publicRoomBody = await (await read(member, roomId)).text()
  assert.equal(publicRoomBody.includes(issued.token), false)
  assert.equal(publicRoomBody.includes(hash), false)

  // Replay requestJoin with schema-valid 43char different token asserts conflict specifically
  const altSchemaToken = createHash('sha256').update('alt-fixture-valid-seed').digest('base64url')
  const conflictReplay = await invoke(member, 'requestJoin', { token: altSchemaToken }, memberRequestId)
  assert.notEqual(conflictReplay.status, 200)
  assert.equal(conflictReplay.body.error?.details?.code, 'conflict')

  // 6.3-AC2, 6.3-AC3: Approved current member STILL retains 'approved' status after link rotate and revoke
  const replacement = success(await invoke(owner, 'issueInvite', { roomId }))
  assert.notEqual(replacement.token, issued.token)

  const statusAfterRotate = success(await invoke(member, 'getJoinStatus', { joinRequestId: memberRequestId }))
  assert.equal(statusAfterRotate.joinStatus, 'approved')
  assert.equal(statusAfterRotate.roomId, roomId)

  // Old rotated token cannot requestJoin
  const rotatedDenied = await invoke(outsider, 'requestJoin', { token: issued.token })
  assert.notEqual(rotatedDenied.status, 200)
  assert.equal(rotatedDenied.body.error?.details?.code, 'forbidden')

  // Revoke invite link
  success(await invoke(owner, 'revokeInvite', { roomId }))

  // Approved member still retains approved status after revocation
  const statusAfterRevoke = success(await invoke(member, 'getJoinStatus', { joinRequestId: memberRequestId }))
  assert.equal(statusAfterRevoke.joinStatus, 'approved')
  assert.equal(statusAfterRevoke.roomId, roomId)
  assert.equal((await read(member, roomId)).status, 200)

  // Revoked token cannot requestJoin
  const revokedDenied = await invoke(outsider, 'requestJoin', { token: replacement.token })
  assert.notEqual(revokedDenied.status, 200)
  assert.equal(revokedDenied.body.error?.details?.code, 'forbidden')
  assert.equal((await read(outsider, roomId)).status, 403)
})

test('expiry, capacity and invalidation serialize admission and do not leak invalid-room metadata', async () => {
  const owner = await account(), a = await account(), b = await account()
  const roomId = await room(owner)
  const issued = success(await invoke(owner, 'issueInvite', { roomId }))
  const hash = createHash('sha256').update(issued.token).digest('hex')

  // Expired invite rejection
  await patch(`invites/${hash}`, { expiresAt: { timestampValue: new Date(Date.now() - 1000).toISOString() } })
  const expiredJoin = await invoke(a, 'requestJoin', { token: issued.token })
  assert.notEqual(expiredJoin.status, 200)
  assert.equal(expiredJoin.body.error?.details?.code, 'forbidden')

  // Capacity race (20 member capacity checked atomically on decideJoin)
  const fresh = success(await invoke(owner, 'issueInvite', { roomId }))
  const existing = [owner.localId, ...Array.from({ length: 18 }, () => randomUUID())]
  await patch(`rooms/${roomId}`, {
    memberIds: { arrayValue: { values: existing.map((uid) => ({ stringValue: uid })) } },
    members: { arrayValue: { values: existing.map((uid) => ({ mapValue: { fields: { uid: { stringValue: uid }, label: { stringValue: 'Fixture member' } } } })) } },
  })

  const reqA = success(await invoke(a, 'requestJoin', { token: fresh.token }))
  const reqB = success(await invoke(b, 'requestJoin', { token: fresh.token }))
  assert.equal(reqA.joinStatus, 'pending')
  assert.equal(reqB.joinStatus, 'pending')

  // Race approvals when room is at 19/20 capacity
  const results = await Promise.all([
    invoke(owner, 'decideJoin', { roomId, joinRequestId: reqA.joinRequestId, decision: 'approve' }),
    invoke(owner, 'decideJoin', { roomId, joinRequestId: reqB.joinRequestId, decision: 'approve' }),
  ])
  assert.equal(results.filter((r) => r.status === 200).length, 1)

  const loserRes = results.find((r) => r.status !== 200)
  assert.ok(loserRes)
  assert.equal(loserRes.body.error?.details?.code, 'room-busy')

  const after = await fetch(`${dataUrl}/rooms/${roomId}`, { headers: adminHeaders }).then((r) => r.json())
  assert.equal(after.fields.memberIds.arrayValue.values.length, 20)

  const winner = results[0].status === 200 ? a : b
  const loser = results[0].status === 200 ? b : a
  assert.equal((await read(winner, roomId)).status, 200)
  assert.equal((await read(loser, roomId)).status, 403)

  // 6.3-AC3: Concurrent approve-vs-revoke race boundary
  const raceRevokeRoom = await room(owner)
  const raceRevokeInvite = success(await invoke(owner, 'issueInvite', { roomId: raceRevokeRoom }))
  const pendingRevokeReq = success(await invoke(a, 'requestJoin', { token: raceRevokeInvite.token }))

  const [approveRevokeRes, revokeRes] = await Promise.all([
    invoke(owner, 'decideJoin', { roomId: raceRevokeRoom, joinRequestId: pendingRevokeReq.joinRequestId, decision: 'approve' }),
    invoke(owner, 'revokeInvite', { roomId: raceRevokeRoom }),
  ])
  assert.equal(revokeRes.status, 200)
  if (approveRevokeRes.status === 200) {
    assert.equal(approveRevokeRes.body.result?.joinStatus, 'approved')
    assert.equal((await read(a, raceRevokeRoom)).status, 200)
  } else {
    assert.equal(approveRevokeRes.body.error?.details?.code, 'conflict')
    assert.equal((await read(a, raceRevokeRoom)).status, 403)
  }

  // An already committed approval may replay, but invalidated pending work cannot admit.
  const postRevokeApprove = await invoke(owner, 'decideJoin', { roomId: raceRevokeRoom, joinRequestId: pendingRevokeReq.joinRequestId, decision: 'approve' })
  if (approveRevokeRes.status === 200) {
    assert.equal(success(postRevokeApprove).joinStatus, 'approved')
  } else {
    assert.notEqual(postRevokeApprove.status, 200)
    assert.equal(postRevokeApprove.body.error?.details?.code, 'conflict')
  }

  // 6.3-AC3: Concurrent approve-vs-deletion race boundary
  const raceDeleteRoom = await room(owner)
  const raceDelInvite = success(await invoke(owner, 'issueInvite', { roomId: raceDeleteRoom }))
  const pendingDelReq = success(await invoke(b, 'requestJoin', { token: raceDelInvite.token }))

  const [approveDelRes, deleteRes] = await Promise.all([
    invoke(owner, 'decideJoin', { roomId: raceDeleteRoom, joinRequestId: pendingDelReq.joinRequestId, decision: 'approve' }),
    invoke(owner, 'deleteRoom', { roomId: raceDeleteRoom }),
  ])
  assert.equal(deleteRes.status, 200)
  if (approveDelRes.status === 200) {
    assert.equal(approveDelRes.body.result?.joinStatus, 'approved')
  } else {
    assert.notEqual(approveDelRes.status, 200)
    assert.equal((await read(b, raceDeleteRoom)).status, 403)
  }

  // Must never approve after deletion
  const postDeleteApprove = await invoke(owner, 'decideJoin', { roomId: raceDeleteRoom, joinRequestId: pendingDelReq.joinRequestId, decision: 'approve' })
  assert.notEqual(postDeleteApprove.status, 200)
})

test('deterministic direct-handler edge tests: 20 active queue limit, bounded expired-slot reconciliation, sliding 3-attempt cooldown, and duplicate suppression', async () => {
  const edgeDb = getFirestore(initializeApp({ projectId: 'demo-threadline' }, 'join-edge-regressions'), 'join-edge-regressions')
  const runPrefix = randomUUID().slice(0, 8)
  const queueUid = (i) => `queue-${runPrefix}-app-${i}`
  const ownerUid = `edge-owner-${runPrefix}`

  const { roomId } = await handleCreateRoom(edgeDb, ownerUid, 'Edge Owner', randomUUID(), {
    name: 'Edge Queue Room',
    description: 'Deterministic queue bounds and sliding cooldown tests',
  })
  const invite = await handleIssueInvite(edgeDb, ownerUid, randomUUID(), { roomId })
  assert.ok(invite.token)

  // 1. 20 active room requests limit (6.3-AC4)
  const firstReqId = randomUUID()
  const firstReq = await handleRequestJoin(edgeDb, queueUid(0), 'Applicant 0', firstReqId, { token: invite.token })
  assert.equal(firstReq.joinStatus, 'pending')

  for (let i = 1; i < 20; i++) {
    const res = await handleRequestJoin(edgeDb, queueUid(i), `Applicant ${i}`, randomUUID(), { token: invite.token })
    assert.equal(res.joinStatus, 'pending')
  }

  // 21st active request rejected with safe details.code === 'room-busy'
  await assert.rejects(
    async () => {
      await handleRequestJoin(edgeDb, queueUid(20), 'Applicant 20', randomUUID(), { token: invite.token })
    },
    (err) => err.details?.code === 'room-busy'
  )

  // Bounded expired-slot reconciliation: expire the 1st request
  await edgeDb.collection('joinRequests').doc(firstReqId).update({
    expiresAt: Timestamp.fromMillis(Date.now() - 60_000),
  })

  // Now applicant 20 request succeeds and reconciles the expired slot
  const reconciledReqId = randomUUID()
  const reconciledRes = await handleRequestJoin(edgeDb, queueUid(20), 'Applicant 20', reconciledReqId, { token: invite.token })
  assert.equal(reconciledRes.joinStatus, 'pending')

  const reconciledDoc = await edgeDb.collection('joinRequests').doc(firstReqId).get()
  assert.equal(reconciledDoc.data()?.status, 'expired')

  // 2. Duplicate active request does not create multiple queue entries or bypass (6.3-AC4)
  const dupAttempt = await handleRequestJoin(edgeDb, queueUid(20), 'Applicant 20', randomUUID(), { token: invite.token })
  assert.equal(dupAttempt.joinRequestId, reconciledReqId)
  assert.equal(dupAttempt.joinStatus, 'pending')

  const activeApplicant20Docs = await edgeDb.collection('joinRequests').where('roomId', '==', roomId).where('applicantUid', '==', queueUid(20)).get()
  assert.equal(activeApplicant20Docs.size, 1)

  // Changed-payload replay on direct handler with valid 43char token asserts conflict
  const altDirectToken = createHash('sha256').update('alt-direct-token-seed').digest('base64url')
  await assert.rejects(
    async () => {
      await handleRequestJoin(edgeDb, queueUid(0), 'Applicant 0', firstReqId, { token: altDirectToken })
    },
    (err) => err.details?.code === 'conflict'
  )

  // 3. Sliding 3 attempts / UID / 10 min rate limit across deterministic Date.now boundary (6.3-AC4)
  const realNow = Date.now
  let currentMs = 1_700_000_000_000
  Date.now = () => currentMs

  try {
    const slidingUid = `sliding-${runPrefix}-${randomUUID()}`
    const rooms = []
    const invites = []
    for (let i = 0; i < 5; i++) {
      const r = await handleCreateRoom(edgeDb, ownerUid, 'Owner', randomUUID(), { name: `Cooldown Room ${i}`, description: '' })
      rooms.push(r.roomId)
      invites.push(await handleIssueInvite(edgeDb, ownerUid, randomUUID(), { roomId: r.roomId }))
    }

    // T0: Attempt 1
    currentMs = 1_700_000_000_000
    const sReq0 = await handleRequestJoin(edgeDb, slidingUid, 'Slider', randomUUID(), { token: invites[0].token })
    assert.equal(sReq0.joinStatus, 'pending')

    // T0 + 2m: Attempt 2
    currentMs = 1_700_000_000_000 + 120_000
    const sReq1 = await handleRequestJoin(edgeDb, slidingUid, 'Slider', randomUUID(), { token: invites[1].token })
    assert.equal(sReq1.joinStatus, 'pending')

    // T0 + 5m: Attempt 3
    currentMs = 1_700_000_000_000 + 300_000
    const sReq2 = await handleRequestJoin(edgeDb, slidingUid, 'Slider', randomUUID(), { token: invites[2].token })
    assert.equal(sReq2.joinStatus, 'pending')

    // T0 + 8m: Advance across intermediate boundary; all 3 attempts remain <10min old (8m, 6m, 3m old).
    // Attempt 4 must still throttle:
    currentMs = 1_700_000_000_000 + 480_000
    await assert.rejects(
      async () => {
        await handleRequestJoin(edgeDb, slidingUid, 'Slider', randomUUID(), { token: invites[3].token })
      },
      (err) => err.details?.code === 'throttled'
    )

    // Rejecting attempt 0 does NOT reset cooldown:
    await handleDecideJoin(edgeDb, ownerUid, randomUUID(), { roomId: rooms[0], joinRequestId: sReq0.joinRequestId, decision: 'reject' })
    await assert.rejects(
      async () => {
        await handleRequestJoin(edgeDb, slidingUid, 'Slider', randomUUID(), { token: invites[3].token })
      },
      (err) => err.details?.code === 'throttled'
    )

    // Rotating invite on room 1 does NOT reset cooldown:
    const rotated1 = await handleIssueInvite(edgeDb, ownerUid, randomUUID(), { roomId: rooms[1] })
    await assert.rejects(
      async () => {
        await handleRequestJoin(edgeDb, slidingUid, 'Slider', randomUUID(), { token: rotated1.token })
      },
      (err) => err.details?.code === 'throttled'
    )

    // T0 + 11m: Advance past 10min from attempt 0.
    // Attempt 0 (at T0) is 11m old (> 10m, expired from sliding window).
    // Attempts 1 and 2 (at T0+2m, T0+5m) are 9m and 6m old (< 10m, active).
    // Exactly ONE slot opens!
    currentMs = 1_700_000_000_000 + 660_000
    const sReq3 = await handleRequestJoin(edgeDb, slidingUid, 'Slider', randomUUID(), { token: invites[3].token })
    assert.equal(sReq3.joinStatus, 'pending')

    // Attempt 5 at T0 + 11m must throttle again (3 attempts active in sliding window):
    await assert.rejects(
      async () => {
        await handleRequestJoin(edgeDb, slidingUid, 'Slider', randomUUID(), { token: invites[4].token })
      },
      (err) => err.details?.code === 'throttled'
    )

    // 4. Stale / expired / rotated decisions cannot grant (6.3-AC3, 6.3-AC4)
    // Already rejected request cannot be approved
    await assert.rejects(
      async () => {
        await handleDecideJoin(edgeDb, ownerUid, randomUUID(), { roomId: rooms[0], joinRequestId: sReq0.joinRequestId, decision: 'approve' })
      },
      (err) => err.details?.code === 'conflict'
    )

    // Request on rotated invite cannot be approved
    await assert.rejects(
      async () => {
        await handleDecideJoin(edgeDb, ownerUid, randomUUID(), { roomId: rooms[1], joinRequestId: sReq1.joinRequestId, decision: 'approve' })
      },
      (err) => err.details?.code === 'conflict'
    )

    // Expired request cannot be approved
    await edgeDb.collection('joinRequests').doc(sReq2.joinRequestId).update({
      expiresAt: Timestamp.fromMillis(currentMs - 60_000),
    })
    await assert.rejects(
      async () => {
        await handleDecideJoin(edgeDb, ownerUid, randomUUID(), { roomId: rooms[2], joinRequestId: sReq2.joinRequestId, decision: 'approve' })
      },
      (err) => err.details?.code === 'conflict'
    )
  } finally {
    Date.now = realNow
  }
})

test('request collisions and stale receipt replays never replace applicants or restore access', async () => {
  const db = getFirestore(initializeApp({ projectId: project }, `join-replay-${randomUUID()}`), 'join-replay-regressions')
  const owner = `owner-${randomUUID()}`
  const applicant = `applicant-${randomUUID()}`
  const other = `other-${randomUUID()}`
  const { roomId } = await handleCreateRoom(db, owner, 'Owner', randomUUID(), { name: 'Replay boundaries', description: '' })
  const invite = await handleIssueInvite(db, owner, randomUUID(), { roomId })
  const joinRequestId = randomUUID()
  await handleRequestJoin(db, applicant, 'Applicant', joinRequestId, { token: invite.token })
  await assert.rejects(
    handleRequestJoin(db, other, 'Other', joinRequestId, { token: invite.token }),
    (error) => error.details?.code === 'conflict',
  )
  assert.equal((await db.collection('joinRequests').doc(joinRequestId).get()).data().applicantUid, applicant)
  const decisionId = randomUUID()
  await handleDecideJoin(db, owner, decisionId, { roomId, joinRequestId, decision: 'approve' })
  await db.collection('rooms').doc(roomId).update({ memberIds: [owner], members: [{ uid: owner, label: 'Owner' }] })
  await handleDecideJoin(db, owner, randomUUID(), { roomId, joinRequestId, decision: 'approve' })
  assert.deepEqual((await db.collection('rooms').doc(roomId).get()).data().memberIds, [owner])
  await db.collection('rooms').doc(roomId).update({ creatorId: other })
  await assert.rejects(
    handleDecideJoin(db, owner, decisionId, { roomId, joinRequestId, decision: 'approve' }),
    (error) => error.details?.code === 'forbidden',
  )
  await db.collection('rooms').doc(roomId).update({ creatorId: owner })
  const pendingId = randomUUID()
  await handleRequestJoin(db, other, 'Other', pendingId, { token: invite.token })
  await handleRevokeInvite(db, owner, randomUUID(), { roomId })
  const replay = await handleRequestJoin(db, other, 'Other', pendingId, { token: invite.token })
  assert.equal(replay.joinStatus, 'expired')
  assert.equal(replay.roomId, undefined)
  assert.deepEqual((await db.collection('rooms').doc(roomId).get()).data().memberIds, [owner])
})
