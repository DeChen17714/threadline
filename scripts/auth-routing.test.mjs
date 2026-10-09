import test from 'node:test'
import assert from 'node:assert/strict'
import { privateDestination } from '../src/app/routes.ts'

test('authentication returns only to supported private routes', () => {
  for (const route of ['/workspace', '/join', '/rooms/abcd-1234']) assert.equal(privateDestination(route), route)
  for (const route of [null, '', 'https://example.com', '//example.com', '/\\example.com', '/auth?next=//example.com', '/rooms/a/../../auth', '/rooms/a?next=//example.com', '/rooms/%2f%2fexample.com', 'javascript:alert(1)', '/']) {
    assert.equal(privateDestination(route), '/workspace')
  }
})
