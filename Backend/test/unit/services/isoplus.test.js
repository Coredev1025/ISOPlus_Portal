import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../msw/server.js';
import Board from '../../../src/models/Board.js';
import {
  ITEM_DELETED,
  getWorkspacePage,
  getBoardPage,
  getMemberRole,
  getFolder,
  getItem,
  getItemValues,
  validateItemBelongsToTenant,
  getReferences,
  getAttribute,
  getBoardAttributes,
  setIntegrationMessage,
  setPDFLinkAttribute,
  setGeneratedField,
  getAutomation,
  getMyWorkspace,
  listWorkspacesForAuthorization,
} from '../../../src/services/isoplus.js';

/**
 * src/services/isoplus.js is the ISO+ HTTP client. Every test here stubs the
 * upstream through MSW and asserts either the request the service made (URL and
 * query) or the value it returned — including the error shapes, since almost
 * every function in this module swallows failures and returns a sentinel rather
 * than throwing.
 *
 * The module keeps a 30-second response cache keyed on the authorization header
 * and the workspace id, so every test uses fresh ids.
 */

const API = 'https://app.isoplus.online/api/v2';
const AUTH = 'Bearer test-token';

let counter = 0;
const nextId = (prefix) => `${prefix}-${Date.now()}-${counter++}`;

describe('getWorkspacePage', () => {
  it('asks for the requested page size and reports the cursor', async () => {
    let seen;
    server.use(
      http.get(`${API}/workspaces`, ({ request }) => {
        seen = new URL(request.url).searchParams;
        return HttpResponse.json({
          data: [{ id: 'ws-1', name: 'First' }],
          has_more: true,
          after: 'cursor-2',
        });
      })
    );

    const result = await getWorkspacePage(AUTH, { limit: 25 });

    expect(seen.get('limit')).toBe('25');
    expect(seen.get('sort_by')).toBe('created_at');
    expect(seen.get('sort_direction')).toBe('desc');
    expect(result).toEqual({
      workspace: [{ id: 'ws-1', name: 'First' }],
      has_more: true,
      after: 'cursor-2',
      status: 200,
    });
  });

  it('clamps a limit above the ISO+ maximum of 100', async () => {
    let seen;
    server.use(
      http.get(`${API}/workspaces`, ({ request }) => {
        seen = new URL(request.url).searchParams;
        return HttpResponse.json({ data: [], has_more: false, after: null });
      })
    );

    await getWorkspacePage(AUTH, { limit: 5000 });

    expect(seen.get('limit')).toBe('100');
  });

  it('clamps a limit below 1 up to 1', async () => {
    let seen;
    server.use(
      http.get(`${API}/workspaces`, ({ request }) => {
        seen = new URL(request.url).searchParams;
        return HttpResponse.json({ data: [], has_more: false, after: null });
      })
    );

    await getWorkspacePage(AUTH, { limit: 0 });

    expect(seen.get('limit')).toBe('1');
  });

  it('passes the after cursor through when one is supplied', async () => {
    let seen;
    server.use(
      http.get(`${API}/workspaces`, ({ request }) => {
        seen = new URL(request.url).searchParams;
        return HttpResponse.json({ data: [], has_more: false, after: null });
      })
    );

    await getWorkspacePage(AUTH, { after: 'cursor-9' });

    expect(seen.get('after')).toBe('cursor-9');
  });

  it('surfaces the upstream status and message instead of throwing', async () => {
    server.use(
      http.get(`${API}/workspaces`, () =>
        HttpResponse.json({ message: 'Unauthorized' }, { status: 401 })
      )
    );

    const result = await getWorkspacePage(AUTH);

    expect(result).toEqual({
      workspace: [],
      has_more: false,
      after: null,
      status: 401,
      message: 'Unauthorized',
    });
  });

  it('treats a non-array data field as an empty page', async () => {
    server.use(
      http.get(`${API}/workspaces`, () => HttpResponse.json({ data: null, has_more: false }))
    );

    const result = await getWorkspacePage(AUTH);

    expect(result.workspace).toEqual([]);
    expect(result.has_more).toBe(false);
  });
});

describe('listWorkspacesForAuthorization', () => {
  it('follows the cursor until has_more is false and concatenates the pages', async () => {
    const seenCursors = [];
    server.use(
      http.get(`${API}/workspaces`, ({ request }) => {
        const after = new URL(request.url).searchParams.get('after');
        seenCursors.push(after);
        if (!after) {
          return HttpResponse.json({ data: [{ id: 'ws-1' }], has_more: true, after: 'page-2' });
        }
        return HttpResponse.json({ data: [{ id: 'ws-2' }], has_more: false, after: null });
      })
    );

    const result = await listWorkspacesForAuthorization(AUTH);

    expect(seenCursors).toEqual([null, 'page-2']);
    expect(result).toEqual({ workspaces: [{ id: 'ws-1' }, { id: 'ws-2' }], status: 200 });
  });

  it('stops with an error when the upstream claims more pages but sends no cursor', async () => {
    server.use(
      http.get(`${API}/workspaces`, () =>
        HttpResponse.json({ data: [{ id: 'ws-1' }], has_more: true, after: null })
      )
    );

    const result = await listWorkspacesForAuthorization(AUTH);

    expect(result.status).toBe(500);
    expect(result.workspaces).toEqual([]);
    expect(result.message).toBe('Pagination cursor missing/unchanged for workspaces');
  });
});

describe('getBoardPage', () => {
  it('requests the boards of the given workspace', async () => {
    const workspaceId = nextId('ws');
    let seen;
    server.use(
      http.get(`${API}/workspaces/${workspaceId}/boards`, ({ request }) => {
        seen = new URL(request.url).searchParams;
        return HttpResponse.json({ data: [{ id: 'b-1' }], has_more: false, after: null });
      })
    );

    const result = await getBoardPage(AUTH, workspaceId, { limit: 10 });

    expect(seen.get('limit')).toBe('10');
    expect(result.board).toEqual([{ id: 'b-1' }]);
    expect(result.status).toBe(200);
  });

  it('reports a workspaceId that cannot be used as a path segment', async () => {
    const result = await getBoardPage(AUTH, '../secrets');

    expect(result.status).toBe(500);
    expect(result.message).toBe('Invalid workspaceId: path traversal sequences are not allowed.');
    expect(result.board).toEqual([]);
  });
});

describe('getMemberRole', () => {
  it('refuses a lookup with no email', async () => {
    const result = await getMemberRole(AUTH, nextId('ws'), null);

    expect(result).toEqual({ role: null, status: 400, message: 'userEmail is required' });
  });

  it('matches the member email case-insensitively', async () => {
    const workspaceId = nextId('ws');
    server.use(
      http.get(`${API}/workspaces/${workspaceId}/members`, () =>
        HttpResponse.json({
          data: [{ email: 'Owner@Example.com', role: 'owner' }],
          has_more: false,
          after: null,
        })
      )
    );

    const result = await getMemberRole(AUTH, workspaceId, 'OWNER@example.COM');

    expect(result).toEqual({ role: 'owner', status: 200 });
  });

  it('keeps paging until it finds the member', async () => {
    const workspaceId = nextId('ws');
    server.use(
      http.get(`${API}/workspaces/${workspaceId}/members`, ({ request }) => {
        const after = new URL(request.url).searchParams.get('after');
        if (!after) {
          return HttpResponse.json({
            data: [{ email: 'someone@example.com', role: 'member' }],
            has_more: true,
            after: 'page-2',
          });
        }
        return HttpResponse.json({
          data: [{ email: 'target@example.com', role: 'admin' }],
          has_more: false,
          after: null,
        });
      })
    );

    const result = await getMemberRole(AUTH, workspaceId, 'target@example.com');

    expect(result).toEqual({ role: 'admin', status: 200 });
  });

  it('returns a null role with a 200 when the member is not in the workspace', async () => {
    const workspaceId = nextId('ws');
    server.use(
      http.get(`${API}/workspaces/${workspaceId}/members`, () =>
        HttpResponse.json({ data: [], has_more: false, after: null })
      )
    );

    const result = await getMemberRole(AUTH, workspaceId, 'nobody@example.com');

    expect(result).toEqual({ role: null, status: 200 });
  });

  it('reports the upstream status when the members call fails', async () => {
    const workspaceId = nextId('ws');
    server.use(
      http.get(`${API}/workspaces/${workspaceId}/members`, () =>
        HttpResponse.json({ message: 'Forbidden' }, { status: 403 })
      )
    );

    const result = await getMemberRole(AUTH, workspaceId, 'someone@example.com');

    expect(result).toEqual({ role: null, status: 403, message: 'Forbidden' });
  });
});

describe('getFolder', () => {
  it('collects every folder page', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    server.use(
      http.get(`${API}/workspaces/${workspaceId}/boards/${boardId}/folders/`, ({ request }) => {
        const after = new URL(request.url).searchParams.get('after');
        if (!after) {
          return HttpResponse.json({
            data: [{ id: 'f1', name: 'Master Plan' }],
            has_more: true,
            after: 'f-page-2',
          });
        }
        return HttpResponse.json({
          data: [{ id: 'f2', name: 'Participants Intake' }],
          has_more: false,
          after: null,
        });
      })
    );

    const result = await getFolder(workspaceId, boardId);

    expect(result.status).toBe(200);
    expect(result.folder.map((f) => f.id)).toEqual(['f1', 'f2']);
  });

  it('returns a 500 shape with no folder key when the upstream fails', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    server.use(
      http.get(`${API}/workspaces/${workspaceId}/boards/${boardId}/folders/`, () =>
        HttpResponse.json({ message: 'boom' }, { status: 500 })
      )
    );

    const result = await getFolder(workspaceId, boardId);

    expect(result.status).toBe(500);
    expect(result.folder).toBeUndefined();
  });
});

describe('getItem', () => {
  it('expands the attribute on each value and follows the item cursor', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    let firstQuery;
    server.use(
      http.get(`${API}/workspaces/${workspaceId}/boards/${boardId}/items/`, ({ request }) => {
        const params = new URL(request.url).searchParams;
        const after = params.get('after');
        if (!after) {
          firstQuery = params;
          return HttpResponse.json({ data: [{ id: 'i1' }], has_more: true, after: 'i-page-2' });
        }
        return HttpResponse.json({ data: [{ id: 'i2' }], has_more: false, after: null });
      })
    );

    const result = await getItem(workspaceId, boardId);

    expect(firstQuery.get('expand[0]')).toBe('values.attribute');
    expect(firstQuery.get('limit')).toBe('100');
    expect(result.status).toBe(200);
    expect(result.item.map((i) => i.id)).toEqual(['i1', 'i2']);
  });

  it('adds a folder filter only when a folder id is given', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    let seen;
    server.use(
      http.get(`${API}/workspaces/${workspaceId}/boards/${boardId}/items/`, ({ request }) => {
        seen = new URL(request.url).searchParams;
        return HttpResponse.json({ data: [], has_more: false, after: null });
      })
    );

    await getItem(workspaceId, boardId, 'folder-3');

    expect(seen.get('folder_id')).toBe('folder-3');
  });
});

describe('getItemValues', () => {
  it('returns the item body on success', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    server.use(
      http.get(`${API}/workspaces/${workspaceId}/boards/${boardId}/items/item-1`, () =>
        HttpResponse.json({ id: 'item-1', values: [{ data: 'x' }] })
      )
    );

    const result = await getItemValues(workspaceId, boardId, 'item-1');

    expect(result).toEqual({ id: 'item-1', values: [{ data: 'x' }] });
  });

  it('returns the ITEM_DELETED sentinel for a 404, not null', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    server.use(
      http.get(`${API}/workspaces/${workspaceId}/boards/${boardId}/items/item-1`, () =>
        HttpResponse.json({ message: 'Not found' }, { status: 404 })
      )
    );

    const result = await getItemValues(workspaceId, boardId, 'item-1');

    expect(result).toBe(ITEM_DELETED);
  });

  it('returns null for any other upstream failure', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    server.use(
      http.get(`${API}/workspaces/${workspaceId}/boards/${boardId}/items/item-1`, () =>
        HttpResponse.json({ message: 'boom' }, { status: 500 })
      )
    );

    const result = await getItemValues(workspaceId, boardId, 'item-1');

    expect(result).toBeNull();
  });
});

describe('validateItemBelongsToTenant', () => {
  it('rejects loudly when the item cannot be read', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    server.use(
      http.get(`${API}/workspaces/${workspaceId}/boards/${boardId}/items/item-1`, () =>
        HttpResponse.json({ message: 'boom' }, { status: 500 })
      )
    );

    await expect(validateItemBelongsToTenant(workspaceId, boardId, 'item-1')).rejects.toThrow(
      'CRITICAL: Item does not exist. This may be a result of an intrusion attempt or misconfiguration of the tenant!'
    );
  });

  it('accepts the deleted sentinel, because it is truthy', async () => {
    // ITEM_DELETED is a Symbol, so the `!validatedItemOwnership` guard passes
    // and an item deleted in ISO+ is treated as belonging to the tenant.
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    server.use(
      http.get(`${API}/workspaces/${workspaceId}/boards/${boardId}/items/item-1`, () =>
        HttpResponse.json({ message: 'Not found' }, { status: 404 })
      )
    );

    await expect(
      validateItemBelongsToTenant(workspaceId, boardId, 'item-1')
    ).resolves.toBeUndefined();
  });
});

describe('getReferences and getAttribute', () => {
  it('returns the references body on success', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    server.use(
      http.get(`${API}/workspaces/${workspaceId}/boards/${boardId}/references`, ({ request }) => {
        const from = new URL(request.url).searchParams.get('from_item_id');
        return HttpResponse.json({ data: [{ attribute_id: 'a1', to_item_id: from }] });
      })
    );

    const result = await getReferences(workspaceId, boardId, 'item-1');

    expect(result).toEqual({ data: [{ attribute_id: 'a1', to_item_id: 'item-1' }] });
  });

  it('returns null rather than throwing when references fail', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    server.use(
      http.get(`${API}/workspaces/${workspaceId}/boards/${boardId}/references`, () =>
        HttpResponse.json({ message: 'boom' }, { status: 500 })
      )
    );

    expect(await getReferences(workspaceId, boardId, 'item-1')).toBeNull();
  });

  it('returns null rather than throwing when an attribute fails', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    server.use(
      http.get(`${API}/workspaces/${workspaceId}/boards/${boardId}/attributes/a1`, () =>
        HttpResponse.json({ message: 'boom' }, { status: 500 })
      )
    );

    expect(await getAttribute(workspaceId, boardId, 'a1')).toBeNull();
  });
});

describe('getBoardAttributes', () => {
  it('walks every attribute page', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    server.use(
      http.get(`${API}/workspaces/${workspaceId}/boards/${boardId}/attributes`, ({ request }) => {
        const after = new URL(request.url).searchParams.get('after');
        if (!after) {
          return HttpResponse.json({
            data: [{ id: 'a1', name: 'Unit' }],
            has_more: true,
            after: 'attr-page-2',
          });
        }
        return HttpResponse.json({
          data: [{ id: 'a2', name: 'Quantity' }],
          has_more: false,
          after: null,
        });
      })
    );

    const result = await getBoardAttributes(workspaceId, boardId);

    expect(result.status).toBe(200);
    expect(result.attribute.map((a) => a.id)).toEqual(['a1', 'a2']);
  });

  it('returns a 500 shape when the attributes call fails', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    server.use(
      http.get(`${API}/workspaces/${workspaceId}/boards/${boardId}/attributes`, () =>
        HttpResponse.json({ message: 'boom' }, { status: 500 })
      )
    );

    const result = await getBoardAttributes(workspaceId, boardId);

    expect(result.status).toBe(500);
    expect(result.attribute).toBeUndefined();
  });
});

describe('setIntegrationMessage', () => {
  it('returns false when the board is not configured with a message attribute', async () => {
    const boardId = nextId('board');

    expect(await setIntegrationMessage(nextId('ws'), boardId, 'item-1', 'hello')).toBe(false);
  });

  it('returns false when the board exists but has no attribute id', async () => {
    const boardId = nextId('board');
    await Board.create({ boardId, name: 'Master Plan', workspaceId: 'w1' });

    expect(await setIntegrationMessage('w1', boardId, 'item-1', 'hello')).toBe(false);
  });

  it('wraps the message in a paragraph and sends it to the configured attribute', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    await Board.create({
      boardId,
      name: 'Master Plan',
      workspaceId,
      attribute: { id: 'attr-msg', name: 'Integration Message' },
    });
    let body;
    server.use(
      http.put(
        `${API}/workspaces/${workspaceId}/boards/${boardId}/items/item-1`,
        async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({ ok: true });
        }
      )
    );

    const result = await setIntegrationMessage(workspaceId, boardId, 'item-1', 'All good');

    expect(result).toBe(true);
    expect(body).toEqual({
      values: [{ attribute_id: 'attr-msg', data: '<p>All good</p>' }],
    });
  });

  it('returns false when the upstream write fails', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    await Board.create({
      boardId,
      name: 'Master Plan',
      workspaceId,
      attribute: { id: 'attr-msg', name: 'Integration Message' },
    });
    server.use(
      http.put(`${API}/workspaces/${workspaceId}/boards/${boardId}/items/item-1`, () =>
        HttpResponse.json({ message: 'boom' }, { status: 500 })
      )
    );

    expect(await setIntegrationMessage(workspaceId, boardId, 'item-1', 'All good')).toBe(false);
  });
});

describe('setPDFLinkAttribute', () => {
  it('returns false when the board has no PDF attribute configured', async () => {
    const boardId = nextId('board');
    await Board.create({ boardId, name: 'Master Plan', workspaceId: 'w1' });

    expect(
      await setPDFLinkAttribute('w1', boardId, 'item-1', 'https://example.com/a.pdf', 'Invoice')
    ).toBe(false);
  });

  it('writes a bare anchor for a non-NDIS document', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    await Board.create({
      boardId,
      name: 'Master Plan',
      workspaceId,
      pdfAttribute: { id: 'attr-pdf', name: 'PDF Link' },
    });
    let body;
    server.use(
      http.put(
        `${API}/workspaces/${workspaceId}/boards/${boardId}/items/item-1`,
        async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({ ok: true });
        }
      )
    );

    const result = await setPDFLinkAttribute(
      workspaceId,
      boardId,
      'item-1',
      'https://example.com/a.pdf',
      'Invoice'
    );

    expect(result).toBe(true);
    expect(body.values[0]).toEqual({
      data: '<a href="https://example.com/a.pdf">https://example.com/a.pdf</a>',
      attribute_id: 'attr-pdf',
    });
  });

  it('writes the "Click here to download" form for an NDIS document', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    await Board.create({
      boardId,
      name: 'Master Plan',
      workspaceId,
      pdfAttribute: { id: 'attr-pdf', name: 'PDF Link' },
    });
    let body;
    server.use(
      http.put(
        `${API}/workspaces/${workspaceId}/boards/${boardId}/items/item-1`,
        async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({ ok: true });
        }
      )
    );

    await setPDFLinkAttribute(
      workspaceId,
      boardId,
      'item-1',
      'https://example.com/a.pdf',
      'NDIS Invoice'
    );

    expect(body.values[0].data).toBe(
      '<p>Click <a href="https://example.com/a.pdf">here</a> to download.</p>'
    );
  });
});

describe('setGeneratedField', () => {
  it('writes to the text attribute whose name has both "Generated" and "Number"', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    let body;
    server.use(
      http.get(`${API}/workspaces/${workspaceId}/boards/${boardId}/items/item-1`, () =>
        HttpResponse.json({
          id: 'item-1',
          values: [
            { data: '', attribute: { id: 'a-other', name: 'Generated Date', type: 'text' } },
            { data: '', attribute: { id: 'a-num', name: 'Generated Invoice Number', type: 'text' } },
          ],
        })
      ),
      http.put(
        `${API}/workspaces/${workspaceId}/boards/${boardId}/items/item-1`,
        async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({ ok: true });
        }
      )
    );

    const result = await setGeneratedField(workspaceId, boardId, 'item-1', 'INV-1 (Xero)');

    expect(result).toBe(true);
    expect(body).toEqual({ values: [{ data: 'INV-1 (Xero)', attribute_id: 'a-num' }] });
  });

  it('returns false when the board has no such attribute', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    server.use(
      http.get(`${API}/workspaces/${workspaceId}/boards/${boardId}/items/item-1`, () =>
        HttpResponse.json({
          id: 'item-1',
          values: [{ data: '', attribute: { id: 'a1', name: 'Title', type: 'text' } }],
        })
      )
    );

    expect(await setGeneratedField(workspaceId, boardId, 'item-1', 'INV-1')).toBe(false);
  });

  it('rejects when the item cannot be read at all', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    server.use(
      http.get(`${API}/workspaces/${workspaceId}/boards/${boardId}/items/item-1`, () =>
        HttpResponse.json({ message: 'boom' }, { status: 500 })
      )
    );

    await expect(setGeneratedField(workspaceId, boardId, 'item-1', 'INV-1')).rejects.toThrow(
      'Failed to update item with integration message'
    );
  });
});

describe('getAutomation', () => {
  it('returns the automation body on success', async () => {
    const workspaceId = nextId('ws');
    server.use(
      http.get(`https://app.isoplus.online/api/${workspaceId}/automations/board-1`, () =>
        HttpResponse.json([{ id: 'auto-1', name: 'Set unit price' }])
      )
    );

    const result = await getAutomation(workspaceId, 'board-1', AUTH);

    expect(result).toEqual([{ id: 'auto-1', name: 'Set unit price' }]);
  });

  it('returns null rather than throwing when the call fails', async () => {
    const workspaceId = nextId('ws');
    server.use(
      http.get(`https://app.isoplus.online/api/${workspaceId}/automations/board-1`, () =>
        HttpResponse.json({ message: 'boom' }, { status: 500 })
      )
    );

    expect(await getAutomation(workspaceId, 'board-1', AUTH)).toBeNull();
  });
});

describe('getMyWorkspace', () => {
  it('reads the /api/me/workspaces endpoint, not the v2 collection', async () => {
    server.use(
      http.get('https://app.isoplus.online/api/me/workspaces', () =>
        HttpResponse.json([{ id: 'ws-1' }])
      )
    );

    const result = await getMyWorkspace(AUTH);

    expect(result).toEqual({ workspace: [{ id: 'ws-1' }], status: 200 });
  });

  it('collapses any failure into a generic server error', async () => {
    server.use(
      http.get('https://app.isoplus.online/api/me/workspaces', () =>
        HttpResponse.json({ message: 'Unauthorized' }, { status: 401 })
      )
    );

    expect(await getMyWorkspace(AUTH)).toEqual({ message: 'Server error', status: 500 });
  });
});

// --- offline write-backs ------------------------------------------------------

// Offline, the three ISO+ write-backs must not attempt the network at all. The
// items are local inventions the live platform has never heard of, so the PUTs
// can only 404 — and setPDFLinkAttribute/setGeneratedField rethrow from their
// catch, which killed an offline PDF run *after* the PDF was already stored.
// A skip is the honest behaviour, same as the board_sync handler's offline skip.
describe('write-backs in offline mode', () => {
  const saved = {};

  beforeEach(() => {
    saved.ISOPLUS_OFFLINE = process.env.ISOPLUS_OFFLINE;
    process.env.ISOPLUS_OFFLINE = '1';
    server.use(
      http.all(/app\.isoplus\.online/, () => {
        throw new Error('offline write-back reached the network');
      }),
    );
  });

  afterEach(() => {
    process.env.ISOPLUS_OFFLINE = saved.ISOPLUS_OFFLINE;
  });

  it('setIntegrationMessage resolves false without a request', async () => {
    await expect(setIntegrationMessage('55369', 'b1', 'i1', 'Running...')).resolves.toBe(false);
  });

  it('setPDFLinkAttribute resolves false without a request', async () => {
    await expect(setPDFLinkAttribute('55369', 'b1', 'i1', 'http://x/y.pdf', 'NDIS Quote')).resolves.toBe(false);
  });

  it('setGeneratedField resolves false without a request', async () => {
    await expect(setGeneratedField('55369', 'b1', 'i1', 'QT-1 (ISO+™)')).resolves.toBe(false);
  });
});
