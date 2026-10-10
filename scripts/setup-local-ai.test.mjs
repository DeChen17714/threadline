import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { initializeApp, deleteApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { readLocalSecret, parseOptionalCaps, runLocalAiSetup, computeCredentialDigest, main } from './setup-local-ai.mjs'
import { MODEL } from '../functions/dist/ai/provider.js'
import { BUDGET_ID, RESERVATION_MICRO_USD, PRICING_EXPIRY } from '../functions/dist/ai/policy.js'
import { handleAskThreadline, handleRetryAiReply } from '../functions/dist/ai/lifecycle.js'
import { handleCreateRoom } from '../functions/dist/handlers/createRoom.js'
import { PROJECT_ID } from './emulator-test-env.mjs'

const app = initializeApp({ projectId: PROJECT_ID }, 'threadline-setup-regressions')
const db = getFirestore(app, 'setup-regressions')
const budgetRef = db.collection('budgets').doc(BUDGET_ID)
const policy = { localDevelopment: true, testerUids: [] }
const key = 'synthetic-setup-credential-not-a-real-key'
const moderation = { async screen() { return { verdict: 'allow', policyVersion: 'controlled-test', reason: null } } }
function controlled({ countFailure = false, generateFailure = false, countBarrier } = {}) {
  let counts = 0, generations = 0
  return {
    get counts() { return counts }, get generations() { return generations },
    async count() { counts++; if (countBarrier) await countBarrier(); if (countFailure) throw new Error(key); return 40 },
    async generate() { generations++; if (generateFailure) throw new Error(key); return { text: 'Controlled response', inputTokens: 40, answerTokens: 2, thoughtTokens: 2 } },
  }
}
const setup = (provider, options = {}) => runLocalAiSetup({ db, provider, apiKey: key, ackPaidService: true, ...options })
async function existingBudget(overrides = {}) {
  await budgetRef.set({ model: MODEL, qualified: true, paidServicesVerified: true,
    safetyPolicy: 'medium-and-above-v1', reservationMicroUsd: RESERVATION_MICRO_USD,
    pricingExpiresAt: PRICING_EXPIRY, consumedMicroUsd: 750000, reservedMicroUsd: 0,
    allowanceMicroUsd: 1000000, credentialDigest: computeCredentialDigest(key), ...overrides })
}
test.beforeEach(async () => { await budgetRef.delete() })
test.after(async () => { await budgetRef.update({ qualified: false }).catch(() => {}); await deleteApp(app) })

test('new setup needs paid/data-use consent before any provider work or ledger creation', async () => {
  const provider = controlled()
  await assert.rejects(setup(provider, { ackPaidService: false }))
  assert.equal(provider.counts, 0)
  assert.equal(provider.generations, 0)
  assert.equal((await budgetRef.get()).exists, false)
})

test('clean startup enables actual Ask and author retry past 50 attempts and historical private spend', async () => {
  await setup(controlled())
  const owner = `setup-${randomUUID()}`
  const { roomId } = await handleCreateRoom(db, owner, 'Synthetic owner', randomUUID(), { name: 'Clean setup proof', description: '' })
  await budgetRef.update({ consumedMicroUsd: 2000000 })
  const quota = db.collection('quotaBuckets').doc(`aiLifetime_${owner}`)
  await quota.set({ requesterId: owner, consumedAttempts: 50, reservedAttempts: 0 })
  const messageId = randomUUID()
  const failed = await handleAskThreadline(db, owner, 'Owner', randomUUID(), { roomId, messageId, text: 'Controlled question' }, policy, controlled({ generateFailure: true }), moderation)
  assert.equal(failed.status, 'failed')
  const room = (await db.collection('rooms').doc(roomId).get()).data()
  const provider = controlled()
  const requestId = randomUUID(), input = { roomId, promptMessageId: messageId, generationId: room.latestGenerationId }
  assert.equal((await handleRetryAiReply(db, owner, 'Owner', requestId, input, policy, provider, moderation)).status, 'complete')
  assert.equal((await handleRetryAiReply(db, owner, 'Owner', requestId, input, policy, provider, moderation)).status, 'complete')
  assert.equal(provider.generations, 1)
  assert.equal((await quota.get()).data().consumedAttempts, 52)
  const budget = (await budgetRef.get()).data()
  assert.equal(budget.allowanceMicroUsd, null)
  assert.equal(budget.localAttemptLimit, null)
  assert.equal(budget.consumedMicroUsd, 2000000 + 2 * RESERVATION_MICRO_USD)
  assert.equal(budget.reservedMicroUsd, 0)
  const messages = await db.collection('rooms').doc(roomId).collection('messages').get()
  assert.equal(messages.docs.filter(row => row.data().kind === 'human').length, 1)
  assert.equal(messages.docs.filter(row => row.data().kind === 'ai').length, 1)
})

test('same-key setup reuses qualification without changing private consumption or widening legacy caps', async () => {
  await existingBudget()
  const provider = controlled()
  await setup(provider, { ackPaidService: false })
  const after = (await budgetRef.get()).data()
  assert.equal(after.localAttemptLimit, 50)
  assert.equal(after.allowanceMicroUsd, 1000000)
  assert.equal(after.consumedMicroUsd, 750000)
  assert.equal(after.reservedMicroUsd, 0)
  assert.equal(provider.counts, 0)
  assert.equal(provider.generations, 0)
  await assert.rejects(setup(provider, { allowanceMicroUsd: 2000000 }))
  await assert.rejects(setup(provider, { attemptCap: null }))
  assert.equal((await budgetRef.get()).data().allowanceMicroUsd, 1000000)
})

test('changed credential cannot reuse a prior receipt and preserves counters while qualifying', async () => {
  await existingBudget({ credentialDigest: computeCredentialDigest('different-synthetic-key') })
  const provider = controlled()
  await assert.rejects(setup(provider, { ackPaidService: false }))
  assert.equal(provider.counts, 0)
  await setup(provider)
  const after = (await budgetRef.get()).data()
  assert.equal(provider.generations, 1)
  assert.equal(after.consumedMicroUsd, 750000 + RESERVATION_MICRO_USD)
  assert.equal(after.localAttemptLimit, 50)
  assert.equal(after.allowanceMicroUsd, 1000000)
})

test('count failure releases undispatched funds; ambiguous generation consumes and never exposes provider secrets', async () => {
  for (const dispatched of [false, true]) {
    await budgetRef.delete()
    const provider = controlled(dispatched ? { generateFailure: true } : { countFailure: true })
    await assert.rejects(setup(provider), error => !error.message.includes(key))
    const after = (await budgetRef.get()).data()
    assert.equal(after.reservedMicroUsd, 0)
    assert.equal(after.consumedMicroUsd, dispatched ? RESERVATION_MICRO_USD : 0)
    assert.equal(after.qualified, false)
    assert.equal(provider.generations, dispatched ? 1 : 0)
  }
})

test('concurrent setup owns one qualification and cannot duplicate paid dispatch', async () => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const firstProvider = controlled({ countBarrier: () => { entered.resolve(); return release.promise } })
  const first = setup(firstProvider)
  await entered.promise
  const secondProvider = controlled()
  try { await assert.rejects(setup(secondProvider)); assert.equal(secondProvider.counts, 0) }
  finally { release.resolve() }
  await first
  assert.equal(firstProvider.generations, 1)
  assert.equal((await budgetRef.get()).data().consumedMicroUsd, RESERVATION_MICRO_USD)
})

test('expired counting setup is fenced from dispatch after replacement and cannot erase newer qualification', async () => {
  let now = Date.now()
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  const oldProvider = controlled({ countBarrier: () => { entered.resolve(); return release.promise } })
  const old = setup(oldProvider, { now: () => now }).then(() => null, error => error)
  await entered.promise
  now += 120001
  await setup(controlled(), { now: () => now })
  release.resolve()
  assert(await old instanceof Error)
  assert.equal(oldProvider.generations, 0)
  const after = (await budgetRef.get()).data()
  assert.equal(after.qualified, true)
  assert.equal(after.consumedMicroUsd, RESERVATION_MICRO_USD)
  assert.equal(after.reservedMicroUsd, 0)
})

test('zero optional allowance and active inference reservations refuse setup without provider work', async () => {
  const provider = controlled()
  await assert.rejects(setup(provider, { allowanceMicroUsd: 0 }))
  assert.equal((await budgetRef.get()).exists, false)
  await existingBudget({ reservedMicroUsd: RESERVATION_MICRO_USD })
  const before = (await budgetRef.get()).data()
  await assert.rejects(setup(provider))
  assert.deepEqual((await budgetRef.get()).data(), before)
  assert.equal(provider.counts, 0)
})

test('credential file parsing refuses unreadable, multiple, empty and nonprivate keys without exposing values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadline-secret-test-'))
  const secretPath = path.join(dir, '.secret.test')
  try {
    assert.throws(() => readLocalSecret({ secretPath }))
    fs.writeFileSync(secretPath, `GEMINI_API_KEY="${key}"\n`, { mode: 0o600 })
    assert.throws(() => readLocalSecret({ secretPath }))
    fs.writeFileSync(secretPath, `# Server-only keys\nGEMINI_API_KEY="${key}"\nOPENAI_API_KEY= sk-synthetic-moderation-key \n`)
    assert.equal(readLocalSecret({ secretPath }), key)
    for (const content of [
      `GEMINI_API_KEY=${key}\nGEMINI_API_KEY=${key}`,
      'GEMINI_API_KEY=',
      `GEMINI_API_KEY=${key}\nOPENAI_API_KEY=`,
      `GEMINI_API_KEY=${key}\nOPENAI_API_KEY=sk-synthetic\nOPENAI_API_KEY=sk-duplicate`,
      `GEMINI_API_KEY=${key}\nUNEXPECTED_API_KEY=sk-synthetic`,
    ]) {
      fs.writeFileSync(secretPath, content)
      assert.throws(() => readLocalSecret({ secretPath }), error => !error.message.includes(key))
    }
    if (process.platform !== 'win32') {
      fs.chmodSync(secretPath, 0o644)
      assert.throws(() => readLocalSecret({ secretPath }))
    }
  } finally { fs.rmSync(dir, { recursive: true }) }
})

test('invalid cap and unknown CLI options cannot become permissive configuration', async () => {
  for (const raw of ['-1', '1.2', '9007199254740992', '', 'unlimited']) assert.throws(() => parseOptionalCaps({ cliAttemptCap: raw }))
  await assert.rejects(main(['--allowance-usd=20']))
  await assert.rejects(main(['--ack-paid-service', '--ack-paid-service']))
  assert.equal((await budgetRef.get()).exists, false)
})
