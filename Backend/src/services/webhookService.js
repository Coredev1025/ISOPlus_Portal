import axios from 'axios';
import { info, error, warn } from '../utils/logger.js';
import {
  deleteExistingBoardHooks,
  resolveDuplicateHookRegistration,
  BOARD_WEBHOOK_EVENTS,
  getHookCallbackUrl,
  validateHookRegistrationAuthorization,
  buildSuccessfulHookRegistration,
  cleanupExistingBoardHooks,
} from '../utils/webhookServiceHelpers.js';
import {
  sanitizeApiPathSegment,
} from '../utils/securityHelpers.js';

const ISO_PLUS_API_VERSION = '2026-04-20.morava';
const ISO_PLUS_API_V2_BASE = 'https://app.isoplus.online/api/v2';

function buildSafeBoardHooksUrl(workspaceId, boardId) {
  const safeWorkspaceId = encodeURIComponent(sanitizeApiPathSegment(workspaceId, 'workspaceId'));
  const safeBoardId = encodeURIComponent(sanitizeApiPathSegment(boardId, 'boardId'));
  return `${ISO_PLUS_API_V2_BASE}/workspaces/${safeWorkspaceId}/boards/${safeBoardId}/hooks`;
}

function buildSafeBoardHookUrl(workspaceId, boardId, hookId) {
  const safeWorkspaceId = encodeURIComponent(sanitizeApiPathSegment(workspaceId, 'workspaceId'));
  const safeBoardId = encodeURIComponent(sanitizeApiPathSegment(boardId, 'boardId'));
  const safeHookId = encodeURIComponent(sanitizeApiPathSegment(hookId, 'hookId'));
  return `${ISO_PLUS_API_V2_BASE}/workspaces/${safeWorkspaceId}/boards/${safeBoardId}/hooks/${safeHookId}`;
}

/**
 * Get all hooks for a board
 */
export async function getBoardHooks(authorization, workspaceId, boardId) {
  try {
    if (!authorization) {
      return { success: false, error: 'Authorization token is required' };
    }

    const url = buildSafeBoardHooksUrl(workspaceId, boardId);
    const headers = {
      'Authorization': authorization,
      'Accept': 'application/json',
      'X-API-Version': ISO_PLUS_API_VERSION
    };

    const response = await axios.get(url, { headers });

    if (response.status === 200) {
      return {
        success: true,
        hooks: response.data || []
      };
    } else {
      throw new Error(`Unexpected response status: ${response.status}`);
    }

  } catch (err) {
    // If 404, return empty array (no hooks exist)
    if (err.response?.status === 404) {
      return {
        success: true,
        hooks: []
      };
    }

    warn('Webhook-Service', 'Failed to get board hooks', {
      workspaceId,
      boardId,
      error: err.message
    });

    return {
      success: false,
      error: err.message,
      hooks: []
    };
  }
}

export async function registerHook(authorization, workspaceId, boardId, events, callbackUrl) {
  try {
    info('Webhook-Service', 'Registering hook', { 
      workspaceId, 
      boardId, 
      events, 
      callbackUrl,
      authorization: authorization ? 'present' : 'missing'
    });

    if (!authorization) {
      throw new Error('Authorization token is required');
    }

    if (!callbackUrl) {
      throw new Error('Callback URL is required');
    }

    const url = buildSafeBoardHooksUrl(workspaceId, boardId);
    const headers = {
      'Authorization': authorization,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-API-Version': ISO_PLUS_API_VERSION
    };

    const payload = {
      url: callbackUrl,
      events: events.map(event => ({ event }))
    };

    info('Webhook-Service', 'Making API request', { 
      url,
      payload,
      headers: { ...headers, Authorization: 'REDACTED' }
    });

    const response = await axios.post(url, payload, { headers });

    if (response.status === 200 || response.status === 201) {
      info('Webhook-Service', 'Hook registered successfully', { 
        workspaceId, 
        boardId, 
        events,
        hookId: response.data.id,
        secret: response.data.secret ? 'present' : 'missing'
      });

      return {
        success: true,
        hookId: response.data.id,
        secret: response.data.secret,
        events: events,
        data: response.data
      };
    } else {
      throw new Error(`Unexpected response status: ${response.status}`);
    }

  } catch (err) {
    error('Webhook-Service', 'Failed to register hook', { 
      workspaceId, 
      boardId, 
      events,
      error: err.message,
      statusCode: err.response?.status,
      responseData: err.response?.data,
      requestData: err.config?.data
    });

    return {
      success: false,
      error: err.response?.data?.message || err.message,
      errorDetails: err.response?.data,
      events: events
    };
  }
}

export async function unregisterHook(authorization, workspaceId, boardId, hookId) {
  try {
    if (!hookId) {
      warn('Webhook-Service', 'No hook ID provided for unregistration', { 
        workspaceId, 
        boardId 
      });
      return { success: true, message: 'No hook to unregister' };
    }

    info('Webhook-Service', 'Unregistering hook', { 
      workspaceId, 
      boardId, 
      hookId 
    });

    const url = buildSafeBoardHookUrl(workspaceId, boardId, hookId);
    const headers = {
      'Authorization': authorization,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-API-Version': ISO_PLUS_API_VERSION
    };

    const response = await axios.delete(url, { headers });

    if (response.status === 200 || response.status === 204) {
      info('Webhook-Service', 'Hook unregistered successfully', { 
        workspaceId, 
        boardId, 
        hookId,
        deleted: response.data?.deleted
      });

      return {
        success: true,
        hookId: hookId,
        deleted: response.data?.deleted
      };
    } else {
      throw new Error(`Unexpected response status: ${response.status}`);
    }

  } catch (err) {
    // If hook doesn't exist (404), consider it a success
    if (err.response?.status === 404) {
      warn('Webhook-Service', 'Hook not found (already removed)', { 
        workspaceId, 
        boardId, 
        hookId 
      });
      return {
        success: true,
        hookId: hookId,
        message: 'Hook not found (already removed)'
      };
    }

    error('Webhook-Service', 'Failed to unregister hook', { 
      workspaceId, 
      boardId, 
      hookId,
      error: err.message,
      response: err.response?.data
    });

    return {
      success: false,
      error: err.message,
      hookId: hookId
    };
  }
}

export async function registerBoardWebhooks(authorization, workspaceId, boardId) {
  try {
    const safeWorkspaceId = sanitizeApiPathSegment(workspaceId, 'workspaceId');
    const safeBoardId = sanitizeApiPathSegment(boardId, 'boardId');
    info('Webhook-Service', 'Registering hook for board', { 
      workspaceId: safeWorkspaceId, 
      boardId: safeBoardId,
      authorization: authorization ? 'present' : 'missing',
      backendUrl: process.env.BACKEND_URL || 'NOT SET'
    });

    const authError = validateHookRegistrationAuthorization(authorization, safeWorkspaceId, safeBoardId, error);
    if (authError) {
      return authError;
    }

    const { hookCallbackUrl, usingDefault } = getHookCallbackUrl();
    if (usingDefault) {
      warn('Webhook-Service', 'BACKEND_URL environment variable not set, using localhost', {});
    }

    await cleanupExistingBoardHooks({
      getBoardHooks,
      unregisterHook,
      authorization,
      workspaceId: safeWorkspaceId,
      boardId: safeBoardId,
      info,
      warn,
    });

    info('Webhook-Service', 'Attempting hook registration', {
      workspaceId: safeWorkspaceId,
      boardId: safeBoardId,
      hookCallbackUrl,
      events: BOARD_WEBHOOK_EVENTS,
    });

    const result = await registerHook(
      authorization, 
      safeWorkspaceId, 
      safeBoardId, 
      BOARD_WEBHOOK_EVENTS,
      hookCallbackUrl
    );

    if (result.success) {
      info('Webhook-Service', 'Hook registration completed successfully', { 
        workspaceId: safeWorkspaceId, 
        boardId: safeBoardId,
        hookId: result.hookId,
        events: BOARD_WEBHOOK_EVENTS,
      });

      return buildSuccessfulHookRegistration(result, BOARD_WEBHOOK_EVENTS);
    }

    const duplicateHook = await resolveDuplicateHookRegistration({
      result,
      getBoardHooks,
      authorization,
      workspaceId: safeWorkspaceId,
      boardId: safeBoardId,
      hookCallbackUrl,
      events: BOARD_WEBHOOK_EVENTS,
      info,
    });
    if (duplicateHook) {
      return duplicateHook;
    }

    warn('Webhook-Service', 'Hook registration failed', { 
      workspaceId: safeWorkspaceId, 
      boardId: safeBoardId,
      error: result.error,
      errorDetails: result.errorDetails
    });

    return {
      success: false,
      error: result.error,
      errorDetails: result.errorDetails
    };

  } catch (err) {
    error('Webhook-Service', 'Failed to register board hook', { 
      workspaceId, 
      boardId,
      error: err.message,
      stack: err.stack
    });

    return {
      success: false,
      error: err.message
    };
  }
}

export async function unregisterBoardWebhooks(authorization, workspaceId, boardId, hookId) {
  try {
    info('Webhook-Service', 'Unregistering hook for board', { 
      workspaceId, 
      boardId,
      hookId 
    });

    if (!hookId) {
      info('Webhook-Service', 'No hook to unregister', { 
        workspaceId, 
        boardId 
      });
      return { success: true, message: 'No hook to unregister' };
    }

    const result = await unregisterHook(
      authorization, 
      workspaceId, 
      boardId, 
      hookId
    );

    if (result.success) {
      info('Webhook-Service', 'Hook unregistration completed successfully', { 
        workspaceId, 
        boardId,
        hookId: hookId
      });

      return {
        success: true,
        hookId: hookId,
        deleted: result.deleted
      };
    } else {
      warn('Webhook-Service', 'Hook unregistration failed', { 
        workspaceId, 
        boardId,
        hookId: hookId,
        error: result.error
      });

      return {
        success: false,
        error: result.error
      };
    }

  } catch (err) {
    error('Webhook-Service', 'Failed to unregister board hook', { 
      workspaceId, 
      boardId,
      error: err.message 
    });

    return {
      success: false,
      error: err.message
    };
  }
}

