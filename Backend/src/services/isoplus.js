import axios from "axios";
import Board from '../models/Board.js';
import FormData from 'form-data';
import http from 'http';
import https from 'https';
import { info, warn, error, logAttributeError, logApiError, logOperationStart, logOperationEnd } from '../utils/logger.js';
import { buildJobPlanningValues, buildServiceFeeTypeValues } from '../utils/isoplusJobReferenceHelpers.js';
import { getErrorMessageFromUnknown } from '../utils/isoplusErrorHelpers.js';
// Safe direction: offlineIsoplus.js imports models and the logger, never this
// module, so there is no cycle.
import {
    isOfflineMode,
    getItemValuesOffline,
    getReferencesOffline,
    getAttributeOffline,
    getFolderOffline,
} from './offlineIsoplus.js';
import {
    secureRandomFloat,
    mongoEq,
    sanitizeApiPathSegment,
    buildIsoPlusV2WorkspaceBoardsUrl,
    buildIsoPlusV2WorkspaceMembersUrl,
    buildIsoPlusV2BoardFoldersUrl,
    buildIsoPlusV2BoardViewsUrl,
    buildIsoPlusV2BoardViewUrl,
    buildIsoPlusV2BoardItemsUrl,
    buildIsoPlusV2ItemUrl,
    buildIsoPlusV2BoardReferencesUrl,
    buildIsoPlusV2BoardAttributesUrl,
    buildIsoPlusV2BoardAttributeUrl,
    buildIsoPlusAutomationUrl,
} from '../utils/securityHelpers.js';
import { executeSetLogo } from '../utils/isoplusLogoHelpers.js';
import { fetchPartyJobTypeReferencedItems } from '../utils/isoplusClientReferenceHelpers.js';
import {
    fetchLegacyNdisParticipantsPlanReferencedItems,
    fetchLegacyNdisQuoteReferencedItems,
} from '../utils/ndisPricingReferenceHelpers.js';
import { fetchNdisMasterPlanReferencedItems } from '../utils/isoplusNdisMasterPlanHelpers.js';
import { fetchAgeCareParticipantsServicePlanReferencedItems } from '../utils/isoplusAgeCarePlanReferenceHelpers.js';


const DEFAULT_ITEM_PAGE_SIZE = parseInt(process.env.ISOPLUS_ITEM_PAGE_SIZE || '100', 10);
const DEFAULT_PAGE_DELAY_MS = parseInt(process.env.ISOPLUS_PAGE_DELAY_MS || '0', 10);
const DEFAULT_COLLECTION_PAGE_SIZE = parseInt(process.env.ISOPLUS_COLLECTION_PAGE_SIZE || '100', 10);
const LOGO_ITEMS_PAGE_SIZE = parseInt(process.env.LOGO_ITEMS_PAGE_SIZE || '50', 10);
const DEFAULT_WORKSPACE_DETAIL_CONCURRENCY = Math.max(parseInt(process.env.ISOPLUS_WORKSPACE_DETAIL_CONCURRENCY || '8', 10), 1);
const CACHE_TTL_MS = Math.max(parseInt(process.env.ISOPLUS_COLLECTION_CACHE_TTL_MS || '30000', 10), 0);
const CACHE_MAX_ENTRIES = Math.max(parseInt(process.env.ISOPLUS_COLLECTION_CACHE_MAX_ENTRIES || '500', 10), 50);

const sleep = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const withAfterParam = (params, after) => (after ? { ...params, after } : params);

const isoPlusClient = axios.create({
    timeout: Math.max(parseInt(process.env.ISOPLUS_HTTP_TIMEOUT_MS || '30000', 10), 1000),
    httpAgent: new http.Agent({ keepAlive: true, maxSockets: 100 }),
    httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 100 }),
});

const ISOPLUS_MAX_RETRIES = Math.max(parseInt(process.env.ISOPLUS_HTTP_MAX_RETRIES || '4', 10), 0);

function isRetryableIsoPlusError(err) {
    const status = err?.response?.status;
    if (status === 429 || status === 503) return true;
    const code = err?.code;
    return code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ECONNRESET';
}

isoPlusClient.interceptors.response.use(
    (response) => response,
    async (err) => {
        const config = err?.config;
        if (!config) throw err;

        const attempt = config.__isoplusRetryAttempt || 0;
        if (attempt >= ISOPLUS_MAX_RETRIES || !isRetryableIsoPlusError(err)) {
            throw err;
        }

        config.__isoplusRetryAttempt = attempt + 1;
        const jitter = 1 + (secureRandomFloat() * 0.3);
        const backoffMs = Math.min(1000 * Math.pow(2, attempt) * jitter, 15000);
        warn('ISO+™ Service', 'Retrying ISO+ HTTP request after transient error', {
            attempt: config.__isoplusRetryAttempt,
            maxRetries: ISOPLUS_MAX_RETRIES,
            backoffMs: Math.floor(backoffMs),
            status: err?.response?.status,
            code: err?.code,
            url: config.url,
        });
        await sleep(backoffMs);
        return isoPlusClient.request(config);
    }
);

const responseCache = new Map();
const inflightCache = new Map();

function readFromCache(key) {
    if (CACHE_TTL_MS <= 0) return null;
    const entry = responseCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        responseCache.delete(key);
        return null;
    }
    return entry.value;
}

function writeToCache(key, value) {
    if (CACHE_TTL_MS <= 0) return;
    if (responseCache.size >= CACHE_MAX_ENTRIES) {
        const oldestKey = responseCache.keys().next().value;
        if (oldestKey) responseCache.delete(oldestKey);
    }
    responseCache.set(key, {
        value,
        expiresAt: Date.now() + CACHE_TTL_MS,
    });
}

async function getOrSetCache(key, fetcher) {
    const cached = readFromCache(key);
    if (cached !== null) {
        return cached;
    }

    const inFlight = inflightCache.get(key);
    if (inFlight) {
        return inFlight;
    }

    const promise = (async () => {
        try {
            const value = await fetcher();
            writeToCache(key, value);
            return value;
        } finally {
            inflightCache.delete(key);
        }
    })();

    inflightCache.set(key, promise);
    return promise;
}

async function mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;

    const worker = async () => {
        while (true) {
            const currentIndex = nextIndex;
            nextIndex += 1;

            if (currentIndex >= items.length) {
                return;
            }

            results[currentIndex] = await mapper(items[currentIndex], currentIndex);
        }
    };

    const poolSize = Math.min(Math.max(concurrency, 1), items.length || 1);
    await Promise.all(Array.from({ length: poolSize }, () => worker()));
    return results;
}

function createPaginator(fetchPage, options = {}) {
    const pageDelayMs = options.pageDelayMs ?? DEFAULT_PAGE_DELAY_MS;
    const selectData = options.selectData || ((response) => response.data?.data || []);
    const selectHasMore = options.selectHasMore || ((response) => Boolean(response.data?.has_more));
    const selectAfter = options.selectAfter || ((response) => response.data?.after);
    const debugKey = options.debugKey ? String(options.debugKey) : 'unknown';
    const maxPagesRaw = options.maxPages ?? process.env.ISOPLUS_PAGINATION_MAX_PAGES ?? '1000';
    const maxPages = Math.max(parseInt(maxPagesRaw, 10), 1);

    let after = null;
    let hasMore = true;
    let pageCount = 0;

    return {
        async next() {
            if (!hasMore) {
                return { value: undefined, done: true };
            }

            pageCount += 1;
            if (pageCount > maxPages) {
                throw new Error(`Pagination exceeded max pages (${maxPages}) for ${debugKey}`);
            }

            const previousAfter = after;
            const response = await fetchPage(after);
            const batch = selectData(response) || [];
            hasMore = selectHasMore(response);
            after = selectAfter(response);

            if (hasMore && (after === null || after === undefined || after === '' || after === previousAfter)) {
                warn('ISO+™ Service', 'Paginator cursor missing/unchanged; stopping to avoid hang', {
                    debugKey,
                    hasMore,
                    previousAfter: previousAfter ?? null,
                    after: after ?? null,
                    batchSize: Array.isArray(batch) ? batch.length : undefined,
                });
                throw new Error(`Pagination cursor missing/unchanged for ${debugKey}`);
            }

            if (hasMore && pageDelayMs > 0) {
                await sleep(pageDelayMs);
            }

            return { value: batch, done: false };
        },
        [Symbol.asyncIterator]() {
            return this;
        }
    };
}

async function collectPaginated(iterator) {
    const results = [];
    while (true) {
        const { value, done } = await iterator.next();
        if (done) {
            break;
        }
        if (Array.isArray(value)) {
            results.push(...value);
        }
    }
    return results;
}

function iterateWorkspaces(authorization, options = {}) {
    const url = "https://app.isoplus.online/api/v2/workspaces";
    const headers = {
        "Authorization": authorization,
        "Content-Type": "application/json",
        "Accept": "application/json",
    };
    const baseParams = {
        "limit": String(options.limit || DEFAULT_COLLECTION_PAGE_SIZE),
        "sort_by": "created_at",
        "sort_direction": "desc",
    };

    return createPaginator(
        (after) => isoPlusClient.get(url, { headers, params: withAfterParam(baseParams, after) }),
        { pageDelayMs: options.pageDelayMs, debugKey: 'workspaces' }
    );
}

export async function listWorkspacesForAuthorization(authorization) {
    try {
        const workspaces = await collectPaginated(iterateWorkspaces(authorization));
        return { workspaces, status: 200 };
    } catch (err) {
        return { workspaces: [], status: 500, message: err.message };
    }
}

export async function getWorkspacePage(authorization, options = {}) {
    try {
        const limit = Math.min(Math.max(parseInt(options.limit ?? DEFAULT_COLLECTION_PAGE_SIZE, 10), 1), 100);
        const after = options.after ?? null;

        const url = "https://app.isoplus.online/api/v2/workspaces";
        const headers = {
            "Authorization": authorization,
            "Content-Type": "application/json",
            "Accept": "application/json",
        };
        const params = withAfterParam(
            {
                limit: String(limit),
                sort_by: "created_at",
                sort_direction: "desc",
            },
            after
        );

        const response = await isoPlusClient.get(url, { headers, params });
        const data = response?.data || {};
        return {
            workspace: Array.isArray(data.data) ? data.data : [],
            has_more: Boolean(data.has_more),
            after: data.after ?? null,
            status: response.status || 200,
        };
    } catch (err) {
        const status = err?.response?.status || 500;
        const message = err?.response?.data?.message || err?.message || 'Failed to fetch workspaces';
        return { workspace: [], has_more: false, after: null, status, message };
    }
}

function iterateBoards(authorization, workspaceId, options = {}) {
    const url = buildIsoPlusV2WorkspaceBoardsUrl(workspaceId);
    const headers = {
        "Authorization": authorization,
        "Content-Type": "application/json",
        "Accept": "application/json",
    };
    const baseParams = {
        "limit": String(options.limit || DEFAULT_COLLECTION_PAGE_SIZE),
        "sort_by": "created_at",
        "sort_direction": "desc",
    };

    return createPaginator(
        (after) => isoPlusClient.get(url, { headers, params: withAfterParam(baseParams, after) }),
        { pageDelayMs: options.pageDelayMs, debugKey: `boards:${workspaceId}` }
    );
}

export async function getBoardPage(authorization, workspaceId, options = {}) {
    try {
        // ISO+ API enforces limit <= 100
        const limit = Math.min(Math.max(parseInt(options.limit ?? DEFAULT_COLLECTION_PAGE_SIZE, 10), 1), 100);
        const after = options.after ?? null;

        const safeWorkspaceId = encodeURIComponent(sanitizeApiPathSegment(workspaceId, 'workspaceId'));
        const url = `https://app.isoplus.online/api/v2/workspaces/${safeWorkspaceId}/boards`;
        const headers = {
            "Authorization": authorization,
            "Content-Type": "application/json",
            "Accept": "application/json",
        };
        const params = withAfterParam(
            {
                limit: String(limit),
                sort_by: "created_at",
                sort_direction: "desc",
            },
            after
        );

        const response = await isoPlusClient.get(url, { headers, params });
        const data = response?.data || {};
        return {
            board: Array.isArray(data.data) ? data.data : [],
            has_more: Boolean(data.has_more),
            after: data.after ?? null,
            status: response.status || 200,
        };
    } catch (err) {
        const status = err?.response?.status || 500;
        const message = err?.response?.data?.message || err?.message || 'Failed to fetch boards';
        return { board: [], has_more: false, after: null, status, message };
    }
}

export async function getMemberRole(authorization, workspaceId, userEmail, options = {}) {
    try {
        const email = userEmail ? String(userEmail).toLowerCase() : null;
        if (!email) return { role: null, status: 400, message: 'userEmail is required' };

        const url = buildIsoPlusV2WorkspaceMembersUrl(workspaceId);
        const headers = {
            "Authorization": authorization,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-API-Version": "2025-02-26.morava",
        };
        const limit = Math.max(parseInt(options.limit ?? '100', 10), 1);
        const pageDelayMs = options.pageDelayMs ?? DEFAULT_PAGE_DELAY_MS;
        let after = null;

        while (true) {
            const params = withAfterParam(
                {
                    limit: String(limit),
                    sort_by: "created_at",
                    sort_direction: "desc",
                },
                after
            );

            const response = await isoPlusClient.get(url, { headers, params });
            const data = response?.data || {};
            const members = Array.isArray(data.data) ? data.data : [];
            const match = members.find((m) => m?.email && String(m.email).toLowerCase() === email);
            if (match?.role) return { role: match.role, status: 200 };

            const hasMore = Boolean(data.has_more);
            const nextAfter = data.after ?? null;
            if (!hasMore || !nextAfter || nextAfter === after) {
                return { role: null, status: 200 };
            }
            after = nextAfter;
            if (pageDelayMs > 0) await sleep(pageDelayMs);
        }
    } catch (err) {
        const status = err?.response?.status || 500;
        const message = err?.response?.data?.message || err?.message || 'Failed to fetch members';
        return { role: null, status, message };
    }
}

function iterateFolders(workspaceId, boardId, options = {}) {
    const url = buildIsoPlusV2BoardFoldersUrl(workspaceId, boardId);
    const headers = {
        "Authorization": `Bearer ${process.env.PERSONAL_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-API-Version": "2025-02-26.morava",
    };
    const baseParams = {
        "limit": String(options.limit || DEFAULT_COLLECTION_PAGE_SIZE),
        "sort_by": "id",
        "sort_direction": "desc",
    };

    return createPaginator(
        (after) => isoPlusClient.get(url, { headers, params: withAfterParam(baseParams, after) }),
        { pageDelayMs: options.pageDelayMs, debugKey: `folders:${workspaceId}:${boardId}` }
    );
}

function iterateMembers(authorization, workspaceId, options = {}) {
    const membersUrl = buildIsoPlusV2WorkspaceMembersUrl(workspaceId);
    const membersHeaders = {
        "Authorization": authorization,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-API-Version": "2025-02-26.morava",
    };
    const baseParams = {
        "limit": String(options.limit || 10),
        "sort_by": "created_at",
        "sort_direction": "desc",
    };

    return createPaginator(
        (after) => isoPlusClient.get(membersUrl, { headers: membersHeaders, params: withAfterParam(baseParams, after) }),
        { pageDelayMs: options.pageDelayMs, debugKey: `members:${workspaceId}` }
    );
}

function iterateViews(authorization, workspaceId, boardId, options = {}) {
    const url = buildIsoPlusV2BoardViewsUrl(workspaceId, boardId);
    const headers = {
        "Authorization": authorization,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-API-Version": "2025-02-26.morava",
    };
    const baseParams = {
        "limit": String(options.limit || DEFAULT_COLLECTION_PAGE_SIZE),
        "sort_by": "created_at",
        "sort_direction": "desc",
    };

    return createPaginator(
        (after) => isoPlusClient.get(url, { headers, params: withAfterParam(baseParams, after) }),
        { pageDelayMs: options.pageDelayMs, debugKey: `views:${workspaceId}:${boardId}` }
    );
}

export async function getWorkspace(authorization, userEmail = null, options = {}) {
    try {
        const includeBoards = options.includeBoards !== false;
        const workspaceRolesById = options.workspaceRolesById || null;
        const detailConcurrency = Math.max(
            parseInt(options.detailConcurrency ?? DEFAULT_WORKSPACE_DETAIL_CONCURRENCY, 10) || DEFAULT_WORKSPACE_DETAIL_CONCURRENCY,
            1
        );
        const normalizedEmail = userEmail ? userEmail.toLowerCase() : null;
        const cacheKey = `workspace:${authorization}:${normalizedEmail || ''}:${includeBoards ? 'with-boards' : 'no-boards'}:c${detailConcurrency}`;

        const workspaceResults = await getOrSetCache(cacheKey, async () => {
            const workspaces = await collectPaginated(iterateWorkspaces(authorization));

            return mapWithConcurrency(
                workspaces,
                detailConcurrency,
                async (item) => {
                    const workspaceId = item.id?.toString();
                    const roleFromToken = workspaceRolesById && workspaceId
                        ? workspaceRolesById[workspaceId]
                        : null;

                    const tasks = [
                        includeBoards ? getBoard(authorization, item.id) : Promise.resolve({ board: [], status: 200 }),
                    ];

                    const shouldFetchMembers = !roleFromToken && normalizedEmail;
                    if (shouldFetchMembers) {
                        tasks.push(getMember(authorization, item.id));
                    }

                    const [board, member] = await Promise.all(tasks);

                    let userRole = roleFromToken || 'restricted_member';
                    if (!roleFromToken && member?.status === 200 && normalizedEmail) {
                        userRole = member.members.find(
                            (m) => m.email && m.email.toLowerCase() === normalizedEmail
                        )?.role || userRole;
                    }

                    return {
                        id: item.id,
                        name: item.name,
                        label: item.label,
                        board: Array.isArray(board?.board) ? board.board : [],
                        user_role: userRole,
                    };
                }
            );
        });

        return { workspace: workspaceResults, status: 200 };
    } catch (err) {
        return {
            message: err.message,
            status: 500,
            upstreamStatus: err?.response?.status,
            errorCode: err?.code,
        };
    }
}

export async function getMyWorkspace(authorization) {
    try {
        const url = "https://app.isoplus.online/api/me/workspaces";

        const headers = {
            Authorization: authorization,
            "Content-Type": "application/json",
            Accept: "application/json",
        };

        let workspace = [];

        const response = await axios.get(url, { headers })
        if (response.status === 200) {
            workspace = workspace.concat(response.data);
        } else {
            return { message: 'Error fetching workspaces', status: 500 };
        }
        return { workspace: workspace, status: 200 };
    } catch (err) {
        return { message: 'Server error', status: 500 };
    }
}

export async function getBoard(authorization, workspaceId) {
    try {
        const cacheKey = `board:${authorization}:${workspaceId}`;
        const boards = await getOrSetCache(cacheKey, async () => collectPaginated(iterateBoards(authorization, workspaceId)));
        return { board: boards, status: 200 };
    } catch (err) {
        return { message: err.message, status: 500 };
    }
}

export async function getFolder(workspaceId, boardId) {
    if (isOfflineMode()) {
        return getFolderOffline(workspaceId, boardId);
    }
    try {
        const folders = await collectPaginated(iterateFolders(workspaceId, boardId));
        return { folder: folders, status: 200 };
    } catch (err) {
        return { message: err.message, status: 500 };
    }
}

async function buildItemRequest(workspaceId, boardId, folderId, limit, after, authorization) {
    const url = buildIsoPlusV2BoardItemsUrl(workspaceId, boardId);
    const headers = {
        "Authorization": authorization || `Bearer ${process.env.PERSONAL_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-API-Version": "2025-02-26.morava",
    };
    const params = {
        "limit": String(limit),
        "sort_by": "created_at",
        "sort_direction": "desc",
        "expand[0]": "values.attribute",
    };
    if (folderId) {
        params["folder_id"] = folderId;
    }
    return { url, headers, params: withAfterParam(params, after) };
}

export function iterateBoardItems(workspaceId, boardId, folderId, options = {}) {
    const limit = options.limit || DEFAULT_ITEM_PAGE_SIZE;
    return createPaginator(
        async (after) => {
            const requestConfig = await buildItemRequest(
                workspaceId,
                boardId,
                folderId,
                limit,
                after,
                options.authorization,
            );
            return axios.get(requestConfig.url, { headers: requestConfig.headers, params: requestConfig.params });
        },
        { pageDelayMs: options.pageDelayMs, debugKey: `items:${workspaceId}:${boardId}:${folderId || 'all'}` }
    );
}

export async function getItem(workspaceId, boardId, folderId) {
    try {
        const items = [];
        const iterator = iterateBoardItems(workspaceId, boardId, folderId);
        while (true) {
            const { value, done } = await iterator.next();
            if (done) {
                break;
            }
            items.push(...value);
        }
        return { item: items, status: 200 };
    } catch (err) {
        return { message: err.message, status: 500 };
    }
}

export async function getMember(authorization, workspaceId) {
    try {
        const cacheKey = `member:${authorization}:${workspaceId}`;
        const members = await getOrSetCache(cacheKey, async () => collectPaginated(iterateMembers(authorization, workspaceId)));
        return { members: members, status: 200 };
    } catch (err) {
        return { message: err.message, status: 500 };
    }
}

export async function getAllViews(authorization, workspaceId, boardId) {
    try {
        const cacheKey = `views:${authorization}:${workspaceId}:${boardId}`;
        const views = await getOrSetCache(cacheKey, async () => collectPaginated(iterateViews(authorization, workspaceId, boardId)));
        return { views: views, status: 200 };
    } catch (err) {
        return { message: err.message, status: 500 };
    }
}

export async function getViewsById(authorization, workspaceId, boardId, viewId) {
    try {
        const url = buildIsoPlusV2BoardViewUrl(workspaceId, boardId, viewId);
        const headers = {
            "Authorization": authorization,
            "Content-Type": "application/json",
            "Accept": "application/json",
        };

        const result = await axios.get(url, { headers, params });

        return result.status === 200 ? result.data : null;
    } catch (err) {
        return { message: err.message, status: 500 };
    }
}


export async function setIntegrationMessage(workspaceId, boardId, itemId, message) {
    // Offline, this write-back can only 404: the local items are inventions the
    // live platform has never heard of. Skip rather than throw — the local run
    // has already done its work, and a skip is the same honest behaviour as the
    // board_sync handler's offline skip.
    if (isOfflineMode()) {
        warn('ISO+™ Service', 'setIntegrationMessage skipped: backend is in offline mode', { workspaceId, boardId, itemId });
        return false;
    }

    try {
        const board = await Board.findOne({ boardId: mongoEq(boardId) })
            .select('attribute')
            .lean();
        if (!board || !board.attribute || !board.attribute.id) {
            throw new Error("Internal message attribute not found in board configuration");
        }
        await axios.put(
            buildIsoPlusV2ItemUrl(workspaceId, boardId, itemId),
            {
                "values": [
                    {
                        "attribute_id": board.attribute.id || process.env.INTEGRATION_MESSAGE_ATTRIBUTE_ID || "b84bf475-b4f7-4e35-891a-72c24631468f",
                        "data": `<p>${message}</p>`
                    }
                ]
            },
            {
                headers: {
                    "Authorization": `Bearer ${process.env.PERSONAL_ACCESS_TOKEN}`,
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "X-API-Version": "2025-02-26.morava",
                }
            }
        );
        return true;
    } catch (err) {
        error('ISO+™ Service', 'Error putting internal message: ', err.message);
        return false;
    }
}

function toISoPlusDatetime(date) {
    return new Date(date).toISOString().replace(/\.(\d{3})Z$/, '.$1000Z');
}

export async function putTimeTracking(workspaceId, boardId, itemId, startTime, endTime, nativeAttributeId, existingEntries = [], description = '') {
    if (!nativeAttributeId || !startTime || !endTime) {
        warn('ISO+™ Service', 'putTimeTracking skipped — missing required params', {
            workspaceId, boardId, itemId,
            hasAttrId: !!nativeAttributeId, hasStart: !!startTime, hasEnd: !!endTime
        });
        return false;
    }

    const newEntry = {
        started_at: toISoPlusDatetime(startTime),
        ended_at: toISoPlusDatetime(endTime),
        description: description || '',
    };

    const cleanExisting = (Array.isArray(existingEntries) ? existingEntries : [])
        .map(({ _portal_pending, ...rest }) => rest); 

    const updatedEntries = [...cleanExisting, newEntry];

    try {
        await isoPlusClient.put(
            buildIsoPlusV2ItemUrl(workspaceId, boardId, itemId),
            { values: [{ attribute_id: nativeAttributeId, data: updatedEntries }] },
            {
                headers: {
                    Authorization: `Bearer ${process.env.PERSONAL_ACCESS_TOKEN}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    'X-API-Version': '2025-02-26.morava',
                }
            }
        );
        return true;
    } catch (err) {
        error('ISO+™ Service', 'putTimeTracking failed', {
            workspaceId, boardId, itemId,
            message: err.message
        });
        return false;
    }
}

export const ITEM_DELETED = Symbol('ITEM_DELETED');

export async function getItemValues(workspaceId, boardId, itemId, authorization) {
    // Offline, this 401s and the whole inbound webhook path then refuses real
    // payloads as intrusion attempts. Served from Mongo instead — see
    // getItemValuesOffline, and isOfflineMode for why production is unaffected.
    if (isOfflineMode()) {
        return getItemValuesOffline(workspaceId, boardId, itemId);
    }

    const maxRetries = 5; // Increased from 3 to handle rate limits better
    let lastError = null;
    let retryDelay = 2000; // Start with 2 seconds (increased from 1 second)

    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const url = `${buildIsoPlusV2ItemUrl(workspaceId, boardId, itemId)}?expand[]=values.attribute`;
            const headers = {
                "Authorization": authorization || `Bearer ${process.env.PERSONAL_ACCESS_TOKEN}`,
                "Content-Type": "application/json",
                "Accept": "application/json",
                "X-API-Version": "2025-02-26.morava",
            };

            const result = await axios.get(url, { headers });
            return result.status === 200 ? result.data : null;
        } catch (err) {
            lastError = err;
            
            if (err.response?.status === 404) {
                info('ISO+™ Service', 'Item not found (404) - item was deleted in ISO+', { 
                    workspaceId, 
                    boardId, 
                    itemId 
                });
                return ITEM_DELETED;
            }
            
            // Check if it's a 429 error (rate limit)
            const isRateLimitError = err.response?.status === 429 || 
                                   err.message?.includes('429') ||
                                   err.message?.toLowerCase().includes('rate limit') ||
                                   err.message?.toLowerCase().includes('too many requests');

            if (isRateLimitError && attempt < maxRetries - 1) {
                // Exponential backoff with jitter: delay increases with each retry
                // Add random jitter (0-30%) to prevent thundering herd
                const jitter = 1 + (secureRandomFloat() * 0.3);
                const backoffDelay = Math.min(
                    retryDelay * Math.pow(2, attempt) * jitter,
                    30000 // Cap at 30 seconds
                );
                warn('ISO+™ Service', `Rate limit hit, retrying after ${Math.floor(backoffDelay)}ms`, { 
                    workspaceId, 
                    boardId, 
                    itemId, 
                    attempt: attempt + 1,
                    maxRetries 
                });
                await sleep(Math.floor(backoffDelay));
                continue;
            }

            // If not a rate limit error or max retries reached, log and return null
            if (!isRateLimitError || attempt === maxRetries - 1) {
                error('ISO+™ Service', `Error getting item values: ${err.message}`, { 
                    workspaceId, 
                    boardId, 
                    itemId,
                    status: err.response?.status,
                    isRateLimitError
                });
                return null;
            }
        }
    }

    return null;
}

export async function validateItemBelongsToTenant(workspaceId, boardId, itemId) {
    const validatedItemOwnership = await getItemValues(workspaceId, boardId, itemId);
    if (!validatedItemOwnership) {
        const errorMessage = "CRITICAL: Item does not exist. This may be a result of an intrusion attempt or misconfiguration of the tenant!";
        warn('ISO+™ Service', errorMessage);
        throw new Error(errorMessage);
    }
}

export async function getReferences(workspaceId, boardId, itemId) {
    // Offline, references come from the committed fixture — see
    // getReferencesOffline.
    if (isOfflineMode()) {
        return getReferencesOffline(workspaceId, boardId, itemId);
    }

    try {
        const url = buildIsoPlusV2BoardReferencesUrl(workspaceId, boardId, itemId);
        const headers = {
            "Authorization": `Bearer ${process.env.PERSONAL_ACCESS_TOKEN}`,
            "Content-Type": "application/json",
            "Accept": "application/json"
        };

        const result = await axios.get(url, { headers });
        return result.status === 200 ? result.data : null;
    } catch (err) {
        error('ISO+™ Service', 'Error getting references:', err);
        return null;
    }
}

export async function getAttribute(workspaceId, boardId, attributeId) {
    // Offline: resolved from the fixture's attribute list, same guard as above.
    if (isOfflineMode()) {
        return getAttributeOffline(workspaceId, boardId, attributeId);
    }

    try {
        const url = buildIsoPlusV2BoardAttributeUrl(workspaceId, boardId, attributeId);
        const headers = {
            "Authorization": `Bearer ${process.env.PERSONAL_ACCESS_TOKEN}`,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-API-Version": "2025-02-26.morava",
        };

        const result = await axios.get(url, { headers });
        return result.status === 200 ? result.data : null;
    } catch (err) {
        error('ISO+™ Service', 'Error getting attribute:', err);
        return null;
    }
}

export async function getJobReportingReferencedItems(workspaceId, boardId, itemId) {
    let serviceFeeTypeValues = null;
    let jobPlanningValues = null;

    const referenceResponse = await getReferences(workspaceId, boardId, itemId);
    if (!referenceResponse) return [null, null];

    for (const reference of referenceResponse.data) {
        const attribute = await getAttribute(workspaceId, boardId, reference.attribute_id);
        if (!attribute) continue;

        switch (attribute.name) {
            case "Job Number": {
                const jobPlanningItemValues = await getItemValues(workspaceId, boardId, reference.to_item_id);
                if (jobPlanningItemValues) {
                    jobPlanningValues = buildJobPlanningValues(jobPlanningItemValues);
                }
                break;
            }
            case "Service Fee Type": {
                const serviceFeeTypeItemValues = await getItemValues(workspaceId, boardId, reference.to_item_id);
                if (serviceFeeTypeItemValues) {
                    serviceFeeTypeValues = buildServiceFeeTypeValues(serviceFeeTypeItemValues);
                }
                break;
            }
        }
    }

    return [jobPlanningValues, serviceFeeTypeValues];
}

export async function getJobPlanningReferencedItems(workspaceId, boardId, itemId) {
    return fetchPartyJobTypeReferencedItems({
        workspaceId,
        boardId,
        itemId,
        partyAttributeName: 'Client',
        partyLabel: 'Client',
        outputKey: 'client',
        getReferences,
        getAttribute,
        getItemValues,
    });
}


export async function getQuoteReferencedItems(workspaceId, boardId, itemId) {
    return fetchPartyJobTypeReferencedItems({
        workspaceId,
        boardId,
        itemId,
        partyAttributeName: 'Client',
        partyLabel: 'Client',
        outputKey: 'client',
        getReferences,
        getAttribute,
        getItemValues,
    });
}


export async function getPurchaseOrderReferencedItems(workspaceId, boardId, itemId) {
    return fetchPartyJobTypeReferencedItems({
        workspaceId,
        boardId,
        itemId,
        partyAttributeName: 'Contractor',
        partyLabel: 'Contractor',
        outputKey: 'contractor',
        getReferences,
        getAttribute,
        getItemValues,
    });
}


export async function getBoardAttributes(workspaceId, boardId) {
    try {
        const url = buildIsoPlusV2BoardAttributesUrl(workspaceId, boardId);
        const headers = {
            "Authorization": `Bearer ${process.env.PERSONAL_ACCESS_TOKEN}`,
            "Content-Type": "application/json",
            "Accept": "application/json",
        };
        const params = {
            "limit": "100",
            "sort_by": "created_at",
            "sort_direction": "desc",
        };

        let attribute = [];
        const result = await axios.get(url, { headers, params });

        if (result.status === 200) {
            attribute = attribute.concat(result.data.data);
            let has_more = result.data.has_more, after = result.data.after;

            while (has_more) {
                const response = await axios.get(url, { headers, params: { ...params, after } });
                if (response.status === 200) {
                    attribute = attribute.concat(response.data.data);
                    has_more = response.data.has_more;
                    after = response.data.after;
                } else {
                    has_more = false;
                }
            }
        }
        return { attribute: attribute, status: 200 };
    } catch (err) {
        return { message: err.message, status: 500 };
    }
}

// Helper function to safely extract error message from various error formats
function getErrorMessage(err) {
    return getErrorMessageFromUnknown(err);
}

// Helper function to safely check if error message contains a specific string
function errorMessageIncludes(err, searchString) {
    if (!err || !searchString) return false;
    const errorMsg = getErrorMessage(err);
    return typeof errorMsg === 'string' && errorMsg.includes(searchString);
}

function pageAttributesFromResponse(data) {
    if (Array.isArray(data?.data)) return data.data;
    if (Array.isArray(data?.attributes)) return data.attributes;
    return [];
}

/**
 * ISO+ attributes are capped at 100 per page; walk `after` until has_more is false.
 *
 * Uses the shared `createPaginator` (see iterateWorkspaces/iterateBoards above) instead of a
 * hand-rolled while loop so this gets the same two safety guards for free:
 *   - a max-page cap, so a runaway loop can't hang the request forever;
 *   - a same/missing-cursor check, so if ISO+ ever reports has_more:true without giving a
 *     usable `after` (or the same one twice), we throw instead of silently returning a
 *     truncated-but-reported-as-successful attribute list — which would quietly reintroduce
 *     the "attributes are missing" bug this function exists to fix, just via a different
 *     trigger. A previous version of this function reimplemented pagination by hand and had
 *     neither guard.
 */
async function fetchAllBoardAttributes(workspaceId, boardId, authorization) {
    const url = buildIsoPlusV2BoardAttributesUrl(workspaceId, boardId);
    const headers = {
        Authorization: authorization,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-API-Version': '2025-02-26.morava',
    };
    const baseParams = {
        limit: '100',
        sort_by: 'created_at',
        sort_direction: 'desc',
    };

    try {
        const attributes = await collectPaginated(
            createPaginator(
                (after) => isoPlusClient.get(url, { headers, params: withAfterParam(baseParams, after) }),
                { selectData: (response) => pageAttributesFromResponse(response.data), debugKey: `attributes:${workspaceId}:${boardId}` },
            ),
        );
        return { attributes, status: 200 };
    } catch (err) {
        return { attributes: null, status: err?.response?.status || 500 };
    }
}

/** Load board attributes once per board for a setLogo run when attributesCache is provided. */
async function loadAttributesForCoverValidation(
    workspaceId,
    boardId,
    authorization,
    attributesCache,
    req,
    viewId,
    coverAttributeId,
) {
    if (attributesCache?.has(boardId)) {
        const attributes = attributesCache.get(boardId);
        info('ISO+™ Service', 'Board attributes reused from setLogo cache', {
            workspaceId,
            boardId,
            viewId,
            coverAttributeId,
            attributeCount: attributes.length,
        }, req);
        return attributes;
    }

    const attributesResult = await fetchAllBoardAttributes(workspaceId, boardId, authorization);
    if (attributesResult.status !== 200 || !attributesResult.attributes) {
        return null;
    }

    const attributes = attributesResult.attributes;
    attributesCache?.set(boardId, attributes);
    info('ISO+™ Service', 'Board attributes fetched for document cover validation', {
        workspaceId,
        boardId,
        viewId,
        coverAttributeId,
        attributeCount: attributes.length,
    }, req);
    return attributes;
}

// Function to validate board attributes before logo processing.
// Uses the caller's ISO+ Authorization (req.session.Authorization), not PERSONAL_ACCESS_TOKEN —
// document logo sync is a user action and the PAT often lacks board attribute access.
// Optional attributesCache (Map boardId -> attributes[]) avoids re-fetching per document view.
export async function validateBoardAttributes(
    workspaceId,
    boardId,
    viewId,
    coverAttributeId,
    req,
    authorization,
    attributesCache,
) {
    try {
        info('ISO+™ Service', 'Validating board attributes', { 
            workspaceId, 
            boardId, 
            viewId, 
            coverAttributeId 
        }, req);
        
        const attributes = await loadAttributesForCoverValidation(
            workspaceId,
            boardId,
            authorization,
            attributesCache,
            req,
            viewId,
            coverAttributeId,
        );
        if (!attributes) {
            return { status: 'error', attribute: null };
        }

        const coverAttribute = attributes.find(attr => attr.id === coverAttributeId);
            
        if (!coverAttribute) {
            const fallbackAttribute = findFallbackCoverAttribute(attributes);
            if (fallbackAttribute) {
                warn('ISO+™ Service', 'Cover attribute not found; assigning fallback attribute', {
                    workspaceId,
                    boardId,
                    viewId,
                    requestedCoverAttributeId: coverAttributeId,
                    fallbackAttributeId: fallbackAttribute.id,
                    fallbackAttributeName: fallbackAttribute.name,
                    fallbackAttributeType: fallbackAttribute.type
                }, req);
                return { status: 'fallback', attribute: fallbackAttribute };
            }

            warn('ISO+™ Service', 'Cover attribute not found and no fallback available', {
                workspaceId,
                boardId,
                viewId,
                coverAttributeId,
                availableAttributes: attributes.map(attr => ({ id: attr.id, name: attr.name, type: attr.type }))
            }, req);
            return { status: 'missing', attribute: null };
        }
            
        info('ISO+™ Service', 'Cover attribute validation successful', {
            workspaceId,
            boardId,
            viewId,
            coverAttributeId,
            attributeName: coverAttribute.name,
            attributeType: coverAttribute.type
        }, req);
        return { status: 'valid', attribute: coverAttribute };
    } catch (err) {
        error('ISO+™ Service', 'Error validating board attributes', {
            workspaceId,
            boardId,
            viewId,
            coverAttributeId,
            error: err.message,
            statusCode: err.response?.status
        }, req);
        return { status: 'error', attribute: null };
    }
}

function findFallbackCoverAttribute(attributes = []) {
    if (!Array.isArray(attributes) || attributes.length === 0) {
        return null;
    }

    const preferredTypes = [
        'file',
        'files',
        'image',
        'images',
        'attachment',
        'attachments',
        'media',
        'media_file',
        'file_upload'
    ];

    const normalize = value => (typeof value === 'string' ? value.toLowerCase() : '');
    const hasPreferredType = attribute => {
        const typeMatches = preferredTypes.includes(normalize(attribute?.type));
        const fieldTypeMatches = preferredTypes.includes(normalize(attribute?.field_type));
        return typeMatches || fieldTypeMatches;
    };

    let fallbackAttribute = attributes.find(hasPreferredType);
    if (fallbackAttribute) {
        return fallbackAttribute;
    }

    fallbackAttribute = attributes.find(attr => normalize(attr?.name).includes('cover'));
    return fallbackAttribute || null;
}

export async function setLogo(authorization, workspaceId, logo, type, req) {
    return executeSetLogo({
        authorization,
        workspaceId,
        logo,
        type,
        req,
        getBoard,
        getAllViews,
        iterateBoardItems,
        validateBoardAttributes,
        getItemValues,
        getErrorMessage,
        errorMessageIncludes,
        sleep,
        logoItemsPageSize: LOGO_ITEMS_PAGE_SIZE,
        logOperationStart,
        logOperationEnd,
        info,
        warn,
        error,
        logAttributeError,
        logApiError,
    });
}

export async function setGeneratedField(workspaceId, boardId, itemId, message) {
    // Offline skip, same reason as setIntegrationMessage above.
    if (isOfflineMode()) {
        warn('ISO+™ Service', 'setGeneratedField skipped: backend is in offline mode', { workspaceId, boardId, itemId });
        return false;
    }

    try {
        const itemValues = await getItemValues(workspaceId, boardId, itemId);
        if (!itemValues) {
            throw new Error("Failed to update item with integration message");
        }
        const values = itemValues.values;
        const generatedField = values.find(v => v.attribute.name.includes("Generated") && v.attribute.name.includes("Number") && v.attribute.type === "text");
        if (generatedField) {
            const response = await axios.put(buildIsoPlusV2ItemUrl(workspaceId, boardId, itemId),
                { values: [{ data: message, attribute_id: generatedField.attribute.id }] },
                {
                    headers: {
                        "Authorization": `Bearer ${process.env.PERSONAL_ACCESS_TOKEN}`,
                        "Content-Type": "application/json",
                        "Accept": "application/json",
                        "X-API-Version": "2025-02-26.morava",
                    }
                });
            if (response.status === 200) {
                return true;
            }
        }
        return false;
    } catch (err) {
        error('ISO+™ Service', 'Error setting generated field:', err);
        throw err;
    }
}

export async function setPDFLinkAttribute(workspaceId, boardId, itemId, pdfUrl, docType) {
    // Offline skip, same reason as setIntegrationMessage above.
    if (isOfflineMode()) {
        warn('ISO+™ Service', 'setPDFLinkAttribute skipped: backend is in offline mode', { workspaceId, boardId, itemId });
        return false;
    }

    try {
        // Get the board to find the PDF attribute ID
        const board = await Board.findOne({ boardId: mongoEq(boardId) })
            .select('pdfAttribute')
            .lean();
        if (!board || !board.pdfAttribute || !board.pdfAttribute.id) {
            error('ISO+™ Service', 'PDF attribute not found in board configuration', { boardId, workspaceId });
            return false;
        }
        let payload = {}
        if (docType && docType.toLowerCase().includes("ndis")) {
            payload = {
                values: [{ data: `<p>Click <a href="${pdfUrl}">here</a> to download.</p>`, attribute_id: board.pdfAttribute.id }]
            }
        } else {
            payload = {
                values: [{ data: `<a href="${pdfUrl}">${pdfUrl}</a>`, attribute_id: board.pdfAttribute.id }]
            }
        }

        const response = await axios.put(buildIsoPlusV2ItemUrl(workspaceId, boardId, itemId),
            payload,
            {
                headers: {
                    "Authorization": `Bearer ${process.env.PERSONAL_ACCESS_TOKEN}`,
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "X-API-Version": "2025-02-26.morava",
                }
            });
        if (response.status === 200) {
            return true;
        }
        return false;
    } catch (err) {
        error('ISO+™ Service', 'Error setting PDF link attribute:', err);
        throw err;
    }
}

export async function getQuoteNDISReferencedItems(workspaceId, boardId, itemId) {
    return fetchLegacyNdisQuoteReferencedItems({
        workspaceId,
        boardId,
        itemId,
        getReferences,
        getAttribute,
        getItemValues,
    });
}


export async function getNDISParticipantsServicePlanReferencedItems(workspaceId, boardId, itemId) {
    return fetchLegacyNdisParticipantsPlanReferencedItems({
        workspaceId,
        boardId,
        itemId,
        getReferences,
        getAttribute,
        getItemValues,
        warn,
    });
}

export async function getNDISMasterPlanReferencedItems(workspaceId, boardId, itemId) {
    return fetchNdisMasterPlanReferencedItems({
        workspaceId,
        boardId,
        itemId,
        getReferences,
        getAttribute,
        getItemValues,
        getParticipantsPlanRefs: getNDISParticipantsServicePlanReferencedItems,
    });
}

export async function getAgeCareParticipantsServicePlanReferencedItems(workspaceId, boardId, itemId) {
    return fetchAgeCareParticipantsServicePlanReferencedItems({
        workspaceId,
        boardId,
        itemId,
        getReferences,
        getAttribute,
        getItemValues,
    });
}

/**
 * Fetch budget data from participant profile funding streams
 * Returns budget information for all funding categories
 */
export async function getMonthlyStatementBudgetData(workspaceId, boardId, participantProfileItemId) {
    const budgetData = {
        homeSupport: null,
        restorativeCare: null,
        endOfLife: null,
        assistiveTechShortTerm: null,
        assistiveTechOngoing: null,
        homeModification: null
    };

    if (!participantProfileItemId) {
        return budgetData;
    }

    try {
        const references = await getReferences(workspaceId, boardId, participantProfileItemId);
        if (!references || !references.data || references.data.length === 0) {
            return budgetData;
        }

        for (const reference of references.data) {
            const attribute = await getAttribute(workspaceId, boardId, reference.attribute_id);
            if (!attribute) continue;

            const fundingStreamItem = await getItemValues(workspaceId, boardId, reference.to_item_id);
            if (!fundingStreamItem || !fundingStreamItem.values) continue;

            const values = fundingStreamItem.values;
            const getValue = (attrName) => {
                const val = values.find(v => v.attribute.name === attrName);
                if (!val) return null;
                const data = val.data;
                // Handle date strings
                if (attrName.includes('Date') && data) {
                    return data.toString();
                }
                // Handle numbers
                if (typeof data === 'number') return data;
                if (typeof data === 'string' && data.includes('$')) {
                    return parseFloat(data.replace(/[^0-9.-]/g, '')) || 0;
                }
                return parseFloat(data) || 0;
            };

            switch (attribute.name) {
                case 'Home Support (HS)':
                case 'Home Support':
                    budgetData.homeSupport = {
                        totalAvailableBudget: getValue('Total Available Budget for Home Support ($)') || 
                                           getValue('Remaining Home Support Balance as at the End of the Month ($)') || 0,
                        remainingBalance: getValue('Remaining Home Support Balance as at the End of the Month ($)') || 0,
                        fundingEndDate: getValue('Funding End Date') || null
                    };
                    break;
                case 'Restorative Care Pathway':
                case 'Restorative Care':
                    budgetData.restorativeCare = {
                        totalAvailableBudget: getValue('Total Available Budget for Restorative Care ($)') || 0,
                        remainingBalance: getValue('Remaining Balance for Allocation Period ($)') || 0,
                        fundingEndDate: getValue('Funding End Date') || null
                    };
                    break;
                case 'End-of-Life Pathway':
                case 'End-of-Life Care':
                case 'End of Life':
                    budgetData.endOfLife = {
                        totalAvailableBudget: getValue('Total Available Budget for End-of-Life Care ($)') || 0,
                        remainingBalance: getValue('Remaining Balance for Allocation Period ($)') || 0,
                        fundingEndDate: getValue('Funding End Date') || null
                    };
                    break;
                case 'Assistive Technology (AT) - Short Term':
                case 'Assistive Technology - Short-term':
                    budgetData.assistiveTechShortTerm = {
                        totalAvailableBudget: getValue('Total Available Budget for Assistive Technology - Short-term ($)') || 0,
                        remainingBalance: getValue('Remaining AT - Short-term Balance for Allocation Period ($)') || 0,
                        fundingEndDate: getValue('Funding End Date') || null,
                        committedFunds: getValue('Committed AT Short-term Funds - to be delivered ($-)') || 0
                    };
                    break;
                case 'Assistive Technology (AT) - Ongoing':
                case 'Assistive Technology - Ongoing':
                    budgetData.assistiveTechOngoing = {
                        totalAvailableBudget: getValue('Total Available Budget for Assistive Technology - Ongoing ($)') || 0,
                        remainingBalance: getValue('Remaining AT - Ongoing Balance for Allocation Period ($)') || 0,
                        fundingEndDate: getValue('Funding End Date') || null,
                        committedFunds: getValue('Committed AT Ongoing Funds - to be delivered ($-)') || 0
                    };
                    break;
                case 'Home Modification (HM)':
                case 'Home Modification':
                    budgetData.homeModification = {
                        totalAvailableBudget: getValue('Total Available Budget for Home Modification ($)') || 0,
                        remainingBalance: getValue('Remaining HM Balance for Allocation Period ($)') || 0,
                        fundingEndDate: getValue('Funding End Date') || null,
                        committedFunds: getValue('Committed HM Funds - to be delivered ($-)') || 0
                    };
                    break;
            }
        }
    } catch (err) {
        error('ISO+™ Service', 'Error fetching budget data', { 
            message: err.message,
            participantProfileItemId 
        });
    }

    return budgetData;
}

export async function getAgeCareMasterPlanReferencedItems(workspaceId, boardId, itemId) {
    let servicePlanValues = null, cancellationTypeValues = null, participantProfileValues = null;

    const referenceResponse = await getReferences(workspaceId, boardId, itemId);
    if (!referenceResponse) return [null, null];

    for (const reference of referenceResponse.data) {

        const attribute = await getAttribute(workspaceId, boardId, reference.attribute_id);
        if (!attribute) continue;

        switch (attribute.name) {
            case 'Service Plan':
                {
                    const servicePlan = await getItemValues(workspaceId, boardId, reference.to_item_id);
                    if (servicePlan) {
                        const values = servicePlan.values;
                        servicePlanValues = {
                            unit: values.find(v => v.attribute.name === "Unit").data.toString(),
                            unitPrice: values.find(v => v.attribute.name === "Agreed Unit Price ($)").data.toString().replace('$', '') || '0',
                            participantContribution: values.find(v => v.attribute.name === "Participant Contribution (%)").data.toString() || '',
                        }
                    }
                    break;
                }
            case 'Cancellation Type':
                {
                    const cancellationType = await getItemValues(workspaceId, boardId, reference.to_item_id);
                    if (cancellationType) {
                        const values = cancellationType.values;
                        cancellationTypeValues = {
                            definition: values.find(v => v.attribute.name === "Definition").data.toString(),
                            billableToClient: values.find(v => v.attribute.name === "Billable to Client %").data.toString(),
                            payableToWorker: values.find(v => v.attribute.name === "Payable to Worker %").data.toString(),
                        }
                    }
                    break;
                }
            case 'Participant Profile':
                {
                    const participantProfile = await getItemValues(workspaceId, boardId, reference.to_item_id);
                    if (participantProfile) {
                        const values = participantProfile.values;
                        participantProfileValues = {
                            fullName: values.find(v => v.attribute.name === "Full Name/Preferred Name").data.toString() || '',
                            firstName: values.find(v => v.attribute.name === "First Name").data.toString() || '',
                            lastName: values.find(v => v.attribute.name === "Last Name").data.toString() || '',
                            email: values.find(v => v.attribute.name === "Email").data.toString() || '',
                            phone: values.find(v => v.attribute.name === "Primary Phone Number").data.toString() || '',
                            address: values.find(v => v.attribute.name === "Address").data.toString() || '',
                            suburb: values.find(v => v.attribute.name === "Suburb").data.toString() || '',
                            state: values.find(v => v.attribute.name === "State").data.toString() || '',
                            postcode: values.find(v => v.attribute.name === "Postcode").data.toString() || '',
                            billingContact: values.find(v => v.attribute.name === "Billing Contact").data.toString() || '',
                            billingAddress: values.find(v => v.attribute.name === "Billing Address").data.toString() || '',
                        };
                    }
                    break;
                }
        }
    }

    return [servicePlanValues, cancellationTypeValues, participantProfileValues];
}


export const getAutomation = async (workspaceId, boardId, authorization) => {
    try {
        const response = await axios.get(buildIsoPlusAutomationUrl(workspaceId, boardId), {
            headers: {
                'Authorization': `${authorization}`
            }
        });
        return response.data;
    } catch (error) {
        return null;
    }
}

export const updateAutomation = async (workspaceId, boardId, automationId, automation, authorization) => {
    try {
        console.log("updateAutomation", automation);
        let existingAutomation = await getAutomation(workspaceId, boardId, authorization);
        if (!existingAutomation) {
            return null;
        }
        let existingAutomationIndex = existingAutomation.findIndex(automation => automation.id === automationId);
        if (existingAutomationIndex < 0) {
            return null;
        }

        const response = await axios.put(buildIsoPlusAutomationUrl(workspaceId, automationId), {
            name: automation.name,
            workflow: automation.workflow,
            active: automation.active,
            board_id: automation.board_id
        }, {
            headers: {
                'Authorization': `${authorization}`
            }
        });
        console.log("updateAutomation response", response.data);
        return response.data;
    } catch (error) {
        return null;
    }
}
