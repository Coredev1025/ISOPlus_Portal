/** Printing the marker backfill's result (KAN-312). Pure. The arguments are the same as the invoice backfill's (`backfill/cli.js`). */

const pad = (text, width) => String(text).padEnd(width);
const EXAMPLES_SHOWN = 10;

function totalsLines(totals) {
  return [
    `  ${pad('items to mark', 28)} ${totals.toMark}`,
    ...Object.entries(totals.byType).map(([type, n]) => `    ${pad(`from ${type} rows`, 26)} ${n}`),
    `  ${pad('already marked (left alone)', 28)} ${totals.alreadyMarked}`,
    `  ${pad('had both PDF and Xero', 28)} ${totals.hadBothTypes}  (the later one is the marker)`,
    `  ${pad('dates that are approximate', 28)} ${totals.approximateDates}  (the log row was rewritten later)`,
    `  ${pad('items deleted since (log rows)', 28)} ${totals.deletedItems}`,
    `  ${pad('items whose log rows are unusable', 28)} ${totals.unusableRows}`,
  ];
}

function listLines(planned) {
  const lines = [];
  for (const { workspaceId, plan } of planned || []) {
    for (const [name, list] of Object.entries(plan.report.lists)) {
      if (list.length === 0) continue;
      lines.push(`  ${workspaceId} ${name}: ${list.length}`);
      lines.push(...list.slice(0, EXAMPLES_SHOWN).map((entry) => `      ${JSON.stringify(entry)}`));
      if (list.length > EXAMPLES_SHOWN) lines.push(`      ... and ${list.length - EXAMPLES_SHOWN} more`);
    }
  }
  return lines.length === 0 ? ['  none'] : lines;
}

function undoLines(undone) {
  return undone.preview
    ? [
      'UNDO PREVIEW: nothing was changed',
      `  would clear ${undone.items} markers set by the backfill`,
      '',
      'To do it, re-run with --undo --apply. Once scheduled selection no longer reads the old log, clearing these',
      'markers makes the items billable again: undo only before that.',
    ]
    : ['UNDO', `  cleared ${undone.items} markers set by the backfill`];
}

/** The result of `runMarkerBackfill` as lines of text. */
export function formatMarkerResult(result) {
  if (result.undone) return undoLines(result.undone);
  return [
    result.applied ? 'APPLIED' : 'DRY RUN: nothing was written',
    '',
    'Markers:',
    ...totalsLines(result.totals),
    '',
    'To look at:',
    ...listLines(result.planned),
    ...(result.applied
      ? ['', 'Written:', ...result.results.map((r) => `  ${pad(r.workspaceId, 12)} marked ${r.marked}`)]
      : ['', `Plan hash: ${result.planHash}`, 'To write these, re-run with --apply --plan <hash>.']),
  ];
}
