import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { initializeApp, deleteApp } from 'firebase/app'
import { initializeAuth, inMemoryPersistence } from 'firebase/auth'
import { createFirebaseAuth } from '../src/services/firebaseAuth.ts'
import { PROJECT_ID, authOrigin, connectTestAuthEmulator } from './emulator-test-env.mjs'

// This suite requires the isolated demo-threadline Auth emulator on loopback.
globalThis.window = { setTimeout, location: { origin: 'http://127.0.0.1:5174' } }
const session = new Map()
globalThis.sessionStorage = { removeItem: (key) => session.delete(key) }

async function fixture(t) {
  const id = randomUUID()
  const app = initializeApp({ apiKey: 'emulator-only', projectId: 'demo-threadline' }, id)
  const sdk = initializeAuth(app, { persistence: inMemoryPersistence })
  connectTestAuthEmulator(sdk)
  const auth = createFirebaseAuth(sdk)
  const states = []
  const unsub = auth.subscribe(() => states.push(auth.getSnapshot()))
  t.after(async () => { unsub(); await deleteApp(app) })
  await until(() => auth.getSnapshot().status === 'signed-out')
  return { sdk, auth, states, email: `${id}@example.test`, password: randomUUID() }
}
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await delay(20)
  }
  assert.fail('Authentication did not settle within the bounded wait')
}

test('logout fences an in-flight signup and clears invite intent before its response', async (t) => {
  const { auth, sdk, states, email, password } = await fixture(t)
  session.set('threadline.invite', 'local-test-intent')
  const signingIn = auth.signUpEmail(email, password)
  const start = states.length
  const signingOut = auth.signOut()
  assert.equal(auth.getSnapshot().status, 'signed-out')
  assert.equal(session.has('threadline.invite'), false)
  await Promise.all([signingIn, signingOut])
  await delay(40)
  assert.equal(sdk.currentUser, null)
  assert.equal(auth.getSnapshot().status, 'signed-out')
  assert.equal(states.slice(start).some((state) => state.status === 'signed-in'), false)
})

test('account replacement discards old invite intent and rejected credentials never select a user', async (t) => {
  const { auth, email, password } = await fixture(t)
  await auth.signUpEmail(email, password)
  const firstUid = auth.getSnapshot().user.uid
  session.set('threadline.invite', 'first-account-intent')
  await auth.signUpEmail(`${randomUUID()}@example.test`, password)
  assert.notEqual(auth.getSnapshot().user.uid, firstUid)
  assert.equal(session.has('threadline.invite'), false)
  await auth.signOut()
  await assert.rejects(auth.signInEmail(email, `${password}-wrong`))
  assert.equal(auth.getSnapshot().status, 'signed-out')
})

test('unknown-account recovery is neutral; verified reset invalidates the actual old password and code replay', async (t) => {
  const { auth, email, password } = await fixture(t)
  await auth.signUpEmail(email, password)
  await auth.signOut()
  await auth.sendPasswordReset(`${randomUUID()}@example.test`)
  assert.equal(auth.getSnapshot().status, 'signed-out')
  await auth.sendPasswordReset(email)
  const response = await fetch(`${authOrigin}/emulator/v1/projects/${PROJECT_ID}/oobCodes`)
  assert.equal(response.ok, true)
  const { oobCodes } = await response.json()
  const action = oobCodes.find((entry) => entry.email === email && entry.requestType === 'PASSWORD_RESET')
  assert.ok(action, 'Emulator should issue a password-reset action')
  assert.equal(await auth.verifyPasswordResetCode(action.oobCode), email)
  const replacement = randomUUID()
  await auth.confirmPasswordReset(action.oobCode, replacement)
  await assert.rejects(auth.signInEmail(email, password))
  await auth.signInEmail(email, replacement)
  assert.equal(auth.getSnapshot().user.email, email)
  await assert.rejects(auth.confirmPasswordReset(action.oobCode, randomUUID()))
  await assert.rejects(auth.verifyPasswordResetCode(action.oobCode))
  await assert.rejects(auth.verifyPasswordResetCode('malformed-local-action'))
})

test('remounting a subscription restores the SDK session without duplicating identities', async (t) => {
  const { auth, sdk, email, password } = await fixture(t)
  await auth.signUpEmail(email, password)
  const restored = createFirebaseAuth(sdk)
  const first = restored.subscribe(() => {})
  first()
  const second = restored.subscribe(() => {})
  t.after(second)
  await until(() => restored.getSnapshot().status === 'signed-in')
  assert.equal(restored.getSnapshot().user.uid, auth.getSnapshot().user.uid)
})
