import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  BOARD_WEBHOOK_EVENTS,
  getHookCallbackUrl,
  validateHookRegistrationAuthorization,
  buildSuccessfulHookRegistration,
  cleanupExistingBoardHooks,
  deleteExistingBoardHooks,
  resolveDuplicateHookRegistration,
  registerHookForEvents,
} from '../../../src/utils/webhookServiceHelpers.js';

// Hook shapes mirror what ISO+ /api/v2/.../hooks actually returns, as consumed
// by src/services/webhookService.js: { id, url, secret, events: [{ event }] }.
const isoplusHook = (overrides = {}) => ({
  id: 'hook_01',
  url: 'https://portal.example.com/api/webhooks/isoplus',
  secret: 'whsec_abc123',
  events: [{ event: 'item.updated' }],
  ...overrides,
});

describe('BOARD_WEBHOOK_EVENTS', () => {
  it('is the exact set of eight board events, in registration order', () => {
    expect(BOARD_WEBHOOK_EVENTS).toEqual([
      'item.created',
      'item.updated',
      'item.deleted',
      'item.finalized',
      'value.created',
      'value.updated',
      'comment.created',
      'comment.updated',
    ]);
  });
});

describe('getHookCallbackUrl', () => {
  const originalBackendUrl = process.env.BACKEND_URL;

  afterEach(() => {
    if (originalBackendUrl === undefined) {
      delete process.env.BACKEND_URL;
    } else {
      process.env.BACKEND_URL = originalBackendUrl;
    }
  });

  it('falls back to the localhost:3001 callback and flags it as a default', () => {
    delete process.env.BACKEND_URL;

    expect(getHookCallbackUrl()).toEqual({
      hookCallbackUrl: 'http://localhost:3001/api/webhooks/isoplus',
      usingDefault: true,
    });
  });

  it('appends the webhook path to BACKEND_URL when it is set', () => {
    process.env.BACKEND_URL = 'https://api.example.com';

    expect(getHookCallbackUrl()).toEqual({
      hookCallbackUrl: 'https://api.example.com/api/webhooks/isoplus',
      usingDefault: false,
    });
  });

  it('treats an empty BACKEND_URL as unset rather than building "/api/webhooks/isoplus"', () => {
    process.env.BACKEND_URL = '';

    expect(getHookCallbackUrl()).toEqual({
      hookCallbackUrl: 'http://localhost:3001/api/webhooks/isoplus',
      usingDefault: true,
    });
  });
});

describe('validateHookRegistrationAuthorization', () => {
  it('returns null and logs nothing when an authorization header is present', () => {
    const error = vi.fn();

    expect(validateHookRegistrationAuthorization('Bearer tok', 'ws_1', 'b_1', error)).toBeNull();
    expect(error).not.toHaveBeenCalled();
  });

  it('returns a failure result and logs the error when authorization is missing', () => {
    const error = vi.fn();

    const result = validateHookRegistrationAuthorization(undefined, 'ws_1', 'b_1', error);

    expect(result).toEqual({
      success: false,
      error: 'Authorization token is required for hook registration',
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(
      'Webhook-Service',
      'Authorization token is required for hook registration',
      { workspaceId: 'ws_1', boardId: 'b_1' },
    );
  });

  it('treats an empty-string authorization as missing', () => {
    const error = vi.fn();

    expect(validateHookRegistrationAuthorization('', 'ws_1', 'b_1', error)).toEqual({
      success: false,
      error: 'Authorization token is required for hook registration',
    });
  });
});

describe('buildSuccessfulHookRegistration', () => {
  it('lifts hookId and secret out of the registration result and attaches the events', () => {
    const result = { hookId: 'hook_01', secret: 'whsec_abc123', data: { ignored: true } };

    expect(buildSuccessfulHookRegistration(result, ['item.created', 'item.updated'])).toEqual({
      success: true,
      hookId: 'hook_01',
      secret: 'whsec_abc123',
      events: ['item.created', 'item.updated'],
    });
  });

  it('carries undefined hookId/secret through rather than inventing values', () => {
    expect(buildSuccessfulHookRegistration({}, [])).toEqual({
      success: true,
      hookId: undefined,
      secret: undefined,
      events: [],
    });
  });
});

describe('deleteExistingBoardHooks', () => {
  let unregisterHook;
  let info;
  let warn;

  beforeEach(() => {
    unregisterHook = vi.fn().mockResolvedValue({ success: true });
    info = vi.fn();
    warn = vi.fn();
  });

  it('unregisters every hook in order and logs one success per hook', async () => {
    const hooks = [isoplusHook({ id: 'hook_01' }), isoplusHook({ id: 'hook_02' })];

    await deleteExistingBoardHooks(hooks, unregisterHook, 'Bearer tok', 'ws_1', 'b_1', info, warn);

    expect(unregisterHook.mock.calls).toEqual([
      ['Bearer tok', 'ws_1', 'b_1', 'hook_01'],
      ['Bearer tok', 'ws_1', 'b_1', 'hook_02'],
    ]);
    expect(info).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenNthCalledWith(1, 'Webhook-Service', 'Deleted existing hook', {
      workspaceId: 'ws_1', boardId: 'b_1', hookId: 'hook_01',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('skips hooks with no id without logging them', async () => {
    const hooks = [{ url: 'https://x' }, isoplusHook({ id: 'hook_02' }), { id: '' }];

    await deleteExistingBoardHooks(hooks, unregisterHook, 'Bearer tok', 'ws_1', 'b_1', info, warn);

    expect(unregisterHook).toHaveBeenCalledTimes(1);
    expect(unregisterHook).toHaveBeenCalledWith('Bearer tok', 'ws_1', 'b_1', 'hook_02');
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('warns and keeps going when one deletion rejects', async () => {
    unregisterHook
      .mockRejectedValueOnce(new Error('403 Forbidden'))
      .mockResolvedValueOnce({ success: true });

    await deleteExistingBoardHooks(
      [isoplusHook({ id: 'hook_01' }), isoplusHook({ id: 'hook_02' })],
      unregisterHook, 'Bearer tok', 'ws_1', 'b_1', info, warn,
    );

    expect(unregisterHook).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('Webhook-Service', 'Failed to delete existing hook', {
      workspaceId: 'ws_1', boardId: 'b_1', hookId: 'hook_01', error: '403 Forbidden',
    });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith('Webhook-Service', 'Deleted existing hook', {
      workspaceId: 'ws_1', boardId: 'b_1', hookId: 'hook_02',
    });
  });

  it('does nothing for an empty hook list', async () => {
    await deleteExistingBoardHooks([], unregisterHook, 'Bearer tok', 'ws_1', 'b_1', info, warn);

    expect(unregisterHook).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('cleanupExistingBoardHooks', () => {
  const baseArgs = () => ({
    unregisterHook: vi.fn().mockResolvedValue({ success: true }),
    authorization: 'Bearer tok',
    workspaceId: 'ws_1',
    boardId: 'b_1',
    info: vi.fn(),
    warn: vi.fn(),
  });

  it('deletes every existing hook and logs the count first', async () => {
    const args = baseArgs();
    const getBoardHooks = vi.fn().mockResolvedValue({
      success: true,
      hooks: [isoplusHook({ id: 'hook_01' }), isoplusHook({ id: 'hook_02' })],
    });

    await cleanupExistingBoardHooks({ ...args, getBoardHooks });

    expect(getBoardHooks).toHaveBeenCalledWith('Bearer tok', 'ws_1', 'b_1');
    expect(args.info).toHaveBeenNthCalledWith(1, 'Webhook-Service', 'Found existing hooks, deleting them', {
      workspaceId: 'ws_1', boardId: 'b_1', hookCount: 2,
    });
    expect(args.unregisterHook).toHaveBeenCalledTimes(2);
  });

  it('does nothing when the hook lookup failed', async () => {
    const args = baseArgs();
    const getBoardHooks = vi.fn().mockResolvedValue({ success: false, error: 'boom', hooks: [] });

    await cleanupExistingBoardHooks({ ...args, getBoardHooks });

    expect(args.unregisterHook).not.toHaveBeenCalled();
    expect(args.info).not.toHaveBeenCalled();
  });

  it('does nothing when the board has no hooks', async () => {
    const args = baseArgs();

    await cleanupExistingBoardHooks({ ...args, getBoardHooks: vi.fn().mockResolvedValue({ success: true, hooks: [] }) });
    expect(args.unregisterHook).not.toHaveBeenCalled();

    await cleanupExistingBoardHooks({ ...args, getBoardHooks: vi.fn().mockResolvedValue({ success: true }) });
    expect(args.unregisterHook).not.toHaveBeenCalled();
    expect(args.info).not.toHaveBeenCalled();
  });

  it('lets a rejection from the hook lookup propagate', async () => {
    const args = baseArgs();
    const getBoardHooks = vi.fn().mockRejectedValue(new Error('network down'));

    await expect(cleanupExistingBoardHooks({ ...args, getBoardHooks })).rejects.toThrow('network down');
  });
});

describe('resolveDuplicateHookRegistration', () => {
  const events = ['item.created', 'item.updated'];
  const callbackUrl = 'https://portal.example.com/api/webhooks/isoplus';

  const call = (overrides) => resolveDuplicateHookRegistration({
    getBoardHooks: vi.fn(),
    authorization: 'Bearer tok',
    workspaceId: 'ws_1',
    boardId: 'b_1',
    hookCallbackUrl: callbackUrl,
    events,
    info: vi.fn(),
    ...overrides,
  });

  it('returns null without looking anything up when the registration succeeded', async () => {
    const getBoardHooks = vi.fn();

    expect(await call({ result: { success: true, hookId: 'hook_01' }, getBoardHooks })).toBeNull();
    expect(getBoardHooks).not.toHaveBeenCalled();
  });

  it('returns null for a failure that is not a duplicate', async () => {
    const getBoardHooks = vi.fn();

    expect(await call({ result: { success: false, error: 'Authorization token is required' }, getBoardHooks })).toBeNull();
    expect(getBoardHooks).not.toHaveBeenCalled();
  });

  it('returns null when the failure carries neither an error string nor errorDetails', async () => {
    const getBoardHooks = vi.fn();

    expect(await call({ result: { success: false }, getBoardHooks })).toBeNull();
    expect(getBoardHooks).not.toHaveBeenCalled();
  });

  it.each([
    ['a 409 errorDetails code', { success: false, errorDetails: { code: 409 } }],
    ['an "already exists" message', { success: false, error: 'Hook already exists for this board' }],
    ['a "duplicate" message', { success: false, error: 'duplicate hook' }],
  ])('recognises %s as a duplicate and reuses the matching hook', async (_label, result) => {
    const info = vi.fn();
    const existing = isoplusHook({ id: 'hook_77', url: callbackUrl, secret: 'whsec_existing' });
    const getBoardHooks = vi.fn().mockResolvedValue({ success: true, hooks: [existing] });

    const resolved = await call({ result, getBoardHooks, info });

    expect(getBoardHooks).toHaveBeenCalledWith('Bearer tok', 'ws_1', 'b_1');
    expect(resolved).toEqual({
      success: true,
      hookId: 'hook_77',
      secret: 'whsec_existing',
      events,
      existing: true,
    });
    expect(info).toHaveBeenCalledWith('Webhook-Service', 'Using existing hook', {
      workspaceId: 'ws_1', boardId: 'b_1', hookId: 'hook_77',
    });
  });

  it('does not treat a non-409 errorDetails code as a duplicate', async () => {
    const getBoardHooks = vi.fn();

    expect(await call({ result: { success: false, errorDetails: { code: 500 } }, getBoardHooks })).toBeNull();
    expect(getBoardHooks).not.toHaveBeenCalled();
  });

  it('matches on a subscribed event when the url differs', async () => {
    const existing = isoplusHook({
      id: 'hook_88',
      url: 'https://old-host.example.com/api/webhooks/isoplus',
      events: [{ event: 'item.updated' }],
    });
    const getBoardHooks = vi.fn().mockResolvedValue({ success: true, hooks: [existing] });

    const resolved = await call({ result: { success: false, errorDetails: { code: 409 } }, getBoardHooks });

    expect(resolved.hookId).toBe('hook_88');
    expect(resolved.existing).toBe(true);
  });

  it('matches a plain-string event entry as well as the { event } object form', async () => {
    const existing = isoplusHook({ id: 'hook_99', url: 'https://elsewhere', events: ['item.created'] });
    const getBoardHooks = vi.fn().mockResolvedValue({ success: true, hooks: [existing] });

    const resolved = await call({ result: { success: false, errorDetails: { code: 409 } }, getBoardHooks });

    expect(resolved.hookId).toBe('hook_99');
  });

  it('returns null when no existing hook matches by url or event', async () => {
    const existing = isoplusHook({
      id: 'hook_00',
      url: 'https://elsewhere.example.com/hook',
      events: [{ event: 'board.archived' }],
    });
    const info = vi.fn();
    const getBoardHooks = vi.fn().mockResolvedValue({ success: true, hooks: [existing] });

    expect(await call({ result: { success: false, errorDetails: { code: 409 } }, getBoardHooks, info })).toBeNull();
    expect(info).not.toHaveBeenCalled();
  });

  it('returns null when the duplicate lookup itself fails or comes back empty', async () => {
    const duplicate = { success: false, error: 'already exists' };

    expect(await call({ result: duplicate, getBoardHooks: vi.fn().mockResolvedValue({ success: false, hooks: [] }) })).toBeNull();
    expect(await call({ result: duplicate, getBoardHooks: vi.fn().mockResolvedValue({ success: true, hooks: [] }) })).toBeNull();
    expect(await call({ result: duplicate, getBoardHooks: vi.fn().mockResolvedValue({ success: true }) })).toBeNull();
  });

  it('picks the first hook that matches, not the last', async () => {
    const getBoardHooks = vi.fn().mockResolvedValue({
      success: true,
      hooks: [
        isoplusHook({ id: 'hook_first', url: callbackUrl, secret: 's1' }),
        isoplusHook({ id: 'hook_second', url: callbackUrl, secret: 's2' }),
      ],
    });

    const resolved = await call({ result: { success: false, errorDetails: { code: 409 } }, getBoardHooks });

    expect(resolved.hookId).toBe('hook_first');
    expect(resolved.secret).toBe('s1');
  });
});

describe('registerHookForEvents', () => {
  it('registers one hook per event, sequentially, and pairs each result with its event', async () => {
    const calls = [];
    const registerHook = vi.fn(async (auth, ws, board, event, url) => {
      calls.push(event);
      return { success: true, hookId: `hook_${event}`, data: { url } };
    });

    const results = await registerHookForEvents(
      ['item.created', 'value.updated'],
      registerHook, 'Bearer tok', 'ws_1', 'b_1', 'https://cb.example.com/api/webhooks/isoplus',
    );

    expect(calls).toEqual(['item.created', 'value.updated']);
    expect(registerHook.mock.calls[0]).toEqual([
      'Bearer tok', 'ws_1', 'b_1', 'item.created', 'https://cb.example.com/api/webhooks/isoplus',
    ]);
    expect(results).toEqual([
      { event: 'item.created', result: { success: true, hookId: 'hook_item.created', data: { url: 'https://cb.example.com/api/webhooks/isoplus' } } },
      { event: 'value.updated', result: { success: true, hookId: 'hook_value.updated', data: { url: 'https://cb.example.com/api/webhooks/isoplus' } } },
    ]);
  });

  it('keeps failed registrations in the result list rather than dropping them', async () => {
    const registerHook = vi.fn()
      .mockResolvedValueOnce({ success: false, error: 'Hook already exists', errorDetails: { code: 409 } })
      .mockResolvedValueOnce({ success: true, hookId: 'hook_02' });

    const results = await registerHookForEvents(
      ['item.created', 'item.updated'], registerHook, 'Bearer tok', 'ws_1', 'b_1', 'https://cb',
    );

    expect(results).toHaveLength(2);
    expect(results[0].result.success).toBe(false);
    expect(results[1].result.success).toBe(true);
  });

  it('returns an empty list and never calls registerHook for no events', async () => {
    const registerHook = vi.fn();

    expect(await registerHookForEvents([], registerHook, 'Bearer tok', 'ws_1', 'b_1', 'https://cb')).toEqual([]);
    expect(registerHook).not.toHaveBeenCalled();
  });

  it('propagates a rejection instead of swallowing it, stopping further registrations', async () => {
    const registerHook = vi.fn()
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(new Error('socket hang up'));

    await expect(registerHookForEvents(
      ['item.created', 'item.updated', 'item.deleted'], registerHook, 'Bearer tok', 'ws_1', 'b_1', 'https://cb',
    )).rejects.toThrow('socket hang up');

    expect(registerHook).toHaveBeenCalledTimes(2);
  });
});
