import { parseAcks } from './acks.js';

/**
 * The backfill script's pure parts (KAN-311): reading its arguments and printing its result.
 * Safe by default: a dry run, and nothing runs without naming workspaces or --all.
 */

const kebab = (camel) => camel.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
const EXAMPLES_SHOWN = 10;

/** The flags that take a value, and the ones that stand alone. */
const VALUE_FLAGS = new Set(['--workspace', '--ack', '--report-file', '--plan']);
const SWITCHES = new Set(['--all', '--apply', '--undo', '--json', '--allow-remote']);

/** Store the value of a flag that takes one. */
function storeValue(flags, flag, value) {
  if (flag === '--workspace') flags.workspaces.push(value);
  else if (flag === '--ack') flags.acks.push(value);
  else if (flag === '--plan') flags.planHash = value;
  else flags.reportFile = value;
}

function readFlags(argv) {
  const flags = {
    workspaces: [], acks: [], switches: new Set(), reportFile: undefined, planHash: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (SWITCHES.has(arg)) {
      flags.switches.add(arg);
    } else if (VALUE_FLAGS.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      i += 1;
      storeValue(flags, arg, value);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return flags;
}

export function parseBackfillArgs(argv) {
  const flags = readFlags(argv);
  const all = flags.switches.has('--all');
  if (!all && flags.workspaces.length === 0) {
    throw new Error('Name the workspaces with --workspace <id> (repeatable), or pass --all. Nothing runs by default.');
  }
  return {
    workspaceIds: all ? undefined : flags.workspaces,
    apply: flags.switches.has('--apply'),
    undo: flags.switches.has('--undo'),
    acks: parseAcks(flags.acks),
    planHash: flags.planHash,
    json: flags.switches.has('--json'),
    reportFile: flags.reportFile,
    allowRemote: flags.switches.has('--allow-remote'),
  };
}

const pad = (text, width) => String(text).padEnd(width);

function createdLines(created) {
  const entries = Object.entries(created || {});
  return entries.length === 0 ? ['  nothing to create'] : entries.map(([reason, n]) => `  ${pad(reason, 14)} ${n}`);
}

function exampleLines(list) {
  const shown = list.slice(0, EXAMPLES_SHOWN).map((entry) => `      ${JSON.stringify(entry)}`);
  return list.length > EXAMPLES_SHOWN ? [...shown, `      ... and ${list.length - EXAMPLES_SHOWN} more`] : shown;
}

function categoryLines(totals) {
  const lines = [];
  for (const [category, found] of Object.entries(totals.found || {})) {
    lines.push(`  ${pad(category, 24)} ${pad(found, 5)} --ack ${kebab(category)}=${found}`);
    lines.push(...exampleLines(totals.lists[category]));
  }
  return lines.length === 0 ? ['  none'] : lines;
}

function plannedLines(planned) {
  return (planned || []).map(({ workspaceId, plan }) => `  ${pad(workspaceId, 12)} items linked ${plan.report.counts.itemsLinked}, already recorded ${plan.report.counts.alreadyRecorded}, revisited log rows ${plan.report.counts.revisitedLogRows}`);
}

function appliedLines(results) {
  return results.map((r) => `  ${pad(r.workspaceId, 12)} created ${r.created}, stamped ${r.stamped}, pointed ${r.pointed}${r.pointerSkipped ? ` (${r.pointerSkipped} skipped: pointer changed)` : ''}, xero attached ${r.xeroAttached}`);
}

function undoLines(undone) {
  const verb = undone.preview ? 'would remove' : 'removed';
  const lines = [
    undone.preview ? 'UNDO PREVIEW: nothing was changed' : 'UNDO',
    `  ${verb} ${undone.invoices} invoices, unstamp ${undone.stamped} ledger rows, unpoint ${undone.pointed} items`,
  ];
  if ((undone.skipped || []).length > 0) {
    lines.push(`  left alone, changed since they were created: ${undone.skipped.map((s) => `${s.number} (${s.workspaceId})`).join(', ')}`);
  }
  if (undone.preview) lines.push('', 'To do it, re-run with --undo --apply.');
  return lines;
}

/** The result of `runBackfill` as lines of text. */
export function formatBackfillResult(result) {
  if (result.undone) return undoLines(result.undone);
  return [
    result.applied ? 'APPLIED' : 'DRY RUN: nothing was written',
    '',
    'Invoices to create, by reason:',
    ...createdLines(result.totals.created),
    '',
    'Categories found (each needs its --ack to apply):',
    ...categoryLines(result.totals),
    '',
    'By workspace:',
    ...plannedLines(result.planned),
    ...(result.applied
      ? ['', 'Written:', ...appliedLines(result.results)]
      : ['', `Plan hash: ${result.planHash}`, 'To write these, re-run with --apply --plan <hash> and the --ack flags above.']),
  ];
}
