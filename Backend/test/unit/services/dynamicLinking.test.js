import { describe, it, expect } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../msw/server.js';
import DynamicLinkingService from '../../../src/services/dynamicLinking.js';

// DynamicLinkingService rewrites {{ label > board > item }} templates in ISO+
// item text and automation workflows into real anchors. With update=true it
// writes back to ISO+, so the tests below assert the requests it issues — the
// PUT body is the contract that matters, not the in-memory bookkeeping.

const WS = '55369';
const HOST = 'https://iso.test';
const ISO = 'https://app.isoplus.online';

let tokenCounter = 0;
// getBoard/getAllViews memoize on the authorization token for 30s, so each test
// gets its own token; sharing one would serve a previous test's boards.
const freshToken = () => `tok_${++tokenCounter}`;

const itemValue = (attributeId, data) => ({
  id: `val_${attributeId}`,
  attribute_id: attributeId,
  data,
});

const boardItem = (id, folderId, values) => ({
  id,
  folder_id: folderId,
  row_version: 2,
  created_at: '2026-08-01T00:00:00.000Z',
  values,
});

/**
 * Stub every endpoint the service touches. Board/view/automation reads go to
 * app.isoplus.online (hard-coded in services/isoplus.js); item reads and writes
 * go to the host the service was constructed with.
 */
function stubIsoPlus({ boards = [], views = {}, items = {}, automations = {}, itemsStatus = null }) {
  const captured = { itemPuts: [], automationPuts: [], itemGets: [] };
  server.use(
    http.get(`${ISO}/api/v2/workspaces/:ws/boards`, ({ request }) => {
      captured.boardsAuthorization = request.headers.get('authorization');
      return HttpResponse.json({ data: boards, has_more: false });
    }),
    http.get(`${ISO}/api/v2/workspaces/:ws/boards/:boardId/views`, ({ params }) =>
      HttpResponse.json({ data: views[params.boardId] ?? [], has_more: false })
    ),
    http.get(`${ISO}/api/:ws/automations/:automationId`, ({ params }) =>
      HttpResponse.json(automations[params.automationId] ?? [])
    ),
    http.put(`${ISO}/api/:ws/automations/:automationId`, async ({ params, request }) => {
      captured.automationPuts.push({ url: request.url, automationId: params.automationId, body: await request.json() });
      return HttpResponse.json({ ok: true });
    }),
    http.get(`${HOST}/api/v2/workspaces/:ws/boards/:boardId/items`, ({ params, request }) => {
      captured.itemGets.push(request.url);
      if (itemsStatus) return new HttpResponse(null, { status: itemsStatus });
      return HttpResponse.json({ data: items[params.boardId] ?? [], has_more: false });
    }),
    http.put(`${HOST}/api/v2/workspaces/:ws/boards/:boardId/items/:itemId`, async ({ params, request }) => {
      captured.itemPuts.push({ url: request.url, itemId: params.itemId, body: await request.json() });
      return HttpResponse.json({ ok: true });
    }),
  );
  return captured;
}

describe('DynamicLinkingService constructor', () => {
  it.each([[undefined], [null], [''], [42], [{ token: 'x' }]])(
    'rejects authorization %p',
    (authorization) => {
      expect(() => new DynamicLinkingService(authorization, HOST))
        .toThrow('Invalid authorization parameter. Expected a string authorization token.');
    }
  );

  it.each([[undefined], [null], [''], [8080]])('rejects host %p', (host) => {
    expect(() => new DynamicLinkingService('tok', host))
      .toThrow('Invalid host parameter. Expected a string host URL.');
  });

  it('drops one trailing slash from the host so self links are not doubled', () => {
    expect(new DynamicLinkingService('tok', 'https://iso.test/').host).toBe('https://iso.test');
    expect(new DynamicLinkingService('tok', 'https://iso.test').host).toBe('https://iso.test');
  });

  it('adds the Bearer prefix once, and keeps one already present', () => {
    expect(new DynamicLinkingService('raw_token', HOST).authorization).toBe('Bearer raw_token');
    expect(new DynamicLinkingService('Bearer raw_token', HOST).authorization).toBe('Bearer raw_token');
  });
});

describe('DynamicLinkingService.main workspace validation', () => {
  it.each([
    ['https://app.isoplus.online/55369', 'path traversal sequences are not allowed'],
    ['../55369', 'path traversal sequences are not allowed'],
    ['', 'expected a non-empty string'],
  ])('rejects workspaceId %p', async (workspaceId, message) => {
    const service = new DynamicLinkingService(freshToken(), HOST);
    await expect(service.main(workspaceId, false)).rejects.toThrow(message);
  });

  it('rejects a workspaceId that survives sanitizing but still looks like a URL', async () => {
    // sanitizeApiPathSegment strips anything with a slash or dot first, so this
    // second guard only fires for the odd residue like "http55369".
    const service = new DynamicLinkingService(freshToken(), HOST);
    await expect(service.main('http55369', false))
      .rejects.toThrow('Invalid workspaceId: "http55369". Expected a workspace ID, not a full URL.');
  });
});

describe('DynamicLinkingService.main item links', () => {
  const linkTemplate = '{{Open the file > Client Board > Acme Pty Ltd}}';

  const boardWithLink = () => ({
    boards: [{ id: 'brd_1', name: 'Client Board' }],
    views: { brd_1: [] },
    items: {
      brd_1: [
        boardItem('itm_a', 'fld_1', [itemValue('attr_notes', `See ${linkTemplate} for details.`)]),
        boardItem('itm_b', 'fld_2', [itemValue('attr_name', 'Acme Pty Ltd')]),
      ],
    },
    automations: { brd_1: [] },
  });

  it('resolves a template to the target item and writes it back when update is true', async () => {
    const captured = stubIsoPlus(boardWithLink());
    const service = new DynamicLinkingService(freshToken(), HOST);

    const result = await service.main(WS, true);

    expect(captured.itemPuts).toHaveLength(1);
    expect(captured.itemPuts[0].url).toBe(`${HOST}/api/v2/workspaces/55369/boards/brd_1/items/itm_a`);
    expect(captured.itemPuts[0].body).toEqual({
      values: [{
        attribute_id: 'attr_notes',
        data: 'See <a href="https://iso.test/b/brd_1/fld_2/itm_b">Open the file</a> for details.',
      }],
    });

    expect(result).toEqual([{
      link: {
        label: 'Open the file',
        targetBoardName: 'Client Board',
        targetName: 'Acme Pty Ltd',
        originalMatch: linkTemplate,
      },
      originItem: 'https://iso.test/b/brd_1/fld_1/itm_a',
      originalMatch: linkTemplate,
    }]);
  });

  it('reports the link but writes nothing when update is false', async () => {
    const captured = stubIsoPlus(boardWithLink());
    const service = new DynamicLinkingService(freshToken(), HOST);

    const result = await service.main(WS, false);

    expect(result.map((r) => r.originalMatch)).toEqual([linkTemplate]);
    expect(captured.itemPuts).toEqual([]);
  });

  it('sends the board read with the Bearer authorization it was constructed with', async () => {
    const captured = stubIsoPlus(boardWithLink());
    const token = freshToken();

    await new DynamicLinkingService(token, HOST).main(WS, false);

    expect(captured.boardsAuthorization).toBe(`Bearer ${token}`);
  });

  it('requests board items expanded, newest first, in pages of 50', async () => {
    const captured = stubIsoPlus(boardWithLink());

    await new DynamicLinkingService(freshToken(), HOST).main(WS, false);

    const url = new URL(captured.itemGets[0]);
    expect(url.pathname).toBe('/api/v2/workspaces/55369/boards/brd_1/items');
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('sort_by')).toBe('created_at');
    expect(url.searchParams.get('sort_direction')).toBe('desc');
    expect(url.searchParams.get('expand[]')).toBe('values');
  });

  it('creates nothing when no destination carries the target name', async () => {
    const captured = stubIsoPlus({
      boards: [{ id: 'brd_1', name: 'Client Board' }],
      views: { brd_1: [] },
      items: {
        brd_1: [boardItem('itm_a', 'fld_1', [itemValue('attr_notes', `See ${linkTemplate}.`)])],
      },
      automations: { brd_1: [] },
    });

    const result = await new DynamicLinkingService(freshToken(), HOST).main(WS, true);

    expect(result).toEqual([]);
    expect(captured.itemPuts).toEqual([]);
  });

  it('does not match a destination of the same name on a different board', async () => {
    // boardName is half the key on purpose: two boards routinely hold items
    // with the same primary value, and linking to the wrong one is silent.
    const captured = stubIsoPlus({
      boards: [
        { id: 'brd_1', name: 'Client Board' },
        { id: 'brd_2', name: 'Supplier Board' },
      ],
      views: { brd_1: [], brd_2: [] },
      items: {
        brd_1: [boardItem('itm_a', 'fld_1', [itemValue('attr_notes', `See ${linkTemplate}.`)])],
        brd_2: [boardItem('itm_z', 'fld_9', [itemValue('attr_name', 'Acme Pty Ltd')])],
      },
      automations: { brd_1: [], brd_2: [] },
    });

    const result = await new DynamicLinkingService(freshToken(), HOST).main(WS, true);

    expect(result).toEqual([]);
    expect(captured.itemPuts).toEqual([]);
  });

  it('links to a board view, and to the public form url of an enabled form view', async () => {
    const captured = stubIsoPlus({
      boards: [{ id: 'brd_1', name: 'Client Board' }],
      views: {
        brd_1: [
          { id: 'vw_1', name: 'All Clients', folder_id: 'fld_1', type: 'table' },
          {
            id: 'vw_2',
            name: 'Intake',
            folder_id: 'fld_1',
            type: 'form',
            settings: { formSettings: { enabled: true } },
          },
        ],
      },
      items: {
        brd_1: [
          boardItem('itm_a', 'fld_1', [
            itemValue('attr_notes', '{{Everyone > Client Board > All Clients}}'),
            itemValue('attr_more', '{{Apply > Client Board > public Intake}}'),
          ]),
        ],
      },
      automations: { brd_1: [] },
    });

    await new DynamicLinkingService(freshToken(), HOST).main(WS, true);

    const bodies = captured.itemPuts.map((p) => p.body.values[0]);
    expect(bodies).toContainEqual({
      attribute_id: 'attr_notes',
      data: '<a href="https://iso.test/b/brd_1/fld_1?view=vw_1">Everyone</a>',
    });
    expect(bodies).toContainEqual({
      attribute_id: 'attr_more',
      data: '<a href="https://iso.test/form/vw_2">Apply</a>',
    });
  });

  it('does not publish a form view whose public form is disabled', async () => {
    const captured = stubIsoPlus({
      boards: [{ id: 'brd_1', name: 'Client Board' }],
      views: {
        brd_1: [{
          id: 'vw_2',
          name: 'Intake',
          folder_id: 'fld_1',
          type: 'form',
          settings: { formSettings: { enabled: false } },
        }],
      },
      items: {
        brd_1: [boardItem('itm_a', 'fld_1', [itemValue('attr_notes', '{{Apply > Client Board > public Intake}}')])],
      },
      automations: { brd_1: [] },
    });

    const result = await new DynamicLinkingService(freshToken(), HOST).main(WS, true);

    expect(result).toEqual([]);
    expect(captured.itemPuts).toEqual([]);
  });

  it('ignores non-string values instead of treating them as link text', async () => {
    const captured = stubIsoPlus({
      boards: [{ id: 'brd_1', name: 'Client Board' }],
      views: { brd_1: [] },
      items: {
        brd_1: [
          boardItem('itm_a', 'fld_1', [
            itemValue('attr_count', 42),
            itemValue('attr_refs', ['itm_b']),
            itemValue('attr_notes', `See ${linkTemplate}.`),
          ]),
          boardItem('itm_b', 'fld_2', [itemValue('attr_name', 'Acme Pty Ltd')]),
        ],
      },
      automations: { brd_1: [] },
    });

    await new DynamicLinkingService(freshToken(), HOST).main(WS, true);

    expect(captured.itemPuts).toHaveLength(1);
    expect(captured.itemPuts[0].body.values[0].attribute_id).toBe('attr_notes');
  });
});

describe('DynamicLinkingService.main automation links', () => {
  const automationWith = (config) => ({
    id: 'aut_1',
    name: 'Notify the client',
    active: true,
    board_id: 'brd_1',
    workflow: [{ id: 'step_1', type: 'send_email', config }],
  });

  const withAutomation = (automation) => ({
    boards: [{ id: 'brd_1', name: 'Client Board' }],
    views: { brd_1: [] },
    items: { brd_1: [boardItem('itm_b', 'fld_2', [itemValue('attr_name', 'Acme Pty Ltd')])] },
    automations: { brd_1: [automation], aut_1: [automation] },
  });

  it('rewrites a workflow text step and PUTs the whole automation back', async () => {
    const captured = stubIsoPlus(
      withAutomation(automationWith({ text: 'Hello {{Open > Client Board > Acme Pty Ltd}}' }))
    );

    const result = await new DynamicLinkingService(freshToken(), HOST).main(WS, true);

    expect(result).toEqual([{
      link: {
        label: 'Open',
        targetBoardName: 'Client Board',
        targetName: 'Acme Pty Ltd',
        originalMatch: '{{Open > Client Board > Acme Pty Ltd}}',
      },
      originItem: 'https://iso.test/b/brd_1/?automations=true&t=manage&aid=aut_1',
      originalMatch: '{{Open > Client Board > Acme Pty Ltd}}',
    }]);

    await expect.poll(() => captured.automationPuts.length).toBe(1);
    expect(captured.automationPuts[0].url).toBe(`${ISO}/api/55369/automations/aut_1`);
    expect(captured.automationPuts[0].body).toEqual({
      name: 'Notify the client',
      active: true,
      board_id: 'brd_1',
      workflow: [{
        id: 'step_1',
        type: 'send_email',
        config: { text: 'Hello <a href="https://iso.test/b/brd_1/fld_2/itm_b">Open</a>' },
      }],
    });
  });

  it('rewrites a templateItemValues step', async () => {
    const captured = stubIsoPlus(
      withAutomation(automationWith({
        templateItemValues: [
          { attribute_id: 'attr_body', data: 'Ref {{Open > Client Board > Acme Pty Ltd}}' },
          { attribute_id: 'attr_other', data: 'nothing to link' },
        ],
      }))
    );

    await new DynamicLinkingService(freshToken(), HOST).main(WS, true);

    await expect.poll(() => captured.automationPuts.length).toBe(1);
    expect(captured.automationPuts[0].body.workflow[0].config.templateItemValues).toEqual([
      { attribute_id: 'attr_body', data: 'Ref <a href="https://iso.test/b/brd_1/fld_2/itm_b">Open</a>' },
      { attribute_id: 'attr_other', data: 'nothing to link' },
    ]);
  });

  it('leaves the automation untouched when update is false', async () => {
    const captured = stubIsoPlus(
      withAutomation(automationWith({ text: 'Hello {{Open > Client Board > Acme Pty Ltd}}' }))
    );

    const result = await new DynamicLinkingService(freshToken(), HOST).main(WS, false);

    expect(result).toHaveLength(1);
    expect(captured.automationPuts).toEqual([]);
  });

  it('does not write an automation whose link target does not exist', async () => {
    const captured = stubIsoPlus(
      withAutomation(automationWith({ text: 'Hello {{Open > Client Board > Nobody Ltd}}' }))
    );

    const result = await new DynamicLinkingService(freshToken(), HOST).main(WS, true);

    expect(result).toEqual([]);
    expect(captured.automationPuts).toEqual([]);
  });
});

describe('DynamicLinkingService.main failure handling', () => {
  it('rethrows when the workspace boards cannot be listed', async () => {
    // getBoard swallows the HTTP failure and returns {status:500} with no
    // `board` key, so main dies reading .length rather than on the real cause.
    server.use(
      http.get(`${ISO}/api/v2/workspaces/:ws/boards`, () => new HttpResponse(null, { status: 500 }))
    );

    await expect(new DynamicLinkingService(freshToken(), HOST).main(WS, false))
      .rejects.toThrow("Cannot read properties of undefined (reading 'length')");
  });

  it('skips a board whose views cannot be listed, without failing the run', async () => {
    stubIsoPlus({
      boards: [{ id: 'brd_1', name: 'Client Board' }, { id: 'brd_2', name: 'Supplier Board' }],
      views: { brd_2: [] },
      items: {
        brd_2: [
          boardItem('itm_a', 'fld_1', [itemValue('attr_notes', '{{Open > Supplier Board > Acme Pty Ltd}}')]),
          boardItem('itm_b', 'fld_2', [itemValue('attr_name', 'Acme Pty Ltd')]),
        ],
      },
      automations: { brd_2: [] },
    });
    server.use(
      http.get(`${ISO}/api/v2/workspaces/:ws/boards/brd_1/views`, () => new HttpResponse(null, { status: 500 }))
    );

    const result = await new DynamicLinkingService(freshToken(), HOST).main(WS, false);

    expect(result.map((r) => r.originItem)).toEqual(['https://iso.test/b/brd_2/fld_1/itm_a']);
  });

  it('skips a board whose items cannot be fetched', async () => {
    stubIsoPlus({
      boards: [{ id: 'brd_1', name: 'Client Board' }],
      views: { brd_1: [] },
      itemsStatus: 404,
    });

    await expect(new DynamicLinkingService(freshToken(), HOST).main(WS, false)).resolves.toEqual([]);
  });

  it('keeps the item links already collected when the automations call fails', async () => {
    const captured = stubIsoPlus({
      boards: [{ id: 'brd_1', name: 'Client Board' }],
      views: { brd_1: [] },
      items: {
        brd_1: [
          boardItem('itm_a', 'fld_1', [itemValue('attr_notes', '{{Open > Client Board > Acme Pty Ltd}}')]),
          boardItem('itm_b', 'fld_2', [itemValue('attr_name', 'Acme Pty Ltd')]),
        ],
      },
    });
    server.use(
      http.get(`${ISO}/api/:ws/automations/:automationId`, () => new HttpResponse(null, { status: 500 }))
    );

    const result = await new DynamicLinkingService(freshToken(), HOST).main(WS, true);

    expect(result.map((r) => r.originalMatch)).toEqual(['{{Open > Client Board > Acme Pty Ltd}}']);
    expect(captured.itemPuts).toHaveLength(1);
  });

  it('reports no links for a workspace with no boards', async () => {
    stubIsoPlus({ boards: [] });

    await expect(new DynamicLinkingService(freshToken(), HOST).main(WS, false)).resolves.toEqual([]);
  });
});
