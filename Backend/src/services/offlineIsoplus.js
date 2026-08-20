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

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Business from '../models/Business.js';
import Board from '../models/Board.js';
import Item from '../models/Item.js';
import { warn } from '../utils/logger.js';

let announced = false;

/**
 * True when the backend should serve ISO+ collections from Mongo.
 *
 * Never in production — and NODE_ENV is checked first, so ISOPLUS_OFFLINE=1
 * cannot override it. That ordering is the whole point: utils/uploadS3.js sends
 * generated PDFs to local disk whenever this is true, while routes/localFiles.js,
 * which serves them back, is gated on NODE_ENV and answers 404 on a deployed
 * host. A flag that won here would not give production an offline mode; it would
 * write invoices and statements somewhere nothing can fetch them, and the
 * automation email would carry attachments that cannot be loaded. Relaxing the
 * read gate to match is not the alternative — that route has no auth, so it
 * would expose generated invoices and the outbox's participant addresses.
 *
 * A blank token in production is a misconfiguration that must fail loudly, and
 * quietly serving stub data would hide it. ISOPLUS_OFFLINE=1 forces offline on
 * for deliberate local work; ISOPLUS_OFFLINE=0 forces it off even without a
 * token, which is how you reproduce the real "credentials missing" failure.
 */
export function isOfflineMode() {
    if (process.env.NODE_ENV === 'production') return false;
    if (process.env.ISOPLUS_OFFLINE === '1') return true;
    if (process.env.ISOPLUS_OFFLINE === '0') return false;
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

// --- board attributes --------------------------------------------------------

let fixtureCache;
let fixtureMissingWarned = false;

/**
 * Board attributes come from the committed fixture, not Mongo — the Portal has
 * no Attribute model, because attributes have always been read straight from
 * ISO+. Backend/test/fixtures/ndis-quote-board.json is the only checked-in
 * record of their shape.
 *
 * Only the offline path reads it, and only lazily, so a deployment that ships
 * without test/ is unaffected.
 */
function loadFixture() {
    if (fixtureCache !== undefined) return fixtureCache;
    try {
        const path = fileURLToPath(new URL('../../test/fixtures/ndis-quote-board.json', import.meta.url));
        fixtureCache = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        fixtureCache = null;
    }
    return fixtureCache;
}

/**
 * Mirrors getBoardAttributes(workspaceId, boardId) — { attribute, status }.
 *
 * The fixture holds the subset of attributes worth committing (13), not the
 * board's full 511. That is enough for Board Configuration, whose two dropdowns
 * want `longtext` attributes and are satisfied by Integration Message and
 * Generated PDF Link. It is not enough to reason about pricing rules — those
 * need live ISO+, and boardAttributesUseLegacyNdisPricing() will read this
 * partial list and conclude whatever the fixture says.
 */
export async function getBoardAttributesOffline(_workspaceId, boardId) {
    const fixture = loadFixture();

    if (!fixture) {
        if (!fixtureMissingWarned) {
            fixtureMissingWarned = true;
            warn('Offline-Mode', 'No fixture available for board attributes', {
                boardId,
                hint: 'expected Backend/test/fixtures/ndis-quote-board.json',
            });
        }
        return { attribute: [], status: 200 };
    }

    const known = fixture.board?.boardId;
    if (known && String(boardId) !== String(known)) {
        // Returning another board's attributes would be worse than returning
        // none: the caller cannot tell they are wrong.
        return { attribute: [], status: 200 };
    }

    return { attribute: fixture.attributes ?? [], status: 200 };
}

// --- item values -------------------------------------------------------------

/**
 * Mirrors getItemValues(workspaceId, boardId, itemId) from services/isoplus.js.
 *
 * That function is the tenancy guard's only source of truth:
 * validateItemBelongsToTenant() treats a falsy return as "this item does not
 * belong to this tenant" and throws. Offline it always 401s, so every inbound
 * webhook is refused as an intrusion attempt while the item sits in Mongo the
 * whole time — the guard never consults the database.
 *
 * Stored items keep `data` as a flat map of attribute NAME to value, which is
 * also how ISO+ keys webhook bodies. The live endpoint instead returns
 * `values[]` with the attribute expanded, and consumers read
 * `values[].attribute.name`, so the map is projected into that shape here.
 * Attribute ids are not stored anywhere locally and are therefore null: code
 * that keys on `attribute.id` will not work offline, and should not pretend to.
 *
 * Scoped by board as well as item, deliberately. Returning an item that belongs
 * to another board would not stand in for the tenancy check — it would defeat
 * it, which is worse than being offline.
 */
export async function getItemValuesOffline(_workspaceId, boardId, itemId) {
    try {
        const item = await Item.findOne({
            itemId: String(itemId),
            boardId: String(boardId),
        }).lean();

        if (!item) return null;

        const values = Object.entries(item.data ?? {}).map(([name, data]) => ({
            attribute: { id: null, name },
            data,
        }));

        return { id: item.itemId, values };
    } catch (err) {
        warn('Offline-Mode', 'Offline item lookup failed', {
            boardId,
            itemId,
            error: err.message,
        });
        return null;
    }
}

// --- folders ------------------------------------------------------------------

/**
 * Mirrors getFolder(workspaceId, boardId) — { folder: [{id, name}], status }.
 *
 * There is no Folder model; the only folder knowledge Mongo holds is the
 * folderId already stamped on each Item. Offline, each distinct folderId
 * becomes a folder whose name IS the id, so fixtures that use real folder
 * names as folderIds ('Shift Planning and Reporting', '📋 Participants
 * Intake', the budget stream names) light up every name-matched folder
 * filter: the statement budget classifier, the invoice-generator list
 * scopes, and the participants scans. A folderId that matches no filter
 * (e.g. a fixture's reference-item folder) is silently excluded, exactly
 * as an unrelated live folder would be.
 */
export async function getFolderOffline(workspaceId, boardId) {
    try {
        const ids = await Item.distinct('folderId', {
            workspaceId: String(workspaceId),
            boardId: String(boardId),
        });
        const folder = ids
            .filter((id) => typeof id === 'string' && id.trim())
            .map((id) => ({ id, name: id }));
        return { folder, status: 200 };
    } catch (err) {
        warn('Offline-Mode', 'Offline folder lookup failed', {
            workspaceId,
            boardId,
            error: err.message,
        });
        return { folder: [], status: 200 };
    }
}

// --- references and attributes -----------------------------------------------

/**
 * Mirrors getReferences(workspaceId, boardId, itemId) — { data: [...] } where
 * each entry is {attribute_id, to_item_id}.
 *
 * The PDF handlers walk references before generating: getReferences() lists
 * them, getAttribute() names each one, and the handler map keys on the name,
 * with 'Service Area' mandatory. All three are ISO+ calls, so offline the walk
 * produced nothing and every PDF webhook failed with "Service Area value is
 * required." even though the items were local. References come from the
 * fixture, like board attributes do — the Portal has no Reference model, so
 * the fixture is the only local record of them.
 *
 * An empty list (item has no recorded references) is `{ data: [] }`, not null:
 * null means "the lookup itself failed", and fetchLegacyNdisReferencedItems
 * treats it as such.
 */
export async function getReferencesOffline(_workspaceId, _boardId, itemId) {
    const fixture = loadFixture();
    const references = (fixture?.references ?? []).filter(
        (r) => String(r.from_item_id) === String(itemId),
    );
    return {
        data: references.map(({ attribute_id, to_item_id }) => ({ attribute_id, to_item_id })),
        status: 200,
    };
}

/**
 * Mirrors getAttribute(workspaceId, boardId, attributeId) — the attribute
 * object itself, with the `.name` the reference walk keys on. Null for an
 * unknown id, matching the live function's null on any failure.
 */
export async function getAttributeOffline(_workspaceId, _boardId, attributeId) {
    const fixture = loadFixture();
    return (
        (fixture?.attributes ?? []).find((a) => String(a.id) === String(attributeId)) ?? null
    );
}
