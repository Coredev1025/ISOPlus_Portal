import { describe, it, expect, vi, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from '../../msw/server.js';
import { executeSetLogo } from '../../../src/utils/isoplusLogoHelpers.js';
import { getErrorMessageFromUnknown } from '../../../src/utils/isoplusErrorHelpers.js';

// Collaborators copied verbatim from the production caller, src/services/isoplus.js
// (setLogo). Only the transport (axios -> MSW) and the ISO+ read functions are
// stand-ins; the error classification these two drive is behaviour under test.
const getErrorMessage = (err) => getErrorMessageFromUnknown(err);
const errorMessageIncludes = (err, searchString) => {
  if (!err || !searchString) return false;
  const errorMsg = getErrorMessage(err);
  return typeof errorMsg === 'string' && errorMsg.includes(searchString);
};

const API_BASE = 'https://app.isoplus.online/api/v2';
const WORKSPACE_ID = 'ws_9021';
const BOARD_ID = 'brd_5511';
const VIEW_ID = 'view_771';
const UPLOAD_ID = 'att_31337';
const UPLOAD_LINK = 'https://cdn.isoplus.online/att_31337.png';

function makeLogo(overrides = {}) {
  return {
    buffer: Buffer.from('PNGDATA-hillsgrade'),
    originalname: 'hillsgrade-logo.png',
    size: 18,
    mimetype: 'image/png',
    ...overrides,
  };
}

function makeDeps(overrides = {}) {
  return {
    authorization: 'Bearer tok_abc123',
    workspaceId: WORKSPACE_ID,
    logo: makeLogo(),
    type: 'form',
    req: { headers: { 'x-request-id': 'req_fixed_1' } },
    getBoard: vi.fn(async () => ({ status: 200, board: [{ id: BOARD_ID, name: 'Care Board', description: 'desc' }] })),
    getAllViews: vi.fn(async () => ({
      status: 200,
      views: [
        { id: VIEW_ID, name: 'Intake Form', type: 'FORM', settings: { formSettings: { title: 'Intake' } } },
        { id: 'view_other', name: 'Grid', type: 'grid', settings: {} },
      ],
    })),
    iterateBoardItems: vi.fn(),
    validateBoardAttributes: vi.fn(async () => ({ attribute: { id: 'attr_cover_1' } })),
    getItemValues: vi.fn(),
    getErrorMessage,
    errorMessageIncludes,
    sleep: vi.fn(async () => {}),
    logoItemsPageSize: 50,
    logOperationStart: vi.fn(),
    logOperationEnd: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    logAttributeError: vi.fn(),
    logApiError: vi.fn(),
    ...overrides,
  };
}

/** Records every request MSW serves for the attachment upload. */
function captureUpload({ status = 201, body = { id: UPLOAD_ID, link: UPLOAD_LINK } } = {}) {
  const calls = [];
  server.use(
    http.post(`${API_BASE}/workspaces/:workspaceId/attachments/file`, async ({ request, params }) => {
      calls.push({
        workspaceId: params.workspaceId,
        authorization: request.headers.get('authorization'),
        accept: request.headers.get('accept'),
        contentType: request.headers.get('content-type'),
        body: await request.text(),
      });
      return HttpResponse.json(body, { status });
    }),
  );
  return calls;
}

function captureViewPut(status = 200) {
  const calls = [];
  server.use(
    http.put(`${API_BASE}/workspaces/:workspaceId/boards/:boardId/views/:viewId`, async ({ request, params }) => {
      calls.push({ params: { ...params }, body: await request.json(), authorization: request.headers.get('authorization') });
      if (status !== 200) return HttpResponse.json({ message: 'boom' }, { status });
      return HttpResponse.json({ ok: true }, { status: 200 });
    }),
  );
  return calls;
}

function captureItemPut(status = 200) {
  const calls = [];
  server.use(
    http.put(`${API_BASE}/workspaces/:workspaceId/boards/:boardId/items/:itemId`, async ({ request, params }) => {
      calls.push({ params: { ...params }, body: await request.json() });
      if (status !== 200) return HttpResponse.json({ message: 'Attribute(s) not recognized' }, { status });
      return HttpResponse.json({ ok: true }, { status: 200 });
    }),
  );
  return calls;
}

function errorMessages(deps) {
  return deps.error.mock.calls.map((call) => call[1]);
}

describe('executeSetLogo - parameter validation', () => {
  // Breaks if a guard is dropped: the call would proceed to upload instead of
  // logging "Missing required parameter" and returning null.
  const cases = [
    ['authorization', { authorization: '' }],
    ['workspaceId', { workspaceId: '' }],
    ['logo', { logo: null }],
    ['logo.buffer', { logo: makeLogo({ buffer: undefined }) }],
    ['logo.originalname', { logo: makeLogo({ originalname: '' }) }],
  ];

  it.each(cases)('rejects a missing %s before any HTTP call', async (_label, override) => {
    const uploads = captureUpload();
    const deps = makeDeps(override);

    const result = await executeSetLogo(deps);

    expect(result).toBeNull();
    expect(uploads).toHaveLength(0);
    expect(deps.getBoard).not.toHaveBeenCalled();
    expect(errorMessages(deps)).toEqual(['Error setting logo: Missing required parameter']);
  });

  it('rejects a logo type that is neither form nor document', async () => {
    const uploads = captureUpload();
    const deps = makeDeps({ type: 'banner' });

    const result = await executeSetLogo(deps);

    expect(result).toBeNull();
    expect(uploads).toHaveLength(0);
    // The bad-type guard logs a bare prefix; only the missing-parameter guard
    // appends "Missing required parameter". The specific reason is carried on
    // logOperationEnd instead, asserted below.
    expect(errorMessages(deps)).toEqual(['Error setting logo:']);
    expect(deps.logOperationEnd).toHaveBeenCalledWith(
      'ISO+™ Service',
      'setLogo',
      {
        workspaceId: WORKSPACE_ID,
        logoType: 'banner',
        success: false,
        error: 'Logo type must be either "form" or "document"',
      },
      deps.req,
    );
  });

  it('opens the operation log with the logo metadata and the request id from the header', async () => {
    captureUpload();
    const deps = makeDeps({ type: 'banner' });

    await executeSetLogo(deps);

    expect(deps.logOperationStart).toHaveBeenCalledWith(
      'ISO+™ Service',
      'setLogo',
      {
        workspaceId: WORKSPACE_ID,
        logoType: 'banner',
        requestId: 'req_fixed_1',
        logoFileName: 'hillsgrade-logo.png',
        logoSize: 18,
        logoMimeType: 'image/png',
      },
      deps.req,
    );
  });

  it('generates a logo_<timestamp>_<9 chars> request id when the request carries no x-request-id', async () => {
    captureUpload();
    const deps = makeDeps({ type: 'banner', req: { headers: {} } });

    await executeSetLogo(deps);

    const { requestId } = deps.logOperationStart.mock.calls[0][2];
    expect(requestId).toMatch(/^logo_\d+_[a-z0-9]{9}$/);
  });
});

describe('executeSetLogo - board lookup', () => {
  it('aborts without uploading when the board fetch is not 200', async () => {
    const uploads = captureUpload();
    const deps = makeDeps({ getBoard: vi.fn(async () => ({ status: 403, error: { message: 'Forbidden board' } })) });

    const result = await executeSetLogo(deps);

    expect(result).toBeNull();
    expect(uploads).toHaveLength(0);
    expect(errorMessages(deps)).toEqual(['Error setting logo: Failed to fetch boards']);
    expect(deps.logOperationEnd.mock.calls[0][2].error).toBe('Failed to fetch boards: Forbidden board');
  });

  it('treats an empty board list as a board failure, after the logo is already uploaded', async () => {
    const uploads = captureUpload();
    const deps = makeDeps({ getBoard: vi.fn(async () => ({ status: 200, board: [] })) });

    const result = await executeSetLogo(deps);

    expect(result).toBeNull();
    expect(uploads).toHaveLength(1);
    expect(errorMessages(deps)).toEqual(['Error setting logo: Failed to fetch boards']);
  });
});

describe('executeSetLogo - attachment upload', () => {
  it('posts the file to the workspace attachments endpoint as multipart form data', async () => {
    const uploads = captureUpload();
    captureViewPut();
    const deps = makeDeps();

    await executeSetLogo(deps);

    expect(uploads).toHaveLength(1);
    expect(uploads[0].workspaceId).toBe(WORKSPACE_ID);
    expect(uploads[0].authorization).toBe('Bearer tok_abc123');
    expect(uploads[0].accept).toBe('application/json');
    expect(uploads[0].contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(uploads[0].body).toContain('name="file"; filename="hillsgrade-logo.png"');
    expect(uploads[0].body).toContain('PNGDATA-hillsgrade');
  });

  it('rejects an upload response whose status is not 201', async () => {
    captureUpload({ status: 200 });
    const views = captureViewPut();
    const deps = makeDeps();

    const result = await executeSetLogo(deps);

    expect(result).toBeNull();
    expect(views).toHaveLength(0);
    expect(deps.logOperationEnd.mock.calls[0][2].error).toBe('Logo upload failed with status 200');
    expect(errorMessages(deps)).toEqual(['Error setting logo:']);
  });

  it('rejects an upload response with no attachment id', async () => {
    captureUpload({ body: { link: UPLOAD_LINK } });
    const views = captureViewPut();
    const deps = makeDeps();

    const result = await executeSetLogo(deps);

    expect(result).toBeNull();
    expect(views).toHaveLength(0);
    expect(deps.logOperationEnd.mock.calls[0][2].error).toBe('Logo upload response missing required data (id)');
    expect(errorMessages(deps)).toEqual(['Error setting logo: Missing required parameter']);
  });

  it('requires a link only for the form logo type', async () => {
    captureUpload({ body: { id: UPLOAD_ID } });
    const views = captureViewPut();
    const formDeps = makeDeps();

    expect(await executeSetLogo(formDeps)).toBeNull();
    expect(views).toHaveLength(0);
    expect(formDeps.logOperationEnd.mock.calls[0][2].error)
      .toBe('Logo upload response missing required data (link) for form type');

    const documentDeps = makeDeps({
      type: 'document',
      getAllViews: vi.fn(async () => ({ status: 200, views: [] })),
    });
    await executeSetLogo(documentDeps);
    expect(documentDeps.logOperationEnd.mock.calls[0][2]).toEqual({
      workspaceId: WORKSPACE_ID,
      logoType: 'document',
      success: true,
    });
  });

  it('classifies a 401 from the upload as unauthorized in both the upload and the setLogo log', async () => {
    server.use(
      http.post(`${API_BASE}/workspaces/:workspaceId/attachments/file`, () =>
        HttpResponse.json({ message: 'unauthorized' }, { status: 401 })),
    );
    const deps = makeDeps();

    const result = await executeSetLogo(deps);

    expect(result).toBeNull();
    expect(errorMessages(deps)).toEqual([
      'Error uploading logo: Unauthorized',
      'Error setting logo: Unauthorized',
    ]);
    expect(deps.error.mock.calls[0][2]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      requestId: 'req_fixed_1',
      statusCode: 401,
      logoFileName: 'hillsgrade-logo.png',
      logoSize: 18,
      logoMimeType: 'image/png',
    });
  });

  it('classifies a 403 from the upload as forbidden', async () => {
    server.use(
      http.post(`${API_BASE}/workspaces/:workspaceId/attachments/file`, () =>
        HttpResponse.json({ message: 'nope' }, { status: 403 })),
    );
    const deps = makeDeps();

    await executeSetLogo(deps);

    expect(errorMessages(deps)).toEqual([
      'Error uploading logo: Forbidden',
      'Error setting logo: Forbidden',
    ]);
  });

  it('classifies a 500 from the upload as a generic upload error', async () => {
    server.use(
      http.post(`${API_BASE}/workspaces/:workspaceId/attachments/file`, () =>
        HttpResponse.json({ message: 'kaput' }, { status: 500 })),
    );
    const deps = makeDeps();

    await executeSetLogo(deps);

    expect(errorMessages(deps)).toEqual([
      'Error uploading logo file:',
      'Error setting logo:',
    ]);
  });
});

describe('executeSetLogo - form views', () => {
  it('puts the uploaded link into formSettings.logoImageUrl of every form view, preserving the rest', async () => {
    captureUpload();
    const views = captureViewPut();
    const deps = makeDeps();

    const result = await executeSetLogo(deps);

    expect(result).toBeUndefined();
    expect(views).toHaveLength(1);
    expect(views[0].params).toEqual({ workspaceId: WORKSPACE_ID, boardId: BOARD_ID, viewId: VIEW_ID });
    expect(views[0].authorization).toBe('Bearer tok_abc123');
    expect(views[0].body).toEqual({
      id: VIEW_ID,
      name: 'Intake Form',
      type: 'FORM',
      settings: {
        formSettings: {
          title: 'Intake',
          logoImageUrl: UPLOAD_LINK,
        },
      },
    });
    expect(deps.sleep).toHaveBeenCalledWith(2000);
    expect(deps.logOperationEnd).toHaveBeenCalledWith(
      'ISO+™ Service',
      'setLogo',
      { workspaceId: WORKSPACE_ID, logoType: 'form', success: true },
      deps.req,
    );
  });

  it('skips boards whose view fetch is not 200 and never PUTs', async () => {
    captureUpload();
    const views = captureViewPut();
    const deps = makeDeps({ getAllViews: vi.fn(async () => ({ status: 500, data: { message: 'down' } })) });

    await executeSetLogo(deps);

    expect(views).toHaveLength(0);
    expect(deps.warn).toHaveBeenCalledWith(
      'ISO+™ Service',
      `Failed to fetch views for board ${BOARD_ID}`,
      expect.objectContaining({ boardId: BOARD_ID, responseStatus: 500, responseData: { message: 'down' } }),
      deps.req,
    );
    expect(deps.logOperationEnd.mock.calls[0][2].success).toBe(true);
  });

  it('classifies a timeout from the view fetch as a timeout warning', async () => {
    captureUpload();
    const timeoutErr = Object.assign(new Error('socket hang up'), { code: 'ECONNABORTED' });
    const deps = makeDeps({ getAllViews: vi.fn(async () => { throw timeoutErr; }) });

    await executeSetLogo(deps);

    expect(deps.warn.mock.calls[0][1]).toBe(`Request timeout when fetching views for board ${BOARD_ID}`);
  });

  it('classifies an unresolved host from the view fetch as a network warning', async () => {
    captureUpload();
    const networkErr = Object.assign(new Error('getaddrinfo failed'), { code: 'ENOTFOUND' });
    const deps = makeDeps({ getAllViews: vi.fn(async () => { throw networkErr; }) });

    await executeSetLogo(deps);

    expect(deps.warn.mock.calls[0][1]).toBe(`Network error when fetching views for board ${BOARD_ID}`);
  });

  it('warns and stops when no view matches the requested type', async () => {
    captureUpload();
    const views = captureViewPut();
    const deps = makeDeps({
      getAllViews: vi.fn(async () => ({
        status: 200,
        views: [{ id: 'view_grid', name: 'Grid', type: 'grid', settings: {} }],
      })),
    });

    await executeSetLogo(deps);

    expect(views).toHaveLength(0);
    expect(deps.warn).toHaveBeenCalledWith(
      'ISO+™ Service',
      `No views found for board ${BOARD_ID}`,
      expect.objectContaining({ requestedType: 'form', availableTypes: ['grid'] }),
      deps.req,
    );
  });

  it('logs a 404 on the view PUT through logApiError and still finishes successfully', async () => {
    captureUpload();
    captureViewPut(404);
    const deps = makeDeps();

    await executeSetLogo(deps);

    expect(deps.logApiError.mock.calls[0][1]).toBe('View not found when setting form logo:');
    expect(deps.logApiError.mock.calls[0][2]).toMatchObject({
      boardId: BOARD_ID,
      viewId: VIEW_ID,
      statusCode: 404,
    });
    expect(deps.logOperationEnd.mock.calls[0][2].success).toBe(true);
  });
});

describe('executeSetLogo - document views', () => {
  function documentDeps(overrides = {}) {
    return makeDeps({
      type: 'document',
      getAllViews: vi.fn(async () => ({
        status: 200,
        views: [{
          id: VIEW_ID,
          name: 'Care Plan Doc',
          type: 'DOCUMENT',
          folder_id: 'fld_88',
          settings: { editorCoverAttributeId: 'attr_cover_1' },
        }],
      })),
      iterateBoardItems: vi.fn(async function* () {
        yield [{ id: 'item_1', name: 'Plan A' }];
      }),
      ...overrides,
    });
  }

  it('sets each item cover to the uploaded attachment and then saves the view with editorItems', async () => {
    captureUpload();
    const itemPuts = captureItemPut();
    const viewPuts = captureViewPut();
    const deps = documentDeps();

    await executeSetLogo(deps);

    expect(deps.iterateBoardItems).toHaveBeenCalledWith(WORKSPACE_ID, BOARD_ID, 'fld_88', {
      limit: 50,
      authorization: 'Bearer tok_abc123',
    });
    expect(itemPuts).toHaveLength(1);
    expect(itemPuts[0].params).toEqual({ workspaceId: WORKSPACE_ID, boardId: BOARD_ID, itemId: 'item_1' });
    expect(itemPuts[0].body).toEqual({
      values: [{ data: [{ id: UPLOAD_ID }], attribute_id: 'attr_cover_1' }],
    });

    expect(viewPuts).toHaveLength(1);
    expect(viewPuts[0].body).toEqual({
      id: VIEW_ID,
      name: 'Care Plan Doc',
      type: 'DOCUMENT',
      folder_id: 'fld_88',
      settings: {
        editorCoverAttributeId: 'attr_cover_1',
        editorItems: { item_1: { cover: UPLOAD_ID } },
      },
    });
  });

  it('adopts the cover attribute id resolved by validateBoardAttributes when the view has none', async () => {
    captureUpload();
    const itemPuts = captureItemPut();
    const viewPuts = captureViewPut();
    const deps = documentDeps({
      getAllViews: vi.fn(async () => ({
        status: 200,
        views: [{ id: VIEW_ID, name: 'Care Plan Doc', type: 'document', folder_id: 'fld_88', settings: {} }],
      })),
      validateBoardAttributes: vi.fn(async () => ({ attribute: { id: 'attr_resolved_9' } })),
    });

    await executeSetLogo(deps);

    expect(deps.warn.mock.calls[0][1]).toBe(`No cover attribute id found for view ${VIEW_ID}; attempting fallback`);
    expect(deps.validateBoardAttributes).toHaveBeenCalledWith(
      WORKSPACE_ID,
      BOARD_ID,
      VIEW_ID,
      undefined,
      deps.req,
      deps.authorization,
      expect.any(Map),
    );
    expect(itemPuts[0].body.values[0].attribute_id).toBe('attr_resolved_9');
    expect(viewPuts[0].body.settings.editorCoverAttributeId).toBe('attr_resolved_9');
  });

  it('skips the view entirely when no cover attribute can be resolved', async () => {
    captureUpload();
    const itemPuts = captureItemPut();
    const viewPuts = captureViewPut();
    const deps = documentDeps({ validateBoardAttributes: vi.fn(async () => null) });

    await executeSetLogo(deps);

    expect(itemPuts).toHaveLength(0);
    expect(viewPuts).toHaveLength(0);
    expect(deps.warn).toHaveBeenCalledWith(
      'ISO+™ Service',
      'Skipping view due to invalid cover attribute',
      expect.objectContaining({ viewId: VIEW_ID, coverAttributeId: 'attr_cover_1' }),
      deps.req,
    );
  });

  it('still writes item covers when getItemValues returns null (swallowed upstream 403)', async () => {
    captureUpload();
    const itemPuts = captureItemPut();
    const viewPuts = captureViewPut();
    const deps = documentDeps({
      getItemValues: vi.fn(async () => null),
    });

    await executeSetLogo(deps);

    expect(deps.getItemValues).not.toHaveBeenCalled();
    expect(itemPuts).toHaveLength(1);
    expect(itemPuts[0].body).toEqual({
      values: [{ data: [{ id: UPLOAD_ID }], attribute_id: 'attr_cover_1' }],
    });
    expect(viewPuts[0].body.settings.editorItems).toEqual({
      item_1: { cover: UPLOAD_ID },
    });
  });

  it('routes an unrecognised-attribute failure on the item PUT to logAttributeError with the cover id', async () => {
    captureUpload();
    captureItemPut(400);
    const viewPuts = captureViewPut();
    const deps = documentDeps();

    await executeSetLogo(deps);

    expect(deps.logAttributeError).toHaveBeenCalledTimes(1);
    expect(deps.logAttributeError.mock.calls[0][1])
      .toBe('Error updating item for document logo: Attribute not recognized');
    expect(deps.logAttributeError.mock.calls[0][2]).toBe('attr_cover_1');
    expect(deps.logAttributeError.mock.calls[0][3]).toMatchObject({
      itemId: 'item_1',
      requestPayload: { values: [{ data: [{ id: UPLOAD_ID }], attribute_id: 'attr_cover_1' }] },
    });
    expect(viewPuts[0].body.settings.editorItems).toBeUndefined();
  });

  it('warns when the folder yields no items at all', async () => {
    captureUpload();
    captureViewPut();
    const deps = documentDeps({ iterateBoardItems: vi.fn(async function* () {}) });

    await executeSetLogo(deps);

    expect(deps.warn).toHaveBeenCalledWith(
      'ISO+™ Service',
      'No items found for document view',
      expect.objectContaining({ viewId: VIEW_ID, folderId: 'fld_88' }),
      deps.req,
    );
  });

  it('warns and does not save the view when item iteration throws', async () => {
    captureUpload();
    const viewPuts = captureViewPut();
    const deps = documentDeps({
      iterateBoardItems: vi.fn(() => ({ next: async () => { throw new Error('network is unreachable'); } })),
    });

    await executeSetLogo(deps);

    expect(deps.warn.mock.calls.map((c) => c[1])).toContain('Network error when fetching items for document view');
    expect(deps.warn.mock.calls.map((c) => c[1])).toContain('Skipping view save after items fetch failure');
    expect(viewPuts).toHaveLength(0);
  });

  it('sleeps 2s after every item, every page and every view save', async () => {
    captureUpload();
    captureItemPut();
    captureViewPut();
    const deps = documentDeps({
      iterateBoardItems: vi.fn(async function* () {
        yield [{ id: 'item_1', name: 'A' }, { id: 'item_2', name: 'B' }];
        yield [{ id: 'item_3', name: 'C' }];
      }),
    });

    await executeSetLogo(deps);

    // 3 items + 2 pages + 1 view save
    expect(deps.sleep).toHaveBeenCalledTimes(6);
    expect(deps.sleep.mock.calls.every((call) => call[0] === 2000)).toBe(true);
  });

  it('reports a failed view save through logApiError without failing the operation', async () => {
    captureUpload();
    captureItemPut();
    captureViewPut(403);
    const deps = documentDeps();

    await executeSetLogo(deps);

    expect(deps.logApiError.mock.calls.at(-1)[1]).toBe('Forbidden when setting document logo:');
    expect(deps.logOperationEnd.mock.calls[0][2].success).toBe(true);
  });
});

describe('executeSetLogo - multiple boards', () => {
  it('processes every board returned by getBoard', async () => {
    captureUpload();
    const viewPuts = captureViewPut();
    const deps = makeDeps({
      getBoard: vi.fn(async () => ({
        status: 200,
        board: [{ id: 'brd_1', name: 'One' }, { id: 'brd_2', name: 'Two' }],
      })),
      getAllViews: vi.fn(async (auth, workspaceId, boardId) => ({
        status: 200,
        views: [{ id: `view_${boardId}`, name: 'Form', type: 'form', settings: { formSettings: {} } }],
      })),
    });

    await executeSetLogo(deps);

    expect(deps.getAllViews.mock.calls.map((call) => call[2])).toEqual(['brd_1', 'brd_2']);
    expect(viewPuts.map((call) => call.params.viewId)).toEqual(['view_brd_1', 'view_brd_2']);
  });
});
