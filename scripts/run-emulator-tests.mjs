#!/usr/bin/env node
import { spawn, spawnSync, execSync, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')

// Human dev default ports that disposable test runs must reject
const HUMAN_DEFAULT_PORTS = new Set([8080, 9099, 5001, 4400, 4000, 4500, 9150])

function parseAndValidatePort(envVal, defaultPort, name) {
  const raw = envVal !== undefined ? envVal : defaultPort
  const num = Number(raw)
  if (!Number.isInteger(num) || num < 1024 || num > 65535) {
    throw new Error(`Port configuration for ${name} (${raw}) is invalid. Must be an integer between 1024 and 65535.`)
  }
  if (HUMAN_DEFAULT_PORTS.has(num)) {
    throw new Error(`Port for ${name} (${num}) conflicts with human development default emulator ports. Disposable test runner must use dedicated test ports.`)
  }
  return num
}

function validateUniquePorts(ports) {
  const seen = new Map()
  for (const [name, port] of Object.entries(ports)) {
    if (seen.has(port)) {
      throw new Error(`Duplicate port assignment: ${name} and ${seen.get(port)} both use port ${port}. All test ports must be distinct.`)
    }
    seen.set(port, name)
  }
}

// Dedicated loopback ports for disposable test instances
const PORTS = {
  auth: parseAndValidatePort(process.env.TEST_AUTH_PORT, 9199, 'auth'),
  firestore: parseAndValidatePort(process.env.TEST_FIRESTORE_PORT, 8180, 'firestore'),
  functions: parseAndValidatePort(process.env.TEST_FUNCTIONS_PORT, 5101, 'functions'),
  hub: parseAndValidatePort(process.env.TEST_HUB_PORT, 4501, 'hub'),
  logging: parseAndValidatePort(process.env.TEST_LOGGING_PORT, 4601, 'logging'),
  websocket: parseAndValidatePort(process.env.TEST_WEBSOCKET_PORT, 9250, 'websocket'),
}
validateUniquePorts(PORTS)

const DEFAULT_EMULATOR_TESTS = [
  'scripts/auth-emulator.test.mjs',
  'scripts/auth-link-emulator.test.mjs',
  'scripts/rooms-emulator.test.mjs',
  'scripts/server-policy.test.mjs',
  'scripts/invitations-emulator.test.mjs',
  'scripts/invite-intent.test.mjs',
  'scripts/deletion-emulator.test.mjs',
  'scripts/messages-emulator.test.mjs',
  'scripts/history-emulator.test.mjs',
  'scripts/message-mutations-emulator.test.mjs',
  'scripts/setup-local-ai.test.mjs',
  'scripts/ai-emulator.test.mjs',
]

// Parse command line arguments
const userArgs = process.argv.slice(2)
const nodeFlags = []
const testFiles = []

for (const arg of userArgs) {
  if (arg === '--test') {
    continue
  } else if (arg.startsWith('-')) {
    nodeFlags.push(arg)
  } else {
    testFiles.push(arg)
  }
}

const targetSuites = testFiles.length > 0 ? testFiles : DEFAULT_EMULATOR_TESTS

// Port busy check
async function checkPortFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, host)
  })
}

async function checkAllPortsFree(ports) {
  const busy = []
  for (const [name, port] of Object.entries(ports)) {
    const free = await checkPortFree(port, '127.0.0.1')
    if (!free) busy.push({ name, port })
  }
  return busy
}

function getBoundedJavaOptions(userOptions = process.env.JAVA_TOOL_OPTIONS, { cpus = 2, heap = '2048m' } = {}) {
  if (!userOptions || !userOptions.trim()) {
    return `-XX:ActiveProcessorCount=${cpus} -Xmx${heap}`
  }
  const current = userOptions.trim()
  const additions = []
  if (!current.includes('ActiveProcessorCount')) {
    additions.push(`-XX:ActiveProcessorCount=${cpus}`)
  }
  if (!current.includes('-Xmx')) {
    additions.push(`-Xmx${heap}`)
  }
  return additions.length > 0 ? `${current} ${additions.join(' ')}` : current
}

function resolveFirebaseCli(rootDir) {
  if (process.env.FIREBASE_BIN) {
    return { executable: process.env.FIREBASE_BIN, args: [] }
  }
  try {
    const probe = spawnSync('firebase', ['--version'], { stdio: 'ignore', timeout: 10000 })
    if (probe.status === 0) return { executable: 'firebase', args: [] }
  } catch { /* Try the project-local CLI next. */ }
  const localBin = path.join(rootDir, 'node_modules', '.bin', 'firebase')
  if (fs.existsSync(localBin)) {
    try {
      const probe = spawnSync(localBin, ['--version'], { stdio: 'ignore', timeout: 10000 })
      if (probe.status === 0) return { executable: localBin, args: [] }
    } catch { /* The eventual spawn reports the missing CLI. */ }
  }
  return { executable: 'firebase', args: [] }
}

const FAILURE_LOG_PATH = path.join(rootDir, '.firebase', 'emulator-test-failure.log')

function sanitizeLog(text) {
  if (!text || typeof text !== 'string') return ''
  return text
    // Redact tokens, keys, secrets, passwords
    .replace(/(?:api[_-]?key|password|secret|auth|bearer|idToken|refreshToken)[\s:=]+([A-Za-z0-9_.-]{8,})/gi, (match, val) =>
      match.replace(val, '[REDACTED]')
    )
    // Redact email addresses
    .replace(/[a-zA-Z0-9_.-]+@[a-zA-Z0-9_.-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]')
    // Redact Bearer headers
    .replace(/Authorization:\s*Bearer\s+[A-Za-z0-9_.-]+/gi, 'Authorization: Bearer [REDACTED]')
}

function recordFailureLog({ suite, exitCode, signal, error, output, emulatorOutput }) {
  try {
    const firebaseDir = path.join(rootDir, '.firebase')
    if (!fs.existsSync(firebaseDir)) {
      fs.mkdirSync(firebaseDir, { recursive: true })
    }
    const timestamp = new Date().toISOString()
    const sections = [
      `=== Threadline Disposable Emulator Test Failure Log ===`,
      `Timestamp: ${timestamp}`,
      `Suite: ${suite ?? 'n/a'}`,
      `Exit Code: ${exitCode ?? 'n/a'}${signal ? ` (Signal: ${signal})` : ''}`,
      error ? `Error: ${sanitizeLog(error)}` : '',
      '',
      '--- Test Output ---',
      output ? sanitizeLog(output).trim() : '(no test output captured)',
    ]
    if (emulatorOutput) {
      sections.push('', '--- Emulator Output ---', sanitizeLog(emulatorOutput).trim())
    }
    fs.writeFileSync(FAILURE_LOG_PATH, sections.filter((s) => s !== '').join('\n') + '\n', {
      encoding: 'utf8',
      mode: 0o600,
    })
    console.error(`[run-emulator-tests] Failure details preserved to ${path.relative(rootDir, FAILURE_LOG_PATH)}`)
  } catch (err) {
    console.error(`[run-emulator-tests] Failed to write failure log:`, err.message)
  }
}

let tempDir = null
let emulatorChild = null
let activeTestChild = null
let cleanupPromise = null

async function terminateProcessGroup(child, name = 'process', gracefulMs = 4000) {
  const pid = child?.pid
  if (!pid) return
  const groupExists = () => {
    try {
      process.kill(-pid, 0)
      return true
    } catch (error) {
      if (error.code === 'ESRCH') return false
      throw error
    }
  }
  if (!groupExists()) return
  try {
    process.kill(-pid, name === 'emulator' ? 'SIGINT' : 'SIGTERM')
  } catch (error) {
    if (error.code !== 'ESRCH') throw error
    return
  }

  if (child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, gracefulMs)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  // An exited CLI is not proof its detached Java/runtime children have exited.
  if (groupExists()) {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
}

function stopDetachedFirestore() {
  if (!tempDir) return
  // Firebase launches Java in its own group, outside the CLI's detached group.
  // Match this run's private rules path, never a port alone or another server.
  const rulesArg = `--rules ${path.join(tempDir, 'firestore.rules')}`
  const processes = execFileSync('ps', ['-eo', 'pid=,pgid=,args='], {
    encoding: 'utf8', timeout: 2000,
  })
  for (const row of processes.split('\n')) {
    const match = row.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (!match || match[1] !== match[2]) continue
    const args = match[3]
    if (!args.includes('cloud-firestore-emulator-') || !args.includes(rulesArg)
      || !args.includes(`--port ${PORTS.firestore} `)) continue
    try {
      process.kill(-Number(match[2]), 'SIGKILL')
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
}

async function cleanupAll() {
  if (cleanupPromise) return cleanupPromise
  cleanupPromise = (async () => {
    if (activeTestChild) {
      await terminateProcessGroup(activeTestChild, 'test', 2000)
      activeTestChild = null
    }
    if (emulatorChild) {
      await terminateProcessGroup(emulatorChild, 'emulator', 4000)
      emulatorChild = null
    }
    stopDetachedFirestore()
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true })
      } catch (error) {
        console.error('[run-emulator-tests] Temporary staging cleanup failed:', error.message)
      }
    }
  })()
  return cleanupPromise
}

process.on('SIGINT', async () => {
  console.error('\n[run-emulator-tests] Received SIGINT. Shutting down disposable emulators cleanly...')
  await cleanupAll()
  process.exit(130)
})

process.on('SIGTERM', async () => {
  console.error('\n[run-emulator-tests] Received SIGTERM. Shutting down disposable emulators cleanly...')
  await cleanupAll()
  process.exit(143)
})

async function waitForEmulators(hubPort, functionsPort, timeoutMs = 35000) {
  const startTime = Date.now()
  const hubUrl = `http://127.0.0.1:${hubPort}/emulators`
  const backendsUrl = `http://127.0.0.1:${functionsPort}/backends`

  while (Date.now() - startTime < timeoutMs) {
    if (emulatorChild && emulatorChild.exitCode !== null) {
      throw new Error(`Emulator process exited prematurely with code ${emulatorChild.exitCode}`)
    }
    try {
      // 1. Check hub registration
      const hubRes = await fetch(hubUrl, { signal: AbortSignal.timeout(1000) })
      if (hubRes.ok) {
        const hubJson = await hubRes.json()
        if (hubJson.auth && hubJson.firestore && hubJson.functions) {
          // 2. Bound probe: verify callable triggers are actually loaded in functions backend
          const backendsRes = await fetch(backendsUrl, { signal: AbortSignal.timeout(1000) })
          if (backendsRes.ok) {
            const backendsJson = await backendsRes.json()
            const triggers = (backendsJson.backends ?? []).flatMap((b) => b.functionTriggers ?? [])
            const commandReady = triggers.some(
              (t) => t.entryPoint === 'command' && t.region === 'asia-southeast1'
            )
            if (commandReady) {
              return true
            }
          }
        }
      }
    } catch {
      // Continue polling until timeout
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for emulators and callable command trigger`)
}

async function runSingleTest(testFile, flags, env, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const fullTestPath = path.resolve(rootDir, testFile)
    if (!fs.existsSync(fullTestPath)) {
      const msg = `Test file not found: ${testFile}`
      console.error(`[run-emulator-tests] ${msg}`)
      return resolve({ code: 1, signal: null, output: msg, error: msg })
    }

    // Apply strip-types and test-module-mocks flags by default across all named suites
    const effectiveFlags = [...flags]
    if (!effectiveFlags.includes('--experimental-strip-types')) {
      effectiveFlags.unshift('--experimental-strip-types')
    }
    if (!effectiveFlags.includes('--experimental-test-module-mocks')) {
      effectiveFlags.unshift('--experimental-test-module-mocks')
    }

    const testArgs = [...effectiveFlags, '--test', fullTestPath]
    let child
    try {
      child = spawn(process.execPath, testArgs, {
        cwd: rootDir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      })
    } catch (err) {
      console.error(`[run-emulator-tests] Failed to spawn test process for ${testFile}:`, err.message)
      return resolve({ code: 1, signal: null, output: '', error: err.message })
    }

    activeTestChild = child
    let settled = false
    const outputChunks = []

    const handleChunk = (target, chunk) => {
      target.write(chunk)
      outputChunks.push(chunk)
      if (outputChunks.length > 2000) outputChunks.shift()
    }

    child.stdout.on('data', (chunk) => handleChunk(process.stdout, chunk))
    child.stderr.on('data', (chunk) => handleChunk(process.stderr, chunk))

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      activeTestChild = null
      console.error(`[run-emulator-tests] Error in test process for ${testFile}:`, err.message)
      resolve({
        code: 1,
        signal: null,
        output: Buffer.concat(outputChunks).toString('utf8'),
        error: err.message,
      })
    })

    const timer = setTimeout(async () => {
      if (settled) return
      settled = true
      const errMsg = `Test ${testFile} timed out after ${timeoutMs}ms.`
      console.error(`[run-emulator-tests] ${errMsg} Terminating process group...`)
      await terminateProcessGroup(child, 'test', 2000)
      activeTestChild = null
      resolve({
        code: 124,
        signal: 'SIGTIMEOUT',
        output: Buffer.concat(outputChunks).toString('utf8'),
        error: errMsg,
      })
    }, timeoutMs)

    child.on('exit', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      activeTestChild = null
      const exitCode = signal ? 1 : (code ?? 0)
      resolve({
        code: exitCode,
        signal,
        output: Buffer.concat(outputChunks).toString('utf8'),
        error: exitCode !== 0 ? `Process exited with code ${code ?? 'null'}, signal ${signal ?? 'none'}` : null,
      })
    })
  })
}

async function main() {
  // 1. Fail closed if any dedicated loopback ports are busy
  const busyPorts = await checkAllPortsFree(PORTS)
  if (busyPorts.length > 0) {
    const details = busyPorts.map((b) => `${b.name} (port ${b.port})`).join(', ')
    console.error(`[run-emulator-tests] Refusing to start: ports already in use: ${details}.`)
    console.error(`[run-emulator-tests] Disposable test runner fails closed without touching existing human servers.`)
    recordFailureLog({
      suite: 'port-check',
      exitCode: 1,
      error: `Ports already in use: ${details}`,
    })
    process.exit(1)
  }

  // 2. Build once as existing scripts require (bounded wait)
  console.log('[run-emulator-tests] Building functions before isolated test run...')
  try {
    const output = execSync('npm run build:functions', {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
    })
    process.stdout.write(output)
  } catch (err) {
    console.error('[run-emulator-tests] Build failed. Aborting test execution.')
    recordFailureLog({
      suite: 'build:functions',
      exitCode: err.status ?? 1,
      error: `${err.code ?? ''} ${err.message}`,
      output: [err.stdout, err.stderr].filter(Boolean).join('\n'),
    })
    process.exit(err.status ?? 1)
  }

  // 3. Create isolated disposable staging directory
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'threadline-test-emulator-'))
  const stagedFunctionsDir = path.join(tempDir, 'functions')
  fs.mkdirSync(stagedFunctionsDir, { recursive: true })

  // Copy dist into temp (do NOT symlink to avoid resolution into secrets)
  fs.cpSync(path.join(rootDir, 'functions', 'dist'), path.join(stagedFunctionsDir, 'dist'), { recursive: true })

  // Symlink non-secret dependencies
  fs.symlinkSync(path.join(rootDir, 'functions', 'package.json'), path.join(stagedFunctionsDir, 'package.json'))
  if (fs.existsSync(path.join(rootDir, 'functions', 'staged-shared'))) {
    fs.symlinkSync(path.join(rootDir, 'functions', 'staged-shared'), path.join(stagedFunctionsDir, 'staged-shared'))
  }
  if (fs.existsSync(path.join(rootDir, 'functions', 'node_modules'))) {
    fs.symlinkSync(path.join(rootDir, 'functions', 'node_modules'), path.join(stagedFunctionsDir, 'node_modules'))
  }
  if (fs.existsSync(path.join(rootDir, 'node_modules'))) {
    fs.symlinkSync(path.join(rootDir, 'node_modules'), path.join(tempDir, 'node_modules'))
  }

  // Deliberately empty local secrets and env so accidental calls fail closed
  fs.writeFileSync(
    path.join(stagedFunctionsDir, '.secret.local'),
    'GEMINI_API_KEY=\nOPENAI_API_KEY=\n',
    { mode: 0o600 }
  )
  fs.writeFileSync(
    path.join(stagedFunctionsDir, '.env'),
    'ALLOWED_ORIGINS=\nAI_TESTER_UIDS=\n',
    { mode: 0o600 }
  )

  // Temporary firebase.json pointing to staged functions, running inside tempDir
  fs.copyFileSync(path.join(rootDir, 'firestore.rules'), path.join(tempDir, 'firestore.rules'))
  const tempFirebaseConfig = {
    firestore: {
      rules: path.join(tempDir, 'firestore.rules'),
      indexes: path.join(rootDir, 'firestore.indexes.json'),
    },
    functions: [{
      source: 'functions',
      codebase: 'threadline',
      runtime: 'nodejs22',
    }],
    emulators: {
      hub: { host: '127.0.0.1', port: PORTS.hub },
      logging: { host: '127.0.0.1', port: PORTS.logging },
      auth: { host: '127.0.0.1', port: PORTS.auth },
      firestore: { host: '127.0.0.1', port: PORTS.firestore, websocketPort: PORTS.websocket },
      functions: { host: '127.0.0.1', port: PORTS.functions },
      ui: { enabled: false },
      singleProjectMode: true,
    },
  }
  const tempConfigPath = path.join(tempDir, 'firebase.json')
  fs.writeFileSync(tempConfigPath, JSON.stringify(tempFirebaseConfig, null, 2))

  // 4. Start owned disposable emulator instance with bounded Java CPU/heap
  const javaOptions = getBoundedJavaOptions(process.env.JAVA_TOOL_OPTIONS, { cpus: 2, heap: '2048m' })
  const emulatorEnv = {
    ...process.env,
    JAVA_TOOL_OPTIONS: javaOptions,
    FUNCTIONS_EMULATOR: 'true',
    GCLOUD_PROJECT: 'demo-threadline',
    FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${PORTS.auth}`,
    FIRESTORE_EMULATOR_HOST: `127.0.0.1:${PORTS.firestore}`,
    FIREBASE_EMULATOR_HUB: `127.0.0.1:${PORTS.hub}`,
    FIREBASE_FUNCTIONS_EMULATOR_HOST: `127.0.0.1:${PORTS.functions}`,
    GEMINI_API_KEY: '',
    OPENAI_API_KEY: '',
    ALLOWED_ORIGINS: '',
    AI_TESTER_UIDS: '',
  }

  const firebaseCli = resolveFirebaseCli(rootDir)
  const emulatorCliArgs = [
    ...firebaseCli.args,
    '--config', tempConfigPath,
    '--project', 'demo-threadline',
    'emulators:start',
    '--only', 'auth,firestore,functions',
  ]

  console.log(`[run-emulator-tests] Launching disposable emulators (Auth:${PORTS.auth}, Firestore:${PORTS.firestore}, Functions:${PORTS.functions})...`)
  const emulatorLogs = []

  try {
    emulatorChild = spawn(firebaseCli.executable, emulatorCliArgs, {
      cwd: tempDir,
      env: emulatorEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
  } catch (err) {
    console.error('[run-emulator-tests] Failed to spawn Firebase emulator process:', err.message)
    recordFailureLog({
      suite: 'spawn-emulator',
      exitCode: 1,
      error: err.message,
    })
    await cleanupAll()
    process.exit(1)
  }

  emulatorChild.on('error', async (err) => {
    console.error('[run-emulator-tests] Emulator process error:', err.message)
    await cleanupAll()
    process.exit(1)
  })
  emulatorChild.on('exit', async (code, signal) => {
    if (cleanupPromise) return
    console.error('[run-emulator-tests] Disposable emulator exited unexpectedly:', signal ?? code)
    recordFailureLog({
      suite: 'emulator-lifecycle',
      exitCode: code ?? 1,
      signal,
      error: `Disposable emulator exited unexpectedly: signal=${signal}, code=${code}`,
      emulatorOutput: emulatorLogs.join(''),
    })
    await cleanupAll()
    process.exit(1)
  })

  emulatorChild.stdout.on('data', (chunk) => {
    emulatorLogs.push(chunk.toString())
    if (emulatorLogs.length > 100) emulatorLogs.shift()
  })
  emulatorChild.stderr.on('data', (chunk) => {
    emulatorLogs.push(chunk.toString())
    if (emulatorLogs.length > 100) emulatorLogs.shift()
  })

  try {
    await waitForEmulators(PORTS.hub, PORTS.functions, 35000)
    console.log('[run-emulator-tests] Disposable emulators and callable command trigger ready.')
  } catch (err) {
    console.error(`[run-emulator-tests] Failed to start emulators: ${err.message}`)
    if (emulatorLogs.length > 0) {
      console.error('[run-emulator-tests] Emulator output:')
      console.error(emulatorLogs.join(''))
    }
    recordFailureLog({
      suite: 'waitForEmulators',
      exitCode: 1,
      error: err.message,
      emulatorOutput: emulatorLogs.join(''),
    })
    await cleanupAll()
    process.exit(1)
  }

  // 5. Run tests sequentially
  const testEnv = {
    ...process.env,
    FUNCTIONS_EMULATOR: 'true',
    GCLOUD_PROJECT: 'demo-threadline',
    FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${PORTS.auth}`,
    FIRESTORE_EMULATOR_HOST: `127.0.0.1:${PORTS.firestore}`,
    FIREBASE_EMULATOR_HUB: `127.0.0.1:${PORTS.hub}`,
    FIREBASE_FUNCTIONS_EMULATOR_HOST: `127.0.0.1:${PORTS.functions}`,
    GEMINI_API_KEY: '',
    OPENAI_API_KEY: '',
  }

  let firstFailureCode = 0
  for (const suite of targetSuites) {
    if (cleanupPromise) return
    console.log(`\n[run-emulator-tests] Running suite: ${suite}`)
    const result = await runSingleTest(suite, nodeFlags, testEnv)
    if (result.code !== 0) {
      console.error(`[run-emulator-tests] Suite ${suite} failed with exit code ${result.code}`)
      recordFailureLog({
        suite,
        exitCode: result.code,
        signal: result.signal,
        error: result.error,
        output: result.output,
        emulatorOutput: emulatorLogs.slice(-50).join(''),
      })
      if (firstFailureCode === 0) firstFailureCode = result.code
    }
  }

  // 6. Clean shutdown
  await cleanupAll()
  process.exit(firstFailureCode)
}

main().catch(async (err) => {
  console.error('[run-emulator-tests] Unexpected runner error:', err)
  recordFailureLog({
    suite: 'main-unhandled',
    exitCode: 1,
    error: err?.stack || err?.message || String(err),
  })
  await cleanupAll()
  process.exit(1)
})
