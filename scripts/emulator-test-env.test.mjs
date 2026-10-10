import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

const safeHosts = {
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9199',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8180',
  FIREBASE_EMULATOR_HUB: '127.0.0.1:4501',
  FIREBASE_FUNCTIONS_EMULATOR_HOST: '127.0.0.1:5101',
}

function resolveHosts(overrides = {}) {
  return spawnSync(process.execPath, ['--input-type=module', '-e',
    "import { firestoreHost } from './scripts/emulator-test-env.mjs'; process.stdout.write(firestoreHost)"], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, ...safeHosts, ...overrides },
    encoding: 'utf8',
    timeout: 5000,
  })
}

test('test clients refuse human emulator ports and foreign or malformed endpoints before any database work', () => {
  for (const key of Object.keys(safeHosts)) {
    for (const host of ['127.0.0.1:8080', 'localhost:9099', '127.0.0.1:5001', '127.0.0.1:4400', 'example.test:8180', '127.0.0.1:8180?query=x', '127.0.0.1:8180#fragment', 'user@127.0.0.1:8180', '127.0.0.1:8180/path']) {
      const result = resolveHosts({ [key]: host })
      assert.equal(result.status, 1, `${key} must refuse ${host}`)
      assert.match(result.stderr, /Refusing unsafe/)
      assert.equal(result.stdout, '')
    }
  }
  const valid = resolveHosts({ FIRESTORE_EMULATOR_HOST: 'localhost:8180' })
  assert.equal(valid.status, 0)
  assert.equal(valid.stdout, 'localhost:8180')
})
