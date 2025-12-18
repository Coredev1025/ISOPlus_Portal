import axios from 'axios';
import { info, error, warn } from '../utils/logger.js';

const ISO_PLUS_API_BASE = 'https://app.isoplus.online/api/v2';
const ISO_PLUS_API_VERSION = '2025-02-26.morava';

/**
 * Get all hooks for a board
 */
export async function getBoardHooks(authorization, workspaceId, boardId) {
  try {
    if (!authorization) {
      return { success: false, error: 'Authorization token is required' };
    }

    const url = `${ISO_PLUS_API_BASE}/workspaces/${workspaceId}/boards/${boardId}/hooks`;
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

    const url = `${ISO_PLUS_API_BASE}/workspaces/${workspaceId}/boards/${boardId}/hooks`;
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

    const url = `${ISO_PLUS_API_BASE}/workspaces/${workspaceId}/boards/${boardId}/hooks/${hookId}`;
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
    info('Webhook-Service', 'Registering hook for board', { 
      workspaceId, 
      boardId,
      authorization: authorization ? 'present' : 'missing',
      backendUrl: process.env.BACKEND_URL || 'NOT SET'
    });

    if (!authorization) {
      const errorMsg = 'Authorization token is required for hook registration';
      error('Webhook-Service', errorMsg, { workspaceId, boardId });
      return {
        success: false,
        error: errorMsg
      };
    }

    if (!process.env.BACKEND_URL) {
      warn('Webhook-Service', 'BACKEND_URL environment variable not set, using localhost', {});
    }

    const hookCallbackUrl = `${process.env.BACKEND_URL || 'http://localhost:3001'}/api/webhooks/isoplus`;
  
    const events = [
      'item.created',
      'item.updated',
      'item.deleted',
      'item.finalized',
      'value.created',
      'value.updated',
      'comment.created',
      'comment.updated'
    ];

    // First, check for existing hooks and delete them to prevent duplicates
    info('Webhook-Service', 'Checking for existing hooks', {
      workspaceId,
      boardId
    });

    const existingHooksResult = await getBoardHooks(authorization, workspaceId, boardId);
    
    if (existingHooksResult.success && existingHooksResult.hooks && existingHooksResult.hooks.length > 0) {
      info('Webhook-Service', 'Found existing hooks, deleting them', {
        workspaceId,
        boardId,
        hookCount: existingHooksResult.hooks.length
      });

      // Delete all existing hooks
      for (const hook of existingHooksResult.hooks) {
        if (hook.id) {
          try {
            await unregisterHook(authorization, workspaceId, boardId, hook.id);
            info('Webhook-Service', 'Deleted existing hook', {
              workspaceId,
              boardId,
              hookId: hook.id
            });
          } catch (deleteErr) {
            warn('Webhook-Service', 'Failed to delete existing hook', {
              workspaceId,
              boardId,
              hookId: hook.id,
              error: deleteErr.message
            });
          }
        }
      }
    }

    info('Webhook-Service', 'Attempting hook registration', {
      workspaceId,
      boardId,
      hookCallbackUrl,
      events
    });

    const result = await registerHook(
      authorization, 
      workspaceId, 
      boardId, 
      events,
      hookCallbackUrl
    );

    if (result.success) {
      info('Webhook-Service', 'Hook registration completed successfully', { 
        workspaceId, 
        boardId,
        hookId: result.hookId,
        events: events
      });

      return {
        success: true,
        hookId: result.hookId,
        secret: result.secret,
        events: events
      };
    } else {
      // Check if error is due to duplicate hook (409 Conflict)
      if (result.errorDetails?.code === 409 || result.error?.includes('already exists') || result.error?.includes('duplicate')) {
        warn('Webhook-Service', 'Hook already exists, attempting to get existing hooks', {
          workspaceId,
          boardId
        });

        // Try to get the existing hook
        const hooksResult = await getBoardHooks(authorization, workspaceId, boardId);
        if (hooksResult.success && hooksResult.hooks && hooksResult.hooks.length > 0) {
          const existingHook = hooksResult.hooks.find(h => 
            h.url === hookCallbackUrl || 
            h.events?.some(e => events.includes(e.event || e))
          );

          if (existingHook) {
            info('Webhook-Service', 'Using existing hook', {
              workspaceId,
              boardId,
              hookId: existingHook.id
            });

            return {
              success: true,
              hookId: existingHook.id,
              secret: existingHook.secret,
              events: events,
              existing: true
            };
          }
        }
      }

      warn('Webhook-Service', 'Hook registration failed', { 
        workspaceId, 
        boardId,
        error: result.error,
        errorDetails: result.errorDetails
      });

      return {
        success: false,
        error: result.error,
        errorDetails: result.errorDetails
      };
    }

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

