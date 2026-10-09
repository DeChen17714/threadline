import { test } from 'node:test'
import assert from 'node:assert/strict'
import { captureInviteIntent, readInviteIntent, clearInviteIntent } from '../src/services/inviteIntent.ts'
import { routeSnapshot, subscribeRoute } from '../src/app/routes.ts'

test('invitation bearer intent survives authentication only in session and strips the URL', () => {
  const storage = new Map()
  globalThis.sessionStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) }
  const token = 'a'.repeat(43)
  let stripped = null
  globalThis.window = { location: { pathname: '/join', hash: `#${token}` }, history: { replaceState: (_state, _title, path) => { stripped=path } } }
  captureInviteIntent()
  assert.equal(stripped, '/join')
  assert.equal(readInviteIntent(), token)
  clearInviteIntent()
  assert.equal(readInviteIntent(), null)
  globalThis.window.location.hash = '#bad-token'
  captureInviteIntent()
  assert.equal(readInviteIntent(), null)
  globalThis.window.location.hash = `#${token}`
  globalThis.window.location.pathname = '/auth'
  captureInviteIntent()
  assert.equal(readInviteIntent(), null)
})

test('two invitations on the same stripped route trigger a fresh join gate', () => {
  const values = new Map()
  globalThis.sessionStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) }
  const events = new Map()
  globalThis.window = {
    location: { pathname: '/join', search: '', hash: `#${'a'.repeat(43)}` },
    history: { replaceState: () => { globalThis.window.location.hash = '' } },
    addEventListener: (name, callback) => events.set(name, callback),
    removeEventListener: (name) => events.delete(name),
  }
  const first = routeSnapshot()
  let notified = false
  const unsubscribe = subscribeRoute(() => { notified = true })
  globalThis.window.location.hash = `#${'b'.repeat(43)}`
  events.get('hashchange')()
  const replacement = routeSnapshot()
  assert.equal(notified, true)
  assert.equal(first.url, '/join')
  assert.equal(replacement.url, '/join')
  assert.notEqual(replacement.revision, first.revision)
  assert.equal(readInviteIntent(), 'b'.repeat(43))
  unsubscribe()
  clearInviteIntent()
})
