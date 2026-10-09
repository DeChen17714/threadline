import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isIsolatedEmulator, validateEnvironmentAndOrigin } from '../functions/dist/utils/auth.js'

const keys = ['FUNCTIONS_EMULATOR', 'GCLOUD_PROJECT', 'FIREBASE_EMULATOR_HUB', 'FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST', 'ALLOWED_ORIGINS']
test('local flags cannot relax production origin or App Check authorization', () => {
  const saved = new Map(keys.map((key) => [key, process.env[key]]))
  try {
    for (const key of keys) delete process.env[key]
    process.env.FUNCTIONS_EMULATOR = 'true'
    process.env.GCLOUD_PROJECT = 'demo-threadline'
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
    process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099'
    process.env.FIREBASE_EMULATOR_HUB = '127.0.0.1:4400'
    assert.equal(isIsolatedEmulator(), true)
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1.attacker.example:8080'
    assert.equal(isIsolatedEmulator(), false)
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080'
    process.env.GCLOUD_PROJECT = 'real-project'
    assert.equal(isIsolatedEmulator(), false)
    process.env.GCLOUD_PROJECT = 'demo-threadline'
    delete process.env.FIREBASE_EMULATOR_HUB
    assert.equal(isIsolatedEmulator(), false)
    const req = (origin, app) => ({ rawRequest: { headers: { origin } }, app })
    assert.throws(() => validateEnvironmentAndOrigin(req('https://approved.example'), null), (e) => e.code === 'permission-denied')
    process.env.ALLOWED_ORIGINS = 'https://approved.example'
    assert.throws(() => validateEnvironmentAndOrigin(req('https://approved.example'), null), (e) => e.code === 'unauthenticated')
    assert.throws(() => validateEnvironmentAndOrigin(req('https://other.example', {}), null), (e) => e.code === 'permission-denied')
    validateEnvironmentAndOrigin(req('https://approved.example', { appId: 'verified-by-callable' }), null)
  } finally { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value } }
})
