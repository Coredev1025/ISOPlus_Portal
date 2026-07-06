export const BOARD_WEBHOOK_EVENTS = [
  'item.created',
  'item.updated',
  'item.deleted',
  'item.finalized',
  'value.created',
  'value.updated',
  'comment.created',
  'comment.updated',
];

export function getHookCallbackUrl() {
  if (!process.env.BACKEND_URL) {
    return { hookCallbackUrl: 'http://localhost:3001/api/webhooks/isoplus', usingDefault: true };
  }
  return { hookCallbackUrl: `${process.env.BACKEND_URL}/api/webhooks/isoplus`, usingDefault: false };
}

export function validateHookRegistrationAuthorization(authorization, workspaceId, boardId, error) {
  if (authorization) {
    return null;
  }
  const errorMsg = 'Authorization token is required for hook registration';
  error('Webhook-Service', errorMsg, { workspaceId, boardId });
  return { success: false, error: errorMsg };
}

export function buildSuccessfulHookRegistration(result, events) {
  return {
    success: true,
    hookId: result.hookId,
    secret: result.secret,
    events,
  };
}

export async function cleanupExistingBoardHooks({
  getBoardHooks,
  unregisterHook,
  authorization,
  workspaceId,
  boardId,
  info,
  warn,
}) {
  const existingHooksResult = await getBoardHooks(authorization, workspaceId, boardId);
  if (!existingHooksResult.success || !existingHooksResult.hooks?.length) {
    return;
  }

  info('Webhook-Service', 'Found existing hooks, deleting them', {
    workspaceId,
    boardId,
    hookCount: existingHooksResult.hooks.length,
  });

  await deleteExistingBoardHooks(
    existingHooksResult.hooks,
    unregisterHook,
    authorization,
    workspaceId,
    boardId,
    info,
    warn,
  );
}

export async function deleteExistingBoardHooks(existingHooks, unregisterHook, authorization, workspaceId, boardId, info, warn) {
  for (const hook of existingHooks) {
    if (!hook.id) continue;
    try {
      await unregisterHook(authorization, workspaceId, boardId, hook.id);
      info('Webhook-Service', 'Deleted existing hook', {
        workspaceId,
        boardId,
        hookId: hook.id,
      });
    } catch (deleteErr) {
      warn('Webhook-Service', 'Failed to delete existing hook', {
        workspaceId,
        boardId,
        hookId: hook.id,
        error: deleteErr.message,
      });
    }
  }
}

export async function resolveDuplicateHookRegistration({
  result,
  getBoardHooks,
  authorization,
  workspaceId,
  boardId,
  hookCallbackUrl,
  events,
  info,
}) {
  if (result.success) {
    return null;
  }

  const isDuplicate = result.errorDetails?.code === 409
    || result.error?.includes('already exists')
    || result.error?.includes('duplicate');
  if (!isDuplicate) {
    return null;
  }

  const hooksResult = await getBoardHooks(authorization, workspaceId, boardId);
  if (!hooksResult.success || !hooksResult.hooks?.length) {
    return null;
  }

  const existingHook = hooksResult.hooks.find((hook) =>
    hook.url === hookCallbackUrl
    || hook.events?.some((event) => events.includes(event.event || event)),
  );
  if (!existingHook) {
    return null;
  }

  info('Webhook-Service', 'Using existing hook', {
    workspaceId,
    boardId,
    hookId: existingHook.id,
  });

  return {
    success: true,
    hookId: existingHook.id,
    secret: existingHook.secret,
    events,
    existing: true,
  };
}

export async function registerHookForEvents(events, registerHook, authorization, workspaceId, boardId, hookCallbackUrl) {
  const results = [];
  for (const event of events) {
    const result = await registerHook(authorization, workspaceId, boardId, event, hookCallbackUrl);
    results.push({ event, result });
  }
  return results;
}
