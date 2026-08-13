// Run with: npm run test:scripts
//
// node:test and node:assert are built into Node, so scripts/ keeps its
// no-dependency rule — this suite runs on a fresh clone before any npm
// install, exactly like the code it covers.

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { resolveTickInterval, describeFetchFailure } from '../lib/tick.mjs'

describe('resolveTickInterval', () => {
  test('falls back when no value is given', () => {
    assert.deepEqual(resolveTickInterval(undefined), { seconds: 60, error: null })
    assert.deepEqual(resolveTickInterval(''), { seconds: 60, error: null })
  })

  test('accepts a positive integer', () => {
    assert.deepEqual(resolveTickInterval('5'), { seconds: 5, error: null })
    assert.deepEqual(resolveTickInterval(30), { seconds: 30, error: null })
  })

  test('rejects a non-numeric value instead of ticking every millisecond', () => {
    // The defect this exists for: Number('abc') is NaN, and setInterval with
    // NaN is treated as 1ms, so `npm run tick -- --every abc` hammered the
    // endpoint a thousand times a second.
    const { seconds, error } = resolveTickInterval('abc')
    assert.equal(seconds, null)
    assert.match(error, /--every/)
    assert.match(error, /abc/)
  })

  for (const raw of ['0', '-5', '0.5', 'Infinity', '-Infinity', 'NaN']) {
    test(`rejects ${raw}`, () => {
      const { seconds, error } = resolveTickInterval(raw)
      assert.equal(seconds, null, `expected ${raw} to be rejected`)
      assert.ok(error, `expected an error message for ${raw}`)
    })
  }

  test('names the minimum in the message, so the fix is obvious', () => {
    assert.match(resolveTickInterval('0').error, /at least 1/)
  })
})

describe('describeFetchFailure', () => {
  test('surfaces the cause, which is where the real reason lives', () => {
    // Node's fetch throws a bare "fetch failed"; ECONNREFUSED is only ever in
    // err.cause. Printing err.message alone told the developer nothing.
    const err = new TypeError('fetch failed', {
      cause: new Error('connect ECONNREFUSED 127.0.0.1:4001'),
    })

    const described = describeFetchFailure(err)
    assert.match(described, /fetch failed/)
    assert.match(described, /ECONNREFUSED 127\.0\.0\.1:4001/)
  })

  test('reads a nested cause chain', () => {
    const err = new Error('outer', {
      cause: new Error('middle', { cause: new Error('root reason') }),
    })
    assert.match(describeFetchFailure(err), /root reason/)
  })

  test('falls back to the message when there is no cause', () => {
    assert.equal(describeFetchFailure(new Error('plain')), 'plain')
  })

  test('names an abort as a timeout rather than an opaque AbortError', () => {
    const err = new Error('This operation was aborted')
    err.name = 'AbortError'
    assert.match(describeFetchFailure(err), /timed out/i)
  })

  test('does not invent a duration it cannot know', () => {
    // It was reporting the default 30000ms even when tickOnce had been given
    // a different timeout. tickOnce owns that number and reports it itself.
    const err = new Error('aborted')
    err.name = 'AbortError'
    assert.doesNotMatch(describeFetchFailure(err), /\d+ms/)
  })

  test('survives a non-Error being thrown', () => {
    assert.equal(describeFetchFailure('just a string'), 'just a string')
    assert.ok(describeFetchFailure(undefined))
  })

  test('does not loop forever on a self-referential cause', () => {
    const err = new Error('self')
    err.cause = err
    assert.match(describeFetchFailure(err), /self/)
  })
})
