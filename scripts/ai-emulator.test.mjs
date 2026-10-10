import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { initializeApp } from 'firebase-admin/app'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { commandSchema } from '@threadline/shared'

import { authSignUpUrl } from './emulator-test-env.mjs'

import {
  handleAskThreadline,
  handleRetryAiReply,
} from '../functions/dist/ai/lifecycle.js'
import {
  parseAnswer,
  prepareContext,
  MODEL,
} from '../functions/dist/ai/provider.js'
import { handleRecoverGeneration } from '../functions/dist/ai/recovery.js'
import {
  handleDeleteRoom,
  handleResumeMaintenance,
} from '../functions/dist/handlers/maintenance.js'
import { handleCreateRoom } from '../functions/dist/handlers/createRoom.js'
import { handleSendRoomMessage } from '../functions/dist/handlers/sendRoomMessage.js'
import { handleEditMessage, handleDeleteMessage } from '../functions/dist/handlers/messageMutations.js'

export function createControlledModeration({
  verdict = 'allow',
  policyVersion = 'threadline-moderation-v1',
  reason = null,
  onScreen,
  failScreen,
} = {}) {
  let screenCalls = 0
  return {
    get screenCalls() { return screenCalls },
    async screen(text, signal) {
      screenCalls++
      if (onScreen) await onScreen(text, signal)
      if (failScreen) throw failScreen
      return {
        verdict,
        policyVersion,
        reason: verdict === 'block' ? (reason ?? 'policy-blocked') : null,
      }
    },
  }
}

// A named emulator database prevents controlled qualification fixtures from enabling
// the live-key callable or changing a developer's default-database counters.
const db = getFirestore(initializeApp({ projectId: 'demo-threadline' }, 'threadline-ai-regressions'), 'ai-regressions')

const BUDGET_ID = 'threadline'
const RESERVATION_MICRO_USD = 30000
const VALID_PRICING_EXPIRY = Date.UTC(2026, 11, 31)

function createControlledProvider({
  countTokens = 60,
  answerText = 'Deterministic controlled AI answer for regression testing.',
  answerTokens = 25,
  thoughtTokens = 5,
  onGenerate,
  onCount,
  failCount,
  failGenerate,
} = {}) {
  let countCalls = 0
  let generateCalls = 0
  return {
    get countCalls() { return countCalls },
    get generateCalls() { return generateCalls },
    async count(contents, signal) {
      countCalls++
      if (onCount) await onCount(contents, signal)
      if (failCount) throw failCount
      return countTokens
    },
    async generate(context, signal) {
      generateCalls++
      if (onGenerate) await onGenerate(context, signal)
      if (failGenerate) throw failGenerate
      return {
        text: answerText,
        inputTokens: context.inputTokens ?? countTokens,
        answerTokens,
        thoughtTokens,
      }
    },
  }
}

async function createTestAccount() {
  const response = await fetch(
    authSignUpUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `${randomUUID()}@example.test`,
        password: randomUUID(),
        returnSecureToken: true,
      }),
    }
  )
  if (!response.ok) throw new Error('The isolated Auth emulator must be running for AI regressions.')
  const data = await response.json()
  if (typeof data.localId !== 'string') throw new Error('Auth emulator did not create the fixture account.')
  return { localId: data.localId, email: data.email }
}

async function createTestRoom(ownerUid, ownerLabel = 'Owner') {
  const result = await handleCreateRoom(
    db,
    ownerUid,
    ownerLabel,
    randomUUID(),
    { name: `AI Test Room ${randomUUID().slice(0, 8)}`, description: 'Isolated test room' }
  )
  return result.roomId
}

async function addRoomMember(roomId, memberUid) {
  await db.collection('rooms').doc(roomId).update({
    memberIds: FieldValue.arrayUnion(memberUid),
  })
}

async function setQualifiedBudget(overrides = {}) {
  const budgetRef = db.collection('budgets').doc(BUDGET_ID)
  await budgetRef.set({
    model: MODEL,
    qualified: true,
    paidServicesVerified: true,
    safetyPolicy: 'medium-and-above-v1',
    reservationMicroUsd: RESERVATION_MICRO_USD,
    pricingExpiresAt: VALID_PRICING_EXPIRY,
    allowanceMicroUsd: 5000000,
    consumedMicroUsd: 0,
    reservedMicroUsd: 0,
    ...overrides,
  })
}

async function resetSharedBudget(overrides = {}) {
  const budgetRef = db.collection('budgets').doc(BUDGET_ID)
  await budgetRef.set({
    model: MODEL,
    qualified: false,
    paidServicesVerified: false,
    safetyPolicy: 'medium-and-above-v1',
    reservationMicroUsd: RESERVATION_MICRO_USD,
    pricingExpiresAt: VALID_PRICING_EXPIRY,
    allowanceMicroUsd: 5000000,
    consumedMicroUsd: 0,
    reservedMicroUsd: 0,
    ...overrides,
  })
}
function createSyntheticConversion(overrides = {}) {
  const now = Date.now()
  return {
    sources: ['Synthetic BNM Rate 2026-10-08', 'Synthetic Cloud Billing Prepay Verification'],
    reviewedAt: now - 60000,
    expiresAt: now + 86400000 * 30,
    rateMicroMyrPerUsd: 4500000,
    headroomBps: 1000,
    remainingFundsMicroMyr: 50000000,
    alreadyConsumedMicroUsd: 0,
    ...overrides,
  }
}

async function setHostedQualifiedBudget(overrides = {}) {
  const conversionOverrides = overrides.conversion
  const restOverrides = { ...overrides }
  delete restOverrides.conversion
  const conversion = createSyntheticConversion(conversionOverrides)
  const budgetRef = db.collection('budgets').doc(BUDGET_ID)
  await budgetRef.set({
    model: MODEL,
    qualified: true,
    paidServicesVerified: true,
    safetyPolicy: 'medium-and-above-v1',
    reservationMicroUsd: RESERVATION_MICRO_USD,
    pricingExpiresAt: VALID_PRICING_EXPIRY,
    allowanceMicroUsd: 4000000,
    consumedMicroUsd: 0,
    reservedMicroUsd: 0,
    conversion,
    ...restOverrides,
  })
}

test.beforeEach(async () => {
  await setQualifiedBudget()
})

test.after(async () => {
  // Controlled qualification flags are test-fixture-only, not real clearance.
  // Leave shared budget qualified=false at test end so no real key can be called by accident.
  await resetSharedBudget()
})

const localPolicy = { localDevelopment: true, testerUids: [] }
async function failedAsk(user, roomId, provider = createControlledProvider({ failGenerate: new Error('Controlled provider failure') })) {
  const promptMessageId = randomUUID()
  const result = await handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId, messageId: promptMessageId, text: 'Synthetic question whose original context must be preserved' }, localPolicy, provider, createControlledModeration())
  assert.equal(result.status, 'failed')
  const generationId = (await db.collection('rooms').doc(roomId).get()).data().latestGenerationId
  return { roomId, promptMessageId, generationId }
}

// ---------------------------------------------------------------------------
// 1. parseAnswer on truncated/empty/thought-only/overcap output
// ---------------------------------------------------------------------------
test('only complete, bounded public answers with valid usage can be published', () => {
  const candidate = { finishReason: 'STOP', content: { parts: [{ text: 'Complete answer.' }] } }
  const usage = { promptTokenCount: 8192, candidatesTokenCount: 50, thoughtsTokenCount: 1998 }
  const valid = { candidates: [candidate], usageMetadata: usage }
  assert.deepEqual(parseAnswer(valid), { text: 'Complete answer.', inputTokens: 8192, answerTokens: 50, thoughtTokens: 1998 })
  for (const finishReason of ['MAX_TOKENS', 'SAFETY', 'RECITATION']) {
    assert.throws(() => parseAnswer({ ...valid, candidates: [{ ...candidate, finishReason }] }))
  }
  assert.throws(() => parseAnswer({ ...valid, promptFeedback: { blockReason: 'SAFETY' } }))
  assert.throws(() => parseAnswer({ ...valid, candidates: [] }))
  assert.throws(() => parseAnswer({ ...valid, candidates: [candidate, candidate] }))
  for (const parts of [[{ text: '' }], [{ text: ' \n\t ' }], [{ text: 12 }],
    [{ thought: true, text: 'Private reasoning.' }], [{ text: 'Answer' }, { thought: true, text: 'Private reasoning.' }],
    [{ text: '😀'.repeat(32769) }]]) {
    assert.throws(() => parseAnswer({ ...valid, candidates: [{ ...candidate, content: { parts } }] }))
  }
  for (const usageMetadata of [{ ...usage, promptTokenCount: 8193 }, { ...usage, thoughtsTokenCount: 1999 },
    { ...usage, promptTokenCount: -1 }, { ...usage, candidatesTokenCount: 0 }, { ...usage, candidatesTokenCount: 1.5 }]) {
    assert.throws(() => parseAnswer({ ...valid, usageMetadata }))
  }
})

// ---------------------------------------------------------------------------
// 2. Allowlist / access enforcement and forged client fields rejection
// ---------------------------------------------------------------------------
test('access enforcement: hosted policy denies non-allowlisted callers while localDevelopment permits members, and forged client fields are rejected', async () => {
  const user = await createTestAccount()
  const roomId = await createTestRoom(user.localId, 'Allowed Owner')
  const provider = createControlledProvider()
  const requestId = randomUUID()
  const messageId = randomUUID()

  // 1. Hosted policy denial with empty testerUids (localDevelopment omitted)
  const emptyPolicy = { testerUids: [] }

  await assert.rejects(
    async () => {
      await handleAskThreadline(db, user.localId, 'Tester', requestId, { roomId, messageId, text: 'Should fail hosted allowlist' }, emptyPolicy, provider, createControlledModeration())
    },
    (err) => err?.details?.code === 'forbidden'
  )

  assert.equal(provider.countCalls, 0)
  assert.equal(provider.generateCalls, 0)
  const emptyPromptDoc = await db.collection('rooms').doc(roomId).collection('messages').doc(messageId).get()
  assert.equal(emptyPromptDoc.exists, false)

  // 2. Hosted policy denial with non-matching testerUids
  const unauthPolicy = { testerUids: ['different-tester-id'] }
  await assert.rejects(
    handleAskThreadline(db, user.localId, 'Tester', requestId, { roomId, messageId, text: 'Should fail hosted allowlist' }, unauthPolicy, provider, createControlledModeration()),
    (err) => err?.details?.code === 'forbidden'
  )

  // 3. Local development access allows authenticated member
  const localPolicy = { localDevelopment: true, testerUids: [] }

  const admitted = await handleAskThreadline(db, user.localId, 'Tester', requestId, { roomId, messageId, text: 'Hello Threadline with local access' }, localPolicy, provider, createControlledModeration())
  assert.equal(admitted.status, 'complete')
  assert.equal(admitted.roomId, roomId)
  assert.equal(admitted.messageId, messageId)
  assert.ok(provider.countCalls >= 1)
  assert.equal(provider.generateCalls, 1)

  // 4. Strict commandSchema rejects forged client fields
  const forgedPayload = {
    operation: 'askThreadline',
    requestId: randomUUID(),
    input: {
      roomId,
      messageId: randomUUID(),
      text: 'Prompt with forged entitlement',
      role: 'admin',
      bypass: true,
      localDevelopment: true,
    },
  }
  const parsed = commandSchema.safeParse(forgedPayload)
  assert.equal(parsed.success, false)
})

// ---------------------------------------------------------------------------
// 3. Simultaneous Ask single admission & room-busy semantics
// ---------------------------------------------------------------------------
test('simultaneous Ask admits one request without saving or charging the loser', { timeout: 15000 }, async (t) => {
  const userA = await createTestAccount()
  const userB = await createTestAccount()
  const roomId = await createTestRoom(userA.localId)
  await addRoomMember(roomId, userB.localId)
  const release = Promise.withResolvers()
  t.signal.addEventListener('abort', () => release.resolve(), { once: true })
  const provider = createControlledProvider({ onGenerate: () => release.promise })
  const policy = { localDevelopment: true, testerUids: [] }
  const inputs = [userA, userB].map(() => ({ roomId, messageId: randomUUID(), text: 'Concurrent Ask' }))
  const outcomes = [userA, userB].map((user, i) =>
    handleAskThreadline(db, user.localId, 'Member', randomUUID(), inputs[i], policy, provider, createControlledModeration())
      .then(value => ({ value }), error => ({ error })))
  try {
    assert.equal((await Promise.race(outcomes)).error?.details?.code, 'room-busy')
  } finally {
    release.resolve()
  }
  const results = await Promise.all(outcomes)
  assert.equal(results.filter(result => result.value?.status === 'complete').length, 1)
  assert.equal(provider.generateCalls, 1)
  const loserIndex = results.findIndex(result => result.error)
  assert.equal((await db.collection('rooms').doc(roomId).collection('messages').doc(inputs[loserIndex].messageId).get()).exists, false)
  assert.equal((await db.collection('quotaBuckets').doc(`aiLifetime_${[userA, userB][loserIndex].localId}`).get()).exists, false)
  assert.equal((await db.collection('budgets').doc(BUDGET_ID).get()).data().consumedMicroUsd, RESERVATION_MICRO_USD)
})

// ---------------------------------------------------------------------------
// 4. Captured cutoff while four members send and answer takes current seq
// ---------------------------------------------------------------------------
test('captured cutoff isolates prompt context while four members send messages, and answer allocates current seq', async () => {
  const owner = await createTestAccount()
  const m1 = await createTestAccount()
  const m2 = await createTestAccount()
  const m3 = await createTestAccount()
  const m4 = await createTestAccount()

  const roomId = await createTestRoom(owner.localId, 'Owner')
  await addRoomMember(roomId, m1.localId)
  await addRoomMember(roomId, m2.localId)
  await addRoomMember(roomId, m3.localId)
  await addRoomMember(roomId, m4.localId)

  let contextPassedToGenerate = null
  const provider = createControlledProvider({
    answerText: 'Answer reflecting only cutoff context.',
    async onGenerate(context) {
      contextPassedToGenerate = context
      // While Ask is generating, 4 other members send human messages
      await handleSendRoomMessage(db, m1.localId, 'Member 1', randomUUID(), {
        roomId,
        messageId: randomUUID(),
        text: 'Intervening human message 1',
      }, createControlledModeration())
      await handleSendRoomMessage(db, m2.localId, 'Member 2', randomUUID(), {
        roomId,
        messageId: randomUUID(),
        text: 'Intervening human message 2',
      }, createControlledModeration())
      await handleSendRoomMessage(db, m3.localId, 'Member 3', randomUUID(), {
        roomId,
        messageId: randomUUID(),
        text: 'Intervening human message 3',
      }, createControlledModeration())
      await handleSendRoomMessage(db, m4.localId, 'Member 4', randomUUID(), {
        roomId,
        messageId: randomUUID(),
        text: 'Intervening human message 4',
      }, createControlledModeration())
    },
  })

  const promptMsgId = randomUUID()
  const requestId = randomUUID()
  const policy = { localDevelopment: true, testerUids: [owner.localId] }

  const result = await handleAskThreadline(db, owner.localId, 'Owner', requestId, { roomId, messageId: promptMsgId, text: 'Initial prompt for cutoff test' }, policy, provider, createControlledModeration())

  assert.equal(result.status, 'complete')

  // Prompt had seq 1
  const promptDoc = (await db.collection('rooms').doc(roomId).collection('messages').doc(promptMsgId).get()).data()
  assert.equal(promptDoc.seq, 1)

  // Context passed to generate contained only the prompt (seq 1), not the subsequent 4 sends
  assert.ok(contextPassedToGenerate)
  assert.equal(contextPassedToGenerate.refs.length, 1)
  assert.equal(contextPassedToGenerate.refs[0].id, promptMsgId)

  // The 4 human messages took seqs 2, 3, 4, 5
  // The AI answer took seq 6 (current sequence after all intervening sends)
  const roomDoc = (await db.collection('rooms').doc(roomId).get()).data()
  assert.equal(roomDoc.nextSeq, 7)
  assert.equal(roomDoc.activeGenerationId, null)

  const messagesSnap = await db.collection('rooms').doc(roomId).collection('messages').orderBy('seq', 'asc').get()
  assert.equal(messagesSnap.docs.length, 6)

  const aiMessageDoc = messagesSnap.docs.find((d) => d.data().kind === 'ai')
  assert.ok(aiMessageDoc)
  assert.equal(aiMessageDoc.data().seq, 6)
  assert.equal(aiMessageDoc.data().replyToId, promptMsgId)
  assert.equal(aiMessageDoc.data().text, 'Answer reflecting only cutoff context.')
  assert.deepEqual(aiMessageDoc.data().contextRefs, contextPassedToGenerate.refs)
})

// ---------------------------------------------------------------------------
// 5. Payload-bound replay consumes once & conflicting payload rejected
// ---------------------------------------------------------------------------
test('payload-bound replay returns identical result without double-counting; conflicting payload is rejected', async () => {
  const user = await createTestAccount()
  const roomId = await createTestRoom(user.localId, 'Replay Test')
  const provider = createControlledProvider()
  const policy = { localDevelopment: true, testerUids: [user.localId] }
  const requestId = randomUUID()
  const messageId = randomUUID()
  const initialInput = { roomId, messageId, text: 'Exact payload for replay test' }

  // 1. Initial successful Ask
  const initial = await handleAskThreadline(db, user.localId, 'User', requestId, initialInput, policy, provider, createControlledModeration())
  assert.equal(initial.status, 'complete')

  const quotaSnapInitial = await db.collection('quotaBuckets').doc(`aiLifetime_${user.localId}`).get()
  assert.equal(quotaSnapInitial.data()?.consumedAttempts, 1)
  assert.equal(quotaSnapInitial.data()?.reservedAttempts, 0)

  const budgetSnapInitial = await db.collection('budgets').doc(BUDGET_ID).get()
  assert.equal(budgetSnapInitial.data()?.consumedMicroUsd, RESERVATION_MICRO_USD)
  assert.equal(budgetSnapInitial.data()?.reservedMicroUsd, 0)

  // 2. Exact replay with identical requestId and payload
  const replay = await handleAskThreadline(db, user.localId, 'User', requestId, initialInput, policy, provider, createControlledModeration())
  assert.equal(replay.operationId, initial.operationId)
  assert.equal(replay.status, initial.status)
  assert.equal(replay.roomId, initial.roomId)
  assert.equal(replay.messageId, initial.messageId)
  assert.equal(replay.seq, initial.seq)

  // Ledger counters unchanged on replay
  const quotaSnapReplay = await db.collection('quotaBuckets').doc(`aiLifetime_${user.localId}`).get()
  assert.equal(quotaSnapReplay.data()?.consumedAttempts, 1)
  const budgetSnapReplay = await db.collection('budgets').doc(BUDGET_ID).get()
  assert.equal(budgetSnapReplay.data()?.consumedMicroUsd, RESERVATION_MICRO_USD)

  // 3. Conflicting payload with same requestId but different text
  await assert.rejects(
    async () => {
      await handleAskThreadline(db, user.localId, 'User', requestId, { roomId, messageId, text: 'Conflicting changed prompt text' }, policy, provider, createControlledModeration())
    },
    (err) => err?.details?.code === 'conflict'
  )
})

// ---------------------------------------------------------------------------
// 6. Failure consumes dispatched reservation and prep failure releases
// ---------------------------------------------------------------------------
test('preparation failure releases reservation while dispatch failure consumes it', async () => {
  const user = await createTestAccount()
  const roomId = await createTestRoom(user.localId, 'Failure Test Room')
  const policy = { localDevelopment: true, testerUids: [user.localId] }

  // Part A: Preparation failure releases reservation
  const prepFailProvider = createControlledProvider({
    failCount: new Error('Token count service failure'),
  })
  const prepReqId = randomUUID()
  const prepMsgId = randomUUID()

  const prepResult = await handleAskThreadline(db, user.localId, 'User', prepReqId, { roomId, messageId: prepMsgId, text: 'Prompt that fails during prep' }, policy, prepFailProvider, createControlledModeration())
  assert.equal(prepResult.status, 'failed')

  const prepQuota = (await db.collection('quotaBuckets').doc(`aiLifetime_${user.localId}`).get()).data()
  assert.equal(prepQuota?.reservedAttempts, 0)
  assert.equal(prepQuota?.consumedAttempts, 0)

  const prepBudget = (await db.collection('budgets').doc(BUDGET_ID).get()).data()
  assert.equal(prepBudget?.reservedMicroUsd, 0)
  assert.equal(prepBudget?.consumedMicroUsd, 0)

  // Part B: Dispatched failure consumes reservation
  const dispatchFailProvider = createControlledProvider({
    failGenerate: new Error('Model inference service failed after dispatch claim'),
  })
  const dispatchReqId = randomUUID()
  const dispatchMsgId = randomUUID()

  const dispatchResult = await handleAskThreadline(db, user.localId, 'User', dispatchReqId, { roomId, messageId: dispatchMsgId, text: 'Prompt that fails after dispatch claim' }, policy, dispatchFailProvider, createControlledModeration())
  assert.equal(dispatchResult.status, 'failed')

  const dispatchQuota = (await db.collection('quotaBuckets').doc(`aiLifetime_${user.localId}`).get()).data()
  assert.equal(dispatchQuota?.reservedAttempts, 0)
  assert.equal(dispatchQuota?.consumedAttempts, 1)

  const dispatchBudget = (await db.collection('budgets').doc(BUDGET_ID).get()).data()
  assert.equal(dispatchBudget?.reservedMicroUsd, 0)
  assert.equal(dispatchBudget?.consumedMicroUsd, RESERVATION_MICRO_USD)
})

// ---------------------------------------------------------------------------
// 7. 50-attempt reserved+consumed race & lifetime cap enforcement
// ---------------------------------------------------------------------------
test('concurrent rooms share the same 50 lifetime attempts per UID', { timeout: 15000 }, async (t) => {
  const user = await createTestAccount()
  const roomIds = [await createTestRoom(user.localId), await createTestRoom(user.localId)]
  const quotaRef = db.collection('quotaBuckets').doc(`aiLifetime_${user.localId}`)
  await quotaRef.set({ requesterId: user.localId, consumedAttempts: 49, reservedAttempts: 0 })
  const release = Promise.withResolvers()
  t.signal.addEventListener('abort', () => release.resolve(), { once: true })
  const provider = createControlledProvider({ onGenerate: () => release.promise })
  const policy = { localDevelopment: true, testerUids: [] }
  const outcomes = roomIds.map(roomId =>
    handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId, messageId: randomUUID(), text: 'Attempt 50' }, policy, provider, createControlledModeration())
      .then(value => ({ value }), error => ({ error })))
  try {
    assert.equal((await Promise.race(outcomes)).error?.details?.code, 'budget-exhausted')
  } finally {
    release.resolve()
  }
  assert.equal((await Promise.all(outcomes)).filter(result => result.value?.status === 'complete').length, 1)
  assert.equal(provider.generateCalls, 1)
  const quota = (await quotaRef.get()).data()
  assert.equal(quota.consumedAttempts, 50)
  assert.equal(quota.reservedAttempts, 0)
  await assert.rejects(handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId: roomIds[0], messageId: randomUUID(), text: 'Attempt 51' }, policy, provider, createControlledModeration()),
    error => error?.details?.code === 'budget-exhausted')
  assert.equal(provider.generateCalls, 1)
})

// ---------------------------------------------------------------------------
// 8. Shared lifetime allowance race / exhaustion / expired pricing
// ---------------------------------------------------------------------------
test('shared allowance and pricing gates survive cross-UID reservation races', { timeout: 15000 }, async (t) => {
  const users = [await createTestAccount(), await createTestAccount()]
  const roomIds = [await createTestRoom(users[0].localId), await createTestRoom(users[1].localId)]
  const policy = { localDevelopment: true, testerUids: [] }
  const deniedProvider = createControlledProvider()
  await setQualifiedBudget({ pricingExpiresAt: Date.now() - 1 })
  await assert.rejects(handleAskThreadline(db, users[0].localId, 'Member', randomUUID(), { roomId: roomIds[0], messageId: randomUUID(), text: 'Invalid configuration' }, policy, deniedProvider, createControlledModeration()),
    error => error?.details?.code === 'provider-unavailable')

  await setQualifiedBudget({ consumedMicroUsd: 4980000 })
  await assert.rejects(handleAskThreadline(db, users[0].localId, 'Member', randomUUID(), { roomId: roomIds[0], messageId: randomUUID(), text: 'Exhausted allowance' }, policy, deniedProvider, createControlledModeration()),
    error => error?.details?.code === 'budget-exhausted')
  assert.equal(deniedProvider.countCalls, 0)
  assert.equal(deniedProvider.generateCalls, 0)
  await setQualifiedBudget({ consumedMicroUsd: 4970000 })
  const release = Promise.withResolvers()
  t.signal.addEventListener('abort', () => release.resolve(), { once: true })
  const provider = createControlledProvider({ onGenerate: () => release.promise })
  const outcomes = users.map((user, i) =>
    handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId: roomIds[i], messageId: randomUUID(), text: 'Last shared reservation' }, policy, provider, createControlledModeration())
      .then(value => ({ value }), error => ({ error })))
  try {
    assert.equal((await Promise.race(outcomes)).error?.details?.code, 'budget-exhausted')
  } finally {
    release.resolve()
  }
  assert.equal((await Promise.all(outcomes)).filter(result => result.value?.status === 'complete').length, 1)
  assert.equal(provider.generateCalls, 1)
  const budget = (await db.collection('budgets').doc(BUDGET_ID).get()).data()
  assert.equal(budget.consumedMicroUsd, 5000000)
  assert.equal(budget.reservedMicroUsd, 0)
})

// ---------------------------------------------------------------------------
// 9. Prompt/context bounds, stale/tombstone omission and whole-turn dropping
// ---------------------------------------------------------------------------
test('context builder omits tombstone and stale messages, and drops complete conversation turns while preserving prompt', async () => {
  const user = await createTestAccount()
  const roomId = await createTestRoom(user.localId, 'Context Bounds Room')
  const promptId = randomUUID()
  const normalId = randomUUID()

  // Seed messages:
  // 1. Normal human message
  await db.collection('rooms').doc(roomId).collection('messages').doc(normalId).set({
    id: normalId,
    roomId,
    seq: 1,
    kind: 'human',
    text: 'Active message 1',
    version: 1,
    deletedAt: null,
    contextState: 'current',
  })
  // 2. Deleted tombstone message
  const tombstoneId = randomUUID()
  await db.collection('rooms').doc(roomId).collection('messages').doc(tombstoneId).set({
    id: tombstoneId,
    roomId,
    seq: 2,
    kind: 'human',
    text: 'Deleted secret message',
    version: 1,
    deletedAt: FieldValue.serverTimestamp(),
    contextState: 'current',
  })
  // 3. Stale context message
  const staleId = randomUUID()
  await db.collection('rooms').doc(roomId).collection('messages').doc(staleId).set({
    id: staleId,
    roomId,
    seq: 3,
    kind: 'human',
    text: 'Stale outdated message',
    version: 1,
    deletedAt: null,
    contextState: 'stale',
  })
  await db.collection('rooms').doc(roomId).update({ nextSeq: 4 })

  let preparedContextReceived = null
  const provider = createControlledProvider({
    onGenerate(ctx) {
      preparedContextReceived = ctx
    },
  })

  await handleAskThreadline(db, user.localId, 'User', randomUUID(), { roomId, messageId: promptId, text: 'Prompt checking context filtering' }, { localDevelopment: true, testerUids: [user.localId] }, provider, createControlledModeration())

  assert.ok(preparedContextReceived)
  const refIds = preparedContextReceived.refs.map((r) => r.id)
  assert.deepEqual(refIds, [normalId, promptId])
  assert.equal(JSON.stringify(preparedContextReceived.contents).includes('Deleted secret message'), false)
  assert.equal(JSON.stringify(preparedContextReceived.contents).includes('Stale outdated message'), false)

  // Test prepareContext unit contract: whole-turn dropping under token pressure
  const turn1Prompt = { id: 'turn1-prompt', version: 1, seq: 1, kind: 'human', text: 'Turn 1 Question' }
  const turn1Answer = { id: 'turn1-ans', version: 1, seq: 2, kind: 'ai', text: 'Turn 1 Answer', replyToId: 'turn1-prompt' }
  const turn2Prompt = { id: 'turn2-prompt', version: 1, seq: 3, kind: 'human', text: 'Turn 2 Question' }
  const turn2Answer = { id: 'turn2-ans', version: 1, seq: 4, kind: 'ai', text: 'Turn 2 Answer', replyToId: 'turn2-prompt' }
  const activePrompt = { id: 'active-prompt', version: 1, seq: 5, kind: 'human', text: 'Current Question' }

  const rows = [turn1Prompt, turn1Answer, turn2Prompt, turn2Answer, activePrompt]

  // Provider that reports high token count when Turn 1 is included, but <= 8192 when Turn 1 is dropped
  const turnDroppingProvider = {
    async count(contents) {
      // If Turn 1 is included (more than 3 contents)
      if (contents.length > 3) return 9000
      return 1000
    },
    async generate() {
      throw new Error('Not used in prepareContext test')
    },
  }

  const prep = await prepareContext(rows, 'active-prompt', turnDroppingProvider, AbortSignal.timeout(5000))
  const keptIds = prep.refs.map((r) => r.id)
  // Turn 1 question and answer were dropped together
  assert.ok(!keptIds.includes('turn1-prompt'))
  assert.ok(!keptIds.includes('turn1-ans'))
  // Turn 2 and active prompt were retained
  assert.ok(keptIds.includes('turn2-prompt'))
  assert.ok(keptIds.includes('turn2-ans'))
  assert.ok(keptIds.includes('active-prompt'))

  // Single prompt exceeding bounds throws
  const overcapPrompt = [{ id: 'huge-prompt', version: 1, seq: 1, kind: 'human', text: 'Huge' }]
  const overcapProvider = {
    async count() { return 8193 },
    async generate() { throw new Error('Not used') },
  }
  await assert.rejects(
    async () => prepareContext(overcapPrompt, 'huge-prompt', overcapProvider, AbortSignal.timeout(5000)),
  )
})

// ---------------------------------------------------------------------------
// 10. Lease recovery never redispatches / late answer rejected
// ---------------------------------------------------------------------------
test('expired recovery never redispatches and the real late-completion path cannot publish', { timeout: 15000 }, async () => {
  const user = await createTestAccount()
  const roomId = await createTestRoom(user.localId)
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  let now = Date.now()
  const provider = createControlledProvider({ onGenerate: async () => { entered.resolve(); await release.promise } })
  const work = handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId, messageId: randomUUID(), text: 'Synthetic expired Ask' }, { localDevelopment: true, testerUids: [], now: () => now }, provider, createControlledModeration())
  await entered.promise
  const generationId = (await db.collection('rooms').doc(roomId).get()).data().activeGenerationId
  const generationRef = db.collection('rooms').doc(roomId).collection('generations').doc(generationId)
  now += 121000
  await generationRef.update({ expiresAt: Date.now() - 1 })
  const recovered = await handleRecoverGeneration(db, user.localId, randomUUID(), { roomId, generationId })
  assert.equal(recovered.status, 'failed')
  release.resolve()
  assert.equal((await work).status, 'failed')
  assert.equal(provider.generateCalls, 1)
  assert.equal((await generationRef.get()).data().state, 'timed-out')
  assert.equal((await db.collection('rooms').doc(roomId).get()).data().activeGenerationId, null)
  const messages = await db.collection('rooms').doc(roomId).collection('messages').get()
  assert.deepEqual(messages.docs.map(doc => doc.data().kind), ['human'])
})

// ---------------------------------------------------------------------------
// 11. Deletion settles reserved vs consumed inference before purging
// ---------------------------------------------------------------------------
test('deletion settles preparing and dispatched work without late resurrection or retained conversation text', { timeout: 15000 }, async () => {
  for (const phase of ['preparing', 'dispatched']) {
    await setQualifiedBudget()
    const user = await createTestAccount()
    const roomId = await createTestRoom(user.localId)
    const entered = Promise.withResolvers()
    const release = Promise.withResolvers()
    const pause = async () => { entered.resolve(); await release.promise }
    const provider = createControlledProvider(phase === 'preparing' ? { onCount: pause } : { onGenerate: pause })
    const text = `Synthetic private deletion prompt ${randomUUID()}`
    const work = handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId, messageId: randomUUID(), text }, { localDevelopment: true, testerUids: [] }, provider, createControlledModeration())
    await entered.promise
    const generationId = (await db.collection('rooms').doc(roomId).get()).data().activeGenerationId
    const deletion = await handleDeleteRoom(db, user.localId, randomUUID(), { roomId })
    let resumed = deletion
    for (let pass = 0; pass < 20 && resumed.status === 'pending'; pass++) {
      resumed = await handleResumeMaintenance(db, user.localId, randomUUID(), { operationId: deletion.operationId })
    }
    assert.equal(resumed.status, 'complete')
    release.resolve()
    const result = await work
    assert.equal(result.status, 'cancelled')
    assert.equal((await db.collection('rooms').doc(roomId).get()).exists, false)
    assert.equal((await db.collection('rooms').doc(roomId).collection('messages').get()).size, 0)
    assert.equal((await db.collection('reservations').doc(generationId).get()).exists, false)
    const quota = (await db.collection('quotaBuckets').doc(`aiLifetime_${user.localId}`).get()).data()
    assert.equal(quota.reservedAttempts, 0)
    assert.equal(quota.consumedAttempts, phase === 'dispatched' ? 1 : 0)
    const budget = (await db.collection('budgets').doc(BUDGET_ID).get()).data()
    assert.equal(budget.reservedMicroUsd, 0)
    assert.equal(budget.consumedMicroUsd, phase === 'dispatched' ? RESERVATION_MICRO_USD : 0)
    const receipt = (await db.collection('receipts').doc(result.operationId).get()).data()
    assert.equal(receipt.status, 'cancelled')
    assert.equal(JSON.stringify(receipt).includes(text), false)
  }
})

test('deletion drains closed reservation history in bounded batches without rewriting completed receipts', async () => {
  const user = await createTestAccount()
  const roomId = await createTestRoom(user.localId)
  const receiptId = randomUUID()
  const generationId = randomUUID()
  const batch = db.batch()
  batch.set(db.collection('receipts').doc(receiptId), { callerUid: user.localId, roomId, status: 'complete' })
  batch.set(db.collection('rooms').doc(roomId).collection('generations').doc(generationId), { state: 'succeeded', receiptId })
  for (let index = 0; index < 201; index++) {
    batch.set(db.collection('reservations').doc(index === 0 ? generationId : randomUUID()), {
      roomId, generationId, receiptId, state: 'released',
    })
  }
  await batch.commit()
  const deletion = await handleDeleteRoom(db, user.localId, randomUUID(), { roomId })
  const progress = await handleResumeMaintenance(db, user.localId, randomUUID(), { operationId: deletion.operationId })
  assert.equal(progress.status, 'pending')
  assert.equal((await db.collection('reservations').where('roomId', '==', roomId).get()).size, 1)
  assert.equal((await db.collection('rooms').doc(roomId).get()).exists, true)
  assert.equal((await db.collection('receipts').doc(receiptId).get()).data().status, 'complete')
})

test('an explicit retry preserves the question and cutoff; concurrent replay does not dispatch twice', { timeout: 15000 }, async () => {
  const user = await createTestAccount()
  const roomId = await createTestRoom(user.localId)
  const input = await failedAsk(user, roomId)
  const laterId = randomUUID()
  await handleSendRoomMessage(db, user.localId, 'Member', randomUUID(), { roomId, messageId: laterId, text: 'Later human chat must not silently enter the original question' }, createControlledModeration())
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  let usedContext
  const provider = createControlledProvider({ onGenerate: async context => {
    usedContext = context
    entered.resolve()
    await release.promise
  } })
  const requestId = randomUUID()
  const work = handleRetryAiReply(db, user.localId, 'Member', requestId, input, localPolicy, provider, createControlledModeration())
  await entered.promise
  const retryGenerationId = (await db.collection('rooms').doc(roomId).get()).data().latestGenerationId
  const replay = await handleRetryAiReply(db, user.localId, 'Member', requestId, input, localPolicy, provider, createControlledModeration())
  assert.equal(replay.status, 'pending')
  await assert.rejects(handleRetryAiReply(db, user.localId, 'Member', randomUUID(), input, localPolicy, provider, createControlledModeration()))
  assert.equal((await db.collection('quotaBuckets').doc(`aiLifetime_${user.localId}`).get()).data().reservedAttempts, 0)
  assert.deepEqual(usedContext.refs.map(ref => ref.id), [input.promptMessageId])
  release.resolve()
  const completed = await work
  assert.equal(completed.status, 'complete')
  assert.equal((await handleRetryAiReply(db, user.localId, 'Member', requestId, input, localPolicy, provider, createControlledModeration())).status, 'complete')
  assert.equal(provider.generateCalls, 1)
  const messages = await db.collection('rooms').doc(roomId).collection('messages').orderBy('seq').get()
  assert.deepEqual(messages.docs.map(doc => ({ id: doc.id, seq: doc.data().seq, kind: doc.data().kind })), [
    { id: input.promptMessageId, seq: 1, kind: 'human' },
    { id: laterId, seq: 2, kind: 'human' },
    { id: retryGenerationId, seq: 3, kind: 'ai' },
  ])
  assert.equal(messages.docs[2].data().replyToId, input.promptMessageId)
  assert.equal((await db.collection('quotaBuckets').doc(`aiLifetime_${user.localId}`).get()).data().consumedAttempts, 2)
  assert.equal((await db.collection('budgets').doc(BUDGET_ID).get()).data().consumedMicroUsd, 60000)
  await assert.rejects(handleRetryAiReply(db, user.localId, 'Member', requestId, { ...input, generationId: randomUUID() }, localPolicy, provider, createControlledModeration()), error => error?.details?.code === 'conflict')
  const latestId = (await db.collection('rooms').doc(roomId).get()).data().latestGenerationId
  await assert.rejects(handleRetryAiReply(db, user.localId, 'Member', randomUUID(), { ...input, generationId: latestId }, localPolicy, provider, createControlledModeration()))
  assert.equal(provider.generateCalls, 1)
})

test('author, prompt mutation, newer Ask, membership and fences reject retry before provider work', { timeout: 15000 }, async () => {
  for (const reason of ['other-author', 'edited', 'deleted', 'newer-ask', 'lost-member', 'maintenance', 'active-generation']) {
    const user = await createTestAccount()
    const roomId = await createTestRoom(user.localId)
    const input = await failedAsk(user, roomId)
    let callerUid = user.localId
    const roomRef = db.collection('rooms').doc(roomId)
    if (reason === 'other-author') {
      const other = await createTestAccount()
      await addRoomMember(roomId, other.localId)
      callerUid = other.localId
    } else if (reason === 'edited') {
      await handleEditMessage(db, user.localId, randomUUID(), { roomId, messageId: input.promptMessageId, expectedVersion: 1, text: 'Changed question' }, createControlledModeration())
      await handleResumeMaintenance(db, user.localId, randomUUID(), { operationId: (await roomRef.get()).data().maintenanceId })
    } else if (reason === 'deleted') {
      await handleDeleteMessage(db, user.localId, randomUUID(), { roomId, messageId: input.promptMessageId, expectedVersion: 1 })
      await handleResumeMaintenance(db, user.localId, randomUUID(), { operationId: (await roomRef.get()).data().maintenanceId })
    } else if (reason === 'newer-ask') {
      await failedAsk(user, roomId)
    } else if (reason === 'lost-member') {
      await roomRef.update({ memberIds: FieldValue.arrayRemove(user.localId) })
    } else if (reason === 'maintenance') {
      await roomRef.update({ maintenanceId: randomUUID() })
    } else {
      await roomRef.update({ activeGenerationId: randomUUID() })
    }
    const provider = createControlledProvider()
    const quotaBefore = (await db.collection('quotaBuckets').doc(`aiLifetime_${user.localId}`).get()).data()
    await assert.rejects(handleRetryAiReply(db, callerUid, 'Member', randomUUID(), input, localPolicy, provider, createControlledModeration()), undefined, reason)
    assert.equal(provider.countCalls, 0, reason)
    assert.equal(provider.generateCalls, 0, reason)
    assert.deepEqual((await db.collection('quotaBuckets').doc(`aiLifetime_${user.localId}`).get()).data(), quotaBefore, reason)
  }
})

test('retry admission shares account lifetime limits and never bypasses hosted access policy', { timeout: 15000 }, async () => {
  const user = await createTestAccount()
  const roomId = await createTestRoom(user.localId)
  const input = await failedAsk(user, roomId, createControlledProvider({ failCount: new Error('Controlled pre-dispatch failure') }))
  await db.collection('quotaBuckets').doc(`aiLifetime_${user.localId}`).update({ consumedAttempts: 49 })
  const provider = createControlledProvider({ failGenerate: new Error('Controlled dispatched failure') })
  const failed = await handleRetryAiReply(db, user.localId, 'Member', randomUUID(), input, localPolicy, provider, createControlledModeration())
  assert.equal(failed.status, 'failed')
  assert.equal((await db.collection('quotaBuckets').doc(`aiLifetime_${user.localId}`).get()).data().consumedAttempts, 50)
  const latestId = (await db.collection('rooms').doc(roomId).get()).data().latestGenerationId
  const nextProvider = createControlledProvider()
  const nextInput = { ...input, generationId: latestId }
  await assert.rejects(handleRetryAiReply(db, user.localId, 'Member', randomUUID(), nextInput, localPolicy, nextProvider, createControlledModeration()),
    error => error?.details?.code === 'budget-exhausted')
  await assert.rejects(handleRetryAiReply(db, user.localId, 'Member', randomUUID(), nextInput, { testerUids: [] }, nextProvider, createControlledModeration()), error => error?.details?.code === 'forbidden')
  assert.equal(nextProvider.countCalls, 0)
  assert.equal(nextProvider.generateCalls, 0)
})

test('retry consumes the same shared allowance rather than resetting a failed question budget', { timeout: 15000 }, async () => {
  await setQualifiedBudget({ allowanceMicroUsd: RESERVATION_MICRO_USD })
  const user = await createTestAccount()
  const roomId = await createTestRoom(user.localId)
  const input = await failedAsk(user, roomId)
  const provider = createControlledProvider()
  await assert.rejects(handleRetryAiReply(db, user.localId, 'Member', randomUUID(), input, localPolicy, provider, createControlledModeration()),
    error => error?.details?.code === 'budget-exhausted')
  assert.equal(provider.countCalls, 0)
  assert.equal(provider.generateCalls, 0)
})

// ---------------------------------------------------------------------------
// 12. Controlled qualification flags are test-fixture-only / leave qualified=false
// ---------------------------------------------------------------------------
test('unqualified provider configuration denies local members before prompt admission or provider work', async () => {
  await resetSharedBudget()

  // Direct Ask call fails closed when qualified is false
  const user = await createTestAccount()
  const roomId = await createTestRoom(user.localId, 'Unqualified Budget Room')
  const provider = createControlledProvider()

  await assert.rejects(
    async () => {
      await handleAskThreadline(db, user.localId, 'User', randomUUID(), { roomId, messageId: randomUUID(), text: 'Prompt on unqualified budget' }, { localDevelopment: true, testerUids: [user.localId] }, provider, createControlledModeration())
    },
    (err) => err?.details?.code === 'provider-unavailable'
  )
  assert.equal(provider.countCalls, 0)
  assert.equal(provider.generateCalls, 0)
  assert.equal((await db.collection('rooms').doc(roomId).collection('messages').get()).size, 0)
})

// ---------------------------------------------------------------------------
// 13. Local uncapped allowance, owner numeric limits, and hosted pricing policy
// ---------------------------------------------------------------------------
test('local uncapped Ask and retry proceed past former monetary ceiling with preserved attempt quota, accounting, and replay', { timeout: 20000 }, async () => {
  // Developer opted out of monetary cap in local development (allowanceMicroUsd: null)
  // Already consumed at the former USD 10 ceiling (10,000,000 uUSD)
  await setQualifiedBudget({
    allowanceMicroUsd: null,
    consumedMicroUsd: 10000000,
    reservedMicroUsd: 0,
  })

  const user = await createTestAccount()
  const roomId = await createTestRoom(user.localId)
  const localPolicy = { localDevelopment: true, testerUids: [] }

  // 1. Uncapped Ask admits and consumes past former ceiling even when generation fails
  const askRequestId = randomUUID()
  const askMessageId = randomUUID()
  const failingProvider = createControlledProvider({ failGenerate: new Error('Controlled generation failure') })
  const askResult = await handleAskThreadline(db, user.localId, 'Author', askRequestId, { roomId, messageId: askMessageId, text: 'Uncapped Ask question past former monetary ceiling' }, localPolicy, failingProvider, createControlledModeration())
  assert.equal(askResult.status, 'failed')

  // Attempt quota preserved: exactly 1 attempt consumed
  const quotaAfterAsk = (await db.collection('quotaBuckets').doc(`aiLifetime_${user.localId}`).get()).data()
  assert.equal(quotaAfterAsk.reservedAttempts, 0)
  assert.equal(quotaAfterAsk.consumedAttempts, 1)

  // Accounting preserved: consumedMicroUsd advanced by RESERVATION_MICRO_USD past former ceiling
  const budgetAfterAsk = (await db.collection('budgets').doc(BUDGET_ID).get()).data()
  assert.equal(budgetAfterAsk.consumedMicroUsd, 10030000)
  assert.equal(budgetAfterAsk.reservedMicroUsd, 0)

  // Exact replay of Ask returns cached receipt without double counting attempts or micro-USD
  const askReplay = await handleAskThreadline(db, user.localId, 'Author', askRequestId, { roomId, messageId: askMessageId, text: 'Uncapped Ask question past former monetary ceiling' }, localPolicy, failingProvider, createControlledModeration())
  assert.equal(askReplay.operationId, askResult.operationId)
  assert.equal(askReplay.status, 'failed')
  const quotaAfterAskReplay = (await db.collection('quotaBuckets').doc(`aiLifetime_${user.localId}`).get()).data()
  assert.equal(quotaAfterAskReplay.consumedAttempts, 1)
  const budgetAfterAskReplay = (await db.collection('budgets').doc(BUDGET_ID).get()).data()
  assert.equal(budgetAfterAskReplay.consumedMicroUsd, 10030000)

  // 2. Retry admits and completes past former ceiling with preserved attempt quota and accounting
  const roomDoc = (await db.collection('rooms').doc(roomId).get()).data()
  const generationId = roomDoc.latestGenerationId
  const retryRequestId = randomUUID()
  const retryInput = { roomId, promptMessageId: askMessageId, generationId }
  const succeedingProvider = createControlledProvider({ answerText: 'Successful retry response past former monetary ceiling' })

  const retryResult = await handleRetryAiReply(db, user.localId, 'Author', retryRequestId, retryInput, localPolicy, succeedingProvider, createControlledModeration())
  assert.equal(retryResult.status, 'complete')

  // Attempt quota preserved: now 2 attempts consumed
  const quotaAfterRetry = (await db.collection('quotaBuckets').doc(`aiLifetime_${user.localId}`).get()).data()
  assert.equal(quotaAfterRetry.reservedAttempts, 0)
  assert.equal(quotaAfterRetry.consumedAttempts, 2)

  // Accounting preserved: consumedMicroUsd advanced again by RESERVATION_MICRO_USD
  const budgetAfterRetry = (await db.collection('budgets').doc(BUDGET_ID).get()).data()
  assert.equal(budgetAfterRetry.consumedMicroUsd, 10060000)
  assert.equal(budgetAfterRetry.reservedMicroUsd, 0)

  // Exact replay of Retry returns cached receipt without double counting attempts or micro-USD
  const retryReplay = await handleRetryAiReply(db, user.localId, 'Author', retryRequestId, retryInput, localPolicy, succeedingProvider, createControlledModeration())
  assert.equal(retryReplay.operationId, retryResult.operationId)
  assert.equal(retryReplay.status, 'complete')
  const quotaAfterRetryReplay = (await db.collection('quotaBuckets').doc(`aiLifetime_${user.localId}`).get()).data()
  assert.equal(quotaAfterRetryReplay.consumedAttempts, 2)
  const budgetAfterRetryReplay = (await db.collection('budgets').doc(BUDGET_ID).get()).data()
  assert.equal(budgetAfterRetryReplay.consumedMicroUsd, 10060000)
})

test('local numeric exhaustion enforces explicit cap while hosted policy rejects null allowance and invalid configs fail closed', { timeout: 15000 }, async () => {
  const user = await createTestAccount()
  const roomId = await createTestRoom(user.localId)
  const localPolicy = { localDevelopment: true, testerUids: [] }
  const hostedPolicy = { testerUids: [user.localId] }
  const provider = createControlledProvider()

  // 1. Local explicit numeric cap > $10 is permitted, but exhausts when consumed reaches cap
  await setQualifiedBudget({ allowanceMicroUsd: 20000000, consumedMicroUsd: 19980000 })
  await assert.rejects(
    handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId, messageId: randomUUID(), text: 'Local numeric exhaustion check' }, localPolicy, provider, createControlledModeration()),
    error => error?.details?.code === 'budget-exhausted'
  )

  // Local numeric exhaustion also applies to Retry
  await setQualifiedBudget({ allowanceMicroUsd: 20000000, consumedMicroUsd: 0 })
  const failedInput = await failedAsk(user, roomId)
  await setQualifiedBudget({ allowanceMicroUsd: 20000000, consumedMicroUsd: 19980000 })
  await assert.rejects(
    handleRetryAiReply(db, user.localId, 'Member', randomUUID(), failedInput, localPolicy, provider, createControlledModeration()),
    error => error?.details?.code === 'budget-exhausted'
  )

  // 2. Hosted policy denies explicit null allowance
  await setQualifiedBudget({ allowanceMicroUsd: null })
  await assert.rejects(
    handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId, messageId: randomUUID(), text: 'Hosted null allowance check' }, hostedPolicy, provider, createControlledModeration()),
    error => error?.details?.code === 'provider-unavailable'
  )

  // 3. Missing allowanceMicroUsd configuration fails closed under both local and hosted policy
  await db.collection('budgets').doc(BUDGET_ID).set({
    model: MODEL,
    qualified: true,
    paidServicesVerified: true,
    safetyPolicy: 'medium-and-above-v1',
    reservationMicroUsd: RESERVATION_MICRO_USD,
    pricingExpiresAt: VALID_PRICING_EXPIRY,
    consumedMicroUsd: 0,
    reservedMicroUsd: 0,
  })
  await assert.rejects(
    handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId, messageId: randomUUID(), text: 'Missing allowance under local policy' }, localPolicy, provider, createControlledModeration()),
    error => error?.details?.code === 'provider-unavailable'
  )
  await assert.rejects(
    handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId, messageId: randomUUID(), text: 'Missing allowance under hosted policy' }, hostedPolicy, provider, createControlledModeration()),
    error => error?.details?.code === 'provider-unavailable'
  )

  // 5. Negative allowanceMicroUsd fails closed
  await setQualifiedBudget({ allowanceMicroUsd: -1 })
  await assert.rejects(
    handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId, messageId: randomUUID(), text: 'Negative allowance check' }, localPolicy, provider, createControlledModeration()),
    error => error?.details?.code === 'provider-unavailable'
  )

  // 6. Qualification is never bypassed by allowanceMicroUsd: null under local policy
  await setQualifiedBudget({ allowanceMicroUsd: null, qualified: false })
  await assert.rejects(
    handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId, messageId: randomUUID(), text: 'Unqualified budget with null allowance' }, localPolicy, provider, createControlledModeration()),
    error => error?.details?.code === 'provider-unavailable'
  )

  await setQualifiedBudget({ allowanceMicroUsd: null, paidServicesVerified: false })
  await assert.rejects(
    handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId, messageId: randomUUID(), text: 'Unverified services with null allowance' }, localPolicy, provider, createControlledModeration()),
    error => error?.details?.code === 'provider-unavailable'
  )
})

// ---------------------------------------------------------------------------
// 14. Local Ask and retry beyond 50 attempts with clean setup defaults
// ---------------------------------------------------------------------------
test('local Ask and retry proceed beyond 50 attempts when localAttemptLimit is null', { timeout: 20000 }, async () => {
  // Clean setup defaults: allowanceMicroUsd: null, localAttemptLimit: null
  await setQualifiedBudget({
    allowanceMicroUsd: null,
    localAttemptLimit: null,
    consumedMicroUsd: 0,
    reservedMicroUsd: 0,
  })

  const user = await createTestAccount()
  const roomId = await createTestRoom(user.localId)
  const localPolicy = { localDevelopment: true, testerUids: [] }
  const quotaRef = db.collection('quotaBuckets').doc(`aiLifetime_${user.localId}`)

  // Seed quota bucket with 50 already-consumed attempts
  await quotaRef.set({ requesterId: user.localId, consumedAttempts: 50, reservedAttempts: 0 })

  // 1. Ask on attempt 51 succeeds and consumes attempt 51
  const askRequestId = randomUUID()
  const askMessageId = randomUUID()
  const askProvider = createControlledProvider({ answerText: 'Answer on attempt 51 beyond 50 ceiling.' })
  const askResult = await handleAskThreadline(db, user.localId, 'Author', askRequestId, { roomId, messageId: askMessageId, text: 'Question on attempt 51' }, localPolicy, askProvider, createControlledModeration())
  assert.equal(askResult.status, 'complete')

  // Quota bucket updated: 51 consumed attempts
  const quotaAfter51 = (await quotaRef.get()).data()
  assert.equal(quotaAfter51.consumedAttempts, 51)
  assert.equal(quotaAfter51.reservedAttempts, 0)

  // Accounting updated: exactly 1 reservation consumed
  const budgetAfter51 = (await db.collection('budgets').doc(BUDGET_ID).get()).data()
  assert.equal(budgetAfter51.consumedMicroUsd, RESERVATION_MICRO_USD)

  // 2. Generation failure on attempt 52 consumes attempt 52
  const failRequestId = randomUUID()
  const failMessageId = randomUUID()
  const failingProvider = createControlledProvider({ failGenerate: new Error('Controlled generation failure on attempt 52') })
  const failResult = await handleAskThreadline(db, user.localId, 'Author', failRequestId, { roomId, messageId: failMessageId, text: 'Question on attempt 52 that fails' }, localPolicy, failingProvider, createControlledModeration())
  assert.equal(failResult.status, 'failed')

  const quotaAfter52 = (await quotaRef.get()).data()
  assert.equal(quotaAfter52.consumedAttempts, 52)

  // 3. Retry from attempt 52 succeeds on attempt 53
  const roomDoc = (await db.collection('rooms').doc(roomId).get()).data()
  const failedGenId = roomDoc.latestGenerationId
  const retryRequestId = randomUUID()
  const retryInput = { roomId, promptMessageId: failMessageId, generationId: failedGenId }
  const retryProvider = createControlledProvider({ answerText: 'Successful retry on attempt 53' })

  const retryResult = await handleRetryAiReply(db, user.localId, 'Author', retryRequestId, retryInput, localPolicy, retryProvider, createControlledModeration())
  assert.equal(retryResult.status, 'complete')

  const quotaAfter53 = (await quotaRef.get()).data()
  assert.equal(quotaAfter53.consumedAttempts, 53)
  assert.equal(quotaAfter53.reservedAttempts, 0)

  // Budget consumed 3 reservations (attempt 51, attempt 52, retry attempt 53)
  const budgetAfter53 = (await db.collection('budgets').doc(BUDGET_ID).get()).data()
  assert.equal(budgetAfter53.consumedMicroUsd, RESERVATION_MICRO_USD * 3)

  // 4. Exact replay on retry beyond 50 returns cached receipt without double counting
  const retryReplay = await handleRetryAiReply(db, user.localId, 'Author', retryRequestId, retryInput, localPolicy, retryProvider, createControlledModeration())
  assert.equal(retryReplay.operationId, retryResult.operationId)
  assert.equal(retryReplay.status, 'complete')

  const quotaAfterReplay = (await quotaRef.get()).data()
  assert.equal(quotaAfterReplay.consumedAttempts, 53)
  const budgetAfterReplay = (await db.collection('budgets').doc(BUDGET_ID).get()).data()
  assert.equal(budgetAfterReplay.consumedMicroUsd, RESERVATION_MICRO_USD * 3)
})

// ---------------------------------------------------------------------------
// 15. Legacy local ledger preserves 50 ceiling; explicit optional caps enforced
// ---------------------------------------------------------------------------
test('legacy local ledger preserves prior 50 ceiling when localAttemptLimit is undefined, and optional caps exhaust', { timeout: 20000 }, async () => {
  const user = await createTestAccount()
  const roomId = await createTestRoom(user.localId)
  const localPolicy = { localDevelopment: true, testerUids: [] }
  const provider = createControlledProvider()
  const quotaRef = db.collection('quotaBuckets').doc(`aiLifetime_${user.localId}`)

  // 1. Legacy local ledger: localAttemptLimit is omitted/undefined in document
  await db.collection('budgets').doc(BUDGET_ID).set({
    model: MODEL,
    qualified: true,
    paidServicesVerified: true,
    safetyPolicy: 'medium-and-above-v1',
    reservationMicroUsd: RESERVATION_MICRO_USD,
    pricingExpiresAt: VALID_PRICING_EXPIRY,
    allowanceMicroUsd: null,
    consumedMicroUsd: 0,
    reservedMicroUsd: 0,
    // localAttemptLimit intentionally omitted to model legacy private ledger
  })

  // At 50 consumed attempts, legacy ledger blocks attempt 51
  await quotaRef.set({ requesterId: user.localId, consumedAttempts: 50, reservedAttempts: 0 })
  await assert.rejects(
    handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId, messageId: randomUUID(), text: 'Legacy attempt 51 blocked' }, localPolicy, provider, createControlledModeration()),
    error => error?.details?.code === 'budget-exhausted'
  )

  // Legacy ceiling also applies to Retry
  await quotaRef.set({ requesterId: user.localId, consumedAttempts: 0, reservedAttempts: 0 })
  const failedInput = await failedAsk(user, roomId)
  await quotaRef.set({ requesterId: user.localId, consumedAttempts: 50, reservedAttempts: 0 })
  await assert.rejects(
    handleRetryAiReply(db, user.localId, 'Member', randomUUID(), failedInput, localPolicy, provider, createControlledModeration()),
    error => error?.details?.code === 'budget-exhausted'
  )

  // 2. Explicit optional localAttemptLimit: 3
  await setQualifiedBudget({
    allowanceMicroUsd: null,
    localAttemptLimit: 3,
    consumedMicroUsd: 0,
    reservedMicroUsd: 0,
  })

  await quotaRef.set({ requesterId: user.localId, consumedAttempts: 2, reservedAttempts: 0 })
  const attempt3Result = await handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId, messageId: randomUUID(), text: 'Attempt 3 under explicit cap of 3' }, localPolicy, provider, createControlledModeration())
  assert.equal(attempt3Result.status, 'complete')

  // Attempt 4 is rejected by explicit attempt cap
  await assert.rejects(
    handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId, messageId: randomUUID(), text: 'Attempt 4 under explicit cap of 3' }, localPolicy, provider, createControlledModeration()),
    error => error?.details?.code === 'budget-exhausted'
  )

  // 3. Malformed localAttemptLimit fails closed
  await setQualifiedBudget({ localAttemptLimit: -1 })
  await assert.rejects(
    handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId, messageId: randomUUID(), text: 'Negative attempt limit' }, localPolicy, provider, createControlledModeration()),
    error => error?.details?.code === 'provider-unavailable'
  )

  await setQualifiedBudget({ localAttemptLimit: 3.5 })
  await assert.rejects(
    handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId, messageId: randomUUID(), text: 'Float attempt limit' }, localPolicy, provider, createControlledModeration()),
    error => error?.details?.code === 'provider-unavailable'
  )

  await setQualifiedBudget({ localAttemptLimit: 'unlimited' })
  await assert.rejects(
    handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId, messageId: randomUUID(), text: 'String attempt limit' }, localPolicy, provider, createControlledModeration()),
    error => error?.details?.code === 'provider-unavailable'
  )
})

// ---------------------------------------------------------------------------
// 16. Hosted RM20 conversion: conservative cap, inflation rejection, lower funds ceiling
// ---------------------------------------------------------------------------
test('hosted RM20 conversion enforces conservative cap, rejects inflation, and supports lower funds ceiling without reset', { timeout: 20000 }, async () => {
  const user = await createTestAccount()
  const roomId = await createTestRoom(user.localId)
  const hostedPolicy = { testerUids: [user.localId] }
  const provider = createControlledProvider()

  // Rate 4.50 MYR/USD (4,500,000 uMYR/USD), 10.00% headroom (1000 bps)
  // RM20 buys floor(20,000,000 * 10,000 * 1,000,000 / (4,500,000 * 11,000)) = 4,040,404 microUSD
  const syntheticConversion = createSyntheticConversion({
    rateMicroMyrPerUsd: 4500000,
    headroomBps: 1000,
    remainingFundsMicroMyr: 50000000,
    alreadyConsumedMicroUsd: 0,
  })

  // 1. Conservative cap of 4,040,404 microUSD is valid and admits Ask
  await setHostedQualifiedBudget({
    allowanceMicroUsd: 4040404,
    conversion: syntheticConversion,
    consumedMicroUsd: 0,
    reservedMicroUsd: 0,
  })
  const admittedResult = await handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId, messageId: randomUUID(), text: 'Hosted Ask under conservative RM20 ceiling' }, hostedPolicy, provider, createControlledModeration())
  assert.equal(admittedResult.status, 'complete')

  // 2. Allowance inflation: allowanceMicroUsd = 4,040,405 exceeds conservative ceiling by 1 uUSD -> REJECTED
  await setHostedQualifiedBudget({
    allowanceMicroUsd: 4040405,
    conversion: syntheticConversion,
  })
  await assert.rejects(
    handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId, messageId: randomUUID(), text: 'Inflated hosted allowance' }, hostedPolicy, provider, createControlledModeration()),
    error => error?.details?.code === 'provider-unavailable'
  )

  // 3. Lower verified remaining funds ceiling: verified funds = RM 10 (10,000,000 uMYR) -> 2,020,202 uUSD
  const lowerFundsConversion = createSyntheticConversion({
    rateMicroMyrPerUsd: 4500000,
    headroomBps: 1000,
    remainingFundsMicroMyr: 10000000,
    alreadyConsumedMicroUsd: 0,
  })

  // Setting allowance above lower funds ceiling (2,020,203) is rejected
  await setHostedQualifiedBudget({
    allowanceMicroUsd: 2020203,
    conversion: lowerFundsConversion,
  })
  await assert.rejects(
    handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId, messageId: randomUUID(), text: 'Allowance exceeding lower funds ceiling' }, hostedPolicy, provider, createControlledModeration()),
    error => error?.details?.code === 'provider-unavailable'
  )

  // Setting allowance at lower funds ceiling (2,020,202) is accepted
  await setHostedQualifiedBudget({
    allowanceMicroUsd: 2020202,
    conversion: lowerFundsConversion,
    consumedMicroUsd: 0,
  })

  // 4. Baseline captures prior consumption so available balance is not double-subtracted
  // RM 10 remaining funds (2,020,202 uUSD) + 1,000,000 uUSD baseline = 3,020,202 uUSD allowable
  const baselineConversion = createSyntheticConversion({
    rateMicroMyrPerUsd: 4500000,
    headroomBps: 1000,
    remainingFundsMicroMyr: 10000000,
    alreadyConsumedMicroUsd: 1000000,
  })
  await setHostedQualifiedBudget({
    allowanceMicroUsd: 3020202,
    conversion: baselineConversion,
    consumedMicroUsd: 1000000,
    reservedMicroUsd: 0,
  })

  // Baseline exceeding current consumed ledger fails closed
  await setHostedQualifiedBudget({
    allowanceMicroUsd: 3020202,
    conversion: createSyntheticConversion({
      rateMicroMyrPerUsd: 4500000,
      headroomBps: 1000,
      remainingFundsMicroMyr: 10000000,
      alreadyConsumedMicroUsd: 1500000, // Baseline > consumedMicroUsd (1,000,000)
    }),
    consumedMicroUsd: 1000000,
  })
  await assert.rejects(
    handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId, messageId: randomUUID(), text: 'Baseline exceeds consumed ledger' }, hostedPolicy, provider, createControlledModeration()),
    error => error?.details?.code === 'provider-unavailable'
  )

  // 5. Lowering available funds ceiling preserves existing consumed/reserved totals without reset
  await setHostedQualifiedBudget({
    allowanceMicroUsd: 2020202,
    conversion: lowerFundsConversion,
    consumedMicroUsd: 2000000,
    reservedMicroUsd: 0,
  })

  // Next reservation (30,000 uUSD) requires 2,030,000 uUSD > 2,020,202 uUSD -> budget-exhausted
  await assert.rejects(
    handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId, messageId: randomUUID(), text: 'Budget exhausted under lower funds ceiling' }, hostedPolicy, provider, createControlledModeration()),
    error => error?.details?.code === 'budget-exhausted'
  )

  // Existing consumedMicroUsd is preserved and never reset
  const budgetDoc = (await db.collection('budgets').doc(BUDGET_ID).get()).data()
  assert.equal(budgetDoc.consumedMicroUsd, 2000000)
  assert.equal(budgetDoc.reservedMicroUsd, 0)
})

// ---------------------------------------------------------------------------
// 17. Hosted conversion metadata fail-closed validation
// ---------------------------------------------------------------------------
test('hosted conversion metadata fails closed on missing, expired, unreviewed, or malformed FX', { timeout: 20000 }, async () => {
  const user = await createTestAccount()
  const roomId = await createTestRoom(user.localId)
  const hostedPolicy = { testerUids: [user.localId] }
  const provider = createControlledProvider()

  // 1. Missing conversion metadata under hosted policy fails closed
  await setQualifiedBudget({
    allowanceMicroUsd: 4000000,
  })
  await assert.rejects(
    handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId, messageId: randomUUID(), text: 'Missing conversion under hosted policy' }, hostedPolicy, provider, createControlledModeration()),
    error => error?.details?.code === 'provider-unavailable'
  )

  // 2. Future review timestamp fails closed
  await setHostedQualifiedBudget({
    conversion: createSyntheticConversion({ reviewedAt: Date.now() + 60000 }),
  })
  await assert.rejects(
    handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId, messageId: randomUUID(), text: 'Future reviewedAt' }, hostedPolicy, provider, createControlledModeration()),
    error => error?.details?.code === 'provider-unavailable'
  )

  // 3. Expired conversion review fails closed
  await setHostedQualifiedBudget({
    conversion: createSyntheticConversion({ expiresAt: Date.now() - 1000 }),
  })
  await assert.rejects(
    handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId, messageId: randomUUID(), text: 'Expired conversion' }, hostedPolicy, provider, createControlledModeration()),
    error => error?.details?.code === 'provider-unavailable'
  )

  // 4. Expiry exceeding pricing approval ceiling (2027-01-01) fails closed
  await setHostedQualifiedBudget({
    conversion: createSyntheticConversion({ expiresAt: VALID_PRICING_EXPIRY + 86400000 }),
  })
  await assert.rejects(
    handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId, messageId: randomUUID(), text: 'Expiry exceeding PRICING_EXPIRY' }, hostedPolicy, provider, createControlledModeration()),
    error => error?.details?.code === 'provider-unavailable'
  )

  // 5. Empty or invalid sources fails closed
  await setHostedQualifiedBudget({
    conversion: createSyntheticConversion({ sources: [] }),
  })
  await assert.rejects(
    handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId, messageId: randomUUID(), text: 'Empty sources' }, hostedPolicy, provider, createControlledModeration()),
    error => error?.details?.code === 'provider-unavailable'
  )

  // 6. Zero or negative exchange rate fails closed
  await setHostedQualifiedBudget({
    conversion: createSyntheticConversion({ rateMicroMyrPerUsd: 0 }),
  })
  await assert.rejects(
    handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId, messageId: randomUUID(), text: 'Zero exchange rate' }, hostedPolicy, provider, createControlledModeration()),
    error => error?.details?.code === 'provider-unavailable'
  )

  await setHostedQualifiedBudget({
    conversion: createSyntheticConversion({ rateMicroMyrPerUsd: -4500000 }),
  })
  await assert.rejects(
    handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId, messageId: randomUUID(), text: 'Negative exchange rate' }, hostedPolicy, provider, createControlledModeration()),
    error => error?.details?.code === 'provider-unavailable'
  )

  // 7. Non-positive headroom fails closed
  await setHostedQualifiedBudget({
    conversion: createSyntheticConversion({ headroomBps: 0 }),
  })
  await assert.rejects(
    handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId, messageId: randomUUID(), text: 'Zero headroom' }, hostedPolicy, provider, createControlledModeration()),
    error => error?.details?.code === 'provider-unavailable'
  )

  await setHostedQualifiedBudget({
    conversion: createSyntheticConversion({ headroomBps: -500 }),
  })
  await assert.rejects(
    handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId, messageId: randomUUID(), text: 'Negative headroom' }, hostedPolicy, provider, createControlledModeration()),
    error => error?.details?.code === 'provider-unavailable'
  )

  // 8. Negative remaining funds fails closed
  await setHostedQualifiedBudget({
    conversion: createSyntheticConversion({ remainingFundsMicroMyr: -1 }),
  })
  await assert.rejects(
    handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId, messageId: randomUUID(), text: 'Negative remaining funds' }, hostedPolicy, provider, createControlledModeration()),
    error => error?.details?.code === 'provider-unavailable'
  )

  // 9. Negative alreadyConsumed baseline fails closed
  await setHostedQualifiedBudget({
    conversion: createSyntheticConversion({ alreadyConsumedMicroUsd: -1 }),
  })
  await assert.rejects(
    handleAskThreadline(db, user.localId, 'Member', randomUUID(), { roomId, messageId: randomUUID(), text: 'Negative alreadyConsumed baseline' }, hostedPolicy, provider, createControlledModeration()),
    error => error?.details?.code === 'provider-unavailable'
  )
})

// ---------------------------------------------------------------------------
// 18. Hosted cross-UID budget and attempt race safety under RM20 allowance
// ---------------------------------------------------------------------------
test('hosted cross-UID requests safely serialize shared RM20 budget races and independent 50-attempt limits', { timeout: 20000 }, async (t) => {
  const userA = await createTestAccount()
  const userB = await createTestAccount()
  const roomA = await createTestRoom(userA.localId)
  const roomB = await createTestRoom(userB.localId)
  const hostedPolicy = { testerUids: [userA.localId, userB.localId] }

  // 1. Shared RM20 budget race: only 30,000 uUSD remaining before cap
  await setHostedQualifiedBudget({
    allowanceMicroUsd: 4000000,
    consumedMicroUsd: 3970000,
    reservedMicroUsd: 0,
  })

  const release = Promise.withResolvers()
  t.signal.addEventListener('abort', () => release.resolve(), { once: true })
  const provider = createControlledProvider({ onGenerate: () => release.promise })

  const racers = [
    handleAskThreadline(db, userA.localId, 'User A', randomUUID(), { roomId: roomA, messageId: randomUUID(), text: 'User A racing for last RM20 reservation' }, hostedPolicy, provider, createControlledModeration()).then(value => ({ value }), error => ({ error })),
    handleAskThreadline(db, userB.localId, 'User B', randomUUID(), { roomId: roomB, messageId: randomUUID(), text: 'User B racing for last RM20 reservation' }, hostedPolicy, provider, createControlledModeration()).then(value => ({ value }), error => ({ error })),
  ]

  try {
    assert.equal((await Promise.race(racers)).error?.details?.code, 'budget-exhausted')
  } finally {
    release.resolve()
  }

  const results = await Promise.all(racers)
  const successes = results.filter(r => r.value?.status === 'complete')
  const failures = results.filter(r => r.error?.details?.code === 'budget-exhausted')
  assert.equal(successes.length, 1)
  assert.equal(failures.length, 1)
  assert.equal(provider.generateCalls, 1)

  // Budget consumed safely reaches exactly 4,000,000 with 0 reserved
  const finalBudget = (await db.collection('budgets').doc(BUDGET_ID).get()).data()
  assert.equal(finalBudget.consumedMicroUsd, 4000000)
  assert.equal(finalBudget.reservedMicroUsd, 0)

  // 2. Independent 50-attempt limits per UID:
  // Reset budget with plenty of funds
  await setHostedQualifiedBudget({
    allowanceMicroUsd: 4000000,
    consumedMicroUsd: 0,
    reservedMicroUsd: 0,
  })

  const quotaRefA = db.collection('quotaBuckets').doc(`aiLifetime_${userA.localId}`)
  const quotaRefB = db.collection('quotaBuckets').doc(`aiLifetime_${userB.localId}`)

  // userA reaches 50 attempts
  await quotaRefA.set({ requesterId: userA.localId, consumedAttempts: 50, reservedAttempts: 0 })
  // userB has 0 attempts
  await quotaRefB.set({ requesterId: userB.localId, consumedAttempts: 0, reservedAttempts: 0 })

  const simpleProvider = createControlledProvider()

  // userA's 51st attempt is rejected
  await assert.rejects(
    handleAskThreadline(db, userA.localId, 'User A', randomUUID(), { roomId: roomA, messageId: randomUUID(), text: 'User A attempt 51' }, hostedPolicy, simpleProvider, createControlledModeration()),
    error => error?.details?.code === 'budget-exhausted'
  )

  // userB's attempt succeeds independently!
  const userBResult = await handleAskThreadline(db, userB.localId, 'User B', randomUUID(), { roomId: roomB, messageId: randomUUID(), text: 'User B attempt 1' }, hostedPolicy, simpleProvider, createControlledModeration())
  assert.equal(userBResult.status, 'complete')

  const quotaB = (await quotaRefB.get()).data()
  assert.equal(quotaB.consumedAttempts, 1)
})

// ---------------------------------------------------------------------------
// 19. No request-flag bypass: server policy derives strictly from environment
// ---------------------------------------------------------------------------
test('no request-flag bypass: server policy derives strictly from server environment, rejecting client-forged bypass fields', { timeout: 15000 }, async () => {
  const outsider = await createTestAccount()
  const reviewer = await createTestAccount()
  const roomId = await createTestRoom(outsider.localId)
  await addRoomMember(roomId, reviewer.localId)

  const hostedPolicy = { testerUids: [reviewer.localId] }
  const provider = createControlledProvider()
  await setHostedQualifiedBudget()

  // 1. Outsider sends Ask with client-forged local/bypass flags under hosted policy
  const forgedPayload = {
    roomId,
    messageId: randomUUID(),
    text: 'Outsider trying to bypass hosted allowlist with forged flags',
    localDevelopment: true,
    bypassBudget: true,
    role: 'admin',
    isLocal: true,
  }

  // Under hosted policy, outsider is strictly forbidden regardless of forged client payload
  await assert.rejects(
    handleAskThreadline(db, outsider.localId, 'Outsider', randomUUID(), forgedPayload, hostedPolicy, provider, createControlledModeration()),
    error => error?.details?.code === 'forbidden'
  )

  // 2. Outsider trying retry with forged bypass fields is also rejected
  await assert.rejects(
    handleRetryAiReply(db, outsider.localId, 'Outsider', randomUUID(), {
      roomId,
      promptMessageId: randomUUID(),
      generationId: randomUUID(),
      localDevelopment: true,
      bypassBudget: true,
    }, hostedPolicy, provider, createControlledModeration()),
    error => error?.details?.code === 'forbidden'
  )

  // Provider was never invoked
  assert.equal(provider.countCalls, 0)
  assert.equal(provider.generateCalls, 0)
})

test('Ask input rejection is terminal, hash-only and replays without screening or paid work', { timeout: 15000 }, async () => {
  const user = await createTestAccount()
  const roomId = await createTestRoom(user.localId)
  const roomRef = db.collection('rooms').doc(roomId)
  const provider = createControlledProvider()
  const budgetBefore = (await db.collection('budgets').doc(BUDGET_ID).get()).data()
  for (const options of [{ verdict: 'block' }, { verdict: 'unavailable' }, { verdict: 'unknown' }, { failScreen: new Error('Controlled failure') }]) {
    const moderation = createControlledModeration(options)
    const requestId = randomUUID()
    const input = { roomId, messageId: randomUUID(), text: `Private unapproved prompt ${randomUUID()}` }
    const result = await handleAskThreadline(db, user.localId, 'Member', requestId, input, localPolicy, provider, moderation)
    assert.equal(result.status, 'failed')
    assert.equal(result.errorCode, options.verdict === 'block' ? 'screening-blocked' : 'screening-unavailable')
    assert.deepEqual(await handleAskThreadline(db, user.localId, 'Member', requestId, input, localPolicy, provider, moderation), result)
    assert.equal(moderation.screenCalls, 1)
    assert.equal((await roomRef.collection('messages').doc(input.messageId).get()).exists, false)
    const receipt = (await db.collection('receipts').doc(result.operationId).get()).data()
    assert.equal(receipt.errorCode, result.errorCode)
    assert.equal(JSON.stringify(receipt).includes(input.text), false)
    assert.equal((await db.collection('submissions').doc(result.operationId).get()).exists, false)
  }
  assert.equal(provider.countCalls, 0)
  assert.equal(provider.generateCalls, 0)
  assert.equal((await roomRef.get()).data().activeGenerationId, null)
  assert.deepEqual((await db.collection('budgets').doc(BUDGET_ID).get()).data(), budgetBefore)
  assert.equal((await db.collection('quotaBuckets').doc(`aiLifetime_${user.localId}`).get()).exists, false)
})

test('Ask claim cannot publish after lease expiry even when classification returns allow', { timeout: 15000 }, async () => {
  const user = await createTestAccount()
  const roomId = await createTestRoom(user.localId)
  const input = { roomId, messageId: randomUUID(), text: `Unpublished ${randomUUID()}` }
  const requestId = randomUUID()
  const submissionRef = db.collection('submissions').doc(`${user.localId}_askThreadline_${requestId}`)
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const moderation = createControlledModeration({ onScreen: async () => { entered.resolve(); await release.promise } })
  const provider = createControlledProvider()
  const budgetBefore = (await db.collection('budgets').doc(BUDGET_ID).get()).data()
  const work = handleAskThreadline(db, user.localId, 'Member', requestId, input, localPolicy, provider, moderation)
  await entered.promise
  try {
    assert.equal(JSON.stringify((await submissionRef.get()).data()).includes(input.text), false)
    const duplicate = await handleAskThreadline(db, user.localId, 'Member', requestId, input, localPolicy, provider, moderation)
    assert.equal(duplicate.status, 'pending')
    assert.equal(moderation.screenCalls, 1)
    await submissionRef.update({ leaseExpiresAt: Date.now() - 1 })
  } finally { release.resolve() }
  const result = await work
  assert.equal(result.status, 'failed')
  assert.equal(result.errorCode, 'screening-unavailable')
  assert.deepEqual(await handleAskThreadline(db, user.localId, 'Member', requestId, input, localPolicy, provider, moderation), result)
  assert.equal(moderation.screenCalls, 1)
  assert.equal(provider.countCalls, 0)
  assert.equal(provider.generateCalls, 0)
  assert.equal((await db.collection('rooms').doc(roomId).collection('messages').get()).size, 0)
  assert.deepEqual((await db.collection('budgets').doc(BUDGET_ID).get()).data(), budgetBefore)
  assert.equal((await submissionRef.get()).exists, false)
})

test('Retry duplicates share one durable screen and terminal rejection never dispatches', { timeout: 15000 }, async () => {
  const user = await createTestAccount()
  const roomId = await createTestRoom(user.localId)
  const input = await failedAsk(user, roomId)
  const requestId = randomUUID()
  const provider = createControlledProvider()
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const moderation = createControlledModeration({ verdict: 'block', onScreen: async () => { entered.resolve(); await release.promise } })
  const budgetBefore = (await db.collection('budgets').doc(BUDGET_ID).get()).data()
  const quotaRef = db.collection('quotaBuckets').doc(`aiLifetime_${user.localId}`)
  const quotaBefore = (await quotaRef.get()).data()
  const work = handleRetryAiReply(db, user.localId, 'Member', requestId, input, localPolicy, provider, moderation)
  await entered.promise
  try {
    const duplicate = await handleRetryAiReply(db, user.localId, 'Member', requestId, input, localPolicy, provider, moderation)
    assert.equal(duplicate.status, 'pending')
    assert.equal(moderation.screenCalls, 1)
    const claim = (await db.collection('submissions').doc(duplicate.operationId).get()).data()
    assert.equal(claim.state, 'pending')
    assert.equal(JSON.stringify(claim).includes('Synthetic question'), false)
  } finally { release.resolve() }
  const result = await work
  assert.equal(result.status, 'failed')
  assert.equal(result.errorCode, 'screening-blocked')
  assert.deepEqual(await handleRetryAiReply(db, user.localId, 'Member', requestId, input, localPolicy, provider, moderation), result)
  assert.equal(moderation.screenCalls, 1)
  assert.equal(provider.countCalls, 0)
  assert.equal(provider.generateCalls, 0)
  assert.deepEqual((await db.collection('budgets').doc(BUDGET_ID).get()).data(), budgetBefore)
  assert.deepEqual((await quotaRef.get()).data(), quotaBefore)
  assert.equal((await db.collection('rooms').doc(roomId).collection('generations').get()).size, 1)
})

test('Retry crashed screening lease settles once and late approval cannot reserve', { timeout: 15000 }, async () => {
  const user = await createTestAccount()
  const roomId = await createTestRoom(user.localId)
  const input = await failedAsk(user, roomId)
  const requestId = randomUUID()
  const provider = createControlledProvider()
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const moderation = createControlledModeration({ onScreen: async () => { entered.resolve(); await release.promise } })
  const budgetBefore = (await db.collection('budgets').doc(BUDGET_ID).get()).data()
  const work = handleRetryAiReply(db, user.localId, 'Member', requestId, input, localPolicy, provider, moderation)
  await entered.promise
  let expired
  try {
    await db.collection('submissions').doc(`${user.localId}_retryAiReply_${requestId}`).update({ leaseExpiresAt: Date.now() - 1 })
    expired = await handleRetryAiReply(db, user.localId, 'Member', requestId, input, localPolicy, provider, moderation)
    assert.equal(expired.status, 'failed')
    assert.equal(expired.errorCode, 'screening-unavailable')
  } finally { release.resolve() }
  assert.deepEqual(await work, expired)
  assert.deepEqual(await handleRetryAiReply(db, user.localId, 'Member', requestId, input, localPolicy, provider, moderation), expired)
  assert.equal(moderation.screenCalls, 1)
  assert.equal(provider.countCalls, 0)
  assert.equal(provider.generateCalls, 0)
  assert.deepEqual((await db.collection('budgets').doc(BUDGET_ID).get()).data(), budgetBefore)
  assert.equal((await db.collection('rooms').doc(roomId).collection('generations').get()).size, 1)
})

test('Retry revalidates prompt version after edit maintenance has already finished', { timeout: 15000 }, async () => {
  const user = await createTestAccount()
  const roomId = await createTestRoom(user.localId)
  const input = await failedAsk(user, roomId)
  const roomRef = db.collection('rooms').doc(roomId)
  const provider = createControlledProvider()
  const budgetBefore = (await db.collection('budgets').doc(BUDGET_ID).get()).data()
  const quotaRef = db.collection('quotaBuckets').doc(`aiLifetime_${user.localId}`)
  const quotaBefore = (await quotaRef.get()).data()
  const moderation = createControlledModeration({ onScreen: async () => {
    await handleEditMessage(db, user.localId, randomUUID(),
      { roomId, messageId: input.promptMessageId, expectedVersion: 1, text: 'Changed approved question' }, createControlledModeration())
    await handleResumeMaintenance(db, user.localId, randomUUID(), { operationId: (await roomRef.get()).data().maintenanceId })
    assert.equal((await roomRef.get()).data().maintenanceId, null)
  } })
  const result = await handleRetryAiReply(db, user.localId, 'Member', randomUUID(), input, localPolicy, provider, moderation)
  assert.equal(result.status, 'failed')
  assert.equal(provider.countCalls, 0)
  assert.equal(provider.generateCalls, 0)
  assert.deepEqual((await db.collection('budgets').doc(BUDGET_ID).get()).data(), budgetBefore)
  assert.deepEqual((await quotaRef.get()).data(), quotaBefore)
  assert.equal((await roomRef.collection('generations').get()).size, 1)
  assert.equal((await roomRef.get()).data().latestGenerationId, input.generationId)
})

test('Output rejection and malformed answers retain spend, release fence and replay safe codes', { timeout: 30000 }, async () => {
  for (const mode of ['block', 'unavailable', 'unknown', 'throw', 'empty', 'missing']) {
    const user = await createTestAccount()
    const roomId = await createTestRoom(user.localId)
    const roomRef = db.collection('rooms').doc(roomId)
    const input = { roomId, messageId: randomUUID(), text: 'Approved authored prompt' }
    const requestId = randomUUID()
    const output = `Unpublished generated answer ${randomUUID()}`
    const provider = createControlledProvider({ answerText: mode === 'empty' ? '' : mode === 'missing' ? null : output })
    let screens = 0
    const moderation = { async screen() {
      screens++
      if (screens === 1) return { verdict: 'allow' }
      if (mode === 'throw') throw new Error('Controlled unavailable')
      return { verdict: mode }
    } }
    const budgetBefore = (await db.collection('budgets').doc(BUDGET_ID).get()).data().consumedMicroUsd
    const result = await handleAskThreadline(db, user.localId, 'Member', requestId, input, localPolicy, provider, moderation)
    assert.equal(result.status, 'failed', mode)
    assert.equal(result.errorCode, mode === 'block' ? 'screening-blocked' : 'screening-unavailable', mode)
    assert.deepEqual(await handleAskThreadline(db, user.localId, 'Member', requestId, input, localPolicy, provider, moderation), result)
    assert.equal(screens, ['empty', 'missing'].includes(mode) ? 1 : 2, mode)
    const room = (await roomRef.get()).data()
    assert.equal(room.activeGenerationId, null)
    const messages = await roomRef.collection('messages').get()
    assert.deepEqual(messages.docs.map(doc => doc.data().text), [input.text])
    const generation = (await roomRef.collection('generations').doc(room.latestGenerationId).get()).data()
    assert.equal(generation.state, 'failed')
    assert.equal(generation.errorCode, result.errorCode)
    assert.equal(JSON.stringify(generation).includes(output), false)
    assert.equal((await db.collection('receipts').doc(result.operationId).get()).data().errorCode, result.errorCode)
    assert.equal((await db.collection('budgets').doc(BUDGET_ID).get()).data().consumedMicroUsd, budgetBefore + RESERVATION_MICRO_USD)
    const quota = (await db.collection('quotaBuckets').doc(`aiLifetime_${user.localId}`).get()).data()
    assert.equal(quota.consumedAttempts, 1)
    assert.equal(quota.reservedAttempts, 0)
  }
})

test('Room deletion during output screening never resurrects generation or receipt', { timeout: 15000 }, async () => {
  const user = await createTestAccount()
  const roomId = await createTestRoom(user.localId)
  const roomRef = db.collection('rooms').doc(roomId)
  const input = { roomId, messageId: randomUUID(), text: 'Approved deletion race prompt' }
  const provider = createControlledProvider()
  let screens = 0
  const moderation = { async screen() {
    screens++
    if (screens === 2) {
      const deletion = await handleDeleteRoom(db, user.localId, randomUUID(), { roomId })
      let resumed = deletion
      for (let pass = 0; pass < 20 && resumed.status === 'pending'; pass++) {
        resumed = await handleResumeMaintenance(db, user.localId, randomUUID(), { operationId: deletion.operationId })
      }
      assert.equal(resumed.status, 'complete')
    }
    return { verdict: 'allow' }
  } }
  const result = await handleAskThreadline(db, user.localId, 'Member', randomUUID(), input, localPolicy, provider, moderation)
  assert.equal(result.status, 'cancelled')
  assert.equal(screens, 2)
  assert.equal((await roomRef.collection('messages').get()).size, 0)
  assert.equal((await roomRef.collection('generations').get()).size, 0)
  const receipt = (await db.collection('receipts').doc(result.operationId).get()).data()
  assert.equal(receipt.status, 'cancelled')
  assert.equal(JSON.stringify(receipt).includes(input.text), false)
  assert.equal((await db.collection('quotaBuckets').doc(`aiLifetime_${user.localId}`).get()).data().consumedAttempts, 1)
})

test('Retry publication rejects changed origin or lost claim without reservations or dispatch', { timeout: 30000 }, async () => {
  for (const mutation of ['newer-origin', 'origin-succeeded', 'claim-missing', 'claim-owner', 'claim-hash', 'claim-state']) {
    const user = await createTestAccount()
    const roomId = await createTestRoom(user.localId)
    const roomRef = db.collection('rooms').doc(roomId)
    const input = await failedAsk(user, roomId)
    const requestId = randomUUID()
    const submissionRef = db.collection('submissions').doc(`${user.localId}_retryAiReply_${requestId}`)
    const provider = createControlledProvider()
    const budgetBefore = (await db.collection('budgets').doc(BUDGET_ID).get()).data()
    const quotaRef = db.collection('quotaBuckets').doc(`aiLifetime_${user.localId}`)
    const quotaBefore = (await quotaRef.get()).data()
    const moderation = createControlledModeration({ onScreen: async () => {
      if (mutation === 'newer-origin') await roomRef.update({ latestGenerationId: randomUUID() })
      if (mutation === 'origin-succeeded') await roomRef.collection('generations').doc(input.generationId).update({ state: 'succeeded' })
      if (mutation === 'claim-missing') await submissionRef.delete()
      if (mutation === 'claim-owner') await submissionRef.update({ callerUid: randomUUID() })
      if (mutation === 'claim-hash') await submissionRef.update({ payloadHash: randomUUID() })
      if (mutation === 'claim-state') await submissionRef.update({ state: 'unrecognized' })
    } })
    const result = await handleRetryAiReply(db, user.localId, 'Member', requestId, input, localPolicy, provider, moderation)
    assert.equal(result.status, 'failed', mutation)
    assert.equal(result.errorCode, 'screening-unavailable', mutation)
    assert.equal(moderation.screenCalls, 1)
    assert.equal(provider.countCalls, 0)
    assert.equal(provider.generateCalls, 0)
    assert.equal((await roomRef.collection('generations').get()).size, 1)
    assert.deepEqual((await db.collection('budgets').doc(BUDGET_ID).get()).data(), budgetBefore)
    assert.deepEqual((await quotaRef.get()).data(), quotaBefore)
  }
})

test('Retry output rejection replays its safe error without screening or spending again', { timeout: 15000 }, async () => {
  const user = await createTestAccount()
  const roomId = await createTestRoom(user.localId)
  const input = await failedAsk(user, roomId)
  const requestId = randomUUID()
  const provider = createControlledProvider()
  let screens = 0
  const moderation = { async screen() { return { verdict: ++screens === 1 ? 'allow' : 'block' } } }
  const result = await handleRetryAiReply(db, user.localId, 'Member', requestId, input, localPolicy, provider, moderation)
  assert.equal(result.status, 'failed')
  assert.equal(result.errorCode, 'screening-blocked')
  const budget = (await db.collection('budgets').doc(BUDGET_ID).get()).data()
  const replay = await handleRetryAiReply(db, user.localId, 'Member', requestId, input, localPolicy, provider, moderation)
  assert.equal(replay.status, 'failed')
  assert.equal(replay.errorCode, result.errorCode)
  assert.equal(screens, 2)
  assert.equal(provider.generateCalls, 1)
  assert.deepEqual((await db.collection('budgets').doc(BUDGET_ID).get()).data(), budget)
  const room = (await db.collection('rooms').doc(roomId).get()).data()
  assert.equal(room.activeGenerationId, null)
  assert.equal((await db.collection('rooms').doc(roomId).collection('messages').get()).size, 1)
})

test('Recovery during output classification keeps terminal generation and consumed spend', { timeout: 15000 }, async () => {
  const user = await createTestAccount()
  const roomId = await createTestRoom(user.localId)
  const roomRef = db.collection('rooms').doc(roomId)
  const provider = createControlledProvider()
  let screens = 0
  let generationId
  const moderation = { async screen() {
    if (++screens === 2) {
      generationId = (await roomRef.get()).data().activeGenerationId
      await roomRef.collection('generations').doc(generationId).update({ expiresAt: Date.now() - 1 })
      const recovered = await handleRecoverGeneration(db, user.localId, randomUUID(), { roomId, generationId })
      assert.equal(recovered.status, 'failed')
    }
    return { verdict: 'allow' }
  } }
  const input = { roomId, messageId: randomUUID(), text: 'Approved recovery race prompt' }
  const requestId = randomUUID()
  const result = await handleAskThreadline(db, user.localId, 'Member', requestId, input, localPolicy, provider, moderation)
  assert.equal(result.status, 'failed')
  assert.equal((await roomRef.collection('generations').doc(generationId).get()).data().state, 'timed-out')
  assert.equal((await roomRef.get()).data().activeGenerationId, null)
  assert.equal((await roomRef.collection('messages').get()).size, 1)
  const replay = await handleAskThreadline(db, user.localId, 'Member', requestId, input, localPolicy, provider, moderation)
  assert.equal(replay.status, result.status)
  assert.equal(replay.errorCode, result.errorCode)
  assert.equal(screens, 2)
  assert.equal(provider.generateCalls, 1)
  const quota = (await db.collection('quotaBuckets').doc(`aiLifetime_${user.localId}`).get()).data()
  assert.equal(quota.consumedAttempts, 1)
  assert.equal(quota.reservedAttempts, 0)
})
