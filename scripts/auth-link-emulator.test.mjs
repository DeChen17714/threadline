import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { initializeApp, deleteApp } from 'firebase/app'
import * as sdk from 'firebase/auth'

// Emulator IdP credentials and selected browser failures are fixtures. The
// duplicate-logout test also delays SDK completion; it does not fake server state.
// Authentication and linking use the real loopback SDK/server, not live OAuth.
globalThis.window = { setTimeout: (...args) => globalThis.setTimeout(...args), location: { origin: 'http://127.0.0.1:5174' } }
const intents = new Map()
globalThis.sessionStorage = { removeItem: (key) => intents.delete(key) }

async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await delay(20)
  }
  assert.fail('Authentication did not settle within the bounded wait')
}
async function fixture(t, popupError = null, delayedLogout = false) {
  const app = initializeApp({ apiKey: 'emulator-only', projectId: 'demo-threadline' }, randomUUID())
  const firebaseAuth = sdk.initializeAuth(app, { persistence: sdk.inMemoryPersistence })
  sdk.connectAuthEmulator(firebaseAuth, 'http://127.0.0.1:9099', { disableWarnings: true })
  const email = `${randomUUID()}@example.test`
  const password = randomUUID()
  const credential = sdk.GoogleAuthProvider.credential(JSON.stringify({ sub: randomUUID(), email, email_verified: false }))
  let logoutCount = 0
  t.mock.module('firebase/auth', {
    namedExports: {
      ...sdk,
      signInWithPopup: () => popupError
        ? Promise.reject(Object.assign(new Error('Emulator browser picker failure'), { code: popupError }))
        : sdk.signInWithCredential(firebaseAuth, credential),
      signOut: async (auth) => {
        if (delayedLogout) {
          const count = ++logoutCount
          await delay(count === 2 ? 20 : count === 3 ? 100 : 0)
        }
        await sdk.signOut(auth)
      },
    },
  })
  const { createFirebaseAuth } = await import(`../src/services/firebaseAuth.ts?test=${randomUUID()}`)
  const auth = createFirebaseAuth(firebaseAuth)
  const unsubscribe = auth.subscribe(() => {})
  t.after(async () => { await auth.signOut(); unsubscribe(); await deleteApp(app) })
  await until(() => auth.getSnapshot().status === 'signed-out')
  await auth.signUpEmail(email, password)
  const owner = firebaseAuth.currentUser
  await auth.signOut()
  if (!popupError) {
    await assert.rejects(auth.signInGoogle())
    assert.equal(auth.getSnapshot().status, 'link-required')
    assert.equal(auth.getSnapshot().user, null)
  }
  return { auth, firebaseAuth, owner, password, email }
}

test('Google collision requires the correct password and a separate explicit confirmation for the original UID', async (t) => {
  const { auth, firebaseAuth, owner, password } = await fixture(t)
  await assert.rejects(auth.authenticateGoogleLink(`${password}-wrong`))
  assert.equal(firebaseAuth.currentUser, null)
  assert.equal(auth.getSnapshot().user, null)
  await auth.authenticateGoogleLink(password)
  assert.equal(auth.getSnapshot().status, 'link-required')
  assert.equal(auth.getSnapshot().user.uid, owner.uid)
  assert.equal(firebaseAuth.currentUser.providerData.some((provider) => provider.providerId === 'google.com'), false)
  await auth.confirmGoogleLink()
  assert.equal(auth.getSnapshot().status, 'signed-in')
  assert.equal(firebaseAuth.currentUser.uid, owner.uid)
  assert.equal(firebaseAuth.currentUser.providerData.some((provider) => provider.providerId === 'google.com'), true)
})

test('cancelling after password verification clears pending linking and signs out without adding a provider', async (t) => {
  const { auth, firebaseAuth, owner, password } = await fixture(t)
  await auth.authenticateGoogleLink(password)
  await auth.cancelGoogleLink()
  assert.equal(firebaseAuth.currentUser, null)
  await assert.rejects(auth.confirmGoogleLink())
  await owner.reload()
  assert.equal(owner.providerData.some((provider) => provider.providerId === 'google.com'), false)
})

test('an external account replacement cannot attach the pending Google credential to either UID', async (t) => {
  const { auth, firebaseAuth, owner, password } = await fixture(t)
  await auth.authenticateGoogleLink(password)
  const other = await sdk.createUserWithEmailAndPassword(firebaseAuth, `${randomUUID()}@example.test`, randomUUID())
  await until(() => auth.getSnapshot().status === 'signed-in' && auth.getSnapshot().user.uid === other.user.uid)
  await assert.rejects(auth.confirmGoogleLink())
  assert.equal(firebaseAuth.currentUser.uid, other.user.uid)
  assert.equal(other.user.providerData.some((provider) => provider.providerId === 'google.com'), false)
  await owner.reload()
  assert.equal(owner.providerData.some((provider) => provider.providerId === 'google.com'), false)
})

test('an expired pending credential cannot link after the account has been authenticated', async (t) => {
  const { auth, firebaseAuth, owner, password } = await fixture(t)
  await auth.authenticateGoogleLink(password)
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  t.mock.timers.tick(5 * 60_000 + 1)
  await assert.rejects(auth.confirmGoogleLink())
  await until(() => firebaseAuth.currentUser === null)
  assert.equal(auth.getSnapshot().status, 'signed-out')
  await owner.reload()
  assert.equal(owner.providerData.some((provider) => provider.providerId === 'google.com'), false)
})

for (const code of ['auth/popup-blocked', 'auth/popup-closed-by-user']) {
  test(`${code} releases the operation gate and leaves real email authentication usable`, async (t) => {
    const { auth, firebaseAuth, owner, email, password } = await fixture(t, code)
    await assert.rejects(auth.signInGoogle())
    assert.equal(auth.getSnapshot().status, 'signed-out')
    assert.equal(firebaseAuth.currentUser, null)
    await auth.signInEmail(email, password)
    assert.equal(auth.getSnapshot().user.uid, owner.uid)
    assert.equal(firebaseAuth.currentUser.uid, owner.uid)
  })
}

test('duplicate logout consumers cannot clear a newer successful sign-in', async (t) => {
  const { auth, firebaseAuth, owner, email, password } = await fixture(t, 'auth/popup-blocked', true)
  await auth.signInEmail(email, password)
  const first = auth.signOut()
  const second = auth.signOut()
  await first
  await auth.signInEmail(email, password)
  await second
  assert.equal(auth.getSnapshot().status, 'signed-in')
  assert.equal(firebaseAuth.currentUser.uid, owner.uid)
})

test('background link expiry ends the incomplete session without a confirmation click', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() })
  const { auth, firebaseAuth, owner, password } = await fixture(t)
  await auth.authenticateGoogleLink(password)
  t.mock.timers.tick(5 * 60_000 + 1)
  await until(() => firebaseAuth.currentUser === null)
  assert.equal(auth.getSnapshot().status, 'signed-out')
  await owner.reload()
  assert.equal(owner.providerData.some((provider) => provider.providerId === 'google.com'), false)
})
