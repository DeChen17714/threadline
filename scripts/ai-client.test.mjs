import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import { randomUUID } from 'node:crypto'
import { initializeApp, deleteApp } from 'firebase/app'
import { getFirestore } from 'firebase/firestore'
import * as functionsSdk from 'firebase/functions'
import { CommandUncertainError } from '../src/services/workspace.ts'

let calls = []
mock.module('firebase/functions', { namedExports: {
  ...functionsSdk,
  httpsCallable: () => async () => {
    const action = calls.shift()
    if (!action) throw new Error('Unexpected controlled RPC')
    return action()
  },
} })
const { createFirebaseWorkspace } = await import('../src/services/firebaseWorkspace.ts')

test('reconnecting to an uncertain retry has the same bounded local wait as first submission', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } })
  const app = initializeApp({ projectId: 'demo-threadline', apiKey: 'emulator-only', appId: 'controlled-retry-deadline' }, 'retry-deadline')
  const member = { uid: 'controlled-reader', label: 'Reader' }
  const port = createFirebaseWorkspace(getFirestore(app), functionsSdk.getFunctions(app, 'asia-southeast1'), { currentUser: member }, member)
  const input = { requestId: randomUUID(), roomId: randomUUID(), promptMessageId: randomUUID(), generationId: randomUUID() }
  try {
    calls = [() => { throw Object.assign(new Error('Controlled connection loss'), { code: 'functions/unavailable' }) }]
    await assert.rejects(port.retryReply(input))
    // The subsequent receipt read never answers: no redispatch or new intent is available.
    calls = [() => Promise.withResolvers().promise]
    let settled
    void port.retryReply(input).then(() => { settled = 'confirmed' }, error => { settled = error })
    await Promise.resolve()
    context.mock.timers.tick(15_000)
    const drain = Promise.withResolvers()
    setImmediate(drain.resolve)
    await drain.promise
    assert.equal(settled instanceof CommandUncertainError, true)
  } finally {
    context.mock.timers.reset()
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator)
    else Reflect.deleteProperty(globalThis, 'navigator')
    port.dispose()
    await deleteApp(app)
  }
})
