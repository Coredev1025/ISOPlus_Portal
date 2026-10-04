import { createHash } from 'node:crypto';

import Business from '../../../models/Business.js';
import { DEFAULT_TIMEZONE } from '../../../constants/scheduler.js';
import { blockPricingNetwork } from '../../ndisPricingRules.js';
import { mongoEq } from '../../securityHelpers.js';
import { categoriesFound, missingAcknowledgements } from './acks.js';
import { applyPlan, undoBackfill, validatePlan } from './apply.js';
import { makeDeriveTotal } from './deriveTotal.js';
import { loadBackfillInputs, workspacesWithInvoices } from './loader.js';
import { planBackfill } from './plan.js';

/**
 * The backfill, end to end (KAN-311): plan every selected workspace (reads only), then, only
 * when asked to apply, the plan matches the dry run the operator read, and every category
 * found has been acknowledged, write. A dry run is the default and is exactly the plan. The
 * script (`scripts/invoice-backfill.mjs`) is a thin shell around this.
 *
 * Safety around the write: the apply needs the plan hash the dry run printed; every
 * workspace is planned again immediately before it is written and must still match; every
 * record is validated before the first write; each workspace's result is reported as it is
 * written and survives a later failure.
 */

export class AcknowledgementError extends Error {
  constructor(missing) {
    const detail = missing.map((m) => `${m.category} (found ${m.found}, acknowledged ${m.acknowledged ?? 'none'})`).join(', ');
    super(`The backfill found categories that were not acknowledged: ${detail}. Re-run with --ack category=count for each, after reading the report.`);
    this.name = 'AcknowledgementError';
    this.missing = missing;
  }
}

export class StalePlanError extends Error {
  constructor(message, results = []) {
    super(message);
    this.name = 'StalePlanError';
    this.results = results;
  }
}

const timezoneOf = async (workspaceId) => (
  await Business.findOne({ workspaceId: mongoEq(String(workspaceId)) }).select('headOfficeTimezone').lean()
)?.headOfficeTimezone || DEFAULT_TIMEZONE;

async function planWorkspace(workspaceId, deriveTotalFor) {
  const inputs = await loadBackfillInputs(workspaceId);
  const timezone = await timezoneOf(workspaceId);
  const plan = await planBackfill(inputs, { deriveTotal: deriveTotalFor({ workspaceId, timezone }) });
  return { workspaceId, plan };
}

/** A short digest of what a plan would do, per workspace: stable for the same plan, different when anything it would write changes. */
export function planFingerprint(planned) {
  const slice = planned.map(({ workspaceId, plan }) => [
    workspaceId,
    plan.invoices.map((i) => [i.ref, i.total, i.lines.map((l) => l.itemId).sort(), i.participant.name]),
    plan.pointers.map((p) => [p.itemId, p.ref ?? p.invoiceId]),
    plan.stamps.map((s) => [s.ledgerRowId, s.ref ?? s.invoiceId]),
    plan.xeroAttachments,
    categoriesFound(plan.report),
  ]);
  return createHash('sha1').update(JSON.stringify(slice)).digest('hex').slice(0, 12);
}

/** The reports of every workspace as one, for the gate and the summary. */
function aggregate(planned) {
  const lists = {};
  const created = {};
  for (const { workspaceId, plan } of planned) {
    for (const [key, list] of Object.entries(plan.report.lists)) {
      lists[key] = [...(lists[key] || []), ...list.map((entry) => ({ ...entry, workspaceId }))];
    }
    for (const [reason, n] of Object.entries(plan.report.counts.created)) created[reason] = (created[reason] || 0) + n;
  }
  return { lists, created };
}

async function undoAll(workspaces, apply) {
  const totals = {
    invoices: 0, stamped: 0, pointed: 0, skipped: [], preview: !apply,
  };
  for (const workspaceId of workspaces) {
    const undone = await undoBackfill(workspaceId, { apply });
    ['invoices', 'stamped', 'pointed'].forEach((key) => { totals[key] += undone[key]; });
    totals.skipped.push(...undone.skipped.map((s) => ({ ...s, workspaceId })));
  }
  return { applied: false, undone: totals };
}

/** The checks before any write: the hash of the plan that was read, and the acknowledgements. */
function assertMayApply({ planned, combined, planHash, acks }) {
  if (!planHash) throw new StalePlanError('--plan <hash> is required with --apply: the dry run prints it. Apply the plan you read.');
  if (planFingerprint(planned) !== planHash) {
    throw new StalePlanError('The plan changed since the dry run (the stores or the invoices moved). Run the dry run again and read it.');
  }
  const missing = missingAcknowledgements({ lists: combined.lists }, acks);
  if (missing.length > 0) throw new AcknowledgementError(missing);
}

/** Plan one workspace again just before writing it; it must be the plan that was approved. */
async function replanned(approved, deriveTotalFor, results) {
  const fresh = await planWorkspace(approved.workspaceId, deriveTotalFor);
  if (planFingerprint([fresh]) !== planFingerprint([approved])) {
    throw new StalePlanError(`Workspace ${approved.workspaceId} changed after the plan was approved; nothing more was written. Re-run the dry run.`, results);
  }
  return fresh;
}

async function applyAll(planned, deriveTotalFor, onWorkspaceApplied) {
  const results = [];
  try {
    for (const approved of planned) {
      const { workspaceId, plan } = await replanned(approved, deriveTotalFor, results);
      const written = { workspaceId, ...await applyPlan(plan, workspaceId) };
      results.push(written);
      if (onWorkspaceApplied) await onWorkspaceApplied(written);
    }
  } catch (err) {
    err.results = err.results ?? results;
    throw err;
  }
  return results;
}

export async function runBackfill({
  workspaceIds, apply = false, undo = false, acks = {}, planHash, deriveTotalFor = makeDeriveTotal, onWorkspaceApplied,
}) {
  blockPricingNetwork(true);
  try {
    const workspaces = workspaceIds ?? await workspacesWithInvoices();
    if (undo) return await undoAll(workspaces, apply);

    const planned = [];
    for (const workspaceId of workspaces) planned.push(await planWorkspace(workspaceId, deriveTotalFor));
    const combined = aggregate(planned);
    const totals = { created: combined.created, found: categoriesFound({ lists: combined.lists }), lists: combined.lists };
    const hash = planFingerprint(planned);
    if (!apply) return { applied: false, totals, planned, planHash: hash };

    assertMayApply({
      planned, combined, planHash, acks,
    });
    for (const { plan } of planned) await validatePlan(plan);
    const results = await applyAll(planned, deriveTotalFor, onWorkspaceApplied);
    return {
      applied: true, totals, planned, results, planHash: hash,
    };
  } finally {
    blockPricingNetwork(false);
  }
}
