import { describe, it, expect, vi, beforeEach } from 'vitest';

// getBoardAttributes / getReferences / getAttribute are the ISO+ HTTP boundary.
// They are the only things mocked here — Item goes through the real Mongoose
// model against the in-memory server started by test/setup.js.
vi.mock('../../../src/services/isoplus.js', () => ({
  getBoardAttributes: vi.fn(),
  getReferences: vi.fn(),
  getAttribute: vi.fn(),
}));

import {
  LEGACY_DIRECT_SUPPORT_ATTR,
  NEW_SUPPORT_ITEM_ATTR,
  NEW_ACTIVITY_TRANSPORT_ITEM_ATTR,
  hasSelectionValue,
  boardAttributesUseLegacyNdisPricing,
  boardAttributesUseNewNdisPricing,
  inferPricingRuleFromServicePlanData,
  boardUsesLegacyNdisPricing,
  boardUsesNewNdisPricing,
  resolveNdisPricingRuleForBoard,
  resolveNdisPricingRuleForServicePlan,
  resolveNdisPricingRuleForAutomation,
  automationUsesNewNdisPricing,
  getServicePlanBoardIdFromMasterPlan,
  masterPlanBoardUsesNewNdisPricing,
  isShiftCancelled,
} from '../../../src/utils/ndisPricingRules.js';
import { getBoardAttributes, getReferences, getAttribute } from '../../../src/services/isoplus.js';
import Item from '../../../src/models/Item.js';
import fixture from '../../fixtures/ndis-quote-board.json' with { type: 'json' };

// boardRuleCache is module-level and lives for the whole file, so every test
// that touches it uses a board id no other test has used.
let boardCounter = 0;
const freshBoard = () => `board-${++boardCounter}`;

const refAttr = (name) => ({ id: `attr-${name}`, name, type: 'reference' });

const legacyAttributes = [
  refAttr(LEGACY_DIRECT_SUPPORT_ATTR),
  { id: 'attr-issue-date', name: 'Issue Date', type: 'date' },
];
const newAttributes = [
  refAttr(NEW_SUPPORT_ITEM_ATTR),
  refAttr(NEW_ACTIVITY_TRANSPORT_ITEM_ATTR),
  { id: 'attr-issue-date', name: 'Issue Date', type: 'date' },
];

beforeEach(() => {
  vi.mocked(getBoardAttributes).mockReset();
  vi.mocked(getReferences).mockReset();
  vi.mocked(getAttribute).mockReset();
});

describe('attribute name constants', () => {
  // Breaks if a constant is repointed at a name the live board does not carry:
  // these three strings are the webhook keys the whole dispatch turns on.
  it('drives the fixture board to the new pricing path', () => {
    const names = fixture.attributes.map((a) => a.name);
    expect(names).toContain(NEW_SUPPORT_ITEM_ATTR);
    expect(names).toContain(NEW_ACTIVITY_TRANSPORT_ITEM_ATTR);
    expect(names).not.toContain(LEGACY_DIRECT_SUPPORT_ATTR);
    expect(boardAttributesUseLegacyNdisPricing(fixture.attributes)).toBe(false);
  });
});

describe('hasSelectionValue', () => {
  it('treats a non-empty array as a selection', () => {
    expect(hasSelectionValue({ 'Support Item Number': ['fixture-support-item-ref'] }, 'Support Item Number')).toBe(true);
  });

  it('treats an empty array as no selection', () => {
    expect(hasSelectionValue({ 'Support Item Number': [] }, 'Support Item Number')).toBe(false);
  });

  it('treats a non-empty string as a selection', () => {
    expect(hasSelectionValue({ 'Support Item Number': '01_011_0107_1_1' }, 'Support Item Number')).toBe(true);
  });

  it('treats an empty string, null and undefined as no selection', () => {
    expect(hasSelectionValue({ k: '' }, 'k')).toBe(false);
    expect(hasSelectionValue({ k: null }, 'k')).toBe(false);
    expect(hasSelectionValue({ k: undefined }, 'k')).toBe(false);
    expect(hasSelectionValue({}, 'k')).toBe(false);
  });

  it('treats the number 0 as a selection', () => {
    expect(hasSelectionValue({ k: 0 }, 'k')).toBe(true);
  });

  it('returns false for a nullish container', () => {
    expect(hasSelectionValue(null, 'k')).toBe(false);
    expect(hasSelectionValue(undefined, 'k')).toBe(false);
  });
});

describe('boardAttributesUseLegacyNdisPricing', () => {
  it('is legacy when only the legacy reference column exists', () => {
    expect(boardAttributesUseLegacyNdisPricing(legacyAttributes)).toBe(true);
  });

  it('is not legacy when both legacy and new reference columns exist', () => {
    expect(boardAttributesUseLegacyNdisPricing([...legacyAttributes, ...newAttributes])).toBe(false);
  });

  it('is not legacy when only the new reference column exists', () => {
    expect(boardAttributesUseLegacyNdisPricing(newAttributes)).toBe(false);
  });

  it('ignores a legacy column that is not of type reference', () => {
    expect(boardAttributesUseLegacyNdisPricing([
      { id: 'a1', name: LEGACY_DIRECT_SUPPORT_ATTR, type: 'text' },
    ])).toBe(false);
  });

  it('matches the reference type case-insensitively', () => {
    expect(boardAttributesUseLegacyNdisPricing([
      { id: 'a1', name: LEGACY_DIRECT_SUPPORT_ATTR, type: 'Reference' },
    ])).toBe(true);
  });

  it('ignores a deleted legacy column', () => {
    expect(boardAttributesUseLegacyNdisPricing([
      { ...refAttr(LEGACY_DIRECT_SUPPORT_ATTR), deleted: true },
    ])).toBe(false);
  });

  it('keeps a column whose deleted flag is false rather than true', () => {
    expect(boardAttributesUseLegacyNdisPricing([
      { ...refAttr(LEGACY_DIRECT_SUPPORT_ATTR), deleted: false },
    ])).toBe(true);
  });

  it('reads the attribute list out of an { attribute: [...] } response envelope', () => {
    expect(boardAttributesUseLegacyNdisPricing({ status: 200, attribute: legacyAttributes })).toBe(true);
    expect(boardAttributesUseLegacyNdisPricing({ status: 200, attribute: newAttributes })).toBe(false);
  });

  it('is not legacy for null, undefined and an empty list', () => {
    expect(boardAttributesUseLegacyNdisPricing(null)).toBe(false);
    expect(boardAttributesUseLegacyNdisPricing(undefined)).toBe(false);
    expect(boardAttributesUseLegacyNdisPricing([])).toBe(false);
  });

  it('survives a null entry in the attribute list', () => {
    expect(boardAttributesUseLegacyNdisPricing([null, refAttr(LEGACY_DIRECT_SUPPORT_ATTR)])).toBe(true);
  });

  it('ignores a legacy column whose type is missing entirely', () => {
    expect(boardAttributesUseLegacyNdisPricing([
      { id: 'a1', name: LEGACY_DIRECT_SUPPORT_ATTR },
      { id: 'a2', name: LEGACY_DIRECT_SUPPORT_ATTR, type: null },
    ])).toBe(false);
  });
});

describe('boardAttributesUseNewNdisPricing', () => {
  it('is the exact negation of the legacy check', () => {
    expect(boardAttributesUseNewNdisPricing(legacyAttributes)).toBe(false);
    expect(boardAttributesUseNewNdisPricing(newAttributes)).toBe(true);
    expect(boardAttributesUseNewNdisPricing(fixture.attributes)).toBe(true);
    expect(boardAttributesUseNewNdisPricing([])).toBe(true);
  });
});

describe('inferPricingRuleFromServicePlanData', () => {
  const fixtureItem = (itemId) => fixture.items.find((i) => i.itemId === itemId).data;

  it('returns null for nullish and non-object data', () => {
    expect(inferPricingRuleFromServicePlanData(null)).toBeNull();
    expect(inferPricingRuleFromServicePlanData(undefined)).toBeNull();
    expect(inferPricingRuleFromServicePlanData('Support Item Number')).toBeNull();
    expect(inferPricingRuleFromServicePlanData(7)).toBeNull();
  });

  it('returns null when neither key is present', () => {
    expect(inferPricingRuleFromServicePlanData(fixtureItem('cfd84160-cb3d-4b86-b9d0-a5cb20c674ce'))).toBeNull();
  });

  it("returns 'legacy' for the fixture item that carries only the legacy key", () => {
    expect(inferPricingRuleFromServicePlanData(fixtureItem('fixture-quote-legacy-pricing'))).toBe('legacy');
  });

  it("returns 'new' for the fixture item that carries only the new key", () => {
    expect(inferPricingRuleFromServicePlanData(fixtureItem('fixture-quote-new-pricing'))).toBe('new');
  });

  it("returns 'new' when both keys are present and the new one is filled in", () => {
    expect(inferPricingRuleFromServicePlanData({
      [LEGACY_DIRECT_SUPPORT_ATTR]: ['fixture-direct-support-ref'],
      [NEW_SUPPORT_ITEM_ATTR]: ['fixture-support-item-ref'],
    })).toBe('new');
  });

  it("returns 'legacy' when both keys are present but the new one is an empty selection", () => {
    expect(inferPricingRuleFromServicePlanData({
      [LEGACY_DIRECT_SUPPORT_ATTR]: ['fixture-direct-support-ref'],
      [NEW_SUPPORT_ITEM_ATTR]: [],
    })).toBe('legacy');
    expect(inferPricingRuleFromServicePlanData({
      [LEGACY_DIRECT_SUPPORT_ATTR]: ['fixture-direct-support-ref'],
      [NEW_SUPPORT_ITEM_ATTR]: '',
    })).toBe('legacy');
  });

  it('keys on presence of the property, not on its value', () => {
    expect(inferPricingRuleFromServicePlanData({ [LEGACY_DIRECT_SUPPORT_ATTR]: undefined })).toBe('legacy');
    expect(inferPricingRuleFromServicePlanData({ [NEW_SUPPORT_ITEM_ATTR]: [] })).toBe('new');
  });

  it('does not treat an inherited key as present', () => {
    const parent = { [NEW_SUPPORT_ITEM_ATTR]: ['x'] };
    expect(inferPricingRuleFromServicePlanData(Object.create(parent))).toBeNull();
  });
});

describe('boardUsesLegacyNdisPricing', () => {
  it('returns legacy without calling ISO+ when workspaceId or boardId is missing', async () => {
    expect(await boardUsesLegacyNdisPricing(null, 'b')).toBe(true);
    expect(await boardUsesLegacyNdisPricing('ws', null)).toBe(true);
    expect(await boardUsesLegacyNdisPricing('', '')).toBe(true);
    expect(getBoardAttributes).not.toHaveBeenCalled();
  });

  it('returns legacy when ISO+ does not answer 200', async () => {
    const board = freshBoard();
    getBoardAttributes.mockResolvedValue({ status: 401, error_type: 'oauth' });
    expect(await boardUsesLegacyNdisPricing('55369', board)).toBe(true);
  });

  it('returns legacy when ISO+ returns 200 with no attributes', async () => {
    const board = freshBoard();
    getBoardAttributes.mockResolvedValue({ status: 200, attribute: [] });
    expect(await boardUsesLegacyNdisPricing('55369', board)).toBe(true);
  });

  it('returns legacy when a 200 response omits the attribute key altogether', async () => {
    const board = freshBoard();
    getBoardAttributes.mockResolvedValue({ status: 200 });
    expect(await boardUsesLegacyNdisPricing('55369', board)).toBe(true);
  });

  it('returns legacy when the board carries only the legacy reference column', async () => {
    const board = freshBoard();
    getBoardAttributes.mockResolvedValue({ status: 200, attribute: legacyAttributes });
    expect(await boardUsesLegacyNdisPricing('55369', board)).toBe(true);
    expect(getBoardAttributes).toHaveBeenCalledWith('55369', board);
  });

  it('returns not-legacy for the live fixture board attribute list', async () => {
    const board = freshBoard();
    getBoardAttributes.mockResolvedValue({ status: 200, attribute: fixture.attributes });
    expect(await boardUsesLegacyNdisPricing(fixture.capturedFrom.workspaceId, board)).toBe(false);
  });

  it('caches the answer, so a later ISO+ change is not picked up', async () => {
    const board = freshBoard();
    getBoardAttributes.mockResolvedValue({ status: 200, attribute: newAttributes });
    expect(await boardUsesLegacyNdisPricing('55369', board)).toBe(false);

    getBoardAttributes.mockResolvedValue({ status: 200, attribute: legacyAttributes });
    expect(await boardUsesLegacyNdisPricing('55369', board)).toBe(false);
    expect(getBoardAttributes).toHaveBeenCalledTimes(1);
  });

  it('caches the failure answer too', async () => {
    const board = freshBoard();
    getBoardAttributes.mockResolvedValue(undefined);
    expect(await boardUsesLegacyNdisPricing('55369', board)).toBe(true);

    getBoardAttributes.mockResolvedValue({ status: 200, attribute: newAttributes });
    expect(await boardUsesLegacyNdisPricing('55369', board)).toBe(true);
    expect(getBoardAttributes).toHaveBeenCalledTimes(1);
  });

  it('caches per workspace and board pair, not per board alone', async () => {
    const board = freshBoard();
    getBoardAttributes.mockResolvedValueOnce({ status: 200, attribute: newAttributes });
    getBoardAttributes.mockResolvedValueOnce({ status: 200, attribute: legacyAttributes });
    expect(await boardUsesLegacyNdisPricing('ws-a', board)).toBe(false);
    expect(await boardUsesLegacyNdisPricing('ws-b', board)).toBe(true);
  });
});

// KAN-330. The NDIS Invoice Generator resolves the pricing rule for every row at once,
// and a row with no service plan falls back to this board lookup. Before the fix the
// cache held answers only, so on a cold cache every row asked ISO+ itself: one page
// load on a 9,392-item board sent thousands of identical requests, ISO+ answered 429,
// and the retries made the first load take ~45 s.
describe('boardUsesLegacyNdisPricing under concurrent callers', () => {
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };

  it('makes one ISO+ request for many concurrent callers on one uncached board', async () => {
    const board = freshBoard();
    const reply = deferred();
    getBoardAttributes.mockReturnValue(reply.promise);

    const callers = Array.from({ length: 50 }, () => boardUsesLegacyNdisPricing('55427', board));
    reply.resolve({ status: 200, attribute: newAttributes });
    const answers = await Promise.all(callers);

    expect(getBoardAttributes).toHaveBeenCalledTimes(1);
    expect(new Set(answers)).toEqual(new Set([false]));
  });

  // A request that fails outright (not a non-200 answer, which is cached as legacy)
  // must not be remembered: the next caller after it settles asks again.
  it('does not keep a failed request, so the next caller tries again', async () => {
    const board = freshBoard();
    const reply = deferred();
    getBoardAttributes.mockReturnValueOnce(reply.promise);

    const callers = [boardUsesLegacyNdisPricing('55427', board), boardUsesLegacyNdisPricing('55427', board)];
    reply.reject(new Error('ISO+ unreachable'));
    const settled = await Promise.allSettled(callers);
    expect(settled.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(getBoardAttributes).toHaveBeenCalledTimes(1);

    getBoardAttributes.mockResolvedValueOnce({ status: 200, attribute: legacyAttributes });
    expect(await boardUsesLegacyNdisPricing('55427', board)).toBe(true);
    expect(getBoardAttributes).toHaveBeenCalledTimes(2);
  });

  it('still looks up each board separately', async () => {
    const [a, b] = [freshBoard(), freshBoard()];
    getBoardAttributes.mockImplementation(async (_ws, boardId) => (
      { status: 200, attribute: boardId === a ? legacyAttributes : newAttributes }
    ));

    const answers = await Promise.all([
      boardUsesLegacyNdisPricing('55427', a), boardUsesLegacyNdisPricing('55427', b),
      boardUsesLegacyNdisPricing('55427', a), boardUsesLegacyNdisPricing('55427', b),
    ]);

    expect(answers).toEqual([true, false, true, false]);
    expect(getBoardAttributes).toHaveBeenCalledTimes(2);
  });
});

describe('boardUsesNewNdisPricing / resolveNdisPricingRuleForBoard', () => {
  it('negates and labels the legacy answer', async () => {
    const legacyBoard = freshBoard();
    getBoardAttributes.mockResolvedValue({ status: 200, attribute: legacyAttributes });
    expect(await boardUsesNewNdisPricing('55369', legacyBoard)).toBe(false);
    expect(await resolveNdisPricingRuleForBoard('55369', legacyBoard)).toBe('legacy');

    const newBoard = freshBoard();
    getBoardAttributes.mockResolvedValue({ status: 200, attribute: newAttributes });
    expect(await boardUsesNewNdisPricing('55369', newBoard)).toBe(true);
    expect(await resolveNdisPricingRuleForBoard('55369', newBoard)).toBe('new');
  });
});

describe('resolveNdisPricingRuleForServicePlan', () => {
  it('uses the item data and never asks ISO+ when the data settles it', async () => {
    const rule = await resolveNdisPricingRuleForServicePlan('55369', {
      boardId: freshBoard(),
      data: { [NEW_SUPPORT_ITEM_ATTR]: ['fixture-support-item-ref'] },
    });
    expect(rule).toBe('new');
    expect(getBoardAttributes).not.toHaveBeenCalled();
  });

  it("falls back to the item's own boardId when the data settles nothing", async () => {
    const board = freshBoard();
    getBoardAttributes.mockResolvedValue({ status: 200, attribute: newAttributes });
    expect(await resolveNdisPricingRuleForServicePlan('55369', { boardId: board, data: {} }, 'other-board')).toBe('new');
    expect(getBoardAttributes).toHaveBeenCalledWith('55369', board);
  });

  it('falls back to the supplied fallback board when the item has none', async () => {
    const board = freshBoard();
    getBoardAttributes.mockResolvedValue({ status: 200, attribute: legacyAttributes });
    expect(await resolveNdisPricingRuleForServicePlan('55369', null, board)).toBe('legacy');
    expect(getBoardAttributes).toHaveBeenCalledWith('55369', board);
  });

  it("returns 'legacy' when there is no board to consult", async () => {
    expect(await resolveNdisPricingRuleForServicePlan('55369', null, null)).toBe('legacy');
    expect(await resolveNdisPricingRuleForServicePlan('55369', { data: null })).toBe('legacy');
    expect(getBoardAttributes).not.toHaveBeenCalled();
  });
});

describe('resolveNdisPricingRuleForAutomation', () => {
  it('settles on the webhook values before touching Mongo or ISO+', async () => {
    const payload = fixture.webhookPayloads['participants-service-plan-support'].items[0];
    const rule = await resolveNdisPricingRuleForAutomation('55369', freshBoard(), payload.id, payload.values);
    expect(rule).toBe('new');
    expect(getBoardAttributes).not.toHaveBeenCalled();
  });

  it('settles on the legacy webhook values', async () => {
    const payload = fixture.webhookPayloads['participants-service-plan-direct-support'].items[0];
    expect(await resolveNdisPricingRuleForAutomation('55369', freshBoard(), payload.id, payload.values)).toBe('legacy');
  });

  it('falls back to the stored item data when the webhook values are empty', async () => {
    const board = freshBoard();
    const stored = fixture.items.find((i) => i.itemId === 'fixture-quote-legacy-pricing');
    await Item.create({
      workspaceId: '55369',
      boardId: board,
      folderId: stored.folderId,
      itemId: stored.itemId,
      data: stored.data,
    });
    expect(await resolveNdisPricingRuleForAutomation('55369', board, stored.itemId, {})).toBe('legacy');
    expect(getBoardAttributes).not.toHaveBeenCalled();
  });

  it('falls through to the board rule when no stored item matches', async () => {
    const board = freshBoard();
    getBoardAttributes.mockResolvedValue({ status: 200, attribute: newAttributes });
    expect(await resolveNdisPricingRuleForAutomation('55369', board, 'never-stored', {})).toBe('new');
    expect(getBoardAttributes).toHaveBeenCalledWith('55369', board);
  });

  it('falls through to the board rule when the stored item settles nothing', async () => {
    const board = freshBoard();
    const stored = fixture.items.find((i) => i.itemId === 'cfd84160-cb3d-4b86-b9d0-a5cb20c674ce');
    await Item.create({
      workspaceId: '55369',
      boardId: board,
      folderId: stored.folderId,
      itemId: stored.itemId,
      data: stored.data,
    });
    getBoardAttributes.mockResolvedValue({ status: 200, attribute: legacyAttributes });
    expect(await resolveNdisPricingRuleForAutomation('55369', board, stored.itemId, {})).toBe('legacy');
  });

  it('skips the Mongo lookup when the workspace is missing and returns legacy with no board', async () => {
    expect(await resolveNdisPricingRuleForAutomation(null, null, 'item-1', {})).toBe('legacy');
    expect(getBoardAttributes).not.toHaveBeenCalled();
  });

  it('scopes the Mongo lookup by workspace, so another workspace\'s item does not match', async () => {
    const board = freshBoard();
    await Item.create({
      workspaceId: 'other-workspace',
      boardId: board,
      folderId: 'BFMUenisoQ4',
      itemId: 'shared-item-id',
      data: { [LEGACY_DIRECT_SUPPORT_ATTR]: ['ref'] },
    });
    getBoardAttributes.mockResolvedValue({ status: 200, attribute: newAttributes });
    expect(await resolveNdisPricingRuleForAutomation('55369', board, 'shared-item-id', {})).toBe('new');
  });

  it('rejects a NoSQL-operator itemId rather than querying with it', async () => {
    await expect(
      resolveNdisPricingRuleForAutomation('55369', freshBoard(), { $ne: null }, {}),
    ).rejects.toThrow('Invalid query value');
  });
});

describe('automationUsesNewNdisPricing', () => {
  it('is true only for the new rule', async () => {
    expect(await automationUsesNewNdisPricing('55369', freshBoard(), 'i', { [NEW_SUPPORT_ITEM_ATTR]: ['x'] })).toBe(true);
    expect(await automationUsesNewNdisPricing('55369', freshBoard(), 'i', { [LEGACY_DIRECT_SUPPORT_ATTR]: ['x'] })).toBe(false);
  });
});

describe('getServicePlanBoardIdFromMasterPlan', () => {
  const servicePlanRef = { attribute_id: 'attr-service-plan', to_item_id: 'service-plan-item-1' };

  it('returns the stored service plan board id', async () => {
    getReferences.mockResolvedValue({ data: [servicePlanRef] });
    getAttribute.mockResolvedValue({ id: 'attr-service-plan', name: 'Service Plan' });
    await Item.create({
      workspaceId: '55369',
      boardId: 'service-plan-board',
      folderId: 'folder-1',
      itemId: 'service-plan-item-1',
      data: {},
    });

    expect(await getServicePlanBoardIdFromMasterPlan('55369', 'master-board', 'master-item')).toBe('service-plan-board');
    expect(getReferences).toHaveBeenCalledWith('55369', 'master-board', 'master-item');
    expect(getAttribute).toHaveBeenCalledWith('55369', 'master-board', 'attr-service-plan');
  });

  it('falls back to the master plan board when the referenced item is not stored', async () => {
    getReferences.mockResolvedValue({ data: [servicePlanRef] });
    getAttribute.mockResolvedValue({ name: 'Service Plan' });
    expect(await getServicePlanBoardIdFromMasterPlan('55369', 'master-board', 'master-item')).toBe('master-board');
  });

  it('falls back to the master plan board when the stored item has no boardId', async () => {
    getReferences.mockResolvedValue({ data: [servicePlanRef] });
    getAttribute.mockResolvedValue({ name: 'Service Plan' });
    await Item.collection.insertOne({ workspaceId: '55369', itemId: 'service-plan-item-1', data: {} });
    expect(await getServicePlanBoardIdFromMasterPlan('55369', 'master-board', 'master-item')).toBe('master-board');
  });

  it('skips references whose attribute is not Service Plan', async () => {
    getReferences.mockResolvedValue({
      data: [
        { attribute_id: 'attr-fund', to_item_id: 'fund-1' },
        { attribute_id: 'attr-profile', to_item_id: 'profile-1' },
      ],
    });
    getAttribute.mockResolvedValueOnce({ name: 'Fund' }).mockResolvedValueOnce({ name: 'Participant Profile' });
    expect(await getServicePlanBoardIdFromMasterPlan('55369', 'master-board', 'master-item')).toBeNull();
  });

  it('stops at the first Service Plan reference', async () => {
    getReferences.mockResolvedValue({
      data: [
        { attribute_id: 'attr-cancel', to_item_id: 'cancel-1' },
        servicePlanRef,
        { attribute_id: 'attr-service-plan', to_item_id: 'service-plan-item-2' },
      ],
    });
    getAttribute
      .mockResolvedValueOnce({ name: 'Cancellation Type' })
      .mockResolvedValueOnce({ name: 'Service Plan' })
      .mockResolvedValueOnce({ name: 'Service Plan' });
    await Item.create({
      workspaceId: '55369', boardId: 'first-board', folderId: 'f', itemId: 'service-plan-item-1', data: {},
    });
    await Item.create({
      workspaceId: '55369', boardId: 'second-board', folderId: 'f', itemId: 'service-plan-item-2', data: {},
    });
    expect(await getServicePlanBoardIdFromMasterPlan('55369', 'master-board', 'master-item')).toBe('first-board');
    expect(getAttribute).toHaveBeenCalledTimes(2);
  });

  it('returns null when there are no references at all', async () => {
    getReferences.mockResolvedValue(undefined);
    expect(await getServicePlanBoardIdFromMasterPlan('55369', 'master-board', 'master-item')).toBeNull();

    getReferences.mockResolvedValue({ data: [] });
    expect(await getServicePlanBoardIdFromMasterPlan('55369', 'master-board', 'master-item')).toBeNull();
  });
});

describe('masterPlanBoardUsesNewNdisPricing', () => {
  it('is false when no service plan board can be found', async () => {
    getReferences.mockResolvedValue({ data: [] });
    expect(await masterPlanBoardUsesNewNdisPricing('55369', 'master-board', 'master-item')).toBe(false);
    expect(getBoardAttributes).not.toHaveBeenCalled();
  });

  it('consults the service plan board, not the master plan board', async () => {
    const servicePlanBoard = freshBoard();
    getReferences.mockResolvedValue({ data: [{ attribute_id: 'a', to_item_id: 'sp-1' }] });
    getAttribute.mockResolvedValue({ name: 'Service Plan' });
    await Item.create({
      workspaceId: '55369', boardId: servicePlanBoard, folderId: 'f', itemId: 'sp-1', data: {},
    });
    getBoardAttributes.mockResolvedValue({ status: 200, attribute: newAttributes });

    expect(await masterPlanBoardUsesNewNdisPricing('55369', 'master-board', 'master-item')).toBe(true);
    expect(getBoardAttributes).toHaveBeenCalledWith('55369', servicePlanBoard);
  });

  it('is false when the service plan board is legacy', async () => {
    const servicePlanBoard = freshBoard();
    getReferences.mockResolvedValue({ data: [{ attribute_id: 'a', to_item_id: 'sp-2' }] });
    getAttribute.mockResolvedValue({ name: 'Service Plan' });
    await Item.create({
      workspaceId: '55369', boardId: servicePlanBoard, folderId: 'f', itemId: 'sp-2', data: {},
    });
    getBoardAttributes.mockResolvedValue({ status: 200, attribute: legacyAttributes });

    expect(await masterPlanBoardUsesNewNdisPricing('55369', 'master-board', 'master-item')).toBe(false);
  });
});

describe('isShiftCancelled', () => {
  it('reads Job Status', () => {
    expect(isShiftCancelled({ 'Job Status': 'Cancelled' })).toBe(true);
    expect(isShiftCancelled({ 'Job Status': 'cancelled' })).toBe(true);
    expect(isShiftCancelled({ 'Job Status': 'CANCELLED' })).toBe(true);
    expect(isShiftCancelled({ 'Job Status': 'Completed' })).toBe(false);
  });

  it('falls back to Shift Status when Job Status is absent or null', () => {
    expect(isShiftCancelled({ 'Shift Status': 'Cancelled' })).toBe(true);
    expect(isShiftCancelled({ 'Job Status': null, 'Shift Status': 'Cancelled' })).toBe(true);
    expect(isShiftCancelled({ 'Shift Status': 'Scheduled' })).toBe(false);
  });

  it('prefers Job Status over Shift Status when Job Status is set', () => {
    expect(isShiftCancelled({ 'Job Status': 'Completed', 'Shift Status': 'Cancelled' })).toBe(false);
  });

  it('scans a multi-select Job Status array', () => {
    expect(isShiftCancelled({ 'Job Status': ['Scheduled', 'Cancelled'] })).toBe(true);
    expect(isShiftCancelled({ 'Job Status': ['Scheduled', 'Completed'] })).toBe(false);
    expect(isShiftCancelled({ 'Job Status': [] })).toBe(false);
  });

  it('does not treat an empty-string Job Status as cancelled and still reports false for a missing status', () => {
    expect(isShiftCancelled({ 'Job Status': '' })).toBe(false);
    expect(isShiftCancelled({})).toBe(false);
    expect(isShiftCancelled(null)).toBe(false);
    expect(isShiftCancelled(undefined)).toBe(false);
  });
});
