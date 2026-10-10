#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')

// Sensible Java heap and CPU limits for human development (default 2 CPUs, 2GiB heap),
// preserving any explicit user options set in JAVA_TOOL_OPTIONS.
function getBoundedJavaOptions(userOptions = process.env.JAVA_TOOL_OPTIONS) {
  if (!userOptions || !userOptions.trim()) {
    return '-XX:ActiveProcessorCount=2 -Xmx2048m'
  }
  const current = userOptions.trim()
  const additions = []
  if (!current.includes('ActiveProcessorCount')) {
    additions.push('-XX:ActiveProcessorCount=2')
  }
  if (!current.includes('-Xmx')) {
    additions.push('-Xmx2048m')
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

const javaOptions = getBoundedJavaOptions(process.env.JAVA_TOOL_OPTIONS)
const firebaseCli = resolveFirebaseCli(rootDir)
const userArgs = process.argv.slice(2)
const cliArgs = [
  ...firebaseCli.args,
  'emulators:start',
  '--only', 'auth,firestore,functions',
  '--project', 'demo-threadline',
  ...userArgs,
]

const child = spawn(firebaseCli.executable, cliArgs, {
  cwd: rootDir,
  env: {
    ...process.env,
    JAVA_TOOL_OPTIONS: javaOptions,
  },
  stdio: 'inherit',
})

child.on('error', (err) => {
  console.error('[start-emulators] Failed to start Firebase emulators:', err.message)
  process.exit(1)
})

const forwardSignal = (signal) => {
  if (child && !child.killed) {
    try { child.kill(signal) } catch { /* The process may have already exited. */ }
  }
}
process.on('SIGINT', () => forwardSignal('SIGINT'))
process.on('SIGTERM', () => forwardSignal('SIGTERM'))

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
  } else {
    process.exit(code ?? 0)
  }
})
