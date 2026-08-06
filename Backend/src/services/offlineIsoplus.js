// Offline stand-ins for the ISO+ collection endpoints, so the local stack is
// usable without ISO+ credentials.
//
// Why this exists: GET /api/workspaces does not read Mongo — it proxies
// https://app.isoplus.online/api/v2/workspaces using the bearer that
// applyPrivilegedSessionAuth() builds from PERSONAL_ACCESS_TOKEN. A fresh clone
// has that variable blank, so the workspace list comes back empty and every
// page below it is unreachable. No amount of seeding fixes that, because the
// list never came from the database in the first place.
//
// These functions return the SAME shape as their counterparts in isoplus.js —
// { workspace, has_more, after, status } and { board, has_more, after, status } —
// and are injected in place of them by routes/workspace.js. The request handler
// is unchanged and does not know which provider it got.
//
// The data comes from Mongo: Business documents supply workspaces, Board
// documents supply boards. Both are populated by `npm run dev:fixture`.
//
// This is a development affordance, not a mock of ISO+. It answers "can I open
// the app and see a workspace", not "does my code agree with ISO+". Anything
// asserting real ISO+ behaviour belongs in a live test — see
// Backend/test/fixtures/README.md.

import Business from '../models/Business.js';
import Board from '../models/Board.js';
import { warn } from '../utils/logger.js';

let announced = false;

/**
 * True when the backend should serve ISO+ collections from Mongo.
 *
 * Never in production. A blank token there is a misconfiguration that must fail
 * loudly, and quietly serving stub data instead would hide it — so the implicit
 * branch is gated on NODE_ENV. ISOPLUS_OFFLINE=1 forces it on for deliberate
 * offline work; ISOPLUS_OFFLINE=0 forces it off even without a token, which is
 * how you reproduce the real "credentials missing" failure locally.
 */
export function isOfflineMode() {
    if (process.env.ISOPLUS_OFFLINE === '1') return true;
    if (process.env.ISOPLUS_OFFLINE === '0') return false;
    if (process.env.NODE_ENV === 'production') return false;
    return !hasIsoplusToken();
}

export function hasIsoplusToken() {
    // .env.example ships the key with an empty value, so "declared" is not
    // "configured" — check the value, not the presence of the variable.
    return Boolean((process.env.PERSONAL_ACCESS_TOKEN || '').trim());
}

/** Logged once per process, so the mode is never a silent surprise in the logs. */
export function announceOfflineMode() {
    if (announced || !isOfflineMode()) return;
    announced = true;
    warn('Offline-Mode', 'Serving ISO+ workspaces and boards from MongoDB', {
        reason: process.env.ISOPLUS_OFFLINE === '1'
            ? 'ISOPLUS_OFFLINE=1'
            : 'PERSONAL_ACCESS_TOKEN is empty',
        hint: 'Populate the fixture with: npm run dev:fixture',
    });
}

function paginate(rows, options = {}) {
    const limit = Math.min(Math.max(parseInt(options.limit ?? 50, 10) || 50, 1), 100);
    const after = options.after ?? null;

    // Cursor is the id of the last row of the previous page, matching how the
    // real endpoint's `after` behaves from the caller's point of view.
    const start = after ? rows.findIndex((r) => String(r.id) === String(after)) + 1 : 0;
    const page = rows.slice(start, start + limit);
    const hasMore = start + limit < rows.length;

    return {
        page,
        has_more: hasMore,
        after: hasMore && page.length ? String(page[page.length - 1].id) : null,
    };
}

/** Mirrors getWorkspacePage(authorization, options) from services/isoplus.js. */
export async function getWorkspacePageOffline(_authorization, options = {}) {
    try {
        const businesses = await Business.find({}, 'workspaceId name').lean();

        const rows = businesses
            .filter((b) => b.workspaceId)
            .map((b) => ({
                id: String(b.workspaceId),
                name: b.name || `Workspace ${b.workspaceId}`,
            }))
            .sort((a, b) => a.name.localeCompare(b.name));

        const { page, has_more, after } = paginate(rows, options);
        return { workspace: page, has_more, after, status: 200 };
    } catch (err) {
        return {
            workspace: [],
            has_more: false,
            after: null,
            status: 500,
            message: `offline workspace lookup failed: ${err.message}`,
        };
    }
}

let unassignedWarned = false;

/**
 * Mirrors getBoardPage(authorization, workspaceId, options) from services/isoplus.js.
 *
 * Boards with a null workspaceId are included. That is not tidiness — in the
 * seed dump 33 of 34 boards have workspaceId null, including the NDIS pricing
 * board, because Board.workspaceId defaults to null and the sync path does not
 * reliably populate it. Filtering strictly returns one board and an apparently
 * empty local app.
 *
 * Including them is safe here only because offline mode serves a single
 * workspace. It is the wrong rule for real multi-workspace data, which is why
 * it lives in the offline provider and not in services/isoplus.js. The warning
 * below exists so the underlying data gap stays visible rather than being
 * papered over by this fallback.
 */
export async function getBoardPageOffline(_authorization, workspaceId, options = {}) {
    try {
        const wanted = String(workspaceId);
        const boards = await Board.find(
            { $or: [{ workspaceId: wanted }, { workspaceId: null }] },
            'boardId name label workspaceId',
        ).lean();

        const unassigned = boards.filter((b) => b.workspaceId == null).length;
        if (unassigned > 0 && !unassignedWarned) {
            unassignedWarned = true;
            warn('Offline-Mode', 'Including boards with no workspaceId', {
                workspaceId: wanted,
                unassigned,
                total: boards.length,
                note: 'Board.workspaceId is null in the seed dump; offline mode treats these as belonging to the only workspace',
            });
        }

        const rows = boards.map((b) => ({
            id: String(b.boardId),
            name: b.name || String(b.boardId),
            label: b.label ?? null,
        }));

        const { page, has_more, after } = paginate(rows, options);
        return { board: page, has_more, after, status: 200 };
    } catch (err) {
        return {
            board: [],
            has_more: false,
            after: null,
            status: 500,
            message: `offline board lookup failed: ${err.message}`,
        };
    }
}

/**
 * Mirrors getMemberRole(...). Offline there is exactly one user — whoever is
 * logged in — so the role comes from the session rather than from membership.
 * mapWorkspaceWithRole() already falls back to the session role, so returning
 * null here keeps that single source of truth rather than inventing a second.
 */
export async function getMemberRoleOffline(_authorization, _workspaceId, _userEmail) {
    return { role: null, status: 200 };
}
