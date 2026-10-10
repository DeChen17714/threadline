#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ALL_FIXTURES,
  FIXTURE_VERSION,
  HOLDOUT_VERSION
} from './moderation-fixtures.mjs'
import {
  MODERATION_POLICY_VERSION,
  createOpenAiModerationPort
} from '../functions/dist/moderation/provider.js'

export function readLocalOpenAiSecret({ secretPath = 'functions/.secret.local' } = {}) {
  let stat, content
  try {
    stat = fs.lstatSync(secretPath)
  } catch {
    throw new Error(`Create ${secretPath} in your editor with an OPENAI_API_KEY=... entry. Never put the key in VITE_*, source or shell history.`)
  }
  if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) {
    throw new Error(`Restrict ${secretPath} to an owner-only regular file: chmod 600 ${secretPath}`)
  }
  try {
    content = fs.readFileSync(secretPath, 'utf8')
  } catch {
    throw new Error(`Cannot read owner-only ${secretPath}.`)
  }

  const entries = content
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))

  const openAiEntries = entries.filter(line => /^OPENAI_API_KEY\s*=/.test(line))
  const geminiEntries = entries.filter(line => /^GEMINI_API_KEY\s*=/.test(line))
  if (openAiEntries.length !== 1 || geminiEntries.length > 1 ||
      entries.some(line => !/^(OPENAI_API_KEY|GEMINI_API_KEY)\s*=/.test(line))) {
    throw new Error(`${secretPath} requires one OPENAI_API_KEY and at most one GEMINI_API_KEY; no unknown entries.`)
  }

  const raw = openAiEntries[0].slice(openAiEntries[0].indexOf('=') + 1).trim()
  const key = raw.replace(/^(['"])(.*)\1$/, '$2')
  if (!key || /\s/.test(key)) {
    throw new Error(`Supply a nonblank OpenAI key in ${secretPath}.`)
  }
  return key
}

export function parseQualifyArgs(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--help') {
    return { help: true }
  }

  if (argv.length !== 1 || argv[0] !== '--ack-external-service') {
    throw new Error('Use --ack-external-service to run the complete external-service qualification; partial runs are not accepted.')
  }
  return { help: false }
}

function calculatePercentile(sortedValues, percentile) {
  if (sortedValues.length === 0) return 0
  const index = Math.ceil((percentile / 100) * sortedValues.length) - 1
  return sortedValues[Math.max(0, Math.min(index, sortedValues.length - 1))]
}

export async function runModerationQualification({
  apiKey
} = {}) {
  const activePort = createOpenAiModerationPort(apiKey)
  const activeFixtures = ALL_FIXTURES
  const startedAt = new Date().toISOString()

  const observations = []
  const latencies = []

  for (const fixture of activeFixtures) {
    const start = performance.now()
    const result = await activePort.screen(fixture.text)
    const latencyMs = Math.round(performance.now() - start)
    latencies.push(latencyMs)

    observations.push({
      id: fixture.id,
      family: fixture.family,
      familyGroup: fixture.familyGroup,
      expected: fixture.expected,
      text: fixture.text,
      latencyMs,
      model: result.model ?? null,
      policyVersion: result.policyVersion,
      observed: result.verdict,
      verdict: result.verdict,
      reason: result.reason,
      categories: result.categories ?? null,
      scores: result.scores ?? null,
      holdout: Boolean(fixture.holdout)
    })
    if (result.verdict === 'unavailable') break
  }

  const sortedLatencies = [...latencies].sort((a, b) => a - b)
  const medianLatency = calculatePercentile(sortedLatencies, 50)
  const p95Latency = calculatePercentile(sortedLatencies, 95)
  const minLatency = sortedLatencies.length > 0 ? sortedLatencies[0] : 0
  const maxLatency = sortedLatencies.length > 0 ? sortedLatencies[sortedLatencies.length - 1] : 0

  const harmfulMisses = []
  const allFalsePositives = []
  const unavailable = []

  let actualBlocked = 0
  let actualAllowed = 0
  let expectedBlocked = 0
  let expectedAllowed = 0

  const groupsMap = new Map()

  for (const obs of observations) {
    if (obs.expected === 'block') expectedBlocked++
    if (obs.expected === 'allow') expectedAllowed++
    if (obs.verdict === 'block') actualBlocked++
    if (obs.verdict === 'allow') actualAllowed++

    if (!groupsMap.has(obs.familyGroup)) {
      groupsMap.set(obs.familyGroup, {
        family: obs.familyGroup,
        cases: 0,
        falseNegatives: 0,
        falsePositives: 0,
        unavailable: 0
      })
    }
    const groupStat = groupsMap.get(obs.familyGroup)
    groupStat.cases++

    if (obs.verdict === 'unavailable') {
      unavailable.push(obs.id)
      groupStat.unavailable++
    } else if (obs.expected === 'block' && obs.verdict === 'allow') {
      harmfulMisses.push(obs.id)
      groupStat.falseNegatives++
    } else if (obs.expected === 'allow' && obs.verdict === 'block') {
      allFalsePositives.push(obs.id)
      groupStat.falsePositives++
    }
  }

  const unattempted = activeFixtures.slice(observations.length).map(fixture => fixture.id)
  const passed = isModerationQualified(observations)
  const gate = passed ? 'qualified-conservative-demo' : 'blocked'
  const observedModels = [...new Set(observations.flatMap(observation => observation.model ? [observation.model] : []))]

  const summary = {
    startedAt,
    completedAt: new Date().toISOString(),
    fixtureVersion: FIXTURE_VERSION,
    holdoutVersion: HOLDOUT_VERSION,
    policyVersion: MODERATION_POLICY_VERSION,
    models: observedModels,
    totalFixtures: activeFixtures.length,
    baselineCount: activeFixtures.filter(f => !f.holdout).length,
    holdoutCount: activeFixtures.filter(f => f.holdout).length,
    totalRealCalls: observations.length,
    unattemptedCases: unattempted,
    expectedBlocked,
    expectedAllowed,
    actualBlocked,
    actualAllowed,
    actualUnavailable: unavailable.length,
    harmfulMisses,
    benignBlocked: allFalsePositives,
    unavailableCases: unavailable,
    groups: Array.from(groupsMap.values()),
    latencyMs: {
      minimum: minLatency,
      median: medianLatency,
      p95: p95Latency,
      maximum: maxLatency
    },
    gate,
    delegatedPolicy: 'Conservative demo: harassment>=0.15, illicit>=0.2, violence>=0.5; other category booleans. Benign blocks are reported and accepted, never relabeled.',
    notes: 'Synthetic qualification evaluation; not statistical assurance or verified unsupported-language safety. Tier-specific quotas apply per provider documentation.'
  }

  const recordPayload = {
    fixtureVersion: FIXTURE_VERSION,
    holdoutVersion: HOLDOUT_VERSION,
    policy: MODERATION_POLICY_VERSION,
    startedAt,
    calls: summary.totalRealCalls,
    documentedUnitChargeUsd: 0,
    models: observedModels,
    gate,
    observations
  }

  writePrivateJson('.firebase/epic6-moderation-qualification.json', recordPayload)
  writePrivateJson('.firebase/epic6-moderation-qualification-summary.json', summary)

  return {
    summary,
    observations,
    passed
  }
}

export function isModerationQualified(observations) {
  return observations.length === ALL_FIXTURES.length &&
    observations.some(observation => observation.expected === 'allow' && observation.verdict === 'allow') &&
    ALL_FIXTURES.every((fixture, index) => {
      const observation = observations[index]
      return observation.id === fixture.id && observation.expected === fixture.expected &&
        (observation.verdict === 'allow' || observation.verdict === 'block') &&
        (fixture.expected !== 'block' || observation.verdict === 'block')
    })
}

function writePrivateJson(outputPath, payload) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  const fd = fs.openSync(outputPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600)
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('Qualification evidence must be a regular file.')
    fs.fchmodSync(fd, 0o600)
    fs.ftruncateSync(fd, 0)
    fs.writeFileSync(fd, JSON.stringify(payload, null, 2), 'utf8')
  } finally {
    fs.closeSync(fd)
  }
}

export function printSafeSummary(summary) {
  console.log('=== Moderation Adapter Qualification Summary ===')
  console.log(`Observed Models:     ${summary.models.join(', ') || 'none'}`)
  console.log(`Policy Version:      ${summary.policyVersion}`)
  console.log(`Total Fixtures:      ${summary.totalFixtures} (${summary.baselineCount} baseline + ${summary.holdoutCount} holdouts)`)
  console.log(`Total Calls:         ${summary.totalRealCalls}; unattempted: ${summary.unattemptedCases.length}`)
  console.log(`Harmful Misses (FN): ${summary.harmfulMisses.length}${summary.harmfulMisses.length > 0 ? ` [${summary.harmfulMisses.join(', ')}]` : ''}`)
  console.log(`Benign Blocked (FP): ${summary.benignBlocked.length} [${summary.benignBlocked.join(', ')}]; accepted demo limitation`)
  console.log(`Unavailable (Failures):        ${summary.actualUnavailable}${summary.actualUnavailable > 0 ? ` [${summary.unavailableCases.join(', ')}]` : ''}`)
  console.log(`Latency (ms):        min=${summary.latencyMs.minimum}, median=${summary.latencyMs.median}, p95=${summary.latencyMs.p95}, max=${summary.latencyMs.maximum}`)
  console.log(`Quality Gate:        ${summary.gate.toUpperCase()}`)
  console.log('Limitation Note:     Synthetic evaluation only; not statistical assurance or complete language coverage.')
  console.log('================================================')
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseQualifyArgs(argv)
  if (options.help) {
    console.log('Usage: node scripts/qualify-moderation.mjs --ack-external-service\nRuns all frozen baseline and holdout cases once. Reads the owner-only functions/.secret.local; writes owner-only evidence under ignored .firebase/.')
    return
  }

  const apiKey = readLocalOpenAiSecret()
  const { summary, passed } = await runModerationQualification({ apiKey })

  printSafeSummary(summary)

  if (!passed) {
    process.exitCode = 1
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
