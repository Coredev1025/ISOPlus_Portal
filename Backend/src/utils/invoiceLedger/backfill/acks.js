/**
 * The acknowledgement gate (design 6.4): a real backfill run refuses to start unless every
 * category the plan found has been acknowledged on the command line with its exact count
 * (`--ack double-billed=3`), so nothing is accepted by accident. Pure.
 */

/** `double-billed` to `doubleBilled`, the report's own key. */
const camel = (kebab) => kebab.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

/** `['double-billed=3']` to `{ doubleBilled: 3 }`. */
export function parseAcks(args) {
  const acks = {};
  for (const arg of args || []) {
    const match = /^([a-zA-Z-]+)=(\d+)$/.exec(arg);
    if (!match) throw new Error(`--ack takes category=count, for example double-billed=3 (got "${arg}")`);
    acks[camel(match[1])] = Number(match[2]);
  }
  return acks;
}

/** The categories with something in them, and how many. */
export function categoriesFound(report) {
  return Object.fromEntries(Object.entries(report.lists).filter(([, list]) => list.length > 0).map(([key, list]) => [key, list.length]));
}

/** Categories found that are not acknowledged with the count found. */
export function missingAcknowledgements(report, acks = {}) {
  return Object.entries(categoriesFound(report))
    .filter(([category, found]) => acks[category] !== found)
    .map(([category, found]) => ({ category, found, acknowledged: acks[category] }));
}
