export function groupItemIdsByParticipant(rows, { idKey, participantKey }) {
  const groups = new Map();
  for (const row of rows) {
    const participant = String(row[participantKey] || '').trim() || 'Participant';
    const itemId = row[idKey];
    if (!itemId) continue;
    if (!groups.has(participant)) groups.set(participant, new Set());
    groups.get(participant).add(String(itemId));
  }
  return [...groups.entries()].map(([participant, ids]) => ({
    participant,
    itemIds: [...ids],
  }));
}
