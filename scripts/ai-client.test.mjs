import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import { randomUUID } from 'node:crypto'
import { initializeApp, deleteApp } from 'firebase/app'
import { getFirestore } from 'firebase/firestore'
import * as functionsSdk from 'firebase/functions'
import { CommandRejectedError, CommandUncertainError } from '../src/services/workspace.ts'

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

test('screening rejection and unavailability are known rejections, not uncertain timeout', async () => {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } })
  const app = initializeApp({ projectId: 'demo-threadline', apiKey: 'emulator-only', appId: 'screening-rejections' }, 'screening-test')
  const member = { uid: 'controlled-reader', label: 'Reader' }
  const port = createFirebaseWorkspace(getFirestore(app), functionsSdk.getFunctions(app, 'asia-southeast1'), { currentUser: member }, member)
  const sendInput = { requestId: randomUUID(), roomId: randomUUID(), messageId: randomUUID(), text: 'Harmful or checked text', intent: 'room' }
  const editInput = { requestId: randomUUID(), roomId: randomUUID(), messageId: randomUUID(), expectedVersion: 1, text: 'Harmful edit' }
  try {
    // screening-blocked details on failed-precondition error
    calls = [() => {
      const err = Object.assign(new Error('This message could not be sent. Please revise your draft and try again.'), {
        code: 'functions/failed-precondition',
        details: { code: 'screening-blocked', message: 'This message could not be sent. Please revise your draft and try again.' },
      })
      throw err
    }]
    await assert.rejects(port.send(sendInput), (err) => {
      assert.equal(err instanceof CommandRejectedError, true)
      assert.equal(err instanceof CommandUncertainError, false)
      return true
    })

    // screening-unavailable details on unavailable error
    calls = [() => {
      const err = Object.assign(new Error('Safety screening is temporarily unavailable. Please try again.'), {
        code: 'functions/unavailable',
        details: { code: 'screening-unavailable', message: 'Safety screening is temporarily unavailable. Please try again.' },
      })
      throw err
    }]
    await assert.rejects(port.send(sendInput), (err) => {
      assert.equal(err instanceof CommandRejectedError, true)
      assert.equal(err instanceof CommandUncertainError, false)
      return true
    })

    // editMessage with screening-blocked details
    calls = [() => {
      const err = Object.assign(new Error('This edit could not be saved. Please revise your text and try again.'), {
        code: 'functions/failed-precondition',
        details: { code: 'screening-blocked', message: 'This edit could not be saved. Please revise your text and try again.' },
      })
      throw err
    }]
    await assert.rejects(port.editMessage(editInput), (err) => {
      assert.equal(err instanceof CommandRejectedError, true)
      assert.equal(err instanceof CommandUncertainError, false)
      return true
    })

    // A terminal edit rejection remains a known rejection.
    calls = [
      () => ({ data: { status: 'failed', errorCode: 'screening-blocked', operationId: 'reconciled-op' } }),
    ]
    await assert.rejects(port.editMessage({ ...editInput, requestId: randomUUID() }), (err) => {
      assert.equal(err instanceof CommandRejectedError, true)
      return true
    })

    // A terminal unavailable verdict remains a known rejection.
    calls = [
      () => ({ data: { status: 'failed', errorCode: 'screening-unavailable', operationId: 'reconciled-op' } }),
    ]
    await assert.rejects(port.editMessage({ ...editInput, requestId: randomUUID() }), (err) => {
      assert.equal(err instanceof CommandRejectedError, true)
      return true
    })

    // A failed generated reply does not reject the already-approved question.
    const question = { ...sendInput, requestId: randomUUID(), intent: 'ask-ai' }
    calls = [() => ({
      data: {
        operationId: `${member.uid}_askThreadline_${question.requestId}`,
        status: 'failed',
        errorCode: 'screening-blocked',
        roomId: question.roomId,
        messageId: question.messageId,
        seq: 1,
      },
    })]
    let questionState = 'checking'
    await port.send(question).then(
      () => { questionState = 'awaiting-approved-question' },
      error => { questionState = error instanceof CommandRejectedError ? 'question-rejected' : 'uncertain' },
    )
    assert.equal(questionState, 'awaiting-approved-question')

    // Without a committed sequence, the same status is an input rejection.
    calls = [() => ({
      data: {
        operationId: `${member.uid}_askThreadline_${question.requestId}`,
        status: 'failed',
        errorCode: 'screening-unavailable',
        roomId: question.roomId,
        messageId: question.messageId,
      },
    })]
    await assert.rejects(port.send({ ...question, requestId: randomUUID() }), CommandRejectedError)
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator)
    else Reflect.deleteProperty(globalThis, 'navigator')
    port.dispose()
    await deleteApp(app)
  }
})

test('private screening remains uncertain while committed edits remain accepted', async () => {
  const previousNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } })
  const app = initializeApp({ projectId: 'demo-threadline', apiKey: 'emulator-only', appId: 'screening-progress' }, 'screening-progress')
  const member = { uid: 'controlled-reader', label: 'Reader' }
  const port = createFirebaseWorkspace(getFirestore(app), functionsSdk.getFunctions(app, 'asia-southeast1'), { currentUser: member }, member)
  const question = { requestId: randomUUID(), roomId: randomUUID(), messageId: randomUUID(), text: 'A synthetic question', intent: 'ask-ai' }
  const edit = { requestId: randomUUID(), roomId: question.roomId, messageId: question.messageId, expectedVersion: 1, text: 'A revised synthetic question' }
  try {
    calls = [() => ({ data: { operationId: `${member.uid}_askThreadline_${question.requestId}`, status: 'pending', roomId: question.roomId, messageId: question.messageId } })]
    await assert.rejects(port.send(question), CommandUncertainError)

    calls = [() => { throw Object.assign(new Error('Controlled lost response'), { code: 'functions/unavailable' }) }]
    await assert.rejects(port.editMessage(edit), CommandUncertainError)
    calls = [() => ({ data: { operationId: `${member.uid}_editMessage_${edit.requestId}`, status: 'pending', roomId: edit.roomId, messageId: edit.messageId } })]
    await assert.rejects(port.editMessage(edit), CommandUncertainError)

    calls = [() => ({ data: { operationId: `${member.uid}_editMessage_${edit.requestId}`, status: 'pending', roomId: edit.roomId, messageId: edit.messageId, version: 2 } })]
    const committed = await port.editMessage(edit)
    assert.equal(committed.version, 2)
    assert.equal(committed.status, 'pending')
  } finally {
    if (previousNavigator) Object.defineProperty(globalThis, 'navigator', previousNavigator)
    else Reflect.deleteProperty(globalThis, 'navigator')
    port.dispose()
    await deleteApp(app)
  }
})
