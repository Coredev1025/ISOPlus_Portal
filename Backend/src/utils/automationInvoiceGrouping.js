const GENERIC_PARTICIPANT_LABEL = 'Participant';

/**
 * Group billable rows by the participant they belong to.
 *
 * KAN-293: an item belongs to a participant by its Participant Profile
 * reference, never by the display name. The name is free text and, on a synced
 * board, often blank or stale; grouping on it collapsed every nameless row into
 * one catch-all group that mixed profiles, which the invoice generator refuses,
 * so one such row failed the whole board run. The name is only the label.
 *
 * Pure. `profileIdOf(itemId)` answers the profile reference for an item, or a
 * falsy value when it has none. Rows with no profile are returned in
 * `unprofiled` instead of being grouped: there is no one to bill them to.
 */
export function groupItemIdsByParticipantProfile(rows, { idKey, participantKey, profileIdOf }) {
  const groups = new Map();
  const unprofiled = [];
  for (const row of rows) {
    const itemId = row[idKey];
    if (!itemId) continue;
    const profileId = profileIdOf(itemId);
    if (!profileId) {
      unprofiled.push(String(itemId));
      continue;
    }
    const name = String(row[participantKey] || '').trim();
    if (!groups.has(profileId)) groups.set(profileId, { profileId, name: '', itemIds: new Set() });
    const group = groups.get(profileId);
    if (!group.name) group.name = name;
    group.itemIds.add(String(itemId));
  }
  return {
    groups: [...groups.values()].map(({ profileId, name, itemIds }) => ({
      profileId,
      participant: name || GENERIC_PARTICIPANT_LABEL,
      itemIds: [...itemIds],
    })),
    unprofiled,
  };
}
