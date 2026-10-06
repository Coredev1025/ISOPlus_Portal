// Run with: npm run test:scripts

import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULTS } from '../lib/env.mjs'
import {
  OPEN_ENDED_PATHS, acknowledgements, backendImage, camel, compareExpectations, draftExpectations, exponentForm, keyPaths, leakPatterns,
  migrationName, unexpectedKeys, kebab, parseBackfillDryRun,
  parseMarkerDryRun, parsePendingMigrations, stripAnsi, summariseAudit, summariseStages,
} from '../lib/rehearse-parse.mjs'

const DRY = `DRY RUN: nothing was written

Invoices to create, by reason:
  log-only       14
  xero-later     26

Categories found (each needs its --ack to apply):
  unplaceable              8     --ack unplaceable=8
      {"number":"INV-1074"}
      ... and 7 more
  supersededByXero         200   --ack superseded-by-xero=200

By workspace:
  55369        items linked 157, already recorded 0, revisited log rows 203

Plan hash: 19f60950c3f4
To write these, re-run with --apply --plan <hash> and the --ack flags above.
`

describe('names', () => {
  test('kebab and camel round-trip a category', () => {
    assert.equal(kebab('supersededByXero'), 'superseded-by-xero')
    assert.equal(camel('superseded-by-xero'), 'supersededByXero')
  })
})

describe('parseBackfillDryRun', () => {
  test('reads the reasons, the categories with their counts and the plan hash', () => {
    assert.deepEqual(parseBackfillDryRun(DRY), {
      created: { 'log-only': 14, 'xero-later': 26 },
      found: { unplaceable: 8, supersededByXero: 200 },
      planHash: '19f60950c3f4',
    })
  })

  test('says nothing to create as an empty result, and ignores colour codes', () => {
    const out = '\u001B[32mDRY RUN\u001B[0m\n\nInvoices to create, by reason:\n  nothing to create\n\nPlan hash: abc123\n'
    assert.deepEqual(parseBackfillDryRun(out), { created: {}, found: {}, planHash: 'abc123' })
  })
})

describe('acknowledgements', () => {
  test('one --ack per category with its exact count', () => {
    assert.deepEqual(acknowledgements({ unplaceable: 8, supersededByXero: 200 }), [
      '--ack', 'unplaceable=8', '--ack', 'superseded-by-xero=200',
    ])
  })
})

describe('parseMarkerDryRun', () => {
  test('reads the counts and the hash', () => {
    const out = 'Markers:\n  items to mark                368\n    from Xero rows             216\n    from PDF rows              152\n  already marked (left alone)  0\n\nPlan hash: ee96f690c5b8\n'
    assert.deepEqual(parseMarkerDryRun(out), {
      toMark: 368, fromXero: 216, fromPdf: 152, alreadyMarked: 0, planHash: 'ee96f690c5b8',
    })
  })
})

describe('parsePendingMigrations', () => {
  test('takes the down lines, oldest first, ignoring colour codes and the up lines', () => {
    const out = '\u001B[32mup:\u001B[0m 100-a\n\u001B[31mdown:\u001B[0m 300-c\n\u001B[31mdown:\u001B[0m 200-b\n'
    assert.deepEqual(parsePendingMigrations(out), ['200-b', '300-c'])
    assert.equal(stripAnsi('\u001B[31mx\u001B[0m'), 'x')
  })
})

describe('migrationName', () => {
  test('list prints <timestamp>-<name>; up takes the bare name', () => {
    assert.equal(migrationName('1791102300000-invoice-ledger-indexes'), 'invoice-ledger-indexes')
    assert.equal(migrationName('1771401600000-remove-xero-connection-logs'), 'remove-xero-connection-logs')
  })
})

describe('backendImage', () => {
  test('follows the compose project, so a worktree uses the image its own dev:build made', () => {
    assert.equal(backendImage(DEFAULTS), 'isoplus-portal-backend')
    assert.equal(backendImage({ COMPOSE_PROJECT_NAME: 'isoplus-bugfix-x' }), 'isoplus-bugfix-x-backend')
  })
})

describe('summariseAudit', () => {
  test('sums violations per category over the workspaces and leaves out empty ones', () => {
    const audit = {
      a: { violations: { markerWithoutInvoice: [1, 2], duplicateOwner: [] } },
      b: { violations: { markerWithoutInvoice: [3] } },
    }
    assert.deepEqual(summariseAudit(audit), { markerWithoutInvoice: 3 })
  })
})

describe('compareExpectations', () => {
  const expectations = {
    'backfill.created.xero-later': { value: 26, reason: 'items whose Xero row is later (D9)' },
    'audit.markerWithoutInvoice': { value: 66, reason: 'items on the 8 unplaceable invoices' },
  }

  test('no differences when the run matches', () => {
    const actual = { backfill: { created: { 'xero-later': 26 } }, audit: { markerWithoutInvoice: 66 } }
    assert.deepEqual(compareExpectations(actual, expectations), [])
  })

  test('a drift is reported with the reason, and a missing value counts', () => {
    const actual = { backfill: { created: { 'xero-later': 27 } }, audit: {} }
    assert.deepEqual(compareExpectations(actual, expectations), [
      { path: 'backfill.created.xero-later', expected: 26, actual: 27, reason: 'items whose Xero row is later (D9)' },
      { path: 'audit.markerWithoutInvoice', expected: 66, actual: null, reason: 'items on the 8 unplaceable invoices' },
    ])
  })
})

describe('unexpectedKeys', () => {
  test('flags a category or reason no expectation names', () => {
    const expectations = { 'backfill.found.unplaceable': { value: 8, reason: 'r' } }
    const actual = { backfill: { found: { unplaceable: 8, brandNew: 3 } } }
    assert.deepEqual(unexpectedKeys(actual, expectations, ['backfill.found', 'backfill.created']), [
      { path: 'backfill.found.brandNew', expected: 'not expected', actual: 3, reason: 'a new category or reason: decide what it means before accepting it' },
    ])
  })
})

describe('leakPatterns', () => {
  test('keeps the kinds that identify someone and drops fragments, placeholders and the owner addresses', () => {
    const out = [
      'COUNTS:{}', 'LEAK:name\tJane Citizen', 'LEAK:email\tjane@real.example', 'LEAK:email\tmasoud+billing@isoconsultingservices.com.au',
      'LEAK:email\tsomeone@example.com', 'LEAK:free\tsome note text here', 'LEAK:link\thttps://x/y.pdf', 'LEAK:address\tNot Provided',
      'LEAK:phone\t0412345678', 'LEAK:name1\tAshley', 'LEAK:name\tJane Citizen',
    ].join('\n')
    assert.deepEqual(leakPatterns(out), ['0412345678', 'Jane Citizen', 'jane@real.example'])
  })
})

describe('open-ended paths include the audit', () => {
  const actual = { backfill: { found: { unplaceable: 8 } }, audit: { markerWithoutInvoice: 66, brandNew: 2 } }

  test('a new audit violation category is flagged', () => {
    const expectations = { 'backfill.found.unplaceable': { value: 8, reason: 'r' }, 'audit.markerWithoutInvoice': { value: 66, reason: 'r' } }
    assert.deepEqual(unexpectedKeys(actual, expectations, OPEN_ENDED_PATHS).map((d) => d.path), ['audit.brandNew'])
  })

  test('a --learn draft lists every audit category seen', () => {
    assert.deepEqual(keyPaths(actual, OPEN_ENDED_PATHS), ['backfill.found.unplaceable', 'audit.markerWithoutInvoice', 'audit.brandNew'])
  })
})

describe('draftExpectations and summariseStages', () => {
  test('a draft takes the actual values and asks for the reason', () => {
    const draft = draftExpectations({ a: { b: 5 } }, ['a.b', 'a.c'])
    assert.equal(draft['a.b'].value, 5)
    assert.equal(draft['a.c'].value, null)
    assert.match(draft['a.b'].reason, /TO CONFIRM/)
  })

  test('the summary has one line per stage', () => {
    const out = summariseStages([{ name: 'restore', ok: true, seconds: 12 }, { name: 'audit', ok: false, detail: '3 differ' }])
    assert.equal(out, 'PASS  restore  (12s)\nFAIL  audit  3 differ')
  })
})

test('exponentForm: the spelling mongoexport uses for a number of ten digits or more', () => {
  assert.equal(exponentForm('12345678901'), '1.2345678901E+10')
  assert.equal(exponentForm('51000000000'), '5.1E+10')
  assert.equal(exponentForm('123456789'), null)
  assert.equal(exponentForm('0412 345 678'), null)
  assert.equal(exponentForm('0412345678'), null) // a leading zero is stored as text, never as a number
})

test('leakPatterns: a long numeric original is also searched in its exponent spelling', () => {
  const patterns = leakPatterns('LEAK:id\t12345678901\n')
  assert.ok(patterns.includes('12345678901'))
  assert.ok(patterns.includes('1.2345678901E+10'))
})
