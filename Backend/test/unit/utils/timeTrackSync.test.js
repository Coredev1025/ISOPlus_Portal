import { describe, it, expect } from 'vitest';
import { syncTimeTrackingFromItem } from '../../../src/utils/timeTrackSync.js';
import TimeTrack from '../../../src/models/TimeTrack.js';

const WORKSPACE_ID = 'ws-7f3a';
const BOARD_ID = 'brd-1042';
const ITEM_ID = 'itm-55231';

// Mirrors what transformItemData() (src/utils/itemTransform.js) produces for an
// ISO+ item that carries a time-tracking attribute.
function makeItemData(entries, overrides = {}) {
  return {
    Name: 'Jane Doe',
    'Job Status': { id: 'lbl-3', name: 'Completed', color: '#22aa55' },
    'Time Tracking': entries,
    _primaryValue: 'Jane Doe - Personal Care',
    _hasTimeTracking: true,
    _timeTrackingKey: 'Time Tracking',
    _timeTrackingAttributeId: 'attr-tt-9',
    ...overrides,
  };
}

function makeEntry(overrides = {}) {
  return {
    id: 'tt-1',
    user_id: 'usr-401',
    started_at: '2026-03-01T09:00:00.000Z',
    ended_at: '2026-03-01T11:30:30.900Z',
    description: 'Morning shift - personal care',
    ...overrides,
  };
}

describe('syncTimeTrackingFromItem — guards that skip the sync entirely', () => {
  it('returns 0 when itemData is missing', async () => {
    expect(await syncTimeTrackingFromItem(WORKSPACE_ID, BOARD_ID, ITEM_ID, undefined)).toBe(0);
    expect(await syncTimeTrackingFromItem(WORKSPACE_ID, BOARD_ID, ITEM_ID, null)).toBe(0);
    expect(await TimeTrack.countDocuments()).toBe(0);
  });

  it('returns 0 when the item is not flagged as having time tracking', async () => {
    const withoutFlag = makeItemData([makeEntry()], { _hasTimeTracking: false });
    delete withoutFlag._hasTimeTracking;

    expect(
      await syncTimeTrackingFromItem(
        WORKSPACE_ID,
        BOARD_ID,
        ITEM_ID,
        makeItemData([makeEntry()], { _hasTimeTracking: false }),
      ),
    ).toBe(0);
    expect(await syncTimeTrackingFromItem(WORKSPACE_ID, BOARD_ID, ITEM_ID, withoutFlag)).toBe(0);
    expect(await TimeTrack.countDocuments()).toBe(0);
  });

  it('returns 0 when the time-tracking key is missing or points at nothing', async () => {
    const noKey = makeItemData([makeEntry()]);
    delete noKey._timeTrackingKey;

    expect(await syncTimeTrackingFromItem(WORKSPACE_ID, BOARD_ID, ITEM_ID, noKey)).toBe(0);
    expect(
      await syncTimeTrackingFromItem(
        WORKSPACE_ID,
        BOARD_ID,
        ITEM_ID,
        makeItemData([makeEntry()], { _timeTrackingKey: 'Missing Attribute' }),
      ),
    ).toBe(0);
    expect(await TimeTrack.countDocuments()).toBe(0);
  });

  it('returns 0 when the entry list is empty or not an array', async () => {
    expect(await syncTimeTrackingFromItem(WORKSPACE_ID, BOARD_ID, ITEM_ID, makeItemData([]))).toBe(0);
    expect(
      await syncTimeTrackingFromItem(WORKSPACE_ID, BOARD_ID, ITEM_ID, makeItemData('2026-03-01')),
    ).toBe(0);
    expect(await TimeTrack.countDocuments()).toBe(0);
  });

  it('returns 0 when any identifier is an empty string', async () => {
    const itemData = makeItemData([makeEntry()]);

    expect(await syncTimeTrackingFromItem('', BOARD_ID, ITEM_ID, itemData)).toBe(0);
    expect(await syncTimeTrackingFromItem(WORKSPACE_ID, '', ITEM_ID, itemData)).toBe(0);
    expect(await syncTimeTrackingFromItem(WORKSPACE_ID, BOARD_ID, '', itemData)).toBe(0);
    expect(await TimeTrack.countDocuments()).toBe(0);
  });

  it('rejects rather than returning 0 when an identifier is null or an injection object', async () => {
    const itemData = makeItemData([makeEntry()]);

    await expect(syncTimeTrackingFromItem(null, BOARD_ID, ITEM_ID, itemData)).rejects.toThrow(
      'Invalid query value: expected a plain string, number, boolean, or bigint.',
    );
    await expect(
      syncTimeTrackingFromItem(WORKSPACE_ID, { $ne: '' }, ITEM_ID, itemData),
    ).rejects.toThrow('Invalid query value');
    expect(await TimeTrack.countDocuments()).toBe(0);
  });
});

describe('syncTimeTrackingFromItem — importing entries', () => {
  it('creates one ISO+-sourced row per entry and returns the count', async () => {
    const synced = await syncTimeTrackingFromItem(
      WORKSPACE_ID,
      BOARD_ID,
      ITEM_ID,
      makeItemData([
        makeEntry(),
        makeEntry({
          id: 'tt-2',
          started_at: '2026-03-02T13:15:00.000Z',
          ended_at: '2026-03-02T14:00:00.000Z',
          description: 'Afternoon shift',
        }),
      ]),
    );

    expect(synced).toBe(2);

    const rows = await TimeTrack.find({}).sort({ started_at: 1 }).lean();
    expect(rows).toHaveLength(2);

    expect(rows[0].workspaceId).toBe(WORKSPACE_ID);
    expect(rows[0].boardId).toBe(BOARD_ID);
    expect(rows[0].itemId).toBe(ITEM_ID);
    expect(rows[0].Task).toBe('Jane Doe - Personal Care');
    expect(rows[0].started_at.toISOString()).toBe('2026-03-01T09:00:00.000Z');
    expect(rows[0].ended_at.toISOString()).toBe('2026-03-01T11:30:30.900Z');
    // (11:30:30.900 - 09:00:00.000) === 9_030_900 ms -> 9030.9 s -> floored.
    expect(rows[0].Duration).toBe(9030);
    expect(rows[0].User).toBe('[iso+]');
    expect(rows[0].UserName).toBe('Morning shift - personal care');
    expect(rows[0].notes).toBe('Morning shift - personal care');
    expect(rows[0].isoPlusSynced).toBe(true);
    expect(rows[0].source).toBe('isoplus');

    expect(rows[1].Duration).toBe(2700);
    expect(rows[1].UserName).toBe('Afternoon shift');
  });

  it('accepts Date objects as well as ISO strings for the entry timestamps', async () => {
    const synced = await syncTimeTrackingFromItem(
      WORKSPACE_ID,
      BOARD_ID,
      ITEM_ID,
      makeItemData([
        makeEntry({
          started_at: new Date('2026-03-05T08:00:00.000Z'),
          ended_at: new Date('2026-03-05T08:00:59.000Z'),
        }),
      ]),
    );

    expect(synced).toBe(1);
    const row = await TimeTrack.findOne({}).lean();
    expect(row.Duration).toBe(59);
  });

  it('falls back to the ISO+ Import defaults when the entry has no description', async () => {
    const noDescription = makeEntry();
    delete noDescription.description;

    const synced = await syncTimeTrackingFromItem(
      WORKSPACE_ID,
      BOARD_ID,
      ITEM_ID,
      makeItemData([noDescription]),
    );

    expect(synced).toBe(1);
    const row = await TimeTrack.findOne({}).lean();
    expect(row.UserName).toBe('ISO+ Import');
    expect(row.notes).toBeNull();
  });

  it('falls back to the item id for the task name when there is no primary value', async () => {
    const itemData = makeItemData([makeEntry()], { _primaryValue: '' });

    expect(await syncTimeTrackingFromItem(WORKSPACE_ID, BOARD_ID, ITEM_ID, itemData)).toBe(1);

    const row = await TimeTrack.findOne({}).lean();
    expect(row.Task).toBe(ITEM_ID);
  });

  it('coerces numeric identifiers to strings', async () => {
    expect(await syncTimeTrackingFromItem(9001, 9002, 9003, makeItemData([makeEntry()]))).toBe(1);

    const row = await TimeTrack.findOne({}).lean();
    expect(row.workspaceId).toBe('9001');
    expect(row.boardId).toBe('9002');
    expect(row.itemId).toBe('9003');
    expect(row.Task).toBe('Jane Doe - Personal Care');
  });

  it('skips entries missing either timestamp and imports the rest', async () => {
    const openEntry = makeEntry({ id: 'tt-open', started_at: '2026-03-03T09:00:00.000Z' });
    delete openEntry.ended_at;
    const noStart = makeEntry({ id: 'tt-nostart', ended_at: '2026-03-04T10:00:00.000Z' });
    delete noStart.started_at;

    const synced = await syncTimeTrackingFromItem(
      WORKSPACE_ID,
      BOARD_ID,
      ITEM_ID,
      makeItemData([openEntry, noStart, makeEntry()]),
    );

    expect(synced).toBe(1);
    const rows = await TimeTrack.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].started_at.toISOString()).toBe('2026-03-01T09:00:00.000Z');
  });

  it('skips entries whose timestamps are null, not just absent', async () => {
    // new Date(null) is the epoch, a perfectly valid Date — only the explicit
    // falsy check on both fields stops these becoming rows.
    const synced = await syncTimeTrackingFromItem(
      WORKSPACE_ID,
      BOARD_ID,
      ITEM_ID,
      makeItemData([
        makeEntry({ id: 'tt-no-end', ended_at: null }),
        makeEntry({ id: 'tt-no-start', started_at: null }),
      ]),
    );

    expect(synced).toBe(0);
    expect(await TimeTrack.countDocuments()).toBe(0);
  });
});

describe('syncTimeTrackingFromItem — de-duplication', () => {
  it('skips an entry whose start time is already stored for that board and item', async () => {
    await TimeTrack.create({
      workspaceId: WORKSPACE_ID,
      boardId: BOARD_ID,
      itemId: ITEM_ID,
      Task: 'Jane Doe - Personal Care',
      started_at: new Date('2026-03-01T09:00:00.000Z'),
      ended_at: new Date('2026-03-01T10:00:00.000Z'),
      Duration: 3600,
      User: 'usr-401',
      source: 'portal',
    });

    const synced = await syncTimeTrackingFromItem(
      WORKSPACE_ID,
      BOARD_ID,
      ITEM_ID,
      makeItemData([makeEntry()]),
    );

    expect(synced).toBe(0);
    const rows = await TimeTrack.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('portal');
    expect(rows[0].Duration).toBe(3600);
  });

  it('de-duplicates repeated start times within the same payload', async () => {
    const synced = await syncTimeTrackingFromItem(
      WORKSPACE_ID,
      BOARD_ID,
      ITEM_ID,
      makeItemData([
        makeEntry(),
        makeEntry({ id: 'tt-dup', ended_at: '2026-03-01T12:00:00.000Z', description: 'Duplicate' }),
      ]),
    );

    expect(synced).toBe(1);
    const rows = await TimeTrack.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].UserName).toBe('Morning shift - personal care');
  });

  it('treats a one-millisecond difference as a distinct entry', async () => {
    const synced = await syncTimeTrackingFromItem(
      WORKSPACE_ID,
      BOARD_ID,
      ITEM_ID,
      makeItemData([
        makeEntry(),
        makeEntry({ id: 'tt-2', started_at: '2026-03-01T09:00:00.001Z' }),
      ]),
    );

    expect(synced).toBe(2);
    expect(await TimeTrack.countDocuments()).toBe(2);
  });

  it('is blocked by an existing row under a different workspace — the lookup ignores workspaceId', async () => {
    await TimeTrack.create({
      workspaceId: 'ws-someone-else',
      boardId: BOARD_ID,
      itemId: ITEM_ID,
      Task: 'Jane Doe - Personal Care',
      started_at: new Date('2026-03-01T09:00:00.000Z'),
      ended_at: new Date('2026-03-01T10:00:00.000Z'),
      Duration: 3600,
      User: '[iso+]',
      source: 'isoplus',
    });

    expect(
      await syncTimeTrackingFromItem(WORKSPACE_ID, BOARD_ID, ITEM_ID, makeItemData([makeEntry()])),
    ).toBe(0);
    expect(await TimeTrack.countDocuments()).toBe(1);
  });

  it('is not blocked by an identical start time recorded against another item', async () => {
    await TimeTrack.create({
      workspaceId: WORKSPACE_ID,
      boardId: BOARD_ID,
      itemId: 'itm-other',
      Task: 'Someone Else',
      started_at: new Date('2026-03-01T09:00:00.000Z'),
      ended_at: new Date('2026-03-01T10:00:00.000Z'),
      Duration: 3600,
      User: '[iso+]',
      source: 'isoplus',
    });

    expect(
      await syncTimeTrackingFromItem(WORKSPACE_ID, BOARD_ID, ITEM_ID, makeItemData([makeEntry()])),
    ).toBe(1);
    expect(await TimeTrack.countDocuments()).toBe(2);
  });

  it('is idempotent across two runs of the same payload', async () => {
    const itemData = makeItemData([makeEntry()]);

    expect(await syncTimeTrackingFromItem(WORKSPACE_ID, BOARD_ID, ITEM_ID, itemData)).toBe(1);
    expect(await syncTimeTrackingFromItem(WORKSPACE_ID, BOARD_ID, ITEM_ID, itemData)).toBe(0);
    expect(await TimeTrack.countDocuments()).toBe(1);
  });
});

describe('syncTimeTrackingFromItem — failures while writing', () => {
  it('swallows a write failure for one entry and still imports the others', async () => {
    const synced = await syncTimeTrackingFromItem(
      WORKSPACE_ID,
      BOARD_ID,
      ITEM_ID,
      makeItemData([
        makeEntry({ id: 'tt-bad', started_at: 'not a real timestamp' }),
        makeEntry({ id: 'tt-good' }),
      ]),
    );

    expect(synced).toBe(1);
    const rows = await TimeTrack.find({}).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].started_at.toISOString()).toBe('2026-03-01T09:00:00.000Z');
  });

  it('returns 0 when every entry fails to write', async () => {
    const synced = await syncTimeTrackingFromItem(
      WORKSPACE_ID,
      BOARD_ID,
      ITEM_ID,
      makeItemData([makeEntry({ started_at: 'nonsense', ended_at: 'also nonsense' })]),
    );

    expect(synced).toBe(0);
    expect(await TimeTrack.countDocuments()).toBe(0);
  });
});
