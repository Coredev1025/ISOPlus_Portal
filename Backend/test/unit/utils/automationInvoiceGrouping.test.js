import { describe, it, expect } from 'vitest';
import { groupItemIdsByParticipantProfile } from '../../../src/utils/automationInvoiceGrouping.js';

const row = (id, participant) => ({ id, participant });
const opts = (profiles) => ({
  idKey: 'id',
  participantKey: 'participant',
  profileIdOf: (itemId) => profiles[itemId] ?? null,
});

// KAN-293: the profile reference decides who an item belongs to; the name is
// only the label.
describe('groupItemIdsByParticipantProfile', () => {
  it('makes one group per participant profile, labelled with the name', () => {
    const { groups, unprofiled } = groupItemIdsByParticipantProfile(
      [row('a1', 'Ann'), row('b1', 'Bob'), row('a2', 'Ann')],
      opts({ a1: 'P-A', a2: 'P-A', b1: 'P-B' }),
    );
    expect(unprofiled).toEqual([]);
    expect(groups).toEqual([
      { profileId: 'P-A', participant: 'Ann', itemIds: ['a1', 'a2'] },
      { profileId: 'P-B', participant: 'Bob', itemIds: ['b1'] },
    ]);
  });

  it('keeps two participants who share a name apart', () => {
    const { groups } = groupItemIdsByParticipantProfile(
      [row('x1', 'Sam Lee'), row('y1', 'Sam Lee')],
      opts({ x1: 'P-X', y1: 'P-Y' }),
    );
    expect(groups.map((g) => g.profileId)).toEqual(['P-X', 'P-Y']);
  });

  it('keeps one participant together when their name is spelled two ways', () => {
    const { groups } = groupItemIdsByParticipantProfile(
      [row('a1', 'Ann Smith'), row('a2', 'A. Smith')],
      opts({ a1: 'P-A', a2: 'P-A' }),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ profileId: 'P-A', participant: 'Ann Smith', itemIds: ['a1', 'a2'] });
  });

  it('groups a blank-name item by its profile and labels it with the first name seen', () => {
    const { groups } = groupItemIdsByParticipantProfile(
      [row('a1', ''), row('a2', 'Ann')],
      opts({ a1: 'P-A', a2: 'P-A' }),
    );
    expect(groups).toEqual([{ profileId: 'P-A', participant: 'Ann', itemIds: ['a1', 'a2'] }]);
  });

  it('falls back to a generic label when no row carries a name', () => {
    const { groups } = groupItemIdsByParticipantProfile([row('a1', '')], opts({ a1: 'P-A' }));
    expect(groups[0].participant).toBe('Participant');
  });

  it('leaves items with no profile out of every group and reports them', () => {
    const { groups, unprofiled } = groupItemIdsByParticipantProfile(
      [row('a1', 'Ann'), row('n1', ''), row('n2', 'Ghost')],
      opts({ a1: 'P-A' }),
    );
    expect(groups).toHaveLength(1);
    expect(unprofiled).toEqual(['n1', 'n2']);
  });

  it('ignores rows without an id and does not mutate its input', () => {
    const rows = [row('a1', 'Ann'), { participant: 'No id' }];
    const copy = JSON.parse(JSON.stringify(rows));
    const { groups } = groupItemIdsByParticipantProfile(rows, opts({ a1: 'P-A' }));
    expect(groups).toHaveLength(1);
    expect(rows).toEqual(copy);
  });
});
