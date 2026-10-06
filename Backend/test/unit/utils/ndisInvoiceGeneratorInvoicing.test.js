import { describe, it, expect, vi, beforeEach } from 'vitest';

// The only boundary mocked here is the ISO+ HTTP client. Everything else —
// Mongo, the Item model, the pricing-rule inference — is real.
vi.mock('../../../src/services/isoplus.js', () => ({
  getItemValues: vi.fn(),
  getBoardAttributes: vi.fn(),
  getReferences: vi.fn(),
  getAttribute: vi.fn(),
}));

const { getItemValues } = await import('../../../src/services/isoplus.js');
const {
  bulkFetchReferenceItemsFromDB,
  prepareParticipantForInvoiceGenerator,
  fetchParticipantProfileItemForMasterPlan,
  getNdisInvoiceGeneratorContextFromMasterItems,
} = await import('../../../src/utils/ndisInvoiceGeneratorInvoicing.js');
const { default: Item } = await import('../../../src/models/Item.js');

/*
 * ndisInvoiceGeneratorInvoicing.js assembles everything the NDIS invoice needs
 * from Mongo: the selected Master Plan items, every reference row they point at
 * (service plan, participant profile, cancellation type, allowances,
 * non-face-to-face, support catalogue), and the participant's billing details.
 *
 * The guards it raises are the safety rails on invoicing — unapproved
 * timesheets and multi-participant selections must not produce an invoice.
 *
 * Service plan fixtures always carry a 'Direct Support Item Number' or
 * 'Support Item Number' key so resolveNdisPricingRuleForServicePlan() infers the
 * rule locally instead of calling ISO+ for the board attributes.
 */

const WORKSPACE = '55369';
const BOARD = 'eNiJpH14PN3';
const OTHER_BOARD = 'zzOtherBoard';

const SP_ID = '11111111-1111-4111-8111-111111111111';
const PP_ID = '22222222-1111-4111-8111-222222222222';
const PP_ID_2 = '22222222-2222-4111-8111-222222222222';
const CT_ID = '33333333-1111-4111-8111-333333333333';
const ALLOWANCE_ID = '44444444-1111-4111-8111-444444444444';
const NF2F_ID = '55555555-1111-4111-8111-555555555555';
const SUPPORT_CAT_ID = '66666666-1111-4111-8111-666666666666';

let folderSeq = 0;
const createItem = (itemId, data, overrides = {}) => Item.create({
  workspaceId: WORKSPACE,
  boardId: BOARD,
  folderId: `folder-${folderSeq++}`,
  itemId,
  data,
  ...overrides,
});

const approvedMaster = (itemId, data = {}) => createItem(itemId, {
  'Timesheet Approval': 'Approved',
  'Service Plan': [{ id: SP_ID, name: 'Service Plan A' }],
  'Participant Profile': [{ id: PP_ID, name: 'Samuel Rivers' }],
  ...data,
});

const servicePlanItem = () => createItem(SP_ID, {
  'Direct Support Item Number': [{ id: SUPPORT_CAT_ID, name: 'Assistance' }],
  'Unit (Direct Support)': 'Hour(H)',
  'Agreed Unit Price for Direct Support ($)': '70.00',
});

const participantProfile = (id = PP_ID, data = {}) => createItem(id, {
  'Full Name/Preferred Name': 'Samuel Rivers',
  'NDIS Number': '430123456',
  'Billing Contact': 'Rivers Family Trust',
  'Billing Email': 'accounts@example.com',
  ...data,
});

beforeEach(() => {
  vi.mocked(getItemValues).mockReset();
});

describe('bulkFetchReferenceItemsFromDB', () => {
  it('returns an empty map for no ids, without querying', async () => {
    await expect(bulkFetchReferenceItemsFromDB(WORKSPACE, BOARD, [])).resolves.toEqual(new Map());
    await expect(bulkFetchReferenceItemsFromDB(WORKSPACE, BOARD, null)).resolves.toEqual(new Map());
    await expect(bulkFetchReferenceItemsFromDB(WORKSPACE, BOARD, [null, '', undefined])).resolves.toEqual(new Map());
  });

  // Breaks if the map stops being keyed by itemId — every caller looks refs up
  // by the id it extracted from the master plan.
  it('keys the found items by itemId and omits ids that do not exist', async () => {
    await createItem(SP_ID, { Name: 'Service Plan A' });

    const map = await bulkFetchReferenceItemsFromDB(WORKSPACE, BOARD, [SP_ID, PP_ID]);

    expect([...map.keys()]).toEqual([SP_ID]);
    expect(map.get(SP_ID).data).toEqual({ Name: 'Service Plan A' });
  });

  // Breaks if the cross-board fallback goes: participant profiles and support
  // catalogue rows normally live on a different board from the master plan.
  it('falls back to a workspace-wide lookup for ids missing from the board', async () => {
    await createItem(SP_ID, { Name: 'Same board' });
    await createItem(PP_ID, { Name: 'Other board' }, { boardId: OTHER_BOARD });

    const map = await bulkFetchReferenceItemsFromDB(WORKSPACE, BOARD, [SP_ID, PP_ID]);

    expect(map.get(SP_ID).boardId).toBe(BOARD);
    expect(map.get(PP_ID).boardId).toBe(OTHER_BOARD);
  });

  // Breaks if the workspace filter is dropped, which would leak another
  // customer's data onto an invoice.
  it('never crosses the workspace boundary', async () => {
    await createItem(PP_ID, { Name: 'Other workspace' }, { workspaceId: '99999', boardId: OTHER_BOARD });

    await expect(bulkFetchReferenceItemsFromDB(WORKSPACE, BOARD, [PP_ID])).resolves.toEqual(new Map());
  });

  // Breaks if the dedupe/stringify step goes: numeric ids and repeats would
  // produce duplicate keys or miss the map lookup entirely.
  it('deduplicates and stringifies the requested ids', async () => {
    await createItem('4321', { Name: 'Numeric id' });

    const map = await bulkFetchReferenceItemsFromDB(WORKSPACE, BOARD, [4321, '4321', 4321]);

    expect(map.size).toBe(1);
    expect(map.get('4321').data).toEqual({ Name: 'Numeric id' });
  });
});

describe('prepareParticipantForInvoiceGenerator', () => {
  const profileItem = (data) => ({
    itemId: PP_ID,
    boardId: OTHER_BOARD,
    data,
    updatedAt: new Date('2026-02-01T00:00:00.000Z'),
  });

  // Breaks if a billing field is renamed: these land on the invoice PDF and on
  // the Xero contact.
  it('reads the billing fields off the profile without hitting ISO+', async () => {
    const item = profileItem({
      'Full Name/Preferred Name': 'Samuel Rivers',
      'NDIS Number': '430123456',
      'Billing Contact': 'Rivers Family Trust',
      'Billing Email': 'accounts@example.com',
      'Billing Address': '1 Fixture Street, Testville NSW 2000',
      Address: '1 Fixture Street',
      Suburb: 'Testville',
      State: 'NSW',
      Postcode: '2000',
    });

    const result = await prepareParticipantForInvoiceGenerator({
      workspaceId: WORKSPACE,
      boardId: BOARD,
      participantProfileItem: item,
    });

    expect(getItemValues).not.toHaveBeenCalled();
    expect(result.participantName).toBe('Samuel Rivers');
    expect(result.billingContact).toBe('Rivers Family Trust');
    expect(result.participantProfile).toMatchObject({
      displayName: 'Samuel Rivers',
      fullName: 'Samuel Rivers',
      firstName: 'Samuel',
      lastName: 'Rivers',
      billingContact: 'Rivers Family Trust',
      billingEmail: 'accounts@example.com',
      billingAddress: '1 Fixture Street, Testville NSW 2000',
      address: '1 Fixture Street',
      suburb: 'Testville',
      state: 'NSW',
      postcode: '2000',
    });
  });

  // Breaks on a changed split: a two-word name splits after the first word, so
  // "Mary Anne Van Der Berg" keeps everything after "Mary" as the surname.
  it('splits a full name into first and last, keeping the whole remainder', async () => {
    const result = await prepareParticipantForInvoiceGenerator({
      workspaceId: WORKSPACE,
      boardId: BOARD,
      participantProfileItem: profileItem({
        'Full Name/Preferred Name': 'Mary Anne Van Der Berg',
        'NDIS Number': '430123456',
      }),
    });

    expect(result.participantProfile.firstName).toBe('Mary');
    expect(result.participantProfile.lastName).toBe('Anne Van Der Berg');
  });

  // Breaks if the single-word case stops duplicating: Xero requires both a
  // first and a last name on a contact.
  it('uses a single-word name for both first and last name', async () => {
    const result = await prepareParticipantForInvoiceGenerator({
      workspaceId: WORKSPACE,
      boardId: BOARD,
      participantProfileItem: profileItem({ 'Full Name/Preferred Name': 'Cher', 'NDIS Number': '430123456' }),
    });

    expect(result.participantProfile.firstName).toBe('Cher');
    expect(result.participantProfile.lastName).toBe('Cher');
  });

  // Breaks if the explicit columns stop winning over the parsed full name.
  it('prefers explicit First/Last Name columns over parsing the full name', async () => {
    const result = await prepareParticipantForInvoiceGenerator({
      workspaceId: WORKSPACE,
      boardId: BOARD,
      participantProfileItem: profileItem({
        'Full Name/Preferred Name': 'Samuel Rivers',
        'First Name': 'Sam',
        'Last Name': 'Riverside',
        'NDIS Number': '430123456',
      }),
    });

    expect(result.participantProfile.firstName).toBe('Sam');
    expect(result.participantProfile.lastName).toBe('Riverside');
  });

  // Breaks if hydration stops firing: a profile stored without an NDIS number
  // would be invoiced without one, which voids the claim.
  it('hydrates from ISO+ when the profile has no NDIS number, and merges the values', async () => {
    vi.mocked(getItemValues).mockResolvedValue({
      values: [
        { attribute: { name: 'NDIS Number' }, data: '430999888' },
        { attribute: { name: 'Suburb' }, data: 'Testville' },
        { attribute: { name: 'Ignored' }, data: null },
        { data: 'no attribute' },
      ],
    });

    const result = await prepareParticipantForInvoiceGenerator({
      workspaceId: WORKSPACE,
      boardId: BOARD,
      participantProfileItem: profileItem({ 'Full Name/Preferred Name': 'Samuel Rivers' }),
    });

    // The profile item's own boardId wins over the master plan board.
    expect(getItemValues).toHaveBeenCalledWith(WORKSPACE, OTHER_BOARD, PP_ID);
    expect(result.participantProfileItem.data).toEqual({
      'Full Name/Preferred Name': 'Samuel Rivers',
      'NDIS Number': '430999888',
      Suburb: 'Testville',
    });
    expect(result.participantProfile.suburb).toBe('Testville');
  });

  // Breaks if the hydration failure stops being swallowed: an ISO+ outage would
  // abort the whole invoice run instead of degrading to stored data.
  it('keeps the stored profile when the ISO+ call fails or returns nothing', async () => {
    vi.mocked(getItemValues).mockRejectedValueOnce(new Error('socket hang up'));
    const item = profileItem({ 'Full Name/Preferred Name': 'Samuel Rivers' });

    const failed = await prepareParticipantForInvoiceGenerator({
      workspaceId: WORKSPACE, boardId: BOARD, participantProfileItem: item,
    });
    expect(failed.participantProfileItem).toBe(item);
    expect(failed.participantName).toBe('Samuel Rivers');

    vi.mocked(getItemValues).mockResolvedValueOnce({ values: [] });
    const empty = await prepareParticipantForInvoiceGenerator({
      workspaceId: WORKSPACE, boardId: BOARD, participantProfileItem: item,
    });
    expect(empty.participantProfileItem).toBe(item);
  });

  // Breaks if the fallback name stops taking precedence: the caller passes the
  // name shown on the invoice-generator row, which the user has already seen.
  it('lets the caller-supplied name outrank the profile name', async () => {
    vi.mocked(getItemValues).mockResolvedValue({ values: [] });

    const result = await prepareParticipantForInvoiceGenerator({
      workspaceId: WORKSPACE,
      boardId: BOARD,
      participantProfileItem: profileItem({
        'Full Name/Preferred Name': 'Samuel Rivers',
        'NDIS Number': '430123456',
      }),
      fallbackParticipantName: '  Sam Rivers  ',
    });

    expect(result.participantName).toBe('Sam Rivers');
    // billingContact still prefers the profile's own Billing Contact, then the
    // full name, before falling back to the participant name.
    expect(result.billingContact).toBe('Samuel Rivers');
  });

  // Breaks if the billing-contact chain reorders — the invoice is addressed to
  // whichever of these resolves first.
  it('falls back through billing contact, full name, display name, participant name', async () => {
    vi.mocked(getItemValues).mockResolvedValue({ values: [] });

    const onlyPreferred = await prepareParticipantForInvoiceGenerator({
      workspaceId: WORKSPACE,
      boardId: BOARD,
      participantProfileItem: profileItem({ 'Preferred Name': 'Sam', 'NDIS Number': '430123456' }),
    });
    expect(onlyPreferred.billingContact).toBe('Sam');

    const nothing = await prepareParticipantForInvoiceGenerator({
      workspaceId: WORKSPACE,
      boardId: BOARD,
      participantProfileItem: profileItem({ 'NDIS Number': '430123456' }),
      fallbackParticipantName: 'Row Name',
    });
    expect(nothing.billingContact).toBe('Row Name');
  });

  it('survives a null profile item', async () => {
    const result = await prepareParticipantForInvoiceGenerator({
      workspaceId: WORKSPACE,
      boardId: BOARD,
      participantProfileItem: null,
    });

    expect(getItemValues).not.toHaveBeenCalled();
    expect(result.participantName).toBe('');
    expect(result.billingContact).toBe('');
    expect(result.participantProfileItem).toBeNull();
  });
});

describe('fetchParticipantProfileItemForMasterPlan', () => {
  // Breaks if the profile lookup stops being workspace-wide: profiles live on a
  // different board from the master plan.
  it('follows the Participant Profile reference across boards', async () => {
    await approvedMaster('mp-1');
    await participantProfile(PP_ID);
    await Item.updateOne({ itemId: PP_ID }, { boardId: OTHER_BOARD });

    const profile = await fetchParticipantProfileItemForMasterPlan(WORKSPACE, BOARD, 'mp-1');

    expect(profile.itemId).toBe(PP_ID);
    expect(profile.data['NDIS Number']).toBe('430123456');
  });

  it('returns null when the master plan is missing or carries no reference', async () => {
    await expect(fetchParticipantProfileItemForMasterPlan(WORKSPACE, BOARD, 'nope')).resolves.toBeNull();

    await createItem('mp-2', { 'Timesheet Approval': 'Approved' });
    await expect(fetchParticipantProfileItemForMasterPlan(WORKSPACE, BOARD, 'mp-2')).resolves.toBeNull();
  });

  // Breaks if the reference is resolved but the row does not exist — the caller
  // must get null rather than a rejected query.
  it('returns null when the referenced profile row does not exist', async () => {
    await approvedMaster('mp-3');

    await expect(fetchParticipantProfileItemForMasterPlan(WORKSPACE, BOARD, 'mp-3')).resolves.toBeNull();
  });
});

describe('getNdisInvoiceGeneratorContextFromMasterItems', () => {
  const context = (masterItemIds) => getNdisInvoiceGeneratorContextFromMasterItems({
    workspaceId: WORKSPACE, boardId: BOARD, masterItemIds,
  });

  it('refuses an empty selection', async () => {
    await expect(context([])).rejects.toThrow('No items provided for invoice generation.');
    await expect(context(null)).rejects.toThrow('No items provided for invoice generation.');
    await expect(context([null, ''])).rejects.toThrow('No items provided for invoice generation.');
  });

  // Breaks if a missing item is silently skipped: the user would get an invoice
  // for fewer shifts than they selected.
  it('names the ids it could not find, capped at five', async () => {
    await approvedMaster('mp-1');

    await expect(context(['mp-1', 'ghost-1'])).rejects.toThrow('Some items were not found: ghost-1');
    await expect(context(['g1', 'g2', 'g3', 'g4', 'g5', 'g6']))
      .rejects.toThrow('Some items were not found: g1, g2, g3, g4, g5...');
  });

  // Breaks if the approval gate goes. This is the guard that stops an
  // unapproved timesheet being invoiced.
  it('refuses any item whose timesheet is not Approved', async () => {
    await approvedMaster('mp-1');
    await approvedMaster('mp-2', { 'Timesheet Approval': 'Pending' });
    await approvedMaster('mp-3', { 'Timesheet Approval': undefined });

    await expect(context(['mp-1', 'mp-2', 'mp-3']))
      .rejects.toThrow('Some items are not Timesheet Approved and cannot be invoiced (2).');
  });

  // Breaks if the approval comparison becomes case- or whitespace-sensitive, or
  // stops reading a label-shaped value.
  it('accepts an approval label in any case and any reference shape', async () => {
    await servicePlanItem();
    await participantProfile();
    await approvedMaster('mp-1', { 'Timesheet Approval': '  approved ' });
    await approvedMaster('mp-2', { 'Timesheet Approval': [{ id: 'l1', name: 'Approved' }] });

    const result = await context(['mp-1', 'mp-2']);
    expect(result.masterItems).toHaveLength(2);
  });

  // Breaks if the single-participant rule goes: one invoice covers exactly one
  // participant, and mixing two would bill the wrong person.
  it('refuses a selection spanning more than one participant', async () => {
    await approvedMaster('mp-1');
    await approvedMaster('mp-2', { 'Participant Profile': [{ id: PP_ID_2, name: 'Other' }] });

    await expect(context(['mp-1', 'mp-2']))
      .rejects.toThrow('Please select items for one participant only (multiple participant profiles detected).');
  });

  it('refuses a selection with no participant profile at all', async () => {
    await approvedMaster('mp-1', { 'Participant Profile': undefined });

    await expect(context(['mp-1']))
      .rejects.toThrow('Please select items for one participant only (multiple participant profiles detected).');
  });

  // Breaks if the missing-profile case is allowed through: the invoice needs
  // the NDIS number and the billing address off that row.
  it('refuses when the referenced participant profile row is absent', async () => {
    await approvedMaster('mp-1');

    await expect(context(['mp-1']))
      .rejects.toThrow('Participant Profile information is required but was not found.');
  });

  // Breaks if a reference set is dropped from the bulk fetch — the row builders
  // would then find no catalogue item and produce an unnumbered invoice line.
  it('returns the master items, the profile and every referenced row', async () => {
    await servicePlanItem();
    await participantProfile();
    await createItem(CT_ID, { Name: 'Short Notice Cancellation' });
    await createItem(ALLOWANCE_ID, { Name: 'Sleepover' });
    await createItem(NF2F_ID, { Name: 'Report writing' });
    await createItem(SUPPORT_CAT_ID, { 'Support Item Number': '01_011_0107_1_1' }, { boardId: OTHER_BOARD });
    await approvedMaster('mp-1', {
      'Cancellation Type': [{ id: CT_ID }],
      Allowances: [{ id: ALLOWANCE_ID }],
      'Non-Face-to-Face Supports': [{ id: NF2F_ID }],
    });

    const result = await getNdisInvoiceGeneratorContextFromMasterItems({
      workspaceId: WORKSPACE, boardId: BOARD, masterItemIds: ['mp-1', 'mp-1'],
    });

    expect(result.masterItems).toHaveLength(1);
    expect(result.participantProfileItem.itemId).toBe(PP_ID);
    expect([...result.refItemsMap.keys()].sort()).toEqual(
      [SP_ID, PP_ID, CT_ID, ALLOWANCE_ID, NF2F_ID, SUPPORT_CAT_ID].sort(),
    );
    // The support catalogue row is reached through the service plan, on another
    // board, which only the cross-board fallback finds.
    expect(result.refItemsMap.get(SUPPORT_CAT_ID).boardId).toBe(OTHER_BOARD);
  });

  // Breaks if the label resolution goes: the invoice line would read
  // "44444444-1111-..." instead of "Sleepover".
  it('replaces allowance and non-face-to-face reference ids with their names', async () => {
    await servicePlanItem();
    await participantProfile();
    await createItem(ALLOWANCE_ID, { Name: 'Sleepover' });
    await createItem(NF2F_ID, { Definition: 'Report writing' });
    await approvedMaster('mp-1', {
      Allowances: [{ id: ALLOWANCE_ID }],
      'Non-Face-to-Face Supports': [{ id: NF2F_ID }],
    });

    const { masterItems } = await context(['mp-1']);

    expect(masterItems[0].data.Allowances).toBe('Sleepover');
    expect(masterItems[0].data['Non-Face-to-Face Supports']).toBe('Report writing');
  });

  // Breaks if an unresolvable reference starts blanking the stored value: the
  // original text is the only thing left to print.
  it('keeps the original value when the reference cannot be resolved', async () => {
    await servicePlanItem();
    await participantProfile();
    await approvedMaster('mp-1', { Allowances: 'Sleepover (free text)' });

    const { masterItems } = await context(['mp-1']);

    expect(masterItems[0].data.Allowances).toBe('Sleepover (free text)');
  });

  // Breaks if the normalization starts copying items that need no change —
  // the untouched item must be returned by reference.
  it('leaves an item untouched when it has neither allowances nor NF2F', async () => {
    await servicePlanItem();
    await participantProfile();
    await approvedMaster('mp-1');

    const { masterItems } = await context(['mp-1']);

    expect(masterItems[0].data.Allowances).toBeUndefined();
    expect(masterItems[0].data['Non-Face-to-Face Supports']).toBeUndefined();
  });
});
