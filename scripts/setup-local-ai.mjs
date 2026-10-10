#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { initializeApp, deleteApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'
import { MODEL, createGeminiProvider } from '../functions/dist/ai/provider.js'
import { BUDGET_ID, RESERVATION_MICRO_USD, PRICING_EXPIRY, LEGACY_LOCAL_ATTEMPT_LIMIT, checkPricing } from '../functions/dist/ai/policy.js'

const localPolicy = { localDevelopment: true, testerUids: [] }
const safetyPolicy = 'medium-and-above-v1'
const qualificationPrompt = 'Reply with exactly READY. This is a synthetic local setup check.'
const integer = value => Number.isSafeInteger(value) && value >= 0
export const computeCredentialDigest = key => createHash('sha256').update(key).digest('hex')

export function isLoopbackHost(host) {
  try {
    const url = new URL(`http://${host}`)
    return ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.port !== ''
      && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}

export async function validateLoopbackEnvironment() {
  for (const name of ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']) {
    if (process.env[name] && process.env[name] !== 'demo-threadline') throw new Error('Setup only supports project demo-threadline, never a live project.')
  }
  const hosts = {
    firestoreHost: process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080',
    authHost: process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099',
    hubHost: process.env.FIREBASE_EMULATOR_HUB ?? '127.0.0.1:4400',
    functionsHost: process.env.FIREBASE_FUNCTIONS_EMULATOR_HOST ?? (process.env.FUNCTIONS_EMULATOR_HOST ?? '127.0.0.1:5001'),
  }
  if (!Object.values(hosts).every(isLoopbackHost)) throw new Error('Setup requires loopback emulator hosts with explicit ports.')
  try {
    const hub = await fetch(`http://${hosts.hubHost}/emulators`, { signal: AbortSignal.timeout(5000) })
    const backends = await fetch(`http://${hosts.functionsHost}/backends`, { signal: AbortSignal.timeout(5000) })
    if (!hub.ok || !backends.ok) throw new Error('Emulators unavailable')
    const discovered = await hub.json()
    for (const [name, host] of [['firestore', hosts.firestoreHost], ['auth', hosts.authHost], ['functions', hosts.functionsHost]]) {
      const target = new URL(`http://${host}`)
      if (!discovered[name] || !isLoopbackHost(`${discovered[name].host}:${discovered[name].port}`)
        || discovered[name].port !== Number(target.port)) throw new Error('Unexpected emulator binding')
    }
    const data = await backends.json()
    const triggers = (data.backends ?? []).flatMap(backend => backend.functionTriggers ?? [])
    if (!triggers.some(trigger => trigger.entryPoint === 'command'
      && trigger.region === 'asia-southeast1'
      && trigger.labels?.EVENTARC_CLOUD_EVENT_SOURCE?.includes('/projects/demo-threadline/'))) throw new Error('Unexpected emulator project')
  } catch { throw new Error('Start Auth, Firestore and Functions using npm run emulators for demo-threadline, then retry setup. No cloud database was selected.') }
  return hosts
}

export function readLocalSecret({ secretPath = 'functions/.secret.local' } = {}) {
  let stat, content
  try { stat = fs.lstatSync(secretPath) }
  catch { throw new Error('Create functions/.secret.local in your editor with GEMINI_API_KEY and OPENAI_API_KEY entries. Never put keys in VITE_*, source or shell history.') }
  if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error('Restrict functions/.secret.local to an owner-only regular file: chmod 600 functions/.secret.local')
  try { content = fs.readFileSync(secretPath, 'utf8') }
  catch { throw new Error('Cannot read owner-only functions/.secret.local.') }
  const entries = content.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'))
  const keys = new Map()
  for (const entry of entries) {
    const match = /^(GEMINI_API_KEY|OPENAI_API_KEY)\s*=(.*)$/.exec(entry)
    if (!match || keys.has(match[1])) throw new Error('functions/.secret.local requires exactly one GEMINI_API_KEY and one OPENAI_API_KEY; no unknown or duplicate entries.')
    const value = match[2].trim().replace(/^(['"])(.*)\1$/, '$2')
    if (!value || /\s/.test(value)) throw new Error('Supply nonblank API keys in functions/.secret.local.')
    keys.set(match[1], value)
  }
  if (keys.size !== 2) throw new Error('functions/.secret.local requires GEMINI_API_KEY and OPENAI_API_KEY.')
  const key = keys.get('GEMINI_API_KEY')
  return key
}

export function parseOptionalCaps({ cliAttemptCap, cliAllowanceMicroUsd,
  envAttemptLimit = process.env.LOCAL_AI_ATTEMPT_LIMIT,
  envAllowanceMicroUsd = process.env.LOCAL_AI_ALLOWANCE_MICRO_USD } = {}) {
  const parse = raw => {
    if (raw === undefined) return undefined
    if (typeof raw !== 'string' || !/^\d+$/.test(raw) || !integer(Number(raw))) throw new Error('Optional caps must be nonnegative safe integers; omit them for clean uncapped setup.')
    return Number(raw)
  }
  return { attemptLimit: parse(cliAttemptCap ?? envAttemptLimit), allowanceMicroUsd: parse(cliAllowanceMicroUsd ?? envAllowanceMicroUsd) }
}

function validateLedger(budget) {
  if (!integer(budget.consumedMicroUsd) || !integer(budget.reservedMicroUsd)
    || !integer(budget.consumedMicroUsd + budget.reservedMicroUsd + RESERVATION_MICRO_USD)
    || (budget.allowanceMicroUsd !== null && !integer(budget.allowanceMicroUsd))
    || (budget.localAttemptLimit !== undefined && budget.localAttemptLimit !== null && !integer(budget.localAttemptLimit))) throw new Error('Existing local ledger is invalid; setup will not reset or replace it.')
}

export async function runLocalAiSetup({ db, provider, apiKey, ackPaidService = false,
  attemptCap, allowanceMicroUsd, now = Date.now }) {
  if (!apiKey?.trim()) throw new Error('A server credential is required.')
  for (const value of [attemptCap, allowanceMicroUsd]) if (value !== undefined && value !== null && !integer(value)) throw new Error('Invalid optional cap.')
  const ref = db.collection('budgets').doc(BUDGET_ID)
  const id = randomUUID(), credentialDigest = computeCredentialDigest(apiKey)
  const admitted = await db.runTransaction(async tx => {
    const snapshot = await tx.get(ref)
    const budget = snapshot.exists ? snapshot.data() : {
      model: MODEL, qualified: false, paidServicesVerified: false, safetyPolicy,
      reservationMicroUsd: RESERVATION_MICRO_USD, pricingExpiresAt: PRICING_EXPIRY,
      consumedMicroUsd: 0, reservedMicroUsd: 0, allowanceMicroUsd: allowanceMicroUsd ?? null,
      localAttemptLimit: attemptCap ?? null,
    }
    validateLedger(budget)
    const oldLimit = budget.localAttemptLimit === undefined ? LEGACY_LOCAL_ATTEMPT_LIMIT : budget.localAttemptLimit
    if (snapshot.exists && ((attemptCap !== undefined && oldLimit !== null && (attemptCap === null || attemptCap > oldLimit))
      || (allowanceMicroUsd !== undefined && budget.allowanceMicroUsd !== null && (allowanceMicroUsd === null || allowanceMicroUsd > budget.allowanceMicroUsd)))) throw new Error('Setup cannot increase an existing private cap. Review its recorded usage separately; nothing was reset.')
    const limits = {
      localAttemptLimit: attemptCap === undefined ? oldLimit : attemptCap,
      allowanceMicroUsd: allowanceMicroUsd === undefined ? budget.allowanceMicroUsd : allowanceMicroUsd,
    }
    const prior = budget.setupQualification
    if (prior && ['counting', 'dispatched'].includes(prior.state)) {
      if (!integer(prior.expiresAt) || prior.expiresAt > now()) throw new Error('Local qualification is already running; wait for it to settle.')
      // A stale counting worker cannot generate: the dispatch transaction checks its claim ID.
      if (prior.state === 'counting') {
        if (budget.reservedMicroUsd < RESERVATION_MICRO_USD) throw new Error('Qualification reservation is inconsistent.')
        budget.reservedMicroUsd -= RESERVATION_MICRO_USD
      }
    }
    if (budget.reservedMicroUsd !== 0) throw new Error('Inference is still reserved. Finish existing work before setup.')
    let reusable = budget.credentialDigest === credentialDigest
    try { checkPricing(budget, now(), 'local-setup', localPolicy) } catch { reusable = false }
    if (reusable) {
      tx.update(ref, limits)
      return { reused: true, ...limits }
    }
    if (!ackPaidService) throw new Error('Explicit paid-service and data-use acknowledgment required: use --ack-paid-service after confirming paid Gemini access/terms. One synthetic count and generation may be billed separately from Firebase credits.')
    if (now() >= PRICING_EXPIRY) throw new Error('Pinned pricing qualification has expired; review current provider pricing before setup.')
    if (limits.allowanceMicroUsd !== null && budget.consumedMicroUsd + RESERVATION_MICRO_USD > limits.allowanceMicroUsd) throw new Error('Insufficient local AI allowance for the synthetic qualification. No cap or usage was increased/reset.')
    const changes = { ...limits, qualified: false, reservedMicroUsd: RESERVATION_MICRO_USD,
      setupQualification: { id, state: 'counting', expiresAt: now() + 120000 } }
    if (snapshot.exists) tx.update(ref, changes)
    else tx.create(ref, { ...budget, ...changes })
    return { reused: false, ...limits }
  })
  if (admitted.reused) return { ...admitted, qualified: true, model: MODEL, attemptLimit: admitted.localAttemptLimit }
  let dispatched = false
  try {
    const contents = [{ role: 'user', parts: [{ text: qualificationPrompt }] }]
    const count = await provider.count(contents, AbortSignal.timeout(15000))
    if (!Number.isSafeInteger(count) || count < 1 || count > 8192) throw new Error('Invalid bounded count')
    await db.runTransaction(async tx => {
      const budget = (await tx.get(ref)).data()
      validateLedger(budget)
      if (budget.setupQualification?.id !== id || budget.setupQualification.state !== 'counting'
        || budget.setupQualification.expiresAt <= now() || budget.reservedMicroUsd < RESERVATION_MICRO_USD) throw new Error('Qualification claim expired')
      tx.update(ref, { reservedMicroUsd: budget.reservedMicroUsd - RESERVATION_MICRO_USD,
        consumedMicroUsd: budget.consumedMicroUsd + RESERVATION_MICRO_USD,
        'setupQualification.state': 'dispatched' })
    })
    dispatched = true
    const answer = await provider.generate({ contents, refs: [], inputTokens: count }, AbortSignal.timeout(45000))
    // The real provider already enforces STOP/safety/usage; controlled tests must also honor bounds.
    if (!answer || !answer.text?.trim() || Buffer.byteLength(answer.text, 'utf8') > 131072
      || !integer(answer.inputTokens) || answer.inputTokens > 8192 || !integer(answer.answerTokens)
      || answer.answerTokens < 1 || !integer(answer.thoughtTokens) || answer.answerTokens + answer.thoughtTokens > 2048) throw new Error('Invalid bounded answer')
    await db.runTransaction(async tx => {
      const budget = (await tx.get(ref)).data()
      validateLedger(budget)
      if (budget.setupQualification?.id !== id || budget.setupQualification.state !== 'dispatched'
        || budget.setupQualification.expiresAt <= now()) throw new Error('Qualification claim expired')
      tx.update(ref, { qualified: true, paidServicesVerified: true, model: MODEL, safetyPolicy,
        reservationMicroUsd: RESERVATION_MICRO_USD, pricingExpiresAt: PRICING_EXPIRY,
        credentialDigest, qualifiedAt: now(), 'setupQualification.state': 'complete' })
    })
    return { ...admitted, qualified: true, model: MODEL, attemptLimit: admitted.localAttemptLimit }
  } catch {
    await db.runTransaction(async tx => {
      const budget = (await tx.get(ref)).data()
      if (budget?.setupQualification?.id !== id) return
      validateLedger(budget)
      const counting = budget.setupQualification.state === 'counting'
      if (counting && budget.reservedMicroUsd < RESERVATION_MICRO_USD) throw new Error('Qualification ledger requires review; it was not reset.')
      tx.update(ref, { qualified: false, reservedMicroUsd: budget.reservedMicroUsd - (counting ? RESERVATION_MICRO_USD : 0),
        'setupQualification.state': 'failed' })
    })
    throw new Error(`Provider qualification failed (${dispatched ? 'dispatched/ambiguous; allowance retained' : 'undispatched; reservation released'}). Check your key, paid access, pinned model availability and quota. No fallback or automatic retry was used.`)
  }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('Local setup: npm run setup:local-ai -- --ack-paid-service [--attempt-cap=N] [--allowance-micro-usd=N]\nUse Node22, Java21+ and the Firebase CLI. Start npm run emulators first. Caps are optional; existing usage is never reset. Gemini charges/data-use terms are separate from Firebase credits.')
    return
  }
  if (argv.some(arg => !/^--(ack-paid-service|attempt-cap=\d+|allowance-micro-usd=\d+)$/.test(arg))
    || new Set(argv.map(arg => arg.split('=')[0])).size !== argv.length) throw new Error('Unknown, duplicate or invalid setup option. Run --help.')
  const caps = parseOptionalCaps({ cliAttemptCap: argv.find(arg => arg.startsWith('--attempt-cap='))?.split('=')[1],
    cliAllowanceMicroUsd: argv.find(arg => arg.startsWith('--allowance-micro-usd='))?.split('=')[1] })
  const hosts = await validateLoopbackEnvironment()
  const apiKey = readLocalSecret()
  process.env.FIRESTORE_EMULATOR_HOST = hosts.firestoreHost
  process.env.FIREBASE_AUTH_EMULATOR_HOST = hosts.authHost
  process.env.FIREBASE_EMULATOR_HUB = hosts.hubHost
  process.env.GCLOUD_PROJECT = 'demo-threadline'
  const app = initializeApp({ projectId: 'demo-threadline' }, `local-setup-${randomUUID()}`)
  try {
    const result = await runLocalAiSetup({ db: getFirestore(app), provider: createGeminiProvider(apiKey), apiKey,
      ackPaidService: argv.includes('--ack-paid-service'), attemptCap: caps.attemptLimit, allowanceMicroUsd: caps.allowanceMicroUsd })
    console.log(result.reused ? 'Existing same-key qualification reused; usage retained.' : 'Synthetic pinned-model qualification passed; conservative 30000 microUSD recorded. Usage retained.')
    console.log('Start: VITE_THREADLINE_AI_ENABLED=true npm run dev:emulator')
  } finally { await deleteApp(app) }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
