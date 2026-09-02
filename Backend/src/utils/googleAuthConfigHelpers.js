import { readFileSync } from 'node:fs';
import {
  GOOGLE_DIRECTORY_GROUP_READONLY_SCOPE,
  GOOGLE_OAUTH_SCOPES,
} from '../constants/googleAuth.js';

function readEnv(name, env = process.env) {
  const value = env[name];
  if (typeof value !== 'string') return '';
  return value.trim();
}

export function parseServiceAccountCredentials(env = process.env) {
  const inlineJson = readEnv('GOOGLE_SERVICE_ACCOUNT_JSON', env);
  if (inlineJson) {
    try {
      return JSON.parse(inlineJson);
    } catch {
      return null;
    }
  }

  const keyFile = readEnv('GOOGLE_SERVICE_ACCOUNT_KEY_FILE', env);
  if (!keyFile) return null;

  try {
    return JSON.parse(readFileSync(keyFile, 'utf8'));
  } catch {
    return null;
  }
}

export function resolveGoogleOAuthConfig(env = process.env) {
  const clientId = readEnv('GOOGLE_OAUTH_CLIENT_ID', env);
  const clientSecret = readEnv('GOOGLE_OAUTH_CLIENT_SECRET', env);
  const backendUrl = readEnv('BACKEND_URL', env);
  const callbackUrl =
    readEnv('GOOGLE_OAUTH_CALLBACK_URL', env) ||
    (backendUrl ? `${backendUrl.replace(/\/+$/, '')}/api/auth/google/callback` : '');

  return {
    clientId,
    clientSecret,
    callbackUrl,
    scopes: GOOGLE_OAUTH_SCOPES,
    configured: Boolean(clientId && clientSecret && callbackUrl),
  };
}

export function resolveGoogleDirectoryConfig(env = process.env) {
  const adminEmail = readEnv('GOOGLE_ADMIN_EMAIL', env);
  const targetGroup = readEnv('GOOGLE_TARGET_GROUP', env);
  const credentials = parseServiceAccountCredentials(env);

  return {
    adminEmail,
    targetGroup,
    credentials,
    scope: GOOGLE_DIRECTORY_GROUP_READONLY_SCOPE,
    configured: Boolean(
      adminEmail &&
        targetGroup &&
        credentials?.client_email &&
        credentials?.private_key,
    ),
  };
}

export function isGoogleSupportAuthConfigured(env = process.env) {
  return resolveGoogleOAuthConfig(env).configured && resolveGoogleDirectoryConfig(env).configured;
}

/** Safe diagnostics for logs — never includes secrets or private keys. */
export function describeGoogleSupportAuthConfig(env = process.env) {
  const oauth = resolveGoogleOAuthConfig(env);
  const directory = resolveGoogleDirectoryConfig(env);
  const hasInlineJson = Boolean(readEnv('GOOGLE_SERVICE_ACCOUNT_JSON', env));
  const keyFile = readEnv('GOOGLE_SERVICE_ACCOUNT_KEY_FILE', env);

  return {
    oauthConfigured: oauth.configured,
    hasClientId: Boolean(oauth.clientId),
    hasClientSecret: Boolean(oauth.clientSecret),
    callbackUrl: oauth.callbackUrl || null,
    directoryConfigured: directory.configured,
    adminEmail: directory.adminEmail || null,
    targetGroup: directory.targetGroup || null,
    serviceAccountEmail: directory.credentials?.client_email || null,
    hasPrivateKey: Boolean(directory.credentials?.private_key),
    credentialSource: hasInlineJson ? 'json_env' : keyFile ? 'key_file' : 'none',
    keyFileSet: Boolean(keyFile),
  };
}
