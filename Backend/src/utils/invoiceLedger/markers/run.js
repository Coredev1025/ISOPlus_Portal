import { createHash } from 'node:crypto';

import { MARKER_BACKFILL_SENTINEL } from '../../../constants/invoiceLedger.js';
import { StalePlanError } from '../backfill/run.js';
import { applyMarkers, undoMarkers } from './apply.js';
import { loadMarkerInputs, workspacesWithLog } from './loader.js';
import { planMarkers } from './plan.js';

/**
 * The marker backfill, end to end (KAN-312). A dry run (the default) is exactly the plan. A
 * real run needs the plan hash the dry run printed, plans each workspace again just before
 * writing it and stops if it changed, and reports each workspace as it is written.
 */

export const MARKER_SENTINEL = MARKER_BACKFILL_SENTINEL;

export function markersFingerprint(planned) {
  const slice = planned.map(({ workspaceId, plan }) => [workspaceId, plan.markers.map((m) => [m.itemId, m.invoicedBy, new Date(m.invoicedAt).toISOString()])]);
  return createHash('sha1').update(JSON.stringify(slice)).digest('hex').slice(0, 12);
}

async function planWorkspace(workspaceId) {
  return { workspaceId, plan: planMarkers(await loadMarkerInputs(workspaceId)) };
}

function totalsOf(planned) {
  const totals = { toMark: 0, alreadyMarked: 0, deletedItems: 0, unusableRows: 0, hadBothTypes: 0, approximateDates: 0, byType: {} };
  for (const { plan } of planned) {
    totals.toMark += plan.markers.length;
    totals.alreadyMarked += plan.report.counts.alreadyMarked;
    totals.deletedItems += plan.report.lists.deletedItems.length;
    totals.unusableRows += plan.report.lists.unusableRows.length;
    totals.hadBothTypes += plan.report.counts.hadBothTypes;
    totals.approximateDates += plan.report.counts.approximateDates;
    for (const [type, n] of Object.entries(plan.report.counts.byType)) totals.byType[type] = (totals.byType[type] || 0) + n;
  }
  return totals;
}

async function undoAll(workspaces, apply) {
  const totals = { items: 0, preview: !apply };
  for (const workspaceId of workspaces) totals.items += (await undoMarkers(workspaceId, { apply })).items;
  return { applied: false, undone: totals };
}

async function applyAll(planned, onWorkspaceApplied) {
  const results = [];
  try {
    for (const approved of planned) {
      const fresh = await planWorkspace(approved.workspaceId);
      if (markersFingerprint([fresh]) !== markersFingerprint([approved])) {
        throw new StalePlanError(`Workspace ${approved.workspaceId} changed after the plan was approved; nothing more was written. Re-run the dry run.`, results);
      }
      const written = { workspaceId: approved.workspaceId, ...await applyMarkers(fresh.plan.markers, approved.workspaceId) };
      results.push(written);
      if (onWorkspaceApplied) await onWorkspaceApplied(written);
    }
  } catch (err) {
    err.results = err.results ?? results;
    throw err;
  }
  return results;
}

export async function runMarkerBackfill({
  workspaceIds, apply = false, undo = false, planHash, onWorkspaceApplied,
}) {
  const workspaces = [...new Set(workspaceIds ?? await workspacesWithLog())];
  if (undo) return undoAll(workspaces, apply);

  const planned = [];
  for (const workspaceId of workspaces) planned.push(await planWorkspace(workspaceId));
  const hash = markersFingerprint(planned);
  const totals = totalsOf(planned);
  if (!apply) return { applied: false, totals, planned, planHash: hash };

  if (!planHash) throw new StalePlanError('--plan <hash> is required with --apply: the dry run prints it. Apply the plan you read.');
  if (hash !== planHash) throw new StalePlanError('The plan changed since the dry run (the stores moved). Run the dry run again and read it.');
  const results = await applyAll(planned, onWorkspaceApplied);
  return {
    applied: true, totals, planned, results, planHash: hash,
  };
}
