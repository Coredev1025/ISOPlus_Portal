import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  shouldUpdatePortalAutomation,
  buildUpdatedAutomation,
} from '../../../src/utils/automationUrlUpdate.js';

/**
 * Shape mirrors what ISO+ returns from GET /api/automation/:workspaceId/:boardId
 * (see src/routes/automation.js): a list of automation objects, each with an id,
 * a human name, a trigger, and a workflow array of steps. Only steps that are
 * webhook calls carry config.url.
 */
function portalAutomation(overrides = {}) {
  return {
    id: 'aut_9f21',
    name: 'Portal - Generate Invoice PDF',
    board_id: 'brd_100',
    active: true,
    trigger: { type: 'item_created', attribute_id: 'att_5' },
    workflow: [
      {
        id: 'wf_1',
        type: 'webhook',
        config: {
          method: 'POST',
          url: 'https://old-api.isoplus.online/api/webhooks/ws_old/brd_old?event=create',
          headers: { 'Content-Type': 'application/json' },
        },
      },
      {
        id: 'wf_2',
        type: 'set_value',
        config: { attribute_id: 'att_9', value: 'done' },
      },
    ],
    ...overrides,
  };
}

describe('shouldUpdatePortalAutomation', () => {
  it('accepts only names with the exact "Portal - " prefix', () => {
    expect(shouldUpdatePortalAutomation({ name: 'Portal - Generate Invoice PDF' })).toBe(true);
    expect(shouldUpdatePortalAutomation({ name: 'Portal - ' })).toBe(true);
  });

  it('rejects names that merely contain or differ in case from the prefix', () => {
    expect(shouldUpdatePortalAutomation({ name: 'portal - lowercase' })).toBe(false);
    expect(shouldUpdatePortalAutomation({ name: 'My Portal - Something' })).toBe(false);
    expect(shouldUpdatePortalAutomation({ name: 'Portal-NoSpace' })).toBe(false);
    expect(shouldUpdatePortalAutomation({ name: '' })).toBe(false);
  });

  it('throws when the automation has no name (no guard in the source)', () => {
    expect(() => shouldUpdatePortalAutomation({})).toThrow(TypeError);
  });
});

describe('buildUpdatedAutomation', () => {
  const savedBackendUrl = process.env.BACKEND_URL;

  beforeEach(() => {
    process.env.BACKEND_URL = 'https://portal-api.example.com';
  });

  afterEach(() => {
    if (savedBackendUrl === undefined) delete process.env.BACKEND_URL;
    else process.env.BACKEND_URL = savedBackendUrl;
  });

  it('leaves a non-Portal automation untouched and flags it as not needing an update', () => {
    const item = portalAutomation({ name: 'Notify Team on Overdue' });
    const result = buildUpdatedAutomation(item, 'ws_new', 'brd_new');

    expect(result.needsUpdate).toBe(false);
    expect(result.automation).toBe(item);
  });

  it('rewrites host, workspace id and board id in webhook workflow urls', () => {
    const item = portalAutomation();
    const result = buildUpdatedAutomation(item, 'ws_new', 'brd_new');

    expect(result.needsUpdate).toBe(true);
    expect(result.automation.workflow[0].config.url).toBe(
      'https://portal-api.example.com/api/webhooks/ws_new/brd_new?event=create',
    );
  });

  it('keeps every other automation and workflow field intact', () => {
    const result = buildUpdatedAutomation(portalAutomation(), 'ws_new', 'brd_new');

    expect(result.automation.id).toBe('aut_9f21');
    expect(result.automation.name).toBe('Portal - Generate Invoice PDF');
    expect(result.automation.board_id).toBe('brd_100');
    expect(result.automation.active).toBe(true);
    expect(result.automation.trigger).toEqual({ type: 'item_created', attribute_id: 'att_5' });
    expect(result.automation.workflow[0].type).toBe('webhook');
    expect(result.automation.workflow[0].config.method).toBe('POST');
    expect(result.automation.workflow[0].config.headers).toEqual({
      'Content-Type': 'application/json',
    });
  });

  it('does not mutate the automation it was given', () => {
    const item = portalAutomation();
    buildUpdatedAutomation(item, 'ws_new', 'brd_new');

    expect(item.workflow[0].config.url).toBe(
      'https://old-api.isoplus.online/api/webhooks/ws_old/brd_old?event=create',
    );
  });

  it('returns workflow steps without a config url unchanged, by reference', () => {
    const item = portalAutomation();
    const result = buildUpdatedAutomation(item, 'ws_new', 'brd_new');

    expect(result.automation.workflow[1]).toBe(item.workflow[1]);
  });

  it('strips the protocol from BACKEND_URL but keeps the original url scheme', () => {
    process.env.BACKEND_URL = 'http://localhost:4001';
    const item = portalAutomation({
      workflow: [
        {
          id: 'wf_1',
          type: 'webhook',
          config: { method: 'POST', url: 'https://old-api.isoplus.online/api/pdf/ws_old/brd_old' },
        },
      ],
    });

    const result = buildUpdatedAutomation(item, 'ws_new', 'brd_new');
    expect(result.automation.workflow[0].config.url).toBe(
      'https://localhost:4001/api/pdf/ws_new/brd_new',
    );
  });

  it('leaves the url alone when BACKEND_URL is not configured', () => {
    delete process.env.BACKEND_URL;
    const item = portalAutomation();
    const result = buildUpdatedAutomation(item, 'ws_new', 'brd_new');

    expect(result.needsUpdate).toBe(true);
    expect(result.automation.workflow[0].config.url).toBe(
      'https://old-api.isoplus.online/api/webhooks/ws_old/brd_old?event=create',
    );
  });

  it('leaves urls that do not match the /api/:path/:workspace/:board shape alone', () => {
    const item = portalAutomation({
      workflow: [
        { id: 'wf_1', type: 'webhook', config: { url: 'https://old-api.isoplus.online/api/pdf/ws_old' } },
        { id: 'wf_2', type: 'webhook', config: { url: 'ftp://old-api.isoplus.online/api/a/b/c' } },
      ],
    });

    const result = buildUpdatedAutomation(item, 'ws_new', 'brd_new');
    expect(result.automation.workflow[0].config.url).toBe('https://old-api.isoplus.online/api/pdf/ws_old');
    expect(result.automation.workflow[1].config.url).toBe('ftp://old-api.isoplus.online/api/a/b/c');
  });

  it('rewrites every webhook step in a multi-step workflow', () => {
    const item = portalAutomation({
      workflow: [
        { id: 'wf_1', type: 'webhook', config: { url: 'https://a.example.com/api/webhooks/w1/b1' } },
        { id: 'wf_2', type: 'webhook', config: { url: 'https://b.example.com/api/pdf/w2/b2' } },
      ],
    });

    const result = buildUpdatedAutomation(item, 'ws_new', 'brd_new');
    expect(result.automation.workflow.map((w) => w.config.url)).toEqual([
      'https://portal-api.example.com/api/webhooks/ws_new/brd_new',
      'https://portal-api.example.com/api/pdf/ws_new/brd_new',
    ]);
  });

  it('flags a Portal automation with no workflow array as needing an update, unchanged', () => {
    const item = { id: 'aut_1', name: 'Portal - QR Codes', workflow: null, active: false };
    const result = buildUpdatedAutomation(item, 'ws_new', 'brd_new');

    expect(result.needsUpdate).toBe(true);
    expect(result.automation).toEqual({ id: 'aut_1', name: 'Portal - QR Codes', workflow: null, active: false });
    expect(result.automation).not.toBe(item);
  });
});
