import { google } from 'googleapis';
import { GOOGLE_DIRECTORY_SCOPES } from '../constants/googleAuth.js';
import { resolveGoogleDirectoryConfig } from './googleAuthConfigHelpers.js';
import { info, warn, error as logError } from './logger.js';

const LOG_SCOPE = 'Google-Directory';

function summarizeDirectoryError(err) {
  return {
    message: err?.message || 'directory_api_error',
    code: err?.code ?? err?.response?.status ?? null,
    status: err?.response?.status ?? err?.status ?? null,
    errors: Array.isArray(err?.errors)
      ? err.errors.map((e) => ({ reason: e?.reason, message: e?.message, domain: e?.domain }))
      : undefined,
    googleError: err?.response?.data?.error
      ? {
          code: err.response.data.error.code,
          message: err.response.data.error.message,
          status: err.response.data.error.status,
          reasons: Array.isArray(err.response.data.error.errors)
            ? err.response.data.error.errors.map((e) => e?.reason).filter(Boolean)
            : undefined,
        }
      : undefined,
  };
}

/**
 * @param {string} userEmail
 * @param {{ hasMember?: (args: { groupKey: string, memberKey: string }) => Promise<{ data: { isMember?: boolean } }>, groupKey?: string }} [deps]
 * @returns {Promise<{ isMember: boolean, error?: string }>}
 */
export async function checkUserGroupMembership(userEmail, deps = {}) {
  const normalizedEmail = typeof userEmail === 'string' ? userEmail.trim().toLowerCase() : '';
  if (!normalizedEmail) {
    warn(LOG_SCOPE, 'Group membership check skipped: missing email', {
      error: 'missing_email',
    });
    return { isMember: false, error: 'missing_email' };
  }

  const directoryConfig = resolveGoogleDirectoryConfig();
  const groupKey = deps.groupKey || directoryConfig.targetGroup;

  if (!groupKey) {
    warn(LOG_SCOPE, 'Group membership check failed: target group not configured', {
      email: normalizedEmail,
      error: 'group_not_configured',
    });
    return { isMember: false, error: 'group_not_configured' };
  }

  info(LOG_SCOPE, 'Checking Workspace group membership', {
    email: normalizedEmail,
    groupKey,
    adminEmail: directoryConfig.adminEmail || null,
    serviceAccountEmail: directoryConfig.credentials?.client_email || null,
    usingInjectedClient: Boolean(deps.hasMember),
  });

  try {
    let isMember = false;

    if (deps.hasMember) {
      const res = await deps.hasMember({ groupKey, memberKey: normalizedEmail });
      isMember = res?.data?.isMember === true;
    } else {
      if (!directoryConfig.configured) {
        warn(LOG_SCOPE, 'Group membership check failed: directory not configured', {
          email: normalizedEmail,
          groupKey,
          hasAdminEmail: Boolean(directoryConfig.adminEmail),
          hasCredentials: Boolean(directoryConfig.credentials?.client_email),
          error: 'directory_not_configured',
        });
        return { isMember: false, error: 'directory_not_configured' };
      }

      const auth = new google.auth.JWT({
        email: directoryConfig.credentials.client_email,
        key: directoryConfig.credentials.private_key,
        scopes: GOOGLE_DIRECTORY_SCOPES,
        subject: directoryConfig.adminEmail,
      });

      const adminSDK = google.admin({ version: 'directory_v1', auth });
      const res = await adminSDK.members.hasMember({
        groupKey,
        memberKey: normalizedEmail,
      });
      isMember = res.data.isMember === true;
    }

    info(LOG_SCOPE, 'Workspace group membership result', {
      email: normalizedEmail,
      groupKey,
      isMember,
    });

    return { isMember };
  } catch (err) {
    const details = summarizeDirectoryError(err);
    logError(LOG_SCOPE, 'Directory API group membership check failed (fail closed)', {
      email: normalizedEmail,
      groupKey,
      adminEmail: directoryConfig.adminEmail || null,
      serviceAccountEmail: directoryConfig.credentials?.client_email || null,
      ...details,
      err,
    });
    return {
      isMember: false,
      error: details.message,
    };
  }
}
