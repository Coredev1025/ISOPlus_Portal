// Local sign-in. Password login was removed in KAN-27, so the way into a local
// stack is the same one-time OAuth ticket the e2e helper uses
// (Backend/scripts/e2e-support-ticket.mjs): it inserts a ticket row in the
// local database, and the app's own oauth-exchange path turns it into a
// support_admin session. Nothing is added to the application.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { parseEnv } from './env.mjs'

/** Backend/.env as a plain object, or {} when the file is absent. */
export function readBackendEnv(root) {
  const file = join(root, 'Backend', '.env')
  return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {}
}

/** The URL that redeems a ticket. Pure. */
export function loginUrl(frontendPort, ticket) {
  return `http://localhost:${frontendPort}/?ticket=${encodeURIComponent(ticket)}`
}

/** The ticket is the last non-empty line the script prints. Pure. */
export function cleanTicket(output) {
  const lines = String(output ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
  return lines.length ? lines[lines.length - 1] : ''
}

/**
 * Things that make the ticket useless even though it was created. Pure.
 *
 * The exchange answers 503 while PERSONAL_ACCESS_TOKEN is blank, and
 * GET /api/auth/verify still answering 200 makes the session look real.
 *
 * A token that is set while ISOPLUS_OFFLINE is not 1 gets sent to live ISO+
 * (offline mode is off whenever a token exists), so workspaces answer 401.
 *
 * A ticket is a google-support session, and /verify re-checks that session's
 * email against the Workspace group named by GOOGLE_TARGET_GROUP. With the
 * Directory configured (admin email and service account too) the ticket's
 * generated address is in no real group, so the session is revoked on the
 * first /verify (403 group_denied). With the group blank the check reports
 * verify_error and the session is kept, without refresh, until its normal expiry.
 */
export function loginHints(backendEnv) {
  const hints = []
  if (!backendEnv.PERSONAL_ACCESS_TOKEN) {
    hints.push(
      'PERSONAL_ACCESS_TOKEN is blank in Backend/.env, so the ticket exchange will answer 503. ' +
        'Set PERSONAL_ACCESS_TOKEN=local-offline-placeholder and ISOPLUS_OFFLINE=1, ' +
        'then recreate the backend: docker compose up -d --force-recreate --no-deps backend',
    )
  }
  if (backendEnv.PERSONAL_ACCESS_TOKEN && backendEnv.ISOPLUS_OFFLINE !== '1') {
    hints.push(
      'PERSONAL_ACCESS_TOKEN is set but ISOPLUS_OFFLINE is not 1, so the app will send it to ISO+ ' +
        'and workspaces will answer 401. Set ISOPLUS_OFFLINE=1 unless the token is real.',
    )
  }
  if (backendEnv.GOOGLE_TARGET_GROUP) {
    hints.push(
      'GOOGLE_TARGET_GROUP is set in Backend/.env, so /api/auth/verify will check the real ' +
        'Workspace group and answer 403 group_denied for the generated address. ' +
        'Leave GOOGLE_TARGET_GROUP blank locally, then recreate the backend.',
    )
  }
  return hints
}
