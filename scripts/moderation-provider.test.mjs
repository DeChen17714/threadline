import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  MODERATION_MODEL,
  MODERATION_POLICY_VERSION,
  createOpenAiModerationPort
} from '../functions/dist/moderation/provider.js'
import {
  readLocalOpenAiSecret,
  parseQualifyArgs,
  isModerationQualified
} from './qualify-moderation.mjs'
import { ALL_FIXTURES } from './moderation-fixtures.mjs'

const EXPECTED_CATEGORIES = [
  'harassment',
  'harassment/threatening',
  'sexual',
  'hate',
  'hate/threatening',
  'illicit',
  'illicit/violent',
  'self-harm/intent',
  'self-harm/instructions',
  'self-harm',
  'sexual/minors',
  'violence',
  'violence/graphic'
]

function makeCleanScores() {
  const scores = {}
  for (const cat of EXPECTED_CATEGORIES) {
    scores[cat] = 0.001
  }
  return scores
}

function makeCleanCategories() {
  const cats = {}
  for (const cat of EXPECTED_CATEGORIES) {
    cats[cat] = false
  }
  return cats
}

function makeMockResponse({
  model = MODERATION_MODEL,
  flagged = false,
  categories = makeCleanCategories(),
  categoryScores = makeCleanScores()
} = {}) {
  return JSON.stringify({
    id: 'modr-test-id-12345',
    model,
    results: [
      {
        flagged,
        categories,
        category_scores: categoryScores
      }
    ]
  })
}

function createMockFetch(handler) {
  let callCount = 0
  const calls = []

  const mock = async (url, options = {}) => {
    callCount++
    calls.push({ url, options })
    return handler(url, options, callCount)
  }

  mock.getCalls = () => calls
  mock.getCallCount = () => callCount
  return mock
}


test('missing or invalid API key fails closed without dispatch', async () => {
  const invalidKeys = ['', '   ', 'private key sentinel', null, undefined, 123, {}]

  for (const key of invalidKeys) {
    const mock = createMockFetch(() => assert.fail('fetch should not be called'))
    const port = createOpenAiModerationPort(key, { fetch: mock })
    const result = await port.screen('Hello world')

    assert.equal(result.verdict, 'unavailable')
    assert.equal(result.policyVersion, MODERATION_POLICY_VERSION)
    assert.equal(mock.getCallCount(), 0)
    // Key must not leak in reason or properties
    if (key === 'private key sentinel') assert.equal(JSON.stringify(result).includes(key), false)
  }
})

test('nonblank text and input byte bounds fail closed without dispatch', async () => {
  const apiKey = 'test-api-key-safe-mock'
  const mock = createMockFetch(() => assert.fail('fetch should not be called'))
  const port = createOpenAiModerationPort(apiKey, { fetch: mock })

  // Empty string
  const emptyRes = await port.screen('')
  assert.equal(emptyRes.verdict, 'unavailable')
  assert.equal(mock.getCallCount(), 0)

  // Whitespace only
  const wsRes = await port.screen('   \n\t  ')
  assert.equal(wsRes.verdict, 'unavailable')
  assert.equal(mock.getCallCount(), 0)

  // Non-string input
  const nonStrRes = await port.screen(null)
  assert.equal(nonStrRes.verdict, 'unavailable')
  assert.equal(mock.getCallCount(), 0)

  // Exceeds 131072 UTF-8 bytes
  const largeText = 'a'.repeat(131073)
  const overflowRes = await port.screen(largeText)
  assert.equal(overflowRes.verdict, 'unavailable')
  assert.equal(mock.getCallCount(), 0)

  // Multi-byte character overflow check (e.g., 3-byte characters)
  const multiByteOverflow = '€'.repeat(43692) // 43692 * 3 = 131076 bytes
  const mbRes = await port.screen(multiByteOverflow)
  assert.equal(mbRes.verdict, 'unavailable')
  assert.equal(mock.getCallCount(), 0)
})


test('oversized streamed responses are cancelled and never allowed', async () => {
  let cancelled = false
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(makeMockResponse().padEnd(65537, ' ')))
    },
    cancel() { cancelled = true },
  })
  const mock = createMockFetch(async () => new Response(stream))
  const result = await createOpenAiModerationPort('synthetic-key', { fetch: mock }).screen('Synthetic request')
  assert.equal(result.verdict, 'unavailable')
  assert.equal(cancelled, true)
})

test('maximum valid input and response byte boundaries remain usable', async () => {
  const mock = createMockFetch(async () => new Response(makeMockResponse().padEnd(65536, ' ')))
  const result = await createOpenAiModerationPort('synthetic-key', { fetch: mock }).screen('€'.repeat(43690) + 'ab')
  assert.equal(result.verdict, 'allow')
})

test('HTTP error status codes (401, 403, 429, 500, 503) resolve to unavailable with no retry', async () => {
  const apiKey = 'secret-test-openai-key-value'
  const errorStatuses = [302, 401, 403, 429, 500, 502, 503, 504]

  for (const status of errorStatuses) {
    const mock = createMockFetch(async () => {
      return new Response(JSON.stringify({ error: { message: `Simulated error ${status} with secret-test-openai-key-value` } }), {
        status,
        headers: { 'content-type': 'application/json' }
      })
    })

    const port = createOpenAiModerationPort(apiKey, { fetch: mock })
    const result = await port.screen('Harmful or harmless input')

    assert.equal(result.verdict, 'unavailable')
    assert.equal(mock.getCallCount(), 1, `Status ${status} must not retry`)
    assert.equal(typeof result.reason, 'string')
    // Safe reasons only: raw error or secret key must never leak
    assert.equal(JSON.stringify(result).includes(apiKey), false)
    assert.equal(result.reason.includes('secret-test-openai-key-value'), false)
  }
})

test('network throw and HTTP redirects fail closed to unavailable', async () => {
  const apiKey = 'test-api-key'

  // Network connection error
  const failingMock = createMockFetch(async () => {
    throw new TypeError('fetch failed: ECONNREFUSED')
  })
  const port1 = createOpenAiModerationPort(apiKey, { fetch: failingMock })
  const result1 = await port1.screen('Hello')
  assert.equal(result1.verdict, 'unavailable')
  assert.equal(failingMock.getCallCount(), 1)

  // Redirect error (due to redirect: 'error')
  const redirectMock = createMockFetch(async () => {
    throw new TypeError('Failed to fetch: redirect mode is set to error')
  })
  const port2 = createOpenAiModerationPort(apiKey, { fetch: redirectMock })
  const result2 = await port2.screen('Hello')
  assert.equal(result2.verdict, 'unavailable')
  assert.equal(redirectMock.getCallCount(), 1)
})

test('timeout and caller abort signal fail closed to unavailable', async () => {
  const apiKey = 'test-api-key'

  // Injected timeoutMs
  const delayMock = createMockFetch(async (_url, options) => {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve(new Response(makeMockResponse()))
      }, 200)
      if (options.signal) {
        options.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          const err = new Error('The operation was aborted')
          err.name = 'AbortError'
          reject(err)
        })
      }
    })
  })

  const port = createOpenAiModerationPort(apiKey, { fetch: delayMock, timeoutMs: 30 })
  const timeoutResult = await port.screen('Checking timeout')
  assert.equal(timeoutResult.verdict, 'unavailable')
  assert.equal(typeof timeoutResult.reason, 'string')

  // Caller abort signal
  const callerController = new AbortController()
  callerController.abort()

  const port2 = createOpenAiModerationPort(apiKey, { fetch: delayMock, timeoutMs: 1000 })
  const abortResult = await port2.screen('Checking caller abort', callerController.signal)
  assert.equal(abortResult.verdict, 'unavailable')
})

test('invalid JSON or malformed schema returns unavailable', async () => {
  const apiKey = 'test-api-key'

  const clean = () => JSON.parse(makeMockResponse())
  const mutations = [
    payload => { payload.model = 'constructor' },
    payload => { payload.model = '__proto__' },
    payload => { payload.model = 'unknown-model' },
    payload => { payload.results = [] },
    payload => { payload.results.push(payload.results[0]) },
    payload => { payload.results[0].flagged = 'false' },
    payload => { delete payload.results[0].categories.hate },
    payload => { payload.results[0].categories.hate = 'false' },
    payload => { payload.results[0].categories.future = false },
    payload => { delete payload.results[0].category_scores.illicit },
    payload => { payload.results[0].category_scores.hate = 'high' },
    payload => { payload.results[0].category_scores.hate = 1.5 },
    payload => { payload.results[0].category_scores.hate = -0.1 },
    payload => { payload.results[0].category_scores.hate = null },
    payload => { payload.results[0].category_scores.future = 0.1 },
    payload => {
      payload.results[0].scores = payload.results[0].category_scores
      delete payload.results[0].category_scores
    },
  ]
  const testPayloads = ['not JSON', ...mutations.map(mutate => {
    const payload = clean()
    mutate(payload)
    return JSON.stringify(payload)
  })]

  for (const payload of testPayloads) {
    const mock = createMockFetch(async () => new Response(payload, { status: 200, headers: { 'content-type': 'application/json' } }))
    const port = createOpenAiModerationPort(apiKey, { fetch: mock })
    const result = await port.screen('Sample text')
    assert.equal(result.verdict, 'unavailable')
    assert.equal(mock.getCallCount(), 1)
  }
})

test('recognized model snapshots are accepted', async () => {
  const apiKey = 'test-api-key'
  const recognizedModels = ['omni-moderation-latest', 'omni-moderation-2024-09-26']

  for (const model of recognizedModels) {
    const mock = createMockFetch(async () => {
      return new Response(makeMockResponse({ model }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const port = createOpenAiModerationPort(apiKey, { fetch: mock })
    const result = await port.screen('Safe text')
    assert.equal(result.verdict, 'allow')
    assert.equal(result.model, model)
  }
})

test('conservative category-score policy: harassment threshold >= 0.15', async () => {
  const apiKey = 'test-api-key'

  // harassment score = 0.15 (triggers block even if categories.harassment is false)
  const scoresBlock = makeCleanScores()
  scoresBlock.harassment = 0.15
  const mockBlock = createMockFetch(async () => new Response(makeMockResponse({ categoryScores: scoresBlock }), { status: 200 }))
  const portBlock = createOpenAiModerationPort(apiKey, { fetch: mockBlock })
  const resultBlock = await portBlock.screen('Test harassment score')
  assert.equal(resultBlock.verdict, 'block')
  assert.equal(typeof resultBlock.reason, 'string')

  // harassment score = 0.149 (allows if no other triggers)
  const scoresAllow = makeCleanScores()
  scoresAllow.harassment = 0.149
  const mockAllow = createMockFetch(async () => new Response(makeMockResponse({ categoryScores: scoresAllow }), { status: 200 }))
  const portAllow = createOpenAiModerationPort(apiKey, { fetch: mockAllow })
  const resultAllow = await portAllow.screen('Test harassment score')
  assert.equal(resultAllow.verdict, 'allow')
  assert.equal(resultAllow.reason, null)
})

test('conservative category-score policy: illicit threshold >= 0.20', async () => {
  const apiKey = 'test-api-key'

  const scoresBlock = makeCleanScores()
  scoresBlock.illicit = 0.20
  const mockBlock = createMockFetch(async () => new Response(makeMockResponse({ categoryScores: scoresBlock }), { status: 200 }))
  const portBlock = createOpenAiModerationPort(apiKey, { fetch: mockBlock })
  const resultBlock = await portBlock.screen('Test illicit score')
  assert.equal(resultBlock.verdict, 'block')

  const scoresAllow = makeCleanScores()
  scoresAllow.illicit = 0.199
  const mockAllow = createMockFetch(async () => new Response(makeMockResponse({ categoryScores: scoresAllow }), { status: 200 }))
  const portAllow = createOpenAiModerationPort(apiKey, { fetch: mockAllow })
  const resultAllow = await portAllow.screen('Test illicit score')
  assert.equal(resultAllow.verdict, 'allow')
})

test('conservative category-score policy: violence threshold >= 0.50', async () => {
  const apiKey = 'test-api-key'

  const scoresBlock = makeCleanScores()
  scoresBlock.violence = 0.50
  const mockBlock = createMockFetch(async () => new Response(makeMockResponse({ categoryScores: scoresBlock }), { status: 200 }))
  const portBlock = createOpenAiModerationPort(apiKey, { fetch: mockBlock })
  const resultBlock = await portBlock.screen('Test violence score')
  assert.equal(resultBlock.verdict, 'block')

  const scoresAllow = makeCleanScores()
  scoresAllow.violence = 0.499
  const mockAllow = createMockFetch(async () => new Response(makeMockResponse({ categoryScores: scoresAllow }), { status: 200 }))
  const portAllow = createOpenAiModerationPort(apiKey, { fetch: mockAllow })
  const resultAllow = await portAllow.screen('Test violence score')
  assert.equal(resultAllow.verdict, 'allow')
})

test('conservative policy: provider boolean flags block for other categories', async () => {
  const apiKey = 'test-api-key'
  const booleanCategories = [
    'hate',
    'hate/threatening',
    'sexual',
    'sexual/minors',
    'self-harm',
    'self-harm/intent',
    'self-harm/instructions',
    'harassment/threatening',
    'illicit/violent',
    'violence/graphic'
  ]

  for (const cat of booleanCategories) {
    const cats = makeCleanCategories()
    cats[cat] = true
    const mock = createMockFetch(async () => new Response(makeMockResponse({ flagged: true, categories: cats }), { status: 200 }))
    const port = createOpenAiModerationPort(apiKey, { fetch: mock })
    const result = await port.screen(`Testing flag ${cat}`)
    assert.equal(result.verdict, 'block', `Category ${cat} set to true must block`)
  }
})

test('no keyword or quoted text allow exceptions', async () => {
  const apiKey = 'test-api-key'
  const scoresBlock = makeCleanScores()
  scoresBlock.harassment = 0.25 // exceeds threshold

  const mock = createMockFetch(async () => new Response(makeMockResponse({ categoryScores: scoresBlock }), { status: 200 }))
  const port = createOpenAiModerationPort(apiKey, { fetch: mock })

  // Even educational counter-speech text must block if score triggers
  const educationalText = 'In class, we examine the false claim “people of a protected ethnicity are inferior” to explain why racist propaganda harms communities.'
  const result = await port.screen(educationalText)
  assert.equal(result.verdict, 'block')
})

test('calibrated score decisions take precedence over aggregate and overridden category flags', async () => {
  const categories = makeCleanCategories()
  const scores = makeCleanScores()
  for (const [category, score] of [['harassment', 0.149], ['illicit', 0.199], ['violence', 0.499]]) {
    categories[category] = true
    scores[category] = score
  }
  const mock = createMockFetch(async () => new Response(makeMockResponse({ flagged: true, categories, categoryScores: scores })))
  const result = await createOpenAiModerationPort('synthetic-key', { fetch: mock }).screen('Synthetic request')
  assert.equal(result.verdict, 'allow')
})


test('readLocalOpenAiSecret enforces file existence, owner-only mode and format', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadline-sec-test-'))

  try {
    const missingFile = path.join(tmpDir, 'missing.secret')
    assert.throws(() => readLocalOpenAiSecret({ secretPath: missingFile }))

    const testFile = path.join(tmpDir, '.secret.local')

    // Empty file
    fs.writeFileSync(testFile, '', { mode: 0o600 })
    assert.throws(() => readLocalOpenAiSecret({ secretPath: testFile }))

    // Multiple keys
    fs.writeFileSync(testFile, 'OPENAI_API_KEY=key1\nOPENAI_API_KEY=key2\n', { mode: 0o600 })
    assert.throws(() => readLocalOpenAiSecret({ secretPath: testFile }))

    // Blank key value
    fs.writeFileSync(testFile, 'OPENAI_API_KEY=\n', { mode: 0o600 })
    assert.throws(() => readLocalOpenAiSecret({ secretPath: testFile }))

    // Whitespace inside key
    fs.writeFileSync(testFile, 'OPENAI_API_KEY=key with space\n', { mode: 0o600 })
    assert.throws(() => readLocalOpenAiSecret({ secretPath: testFile }))

    // Valid key with Gemini key and comments
    fs.writeFileSync(testFile, '# Comment line\nGEMINI_API_KEY=gemini-key-val\nOPENAI_API_KEY="sk-valid-key-value"\n', { mode: 0o600 })
    const key = readLocalOpenAiSecret({ secretPath: testFile })
    assert.equal(key, 'sk-valid-key-value')

    // Unsafe file permissions on Unix
    if (process.platform !== 'win32') {
      fs.chmodSync(testFile, 0o644)
      assert.throws(() => readLocalOpenAiSecret({ secretPath: testFile }))
      fs.chmodSync(testFile, 0o600)
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
})

test('external qualification cannot run silently, partially, or with duplicate approval flags', () => {
  for (const args of [
    [],
    ['--baseline-only'],
    ['--ack-external-service', '--holdouts-only'],
    ['--ack-external-service', '--ack-external-service'],
    ['--ack-external-service', '--unknown'],
  ]) {
    assert.throws(() => parseQualifyArgs(args))
  }
})


test('demo qualification tolerates benign blocks but never harmful misses or unavailable verdicts', () => {
  const observations = ALL_FIXTURES.map(fixture => ({
    id: fixture.id, expected: fixture.expected, verdict: fixture.expected,
  }))
  observations.find(observation => observation.expected === 'allow').verdict = 'block'
  assert.equal(isModerationQualified(observations), true)
  const harmful = observations.find(observation => observation.expected === 'block')
  harmful.verdict = 'allow'
  assert.equal(isModerationQualified(observations), false)
  harmful.verdict = 'block'
  observations.find(observation => observation.expected === 'allow').verdict = 'unavailable'
  assert.equal(isModerationQualified(observations), false)
})

test('partial, duplicate, relabeled or unknown qualification results cannot pass', () => {
  const observations = ALL_FIXTURES.map(fixture => ({
    id: fixture.id, expected: fixture.expected, verdict: fixture.expected,
  }))
  assert.equal(isModerationQualified([]), false)
  assert.equal(isModerationQualified(observations.slice(1)), false)
  const invalidVariants = [
    { ...observations[0], id: observations[1].id },
    { ...observations[0], expected: 'allow' },
    { ...observations[0], verdict: 'unknown' },
  ]
  assert.equal(isModerationQualified(observations.map(observation => ({ ...observation, verdict: 'block' }))), false)
  for (const replacement of invalidVariants) {
    assert.equal(isModerationQualified([replacement, ...observations.slice(1)]), false)
  }
})
