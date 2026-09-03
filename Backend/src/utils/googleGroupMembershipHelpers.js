import { google } from 'googleapis';
import { GOOGLE_DIRECTORY_SCOPES } from '../constants/googleAuth.js';
import { resolveGoogleDirectoryConfig } from './googleAuthConfigHelpers.js';
import {
  classifyDirectoryMembershipError,
  getCachedMembership,
  isBreakGlassEmail,
  resolveBreakGlassEmails,
  setCachedMembership,
} from './googleMembershipCacheHelpers.js';
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
 * @returns {Promise<{ status: 'member'|'not_member'|'verify_error', isMember: boolean, error?: string, breakGlass?: boolean }>}
 */
export async function checkUserGroupMembership(userEmail, deps = {}) {
  const normalizedEmail = typeof userEmail === 'string' ? userEmail.trim().toLowerCase() : '';
  if (!normalizedEmail) {
    warn(LOG_SCOPE, 'Group membership check skipped: missing email', {
      error: 'missing_email',
    });
    return { status: 'not_member', isMember: false, error: 'missing_email' };
  }

  if (deps.useCache !== false) {
    const cached = getCachedMembership(normalizedEmail);
    if (cached) {
      info(LOG_SCOPE, 'Using cached Workspace group membership', {
        email: normalizedEmail,
        status: cached.status,
      });
      return cached;
    }
  }

  const directoryConfig = resolveGoogleDirectoryConfig();
  const groupKey = deps.groupKey || directoryConfig.targetGroup;
  const breakGlass = resolveBreakGlassEmails();

  if (!groupKey) {
    warn(LOG_SCOPE, 'Group membership check failed: target group not configured', {
      email: normalizedEmail,
      error: 'group_not_configured',
    });
    return finalizeMembership(normalizedEmail, {
      status: 'verify_error',
      isMember: false,
      error: 'group_not_configured',
    }, breakGlass);
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
          error: 'directory_not_configured',
        });
        return finalizeMembership(normalizedEmail, {
          status: 'verify_error',
          isMember: false,
          error: 'directory_not_configured',
        }, breakGlass);
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

    const result = {
      status: isMember ? 'member' : 'not_member',
      isMember,
      error: isMember ? undefined : 'not_a_group_member',
    };

    info(LOG_SCOPE, 'Workspace group membership result', {
      email: normalizedEmail,
      groupKey,
      status: result.status,
      isMember: result.isMember,
    });

    setCachedMembership(normalizedEmail, result);
    return result;
  } catch (err) {
    const details = summarizeDirectoryError(err);
    const classification = classifyDirectoryMembershipError(err);

    if (classification === 'not_member') {
      warn(LOG_SCOPE, 'Directory API indicates non-member (expected deny)', {
        email: normalizedEmail,
        groupKey,
        ...details,
      });
      const result = {
        status: 'not_member',
        isMember: false,
        error: details.message,
      };
      setCachedMembership(normalizedEmail, result);
      return result;
    }

    logError(LOG_SCOPE, 'Directory API group membership check failed (verify_error)', {
      email: normalizedEmail,
      groupKey,
      adminEmail: directoryConfig.adminEmail || null,
      serviceAccountEmail: directoryConfig.credentials?.client_email || null,
      ...details,
      err,
    });

    return finalizeMembership(normalizedEmail, {
      status: 'verify_error',
      isMember: false,
      error: details.message,
    }, breakGlass);
  }
}

function finalizeMembership(email, result, breakGlass) {
  if (result.status === 'verify_error' && isBreakGlassEmail(email, breakGlass)) {
    warn(LOG_SCOPE, 'Break-glass allowlist used after Directory verify_error', {
      email,
      originalError: result.error || null,
    });
    const allowed = {
      status: 'member',
      isMember: true,
      breakGlass: true,
      error: result.error,
    };
    setCachedMembership(email, allowed);
    return allowed;
  }
  if (result.status !== 'verify_error') {
    setCachedMembership(email, result);
  }
  return result;
}
