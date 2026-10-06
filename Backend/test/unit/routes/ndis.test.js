import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { http, HttpResponse } from 'msw';
import { createApp } from '../../../src/app.js';
import { server } from '../../msw/server.js';

/**
 * src/routes/ndis.js, mounted at /api/care-management-ndis-pricing. ISO+
 * automations post here; the routes are unauthenticated and answer 200 with the
 * outcome in the body.
 *
 * Which code path a request takes is decided by
 * inferPricingRuleFromServicePlanData (src/utils/ndisPricingRules.js): a
 * payload carrying the legacy 'Direct Support Item Number' key and not the new
 * 'Support Item Number' key resolves to the legacy rule with no database or
 * ISO+ lookup at all, which is what makes these tests deterministic. Board ids
 * are unique per test so the module-level five-minute board rule cache cannot
 * leak between them.
 */

const app = createApp();
const API_BASE = 'https://app.isoplus.online/api/v2';
const BASE = '/api/care-management-ndis-pricing';

let counter = 0;
const nextId = (prefix) => `${prefix}-${Date.now()}-${counter++}`;

/** A values object that pins the legacy pricing rule without any lookup. */
const legacyValues = (extra = {}) => ({ 'Direct Support Item Number': [], ...extra });

const post = (workspaceId, boardId, route, body, query = {}) =>
  request(app).post(`${BASE}/${workspaceId}/${boardId}/${route}`).query(query).send(body);

function stubReferencesUnavailable(workspaceId, boardId) {
  server.use(
    http.get(`${API_BASE}/workspaces/${workspaceId}/boards/${boardId}/references`, () =>
      HttpResponse.json({ message: 'upstream failure' }, { status: 500 })
    )
  );
}

const NEW_PRICING_ITEM_ROUTES = [
  'participants-support-item',
  'participants-provider-travel-item',
  'participants-labour-travel-item',
  'participants-cancellation-item',
  'participants-activity-transport-item',
  'participants-activity-based-transport-item',
];

describe('per-item pricing routes reject a payload without an item id', () => {
  it.each(NEW_PRICING_ITEM_ROUTES)('answers 200 with Missing item id for /%s', async (route) => {
    const res = await post(nextId('ws'), nextId('board'), route, {});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ error: 'Invalid payload', message: 'Missing item id' });
  });

  it.each(NEW_PRICING_ITEM_ROUTES)('also rejects an empty items array for /%s', async (route) => {
    const res = await post(nextId('ws'), nextId('board'), route, { items: [] });

    expect(res.body).toEqual({ error: 'Invalid payload', message: 'Missing item id' });
  });
});

describe('per-item pricing routes stop when the board is on the legacy rule', () => {
  it.each(NEW_PRICING_ITEM_ROUTES)('answers 200 with the legacy notice for /%s', async (route) => {
    const res = await post(nextId('ws'), nextId('board'), route, {
      items: [{ id: nextId('item'), values: legacyValues() }],
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      error: 'Legacy pricing rule applies for this service plan board.',
    });
  });
});

describe('POST /:workspaceId/:boardId/participants-service-plan', () => {
  it('rejects a payload with no items', async () => {
    const res = await post(nextId('ws'), nextId('board'), 'participants-service-plan', {});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ error: 'Invalid payload', message: 'Missing item id' });
  });

  it('rejects an item with no id', async () => {
    const res = await post(nextId('ws'), nextId('board'), 'participants-service-plan', {
      items: [{ values: legacyValues() }],
    });

    expect(res.body).toEqual({ error: 'Invalid payload', message: 'Missing item id' });
  });

  it('reports an unrecognised type without touching pricing', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubReferencesUnavailable(workspaceId, boardId);

    const res = await post(
      workspaceId,
      boardId,
      'participants-service-plan',
      { items: [{ id: nextId('item'), values: legacyValues() }] },
      { type: 'not_a_real_type' }
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ error: 'Invalid type', message: 'Invalid type in set-unit' });
  });

  it('reports a missing Direct Support item when ISO+ returns no references', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubReferencesUnavailable(workspaceId, boardId);

    const res = await post(
      workspaceId,
      boardId,
      'participants-service-plan',
      { items: [{ id: nextId('item'), values: legacyValues() }] },
      { type: 'direct_support' }
    );

    expect(res.body).toEqual({ error: 'Direct Support Item not found' });
  });

  it('reports a missing Centre Capital Cost item for that type', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubReferencesUnavailable(workspaceId, boardId);

    const res = await post(
      workspaceId,
      boardId,
      'participants-service-plan',
      { items: [{ id: nextId('item'), values: legacyValues() }] },
      { type: 'centre_capital_cost' }
    );

    expect(res.body).toEqual({ error: 'Centre Capital Cost Item not found' });
  });
});

describe('POST /:workspaceId/:boardId/set-unit-and-unitprice', () => {
  it('reports an unrecognised type', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubReferencesUnavailable(workspaceId, boardId);

    const res = await post(
      workspaceId,
      boardId,
      'set-unit-and-unitprice',
      { items: [{ id: nextId('item'), values: legacyValues() }] },
      { type: 'nonsense' }
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      error: 'Invalid type',
      message: 'Invalid type in set-unit-and-unitprice',
    });
  });

  it('treats a missing type as unrecognised too, unlike participants-service-plan', async () => {
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubReferencesUnavailable(workspaceId, boardId);

    const res = await post(workspaceId, boardId, 'set-unit-and-unitprice', {
      items: [{ id: nextId('item'), values: legacyValues() }],
    });

    expect(res.body).toEqual({
      error: 'Invalid type',
      message: 'Invalid type in set-unit-and-unitprice',
    });
  });

  it('reports each missing referenced pricing item by name', async () => {
    const cases = [
      ['direct_support', 'Direct Support Item not found'],
      ['activity_based_transport', 'Activity Based Transport Item not found'],
      ['provider_travel_non_labour_cost', 'Provider Travel Non Labour Cost Item not found'],
      ['centre_capital_cost', 'Centre Capital Cost Item not found'],
    ];

    for (const [type, expected] of cases) {
      const workspaceId = nextId('ws');
      const boardId = nextId('board');
      stubReferencesUnavailable(workspaceId, boardId);

      const res = await post(
        workspaceId,
        boardId,
        'set-unit-and-unitprice',
        { items: [{ id: nextId('item'), values: legacyValues() }] },
        { type }
      );

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ error: expected });
    }
  });

  it('defaults the service area to ACT($) and reports success for the service_area type', async () => {
    // getQuoteNDISReferencedItems returns nothing, so serviceAreaValues is
    // replaced with the ACT default rather than short-circuiting.
    const workspaceId = nextId('ws');
    const boardId = nextId('board');
    stubReferencesUnavailable(workspaceId, boardId);

    const res = await post(
      workspaceId,
      boardId,
      'set-unit-and-unitprice',
      { items: [{ id: nextId('item'), values: legacyValues() }] },
      { type: 'service_area' }
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Service area processed' });
  });
});
