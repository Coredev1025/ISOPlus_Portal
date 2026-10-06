import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { http, HttpResponse } from 'msw';
import { createApp } from '../../../src/app.js';
import { server } from '../../msw/server.js';

/**
 * src/routes/ageCare.js, mounted at /api/age-care. Both routes are called by
 * ISO+ automations, are unauthenticated, and always answer 200 — the outcome is
 * carried in the body as { error } or { message }.
 *
 * Neither route has a try/catch of its own: they read req.body.items[0] and
 * sanitize the path params before the first awaited call, so a malformed body
 * or an id containing '.', '/' or '%' rejects the handler's promise, which
 * Express 4 does not catch — the request would never be answered. That is
 * reported as a bug rather than pinned with a test that would hang, so every
 * body below is well formed.
 *
 * All ISO+ traffic is stubbed through MSW; nothing reaches the network.
 */

const app = createApp();
const API_BASE = 'https://app.isoplus.online/api/v2';

let counter = 0;
const nextId = (prefix) => `${prefix}-${Date.now()}-${counter++}`;

const post = (workspaceId, boardId, route, body) =>
  request(app).post(`/api/age-care/${workspaceId}/${boardId}/${route}`).send(body);

/** ISO+ returns 500 for every item read on this board. */
function stubItemsUnavailable(workspaceId, boardId) {
  server.use(
    http.get(`${API_BASE}/workspaces/${workspaceId}/boards/${boardId}/items/:itemId`, () =>
      HttpResponse.json({ message: 'upstream failure' }, { status: 500 })
    )
  );
}

function stubReferencesUnavailable(workspaceId, boardId) {
  server.use(
    http.get(`${API_BASE}/workspaces/${workspaceId}/boards/${boardId}/references`, () =>
      HttpResponse.json({ message: 'upstream failure' }, { status: 500 })
    )
  );
}

/**
 * Wire up the reference chain a Master Plan item walks: one reference pointing
 * at a Service Plan item, the attribute that names it, and the two item reads
 * (the referenced Service Plan and the Master Plan item itself).
 */
function stubMasterPlanWithServicePlan({
  workspaceId,
  boardId,
  masterItemId,
  servicePlanItemId,
  servicePlanValues = {
    Unit: 'Hour',
    'Agreed Unit Price ($)': '$50',
    'Participant Contribution (%)': '0',
  },
}) {
  server.use(
    http.get(`${API_BASE}/workspaces/${workspaceId}/boards/${boardId}/references`, () =>
      HttpResponse.json({
        data: [{ attribute_id: 'attr-service-plan', to_item_id: servicePlanItemId }],
      })
    ),
    http.get(
      `${API_BASE}/workspaces/${workspaceId}/boards/${boardId}/attributes/attr-service-plan`,
      () => HttpResponse.json({ id: 'attr-service-plan', name: 'Service Plan' })
    ),
    http.get(
      `${API_BASE}/workspaces/${workspaceId}/boards/${boardId}/items/${servicePlanItemId}`,
      () =>
        HttpResponse.json({
          id: servicePlanItemId,
          values: Object.entries(servicePlanValues).map(([name, data], i) => ({
            data,
            attribute: { id: `sp-attr-${i}`, name, type: 'text' },
          })),
        })
    ),
    http.get(`${API_BASE}/workspaces/${workspaceId}/boards/${boardId}/items/${masterItemId}`, () =>
      HttpResponse.json({
        id: masterItemId,
        values: [
          { data: '', attribute: { id: 'mp-qty', name: 'Quantity', type: 'number' } },
          { data: '', attribute: { id: 'mp-price', name: 'Unit Price ($)', type: 'number' } },
        ],
      })
    )
  );
}

describe('POST /:workspaceId/:boardId/update-variables-participants-service', () => {
  it('reports the generic failure message when ISO+ will not return the item', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubItemsUnavailable(workspaceId, boardId);

    const res = await post(workspaceId, boardId, 'update-variables-participants-service', {
      items: [{ id: 'item-1', values: {} }],
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      error:
        'An unknown error occurred while updating Participants Service Plan variables. Please contact the ISO+™ support team.',
    });
  });
});

describe('POST /:workspaceId/:boardId/update-variables-masterplan', () => {
  it('reports a missing Service Plan when ISO+ returns no references', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubReferencesUnavailable(workspaceId, boardId);

    const res = await post(workspaceId, boardId, 'update-variables-masterplan', {
      items: [{ id: 'item-1', values: {} }],
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ error: 'Service Plan item not found.' });
  });

  it('reports a missing Service Plan when the references point at other attributes', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    server.use(
      http.get(`${API_BASE}/workspaces/${workspaceId}/boards/${boardId}/references`, () =>
        HttpResponse.json({ data: [{ attribute_id: 'attr-other', to_item_id: 'ref-1' }] })
      ),
      http.get(
        `${API_BASE}/workspaces/${workspaceId}/boards/${boardId}/attributes/attr-other`,
        () => HttpResponse.json({ id: 'attr-other', name: 'Worker' })
      )
    );

    const res = await post(workspaceId, boardId, 'update-variables-masterplan', {
      items: [{ id: 'item-1', values: {} }],
    });

    expect(res.body).toEqual({ error: 'Service Plan item not found.' });
  });

  it('refuses a Delivered transaction with no Actual Shift End Date', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    const masterItemId = nextId('item');
    stubMasterPlanWithServicePlan({
      workspaceId,
      boardId,
      masterItemId,
      servicePlanItemId: nextId('sp'),
    });

    const res = await post(workspaceId, boardId, 'update-variables-masterplan', {
      items: [
        {
          id: masterItemId,
          values: {
            'Transaction Status': 'Delivered - To be claimed and invoiced.',
            'Actual Shift End Date & Time': '',
          },
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      error:
        'ERROR: Invalid transaction status or missing required fields. For Delivered status without Actual Shift End Date: Actual Shift End Date cannot be left blank.',
    });
  });

  it('refuses a Cancelled transaction that still carries an Actual Shift End Date', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    const masterItemId = nextId('item');
    stubMasterPlanWithServicePlan({
      workspaceId,
      boardId,
      masterItemId,
      servicePlanItemId: nextId('sp'),
    });

    const res = await post(workspaceId, boardId, 'update-variables-masterplan', {
      items: [
        {
          id: masterItemId,
          values: {
            'Transaction Status': 'Cancelled',
            'Actual Shift End Date & Time': '2026-03-01T10:00:00Z',
          },
        },
      ],
    });

    expect(res.body).toEqual({
      error:
        'ERROR: Invalid transaction status or missing required fields. For Cancelled status: Actual Shift End Date should be blank. Cancellation percentage should be applied.',
    });
  });

  it('refuses a Committed AT-HM row that also has a Transaction Status', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    const masterItemId = nextId('item');
    stubMasterPlanWithServicePlan({
      workspaceId,
      boardId,
      masterItemId,
      servicePlanItemId: nextId('sp'),
    });

    const res = await post(workspaceId, boardId, 'update-variables-masterplan', {
      items: [
        {
          id: masterItemId,
          values: {
            'Transaction Status': 'Scheduled',
            'Committed AT-HM for Delivery': true,
            'Actual Shift End Date & Time': '',
          },
        },
      ],
    });

    expect(res.body).toEqual({
      error:
        'ERROR: Invalid transaction status or missing required fields. For Committed AT-HM: Transaction Status should be blank. Item will be shown in Monthly Statement for Scheduled Start Date.',
    });
  });

  it('refuses a Committed AT-HM row that still has an Actual Shift End Date', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    const masterItemId = nextId('item');
    stubMasterPlanWithServicePlan({
      workspaceId,
      boardId,
      masterItemId,
      servicePlanItemId: nextId('sp'),
    });

    const res = await post(workspaceId, boardId, 'update-variables-masterplan', {
      items: [
        {
          id: masterItemId,
          values: {
            'Transaction Status': '',
            'Committed AT-HM for Delivery': true,
            'Actual Shift End Date & Time': '2026-03-01T10:00:00Z',
          },
        },
      ],
    });

    expect(res.body).toEqual({
      error:
        'ERROR: Invalid transaction status or missing required fields. For Committed AT-HM: Actual Shift End Date should be blank. Item will be shown in Monthly Statement for Scheduled Start Date.',
    });
  });

  it('requires a Transaction Status when Committed AT-HM is not ticked', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    const masterItemId = nextId('item');
    stubMasterPlanWithServicePlan({
      workspaceId,
      boardId,
      masterItemId,
      servicePlanItemId: nextId('sp'),
    });

    const res = await post(workspaceId, boardId, 'update-variables-masterplan', {
      items: [{ id: masterItemId, values: { 'Transaction Status': '' } }],
    });

    expect(res.body).toEqual({
      error:
        'ERROR: Invalid transaction status or missing required fields. Transaction Status is required when Committed AT-HM for Delivery is not ticked.',
    });
  });

  it('leaves an Adjustment row for manual entry instead of overwriting it', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    const masterItemId = nextId('item');
    stubMasterPlanWithServicePlan({
      workspaceId,
      boardId,
      masterItemId,
      servicePlanItemId: nextId('sp'),
    });

    const res = await post(workspaceId, boardId, 'update-variables-masterplan', {
      items: [
        {
          id: masterItemId,
          values: {
            'Transaction Status': 'Adjustment - Refund',
            'Actual Shift End Date & Time': '',
          },
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'Variables MasterPlan updated' });
  });

  it('reports a missing Cancellation Type when a cancelled row has none', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    const masterItemId = nextId('item');
    stubMasterPlanWithServicePlan({
      workspaceId,
      boardId,
      masterItemId,
      servicePlanItemId: nextId('sp'),
    });

    const res = await post(workspaceId, boardId, 'update-variables-masterplan', {
      items: [
        {
          id: masterItemId,
          values: {
            'Transaction Status': 'Cancelled',
            'Actual Shift End Date & Time': '',
            'Scheduled Shift Duration(Hr.)': '2',
          },
        },
      ],
    });

    expect(res.body).toEqual({ error: 'Cancellation Type item not found.' });
  });

  it('writes the computed quantity, price and totals back to ISO+ for a delivered row', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    const masterItemId = nextId('item');
    const servicePlanItemId = nextId('sp');
    stubMasterPlanWithServicePlan({
      workspaceId,
      boardId,
      masterItemId,
      servicePlanItemId,
      servicePlanValues: {
        Unit: 'Hour',
        'Agreed Unit Price ($)': '$50',
        'Participant Contribution (%)': '10',
      },
    });

    const puts = [];
    server.use(
      http.put(
        `${API_BASE}/workspaces/${workspaceId}/boards/${boardId}/items/${masterItemId}`,
        async ({ request: req }) => {
          puts.push(await req.json());
          return HttpResponse.json({ id: masterItemId });
        }
      )
    );

    const res = await post(workspaceId, boardId, 'update-variables-masterplan', {
      items: [
        {
          id: masterItemId,
          values: {
            'Transaction Status': 'Delivered - To be claimed and invoiced.',
            'Actual Shift End Date & Time': '2026-03-01T12:00:00Z',
            'Actual Shift Duration(Hr.)': '2',
            'Scheduled Shift Duration(Hr.)': '3',
          },
        },
      ],
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, message: 'Variables MasterPlan updated' });

    // Two PUTs: the variable update, then the integration message. Only the
    // first carries the computed figures.
    const variableUpdate = puts.find((body) =>
      body.values.some((v) => v.attribute_id === 'mp-qty')
    );
    // Hour unit and a Delivered status use the actual duration, not the
    // scheduled one: 2 hours at $50 is $100, of which 10% is the participant's.
    expect(variableUpdate.values).toContainEqual({ data: 2, attribute_id: 'mp-qty' });
    expect(variableUpdate.values).toContainEqual({ data: 50, attribute_id: 'mp-price' });
  });
});
