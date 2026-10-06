// Run with: npm run test:scripts

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { loginUrl, loginHints, cleanTicket } from '../lib/login.mjs'

describe('loginUrl', () => {
  test('points the frontend root at the one-time ticket', () => {
    assert.equal(loginUrl('3100', 'abc123'), 'http://localhost:3100/?ticket=abc123')
  })

  test('uses the worktree port it is given', () => {
    assert.equal(loginUrl('3110', 'abc123'), 'http://localhost:3110/?ticket=abc123')
  })

  test('encodes the ticket so it survives the query string', () => {
    assert.equal(loginUrl('3100', 'a b&c'), 'http://localhost:3100/?ticket=a%20b%26c')
  })
})

describe('cleanTicket', () => {
  test('takes the last non-empty line, ignoring log noise before it', () => {
    assert.equal(cleanTicket('connecting\n\nfeedbeef\n'), 'feedbeef')
  })

  test('returns an empty string when the script printed nothing', () => {
    assert.equal(cleanTicket('  \n'), '')
  })
})

describe('loginHints', () => {
  test('warns when PERSONAL_ACCESS_TOKEN is blank, because the exchange then answers 503', () => {
    const hints = loginHints({ PERSONAL_ACCESS_TOKEN: '' })
    assert.equal(hints.length, 1)
    assert.match(hints[0], /PERSONAL_ACCESS_TOKEN/)
    assert.match(hints[0], /ISOPLUS_OFFLINE=1/)
  })

  test('warns when the variable is missing altogether', () => {
    assert.equal(loginHints({}).length, 1)
  })


  test('warns when GOOGLE_TARGET_GROUP is set, because verify then checks the real Workspace group', () => {
    const hints = loginHints({
      PERSONAL_ACCESS_TOKEN: 'x',
      ISOPLUS_OFFLINE: '1',
      GOOGLE_TARGET_GROUP: 'support@example.com',
    })
    assert.equal(hints.length, 1)
    assert.match(hints[0], /GOOGLE_TARGET_GROUP/)
    assert.match(hints[0], /group_denied/)
  })

  test('gives both hints when both problems are present', () => {
    assert.equal(loginHints({ GOOGLE_TARGET_GROUP: 'support@example.com' }).length, 2)
  })

  test('warns when a token is set but offline mode is not pinned, because the app would send it to ISO+', () => {
    const hints = loginHints({ PERSONAL_ACCESS_TOKEN: 'local-offline-placeholder' })
    assert.equal(hints.length, 1)
    assert.match(hints[0], /ISOPLUS_OFFLINE=1/)
  })

  test('is quiet when the token is set and offline mode is pinned', () => {
    assert.deepEqual(
      loginHints({ PERSONAL_ACCESS_TOKEN: 'local-offline-placeholder', ISOPLUS_OFFLINE: '1' }),
      [],
    )
  })
})
