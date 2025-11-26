import axios from "axios";
import Board from '../models/Board.js';
import FormData from 'form-data';
import { info, warn, error, logAttributeError, logApiError, logOperationStart, logOperationEnd, extractContextFromReq } from '../utils/logger.js';

const DEFAULT_ITEM_PAGE_SIZE = parseInt(process.env.ISOPLUS_ITEM_PAGE_SIZE || '100', 10);
const DEFAULT_PAGE_DELAY_MS = parseInt(process.env.ISOPLUS_PAGE_DELAY_MS || '0', 10);
const DEFAULT_COLLECTION_PAGE_SIZE = parseInt(process.env.ISOPLUS_COLLECTION_PAGE_SIZE || '100', 10);
const LOGO_ITEMS_PAGE_SIZE = parseInt(process.env.LOGO_ITEMS_PAGE_SIZE || '50', 10);

const sleep = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const withAfterParam = (params, after) => (after ? { ...params, after } : params);

function createPaginator(fetchPage, options = {}) {
    const pageDelayMs = options.pageDelayMs ?? DEFAULT_PAGE_DELAY_MS;
    const selectData = options.selectData || ((response) => response.data?.data || []);
    const selectHasMore = options.selectHasMore || ((response) => Boolean(response.data?.has_more));
    const selectAfter = options.selectAfter || ((response) => response.data?.after);

    let after = null;
    let hasMore = true;

    return {
        async next() {
            if (!hasMore) {
                return { value: undefined, done: true };
            }

            const response = await fetchPage(after);
            const batch = selectData(response) || [];
            hasMore = selectHasMore(response);
            after = selectAfter(response);

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
        (after) => axios.get(url, { headers, params: withAfterParam(baseParams, after) }),
        { pageDelayMs: options.pageDelayMs }
    );
}

function iterateBoards(authorization, workspaceId, options = {}) {
    const url = `https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards`;
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
        (after) => axios.get(url, { headers, params: withAfterParam(baseParams, after) }),
        { pageDelayMs: options.pageDelayMs }
    );
}

function iterateFolders(workspaceId, boardId, options = {}) {
    const url = `https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/folders/`;
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
        (after) => axios.get(url, { headers, params: withAfterParam(baseParams, after) }),
        { pageDelayMs: options.pageDelayMs }
    );
}

function iterateMembers(authorization, workspaceId, options = {}) {
    const membersUrl = `https://app.isoplus.online/api/v2/workspaces/${workspaceId}/members`;
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
        (after) => axios.get(membersUrl, { headers: membersHeaders, params: withAfterParam(baseParams, after) }),
        { pageDelayMs: options.pageDelayMs }
    );
}

function iterateViews(authorization, workspaceId, boardId, options = {}) {
    const url = `https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/views`;
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
        (after) => axios.get(url, { headers, params: withAfterParam(baseParams, after) }),
        { pageDelayMs: options.pageDelayMs }
    );
}

export async function getWorkspace(authorization, userEmail = null) {
    try {
        const normalizedEmail = userEmail ? userEmail.toLowerCase() : null;
        const workspaceIterator = iterateWorkspaces(authorization);
        const workspaceResults = [];

        while (true) {
            const { value: workspacePage, done } = await workspaceIterator.next();
            if (done) {
                break;
            }

            for (const item of workspacePage) {
                const board = await getBoard(authorization, item.id);
                const member = await getMember(authorization, item.id);
                let userRole = "restricted_member";

                if (member.status === 200 && normalizedEmail) {
                    userRole = member.members.find(
                        (m) => m.email && m.email.toLowerCase() === normalizedEmail
                    )?.role || userRole;
                }

                workspaceResults.push({
                    id: item.id,
                    name: item.name,
                    label: item.label,
                    board: board.board,
                    user_role: userRole
                });
            }
        }

        return { workspace: workspaceResults, status: 200 };
    } catch (err) {
        return { message: err.message, status: 500 };
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
        const boards = await collectPaginated(iterateBoards(authorization, workspaceId));
        return { board: boards, status: 200 };
    } catch (err) {
        return { message: err.message, status: 500 };
    }
}

export async function getFolder(workspaceId, boardId) {
    try {
        const folders = await collectPaginated(iterateFolders(workspaceId, boardId));
        return { folder: folders, status: 200 };
    } catch (err) {
        return { message: err.message, status: 500 };
    }
}

async function buildItemRequest(workspaceId, boardId, folderId, limit, after) {
    const url = `https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/items/`;
    const headers = {
        "Authorization": `Bearer ${process.env.PERSONAL_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "X-API-Version": "2025-02-26.morava",
    };
    const params = {
        "limit": String(limit),
        "sort_by": "created_at",
        "sort_direction": "desc",
        "expand[0]": "values.attribute",
        "folder_id": folderId,
    };
    return { url, headers, params: withAfterParam(params, after) };
}

export function iterateBoardItems(workspaceId, boardId, folderId, options = {}) {
    const limit = options.limit || DEFAULT_ITEM_PAGE_SIZE;
    return createPaginator(
        async (after) => {
            const requestConfig = await buildItemRequest(workspaceId, boardId, folderId, limit, after);
            return axios.get(requestConfig.url, { headers: requestConfig.headers, params: requestConfig.params });
        },
        { pageDelayMs: options.pageDelayMs }
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
        const members = await collectPaginated(iterateMembers(authorization, workspaceId));
        return { members: members, status: 200 };
    } catch (err) {
        return { message: err.message, status: 500 };
    }
}

export async function getAllViews(authorization, workspaceId, boardId) {
    try {
        const views = await collectPaginated(iterateViews(authorization, workspaceId, boardId));
        return { views: views, status: 200 };
    } catch (err) {
        return { message: err.message, status: 500 };
    }
}

export async function getViewsById(authorization, workspaceId, boardId, viewId) {
    try {
        const url = `https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/views/${viewId}`;
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
    try {
        const board = await Board.findOne({ boardId: boardId.toString() })
            .select('attribute')
            .lean();
        if (!board || !board.attribute || !board.attribute.id) {
            throw new Error("Internal message attribute not found in board configuration");
        }
        await axios.put(
            `https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/items/${itemId}`,
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

export function putTimeTracking(workspaceId, boardId, itemId, startTime, endTime) {
    axios.put(`https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/items/${itemId}`, {
        "values": [
            {
                "attribute_id": "b16e64b3-2e79-46af-ae87-3135005d362b",
                "data": `${new Date(startTime).toLocaleString('en-AU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}`
            }, {
                "attribute_id": "00ece0a4-b3bc-43e1-8580-23854b062439",
                "data": `${new Date(endTime).toLocaleString('en-AU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}`
            }
        ],
    }, {
        headers: {
            "Authorization": `Bearer ${process.env.PERSONAL_ACCESS_TOKEN}`,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-API-Version": "2025-02-26.morava",
        }
    });
    return true;
};

export async function getItemValues(workspaceId, boardId, itemId) {
    try {
        const url = `https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/items/${itemId}?expand[]=values.attribute`;
        const headers = {
            "Authorization": `Bearer ${process.env.PERSONAL_ACCESS_TOKEN}`,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-API-Version": "2025-02-26.morava",
        };

        const result = await axios.get(url, { headers });
        return result.status === 200 ? result.data : null;
    } catch (err) {
        error('ISO+™ Service', `Error getting item values: ${err.message}`, { workspaceId, boardId, itemId });
        return null;
    }
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
    try {
        const url = `https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/references?from_item_id=${itemId}`;
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
    try {
        const url = `https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/attributes/${attributeId}`;
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
                    const values = jobPlanningItemValues.values;
                    if (!values.some(v => v.attribute.name === "Job Number")) {
                        throw new Error("Job Number is required");
                    }
                    if (!values.some(v => v.attribute.name === "Client's Order Number")) {
                        throw new Error("Client's Order Number is required");
                    }
                    if (!values.some(v => v.attribute.name === "Job Title")) {
                        throw new Error("Job Title is required");
                    }

                    jobPlanningValues = {
                        id: jobPlanningItemValues.id,
                        jobNumber: values.find(v => v.attribute.name === "Job Number").data.toString(),
                        clientOrderNumber: values.find(v => v.attribute.name === "Client's Order Number").data.toString(),
                        jobTitle: values.find(v => v.attribute.name === "Job Title").data.toString()
                    };
                }
                break;
            }
            case "Service Fee Type": {
                const serviceFeeTypeItemValues = await getItemValues(workspaceId, boardId, reference.to_item_id);
                if (serviceFeeTypeItemValues) {
                    const values = serviceFeeTypeItemValues.values;
                    if (!values.some(v => v.attribute.name === "Fee Type")) {
                        throw new Error("Fee Type is required");
                    }

                    serviceFeeTypeValues = {
                        feeType: values.find(v => v.attribute.name === "Fee Type").data.toString(),
                        rate: parseFloat(values.find(v => v.attribute.name === "Rate($) - GST Excl.").data.toString())
                    };
                }
                break;
            }
        }
    }

    return [jobPlanningValues, serviceFeeTypeValues];
}

export async function getJobPlanningReferencedItems(workspaceId, boardId, itemId) {
    let contactValues = null;
    let jobTypeValues = null;

    const referenceResponse = await getReferences(workspaceId, boardId, itemId);
    if (!referenceResponse) return [null, null];

    for (const reference of referenceResponse.data) {
        const attribute = await getAttribute(workspaceId, boardId, reference.attribute_id);
        if (!attribute) continue;

        switch (attribute.name) {
            case "Client": {
                const clientItemValues = await getItemValues(workspaceId, boardId, reference.to_item_id);
                if (clientItemValues) {
                    const values = clientItemValues.values;
                    if (!values.some(v => v.attribute.name === "Client")) {
                        throw new Error("Client is required");
                    }
                    if (!values.some(v => v.attribute.name === "Email Address")) {
                        throw new Error("Client email address is required");
                    }
                    if (!values.some(v => v.attribute.name === "Phone Number")) {
                        throw new Error("Client phone number is required");
                    }
                    if (!values.some(v => v.attribute.name === "Address")) {
                        throw new Error("Client address is required");
                    }
                    if (!values.some(v => v.attribute.name === "Suburb")) {
                        throw new Error("Client suburb is required");
                    }
                    if (!values.some(v => v.attribute.name === "State")) {
                        throw new Error("Client state is required");
                    }
                    if (!values.some(v => v.attribute.name === "Postcode")) {
                        throw new Error("Client postcode is required");
                    }

                    const stateElement = values.find(v => v.attribute.name === "State").data;
                    let stateId = "";
                    if (stateElement && stateElement[0]) {
                        stateId = stateElement[0].toString();
                    }

                    const stateLabel = stateId && values.find(v => v.attribute.name === "State").attribute.settings.labels.find(l => l.id === stateId);

                    contactValues = {
                        client: values.find(v => v.attribute.name === "Client").data.toString(),
                        emailAddress: values.find(v => v.attribute.name === "Email Address").data.toString(),
                        phoneNumber: values.find(v => v.attribute.name === "Phone Number").data.toString(),
                        address: values.find(v => v.attribute.name === "Address").data.toString(),
                        suburb: values.find(v => v.attribute.name === "Suburb").data.toString(),
                        state: stateLabel ? stateLabel.name : "",
                        postcode: parseInt(values.find(v => v.attribute.name === "Postcode").data.toString()),
                        contactPersonsFirstName: values.some(v => v.attribute.name === "Contact Person's First Name")
                            ? values.find(v => v.attribute.name === "Contact Person's First Name").data.toString()
                            : "",
                        contactPersonsLastName: values.some(v => v.attribute.name === "Contact Person's Last Name")
                            ? values.find(v => v.attribute.name === "Contact Person's Last Name").data.toString()
                            : "",
                        updatedAt: values.some(v => v.attribute.name === "Updated At")
                            ? values.find(v => v.attribute.name === "Updated At").data.toString()
                            : "",
                    };
                }
                break;
            }
            case "Job Type": {
                const jobTypeItemValues = await getItemValues(workspaceId, boardId, reference.to_item_id);
                if (jobTypeItemValues) {
                    const values = jobTypeItemValues.values;
                    if (!values.some(v => v.attribute.name === "Job Type")) {
                        throw new Error("Job Type is required");
                    }
                    if (!values.some(v => v.attribute.name === "Job Code")) {
                        throw new Error("Job Code is required");
                    }

                    jobTypeValues = {
                        jobType: values.find(v => v.attribute.name === "Job Type").data.toString(),
                        jobCode: values.find(v => v.attribute.name === "Job Code").data.toString(),
                    };
                }
                break;
            }
        }
    }

    return [contactValues, jobTypeValues];
}

export async function getQuoteReferencedItems(workspaceId, boardId, itemId) {
    let contactValues = null;
    let jobTypeValues = null;

    const referenceResponse = await getReferences(workspaceId, boardId, itemId);
    if (!referenceResponse) return [null, null];

    for (const reference of referenceResponse.data) {
        const attribute = await getAttribute(workspaceId, boardId, reference.attribute_id);
        if (!attribute) continue;

        switch (attribute.name) {
            case "Client": {
                const clientItemValues = await getItemValues(workspaceId, boardId, reference.to_item_id);
                if (clientItemValues) {
                    const values = clientItemValues.values;
                    if (!values.some(v => v.attribute.name === "Client")) {
                        throw new Error("Client is required");
                    }
                    if (!values.some(v => v.attribute.name === "Email Address")) {
                        throw new Error("Client email Address is required");
                    }
                    if (!values.some(v => v.attribute.name === "Phone Number")) {
                        throw new Error("Client phone number is required");
                    }
                    if (!values.some(v => v.attribute.name === "Address")) {
                        throw new Error("Client address is required");
                    }
                    if (!values.some(v => v.attribute.name === "Suburb")) {
                        throw new Error("Client suburb is required");
                    }
                    if (!values.some(v => v.attribute.name === "State")) {
                        throw new Error("Client state is required");
                    }
                    if (!values.some(v => v.attribute.name === "Postcode")) {
                        throw new Error("Client postcode is required");
                    }

                    const stateElement = values.find(v => v.attribute.name === "State").data;
                    let stateId = "";
                    if (stateElement && stateElement[0]) {
                        stateId = stateElement[0].toString();
                    }

                    const stateLabel = stateId && values.find(v => v.attribute.name === "State").attribute.settings.labels.find(l => l.id === stateId);

                    contactValues = {
                        client: values.find(v => v.attribute.name === "Client").data.toString(),
                        emailAddress: values.find(v => v.attribute.name === "Email Address").data.toString(),
                        phoneNumber: values.find(v => v.attribute.name === "Phone Number").data.toString(),
                        address: values.find(v => v.attribute.name === "Address").data.toString(),
                        suburb: values.find(v => v.attribute.name === "Suburb").data.toString(),
                        state: stateLabel ? stateLabel.name : "",
                        postcode: parseInt(values.find(v => v.attribute.name === "Postcode").data.toString()),
                        contactPersonsFirstName: values.some(v => v.attribute.name === "Contact Person's First Name")
                            ? values.find(v => v.attribute.name === "Contact Person's First Name").data.toString()
                            : "",
                        contactPersonsLastName: values.some(v => v.attribute.name === "Contact Person's Last Name")
                            ? values.find(v => v.attribute.name === "Contact Person's Last Name").data.toString()
                            : "",
                        updatedAt: values.some(v => v.attribute.name === "Updated At")
                            ? values.find(v => v.attribute.name === "Updated At").data.toString()
                            : "",
                    };
                }
                break;
            }
            case "Job Type": {
                const jobTypeItemValues = await getItemValues(workspaceId, boardId, reference.to_item_id);
                if (jobTypeItemValues) {
                    const values = jobTypeItemValues.values;
                    if (!values.some(v => v.attribute.name === "Job Type")) {
                        throw new Error("Job Type is required");
                    }
                    if (!values.some(v => v.attribute.name === "Job Code")) {
                        throw new Error("Job Code is required");
                    }

                    jobTypeValues = {
                        jobType: values.find(v => v.attribute.name === "Job Type").data.toString(),
                        jobCode: values.find(v => v.attribute.name === "Job Code").data.toString(),
                    };
                }
                break;
            }
        }
    }

    return [contactValues, jobTypeValues];
}

export async function getPurchaseOrderReferencedItems(workspaceId, boardId, itemId) {
    let contractorValues = null;
    let jobTypeValues = null;

    const referenceResponse = await getReferences(workspaceId, boardId, itemId);
    if (!referenceResponse) return [null, null];

    for (const reference of referenceResponse.data) {
        const attribute = await getAttribute(workspaceId, boardId, reference.attribute_id);
        if (!attribute) continue;

        switch (attribute.name) {
            case "Contractor": {
                const supplierItemValues = await getItemValues(workspaceId, boardId, reference.to_item_id);
                if (supplierItemValues) {
                    const values = supplierItemValues.values;
                    if (!values.some(v => v.attribute.name === "Contractor")) {
                        throw new Error("Contractor is required");
                    }
                    if (!values.some(v => v.attribute.name === "Email Address")) {
                        throw new Error("Contractor email Address is required");
                    }
                    if (!values.some(v => v.attribute.name === "Phone Number")) {
                        throw new Error("Contractor phone number is required");
                    }
                    if (!values.some(v => v.attribute.name === "Address")) {
                        throw new Error("Contractor address is required");
                    }
                    if (!values.some(v => v.attribute.name === "Suburb")) {
                        throw new Error("Contractor suburb is required");
                    }
                    if (!values.some(v => v.attribute.name === "State")) {
                        throw new Error("Contractor state is required");
                    }
                    if (!values.some(v => v.attribute.name === "Postcode")) {
                        throw new Error("Contractor postcode is required");
                    }

                    const stateElement = values.find(v => v.attribute.name === "State").data;
                    let stateId = "";
                    if (stateElement && stateElement[0]) {
                        stateId = stateElement[0].toString();
                    }

                    const stateLabel = stateId && values.find(v => v.attribute.name === "State").attribute.settings.labels.find(l => l.id === stateId);

                    contractorValues = {
                        contractor: values.find(v => v.attribute.name === "Contractor").data.toString(),
                        emailAddress: values.find(v => v.attribute.name === "Email Address").data.toString(),
                        phoneNumber: values.find(v => v.attribute.name === "Phone Number").data.toString(),
                        address: values.find(v => v.attribute.name === "Address").data.toString(),
                        suburb: values.find(v => v.attribute.name === "Suburb").data.toString(),
                        state: stateLabel ? stateLabel.name : "",
                        postcode: parseInt(values.find(v => v.attribute.name === "Postcode").data.toString()),
                        contactPersonsFirstName: values.some(v => v.attribute.name === "Contact Person's First Name")
                            ? values.find(v => v.attribute.name === "Contact Person's First Name").data.toString()
                            : "",
                        contactPersonsLastName: values.some(v => v.attribute.name === "Contact Person's Last Name")
                            ? values.find(v => v.attribute.name === "Contact Person's Last Name").data.toString()
                            : "",
                        updatedAt: values.some(v => v.attribute.name === "Updated At")
                            ? values.find(v => v.attribute.name === "Updated At").data.toString()
                            : "",
                    };
                }
                break;
            }
            case "Job Type": {
                const jobTypeItemValues = await getItemValues(workspaceId, boardId, reference.to_item_id);
                if (jobTypeItemValues) {
                    const values = jobTypeItemValues.values;
                    if (!values.some(v => v.attribute.name === "Job Type")) {
                        throw new Error("Job Type is required");
                    }
                    if (!values.some(v => v.attribute.name === "Job Code")) {
                        throw new Error("Job Code is required");
                    }

                    jobTypeValues = {
                        jobType: values.find(v => v.attribute.name === "Job Type").data.toString(),
                        jobCode: values.find(v => v.attribute.name === "Job Code").data.toString(),
                    };
                }
                break;
            }
        }
    }

    return [contractorValues, jobTypeValues];
}

export async function getBoardAttributes(workspaceId, boardId) {
    try {
        const url = `https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/attributes`;
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
    if (!err) return 'Unknown error';
    
    // Handle axios errors with response
    if (err.response?.data) {
        const data = err.response.data;
        if (typeof data === 'string') {
            return data;
        } else if (typeof data === 'object') {
            // Try to extract message from common error response formats
            if (data.message) return String(data.message);
            if (data.error) return String(data.error);
            if (data.errors && Array.isArray(data.errors)) {
                return data.errors.map(e => typeof e === 'string' ? e : e.message || JSON.stringify(e)).join(', ');
            }
            // Fallback to JSON stringification
            try {
                return JSON.stringify(data);
            } catch {
                return String(data);
            }
        }
        return String(data);
    }
    
    // Handle network errors, timeouts, etc.
    if (err.code === 'ECONNABORTED') return 'Request timeout';
    if (err.code === 'ENOTFOUND') return 'DNS lookup failed';
    if (err.code === 'ECONNREFUSED') return 'Connection refused';
    if (err.code === 'ETIMEDOUT') return 'Connection timed out';
    
    // Handle standard Error objects
    if (err.message) return err.message;
    
    // Last resort
    try {
        return String(err);
    } catch {
        return 'Unknown error occurred';
    }
}

// Helper function to safely check if error message contains a specific string
function errorMessageIncludes(err, searchString) {
    if (!err || !searchString) return false;
    const errorMsg = getErrorMessage(err);
    return typeof errorMsg === 'string' && errorMsg.includes(searchString);
}

// Function to validate board attributes before logo processing
async function validateBoardAttributes(workspaceId, boardId, viewId, coverAttributeId, req) {
    try {
        info('ISO+™ Service', 'Validating board attributes', { 
            workspaceId, 
            boardId, 
            viewId, 
            coverAttributeId 
        }, req);
        
        // Get board attributes to validate the cover attribute exists
        const attributesResponse = await axios.get(
            `https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/attributes`,
            {
                headers: {
                    "Authorization": `Bearer ${process.env.PERSONAL_ACCESS_TOKEN}`,
                    "Accept": "application/json",
                    "X-API-Version": "2025-02-26.morava",
                }
            }
        );
        
        if (attributesResponse.status === 200) {
            const attributes = Array.isArray(attributesResponse.data?.data)
                ? attributesResponse.data.data
                : Array.isArray(attributesResponse.data?.attributes)
                    ? attributesResponse.data.attributes
                    : [];
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
        }
        
        return { status: 'error', attribute: null };
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
    const requestId = req?.headers?.['x-request-id'] || `logo_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const operationContext = { 
        workspaceId, 
        logoType: type, 
        requestId,
        logoFileName: logo?.originalname,
        logoSize: logo?.size,
        logoMimeType: logo?.mimetype
    };
    
    logOperationStart('ISO+™ Service', 'setLogo', operationContext, req);
    
    try {
        // Validate input parameters
        if (!authorization) {
            throw new Error('Authorization token is required');
        }
        if (!workspaceId) {
            throw new Error('Workspace ID is required');
        }
        if (!logo) {
            throw new Error('Logo file is required');
        }
        if (!logo.buffer) {
            throw new Error('Logo buffer is required');
        }
        if (!logo.originalname) {
            throw new Error('Logo filename is required');
        }
        if (!type || (type !== 'form' && type !== 'document')) {
            throw new Error('Logo type must be either "form" or "document"');
        }
        
        // Log workspace validation
        info('ISO+™ Service', 'Validating workspace access', { workspaceId, requestId }, extractContextFromReq(req));
        const boards = await getBoard(authorization, workspaceId);
        
        if (!boards || boards.status !== 200) {
            throw new Error(`Failed to fetch boards: ${getErrorMessage(boards?.error || { message: 'Unknown error' })}`);
        }
        
        const body = new FormData();
        body.append('file', logo.buffer, logo.originalname);

        let uploadImageURL;
        try {
            uploadImageURL = await axios.post(
                `https://app.isoplus.online/api/v2/workspaces/${workspaceId}/attachments/file`,
                body,
                {
                    headers: {
                        "Authorization": authorization,
                        ...body.getHeaders(),
                        "Accept": "application/json",
                    },
                }
            );
        } catch (err) {
            const uploadErrorContext = {
                workspaceId,
                requestId,
                errorDetails: getErrorMessage(err),
                statusCode: err.response?.status,
                stackTrace: err.stack,
                logoFileName: logo?.originalname,
                logoSize: logo?.size,
                logoMimeType: logo?.mimetype
            };
            
            if (errorMessageIncludes(err, 'unauthorized') || err.response?.status === 401) {
                error('ISO+™ Service', 'Error uploading logo: Unauthorized', uploadErrorContext, extractContextFromReq(req));
            } else if (errorMessageIncludes(err, 'forbidden') || err.response?.status === 403) {
                error('ISO+™ Service', 'Error uploading logo: Forbidden', uploadErrorContext, extractContextFromReq(req));
            } else if (errorMessageIncludes(err, 'timeout') || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
                error('ISO+™ Service', 'Error uploading logo: Request timeout', uploadErrorContext, extractContextFromReq(req));
            } else {
                error('ISO+™ Service', 'Error uploading logo file:', uploadErrorContext, extractContextFromReq(req));
            }
            throw err;
        }

        // Validate upload response
        if (!uploadImageURL || uploadImageURL.status !== 201) {
            throw new Error(`Logo upload failed with status ${uploadImageURL?.status || 'unknown'}`);
        }
        if (!uploadImageURL.data || !uploadImageURL.data.id) {
            throw new Error('Logo upload response missing required data (id)');
        }
        if (!uploadImageURL.data.link && type === 'form') {
            throw new Error('Logo upload response missing required data (link) for form type');
        }

        if (uploadImageURL.status == 201 && boards.status === 200 && boards.board?.length > 0) {
            info('ISO+™ Service', 'Logo uploaded successfully, processing boards', { 
                workspaceId, 
                requestId, 
                uploadId: uploadImageURL.data.id,
                boardCount: boards.board.length,
                boards: boards.board.map(b => ({ id: b.id, name: b.name }))
            }, req);
            
            for (const boardItem of boards.board) {
                info('ISO+™ Service', 'Processing board for logo update', { 
                    workspaceId, 
                    requestId, 
                    boardId: boardItem.id, 
                    boardName: boardItem.name,
                    boardDescription: boardItem.description 
                }, req);
                
                let response;
                try {
                    response = await getAllViews(authorization, workspaceId, boardItem.id);
                } catch (err) {
                    const viewsErrorContext = {
                        workspaceId,
                        requestId,
                        boardId: boardItem.id,
                        boardName: boardItem.name,
                        errorDetails: getErrorMessage(err),
                        statusCode: err.response?.status,
                        stackTrace: err.stack
                    };
                    
                    if (errorMessageIncludes(err, 'timeout') || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
                        warn('ISO+™ Service', `Request timeout when fetching views for board ${boardItem.id}`, viewsErrorContext, req);
                    } else if (errorMessageIncludes(err, 'network') || err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
                        warn('ISO+™ Service', `Network error when fetching views for board ${boardItem.id}`, viewsErrorContext, req);
                    } else {
                        warn('ISO+™ Service', `Failed to fetch views for board ${boardItem.id}`, viewsErrorContext, req);
                    }
                    continue;
                }
                
                if (!response || response.status !== 200) {
                    warn(`ISO+™ Service`, `Failed to fetch views for board ${boardItem.id}`, { 
                        workspaceId, 
                        requestId, 
                        boardId: boardItem.id, 
                        responseStatus: response?.status,
                        responseData: response?.data 
                    }, req);
                    continue;
                }
                
                info('ISO+™ Service', 'Views fetched successfully', { 
                    workspaceId, 
                    requestId, 
                    boardId: boardItem.id, 
                    totalViews: response.views?.length || 0,
                    viewTypes: response.views?.map(v => ({ id: v.id, name: v.name, type: v.type })) || []
                }, req);
                
                const views = response.views.filter(item => item.type.toLowerCase() === type);
                if (!views || views.length === 0) {
                    warn(`ISO+™ Service`, `No views found for board ${boardItem.id}`, { 
                        workspaceId, 
                        requestId, 
                        boardId: boardItem.id, 
                        requestedType: type,
                        availableTypes: response.views?.map(v => v.type) || [],
                        allViews: response.views?.map(v => ({ id: v.id, name: v.name, type: v.type })) || []
                    }, req);
                    continue;
                }
                
                info('ISO+™ Service', `Found ${views.length} ${type} views for processing`, { 
                    workspaceId, 
                    requestId, 
                    boardId: boardItem.id, 
                    viewCount: views.length,
                    views: views.map(v => ({ id: v.id, name: v.name, type: v.type }))
                }, req);
                if (type == "form") {
                    for (const viewItem of views) {
                        const updateView = {
                            ...viewItem,
                            settings: {
                                ...viewItem.settings,
                                formSettings: {
                                    ...viewItem.settings.formSettings,
                                    logoImageUrl: uploadImageURL.data.link
                                }
                            },
                        };
                        try {
                            await axios.put(`https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardItem.id}/views/${viewItem.id}`, updateView, {
                                headers: {
                                    "Authorization": authorization,
                                    "Content-Type": "application/json",
                                    "Accept": "application/json"
                                }
                            });
                            info('ISO+™ Service', `Logo set successfully for view: ${viewItem.id}`);
                        } catch (err) {
                            const errorContext = {
                                workspaceId,
                                boardId: boardItem.id,
                                boardName: boardItem.name,
                                viewId: viewItem.id,
                                viewName: viewItem.name,
                                viewType: viewItem.type,
                                requestId,
                                errorDetails: getErrorMessage(err),
                                statusCode: err.response?.status,
                                stackTrace: err.stack,
                                requestPayload: updateView
                            };
                            
                            // Check for specific error types
                            if (errorMessageIncludes(err, 'not found') || err.response?.status === 404) {
                                logApiError('ISO+™ Service', 'View not found when setting form logo:', errorContext, req);
                            } else if (errorMessageIncludes(err, 'unauthorized') || err.response?.status === 401) {
                                logApiError('ISO+™ Service', 'Unauthorized when setting form logo:', errorContext, req);
                            } else if (errorMessageIncludes(err, 'forbidden') || err.response?.status === 403) {
                                logApiError('ISO+™ Service', 'Forbidden when setting form logo:', errorContext, req);
                            } else {
                                logApiError('ISO+™ Service', 'Error setting form logo for view:', errorContext, req);
                            }
                        }
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                } else if (type == "document") {
                    for (const viewItem of views) {
                        info('ISO+™ Service', 'Processing document view for logo update', { 
                            workspaceId, 
                            requestId, 
                            boardId: boardItem.id, 
                            viewId: viewItem.id,
                            viewName: viewItem.name,
                            viewType: viewItem.type,
                            folderId: viewItem.folder_id,
                            settings: viewItem.settings
                        }, req);
                        
                        let coverAttributeid = viewItem.settings?.editorCoverAttributeId;
                        if (!coverAttributeid) {
                            warn(`ISO+™ Service`, `No cover attribute id found for view ${viewItem.id}; attempting fallback`, { 
                                workspaceId, 
                                requestId, 
                                boardId: boardItem.id, 
                                viewId: viewItem.id,
                                viewName: viewItem.name,
                                viewSettings: viewItem.settings,
                                availableSettings: Object.keys(viewItem.settings || {})
                            }, req);
                        }
                        
                        info('ISO+™ Service', 'Cover attribute found, validating before processing', { 
                            workspaceId, 
                            requestId, 
                            boardId: boardItem.id, 
                            viewId: viewItem.id,
                            coverAttributeId: coverAttributeid
                        }, req);
                        
                        // Validate the cover attribute exists in the board
                        const attributeValidation = await validateBoardAttributes(workspaceId, boardItem.id, viewItem.id, coverAttributeid, req);
                        const resolvedCoverAttributeId = attributeValidation?.attribute?.id;
                        if (!resolvedCoverAttributeId) {
                            warn('ISO+™ Service', 'Skipping view due to invalid cover attribute', {
                                workspaceId,
                                requestId,
                                boardId: boardItem.id,
                                viewId: viewItem.id,
                                coverAttributeId: coverAttributeid
                            }, req);
                            continue;
                        }

                        if (!coverAttributeid || coverAttributeid !== resolvedCoverAttributeId) {
                            const previousCoverAttributeId = coverAttributeid;
                            viewItem.settings = viewItem.settings || {};
                            viewItem.settings.editorCoverAttributeId = resolvedCoverAttributeId;
                            coverAttributeid = resolvedCoverAttributeId;
                            
                            info('ISO+™ Service', 'Assigned fallback cover attribute for view', {
                                workspaceId,
                                requestId,
                                boardId: boardItem.id,
                                viewId: viewItem.id,
                                previousCoverAttributeId,
                                newCoverAttributeId: resolvedCoverAttributeId,
                                assignmentStatus: attributeValidation?.status
                            }, req);
                        } else {
                            coverAttributeid = resolvedCoverAttributeId;
                        }
                        
                        info('ISO+™ Service', 'Cover attribute ready, fetching items', { 
                            workspaceId, 
                            requestId, 
                            boardId: boardItem.id, 
                            viewId: viewItem.id,
                            coverAttributeId: coverAttributeid
                        }, req);
                        
                        let totalItemsProcessed = 0;
                        let pageNumber = 0;
                        try {
                            const itemIterator = iterateBoardItems(
                                workspaceId,
                                boardItem.id,
                                viewItem.folder_id,
                                { limit: LOGO_ITEMS_PAGE_SIZE }
                            );
                            while (true) {
                                const { value: itemsPage, done } = await itemIterator.next();
                                if (done) {
                                    break;
                                }
                                pageNumber += 1;
                                totalItemsProcessed += itemsPage.length;
                                info('ISO+™ Service', 'Items page fetched successfully for document view', { 
                                    workspaceId, 
                                    requestId, 
                                    boardId: boardItem.id, 
                                    viewId: viewItem.id,
                                    pageNumber,
                                    pageSize: itemsPage.length,
                                    totalItemsProcessed
                                }, req);
                                
                                for (const item of itemsPage) {
                                    info('ISO+™ Service', 'Processing item for logo update', { 
                                        workspaceId, 
                                        requestId, 
                                        boardId: boardItem.id, 
                                        viewId: viewItem.id,
                                        itemId: item.id,
                                        itemName: item.name
                                    }, req);
                                    
                                    let itemValues;
                                    try {
                                        itemValues = await getItemValues(workspaceId, boardItem.id, item.id);
                                    } catch (err) {
                                        const itemValuesErrorContext = {
                                            workspaceId,
                                            requestId,
                                            boardId: boardItem.id,
                                            viewId: viewItem.id,
                                            itemId: item.id,
                                            itemName: item.name,
                                            coverAttributeId: coverAttributeid,
                                            errorDetails: getErrorMessage(err),
                                            statusCode: err.response?.status,
                                            stackTrace: err.stack
                                        };
                                        
                                        if (errorMessageIncludes(err, 'timeout') || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
                                            warn('ISO+™ Service', 'Request timeout when fetching item values', itemValuesErrorContext, req);
                                        } else if (errorMessageIncludes(err, 'network') || err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
                                            warn('ISO+™ Service', 'Network error when fetching item values', itemValuesErrorContext, req);
                                        } else {
                                            warn('ISO+™ Service', 'Error fetching item values', itemValuesErrorContext, req);
                                        }
                                        continue;
                                    }
                                    
                                    if (itemValues) {
                                        info('ISO+™ Service', 'Item values fetched, looking for cover attribute', { 
                                            workspaceId, 
                                            requestId, 
                                            boardId: boardItem.id, 
                                            viewId: viewItem.id,
                                            itemId: item.id,
                                            coverAttributeId: coverAttributeid,
                                            availableAttributes: itemValues.values?.map(v => ({ 
                                                id: v.attribute.id, 
                                                name: v.attribute.name, 
                                                type: v.attribute.type 
                                            })) || []
                                        }, req);
                                        
                                        let doc = itemValues.values.find(v => v.attribute.id == coverAttributeid);
                                        const coverData = [{ id: uploadImageURL.data.id }];
                                        if (doc) {
                                            doc.data = coverData;
                                        } else {
                                            doc = { data: coverData, attribute: { id: coverAttributeid } };
                                        }
                                        try {
                                            const itemUpdateResponse = await axios.put(
                                                `https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardItem.id}/items/${item.id}`,
                                                { values: [{ data: doc.data, attribute_id: doc.attribute.id }] },
                                                {
                                                    headers: {
                                                        "Authorization": authorization,
                                                        "Content-Type": "application/json",
                                                        "Accept": "application/json"
                                                    }
                                                }
                                            );
                                            if (!viewItem.settings) {
                                                viewItem.settings = {};
                                            }
                                            if (!viewItem.settings.editorItems) {
                                                viewItem.settings.editorItems = {};
                                            }
                                            if (itemUpdateResponse.status === 200) {
                                                if (item.id in viewItem.settings.editorItems) {
                                                    viewItem.settings.editorItems[item.id].cover = uploadImageURL.data.id;
                                                } else {
                                                    viewItem.settings.editorItems[item.id] = { cover: uploadImageURL.data.id };
                                                }
                                            }
                                        } catch (err) {
                                            const errorContext = {
                                                workspaceId,
                                                boardId: boardItem.id,
                                                boardName: boardItem.name,
                                                itemId: item.id,
                                                itemName: item.name,
                                                viewId: viewItem.id,
                                                viewName: viewItem.name,
                                                viewType: viewItem.type,
                                                folderId: viewItem.folder_id,
                                                coverAttributeId: coverAttributeid,
                                                requestId,
                                                errorDetails: getErrorMessage(err),
                                                statusCode: err.response?.status,
                                                requestPayload: {
                                                    values: [{
                                                        data: uploadImageURL?.data?.id,
                                                        attribute_id: coverAttributeid
                                                    }]
                                                },
                                                stackTrace: err.stack,
                                                itemValues: itemValues?.values?.map(v => ({
                                                    attributeId: v.attribute?.id,
                                                    attributeName: v.attribute?.name,
                                                    attributeType: v.attribute?.type,
                                                    data: v.data
                                                })) || [],
                                                viewSettings: viewItem.settings,
                                                uploadDetails: {
                                                    uploadId: uploadImageURL?.data?.id,
                                                    fileName: logo?.originalname,
                                                    fileSize: logo?.size,
                                                    mimeType: logo?.mimetype
                                                }
                                            };
                                            
                                            // Use specialized logging for attribute errors
                                            if (errorMessageIncludes(err, 'Attribute(s) not recognized')) {
                                                logAttributeError(
                                                    'ISO+™ Service', 
                                                    'Error updating item for document logo: Attribute not recognized', 
                                                    coverAttributeid, 
                                                    errorContext, 
                                                    req
                                                );
                                            } else if (errorMessageIncludes(err, 'not found') || err.response?.status === 404) {
                                                logApiError(
                                                    'ISO+™ Service', 
                                                    'Error updating item for document logo: Item or attribute not found', 
                                                    errorContext, 
                                                    req
                                                );
                                            } else if (errorMessageIncludes(err, 'unauthorized') || err.response?.status === 401) {
                                                logApiError(
                                                    'ISO+™ Service', 
                                                    'Error updating item for document logo: Unauthorized', 
                                                    errorContext, 
                                                    req
                                                );
                                            } else if (errorMessageIncludes(err, 'forbidden') || err.response?.status === 403) {
                                                logApiError(
                                                    'ISO+™ Service', 
                                                    'Error updating item for document logo: Forbidden', 
                                                    errorContext, 
                                                    req
                                                );
                                            } else if (errorMessageIncludes(err, 'timeout') || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
                                                logApiError(
                                                    'ISO+™ Service', 
                                                    'Error updating item for document logo: Request timeout', 
                                                    errorContext, 
                                                    req
                                                );
                                            } else {
                                                logApiError(
                                                    'ISO+™ Service', 
                                                    'Error updating item for document logo:', 
                                                    errorContext, 
                                                    req
                                                );
                                            }
                                        }
                                        await sleep(2000);
                                    }
                                }

                                await sleep(2000);
                            }
                        } catch (err) {
                            const itemsErrorContext = {
                                workspaceId,
                                requestId,
                                boardId: boardItem.id,
                                viewId: viewItem.id,
                                folderId: viewItem.folder_id,
                                coverAttributeId: coverAttributeid,
                                errorDetails: getErrorMessage(err),
                                statusCode: err.response?.status,
                                stackTrace: err.stack
                            };
                            
                            if (errorMessageIncludes(err, 'timeout') || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
                                warn('ISO+™ Service', 'Request timeout when fetching items for document view', itemsErrorContext, req);
                            } else if (errorMessageIncludes(err, 'network') || err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
                                warn('ISO+™ Service', 'Network error when fetching items for document view', itemsErrorContext, req);
                            } else {
                                warn('ISO+™ Service', 'Error fetching items for document view', itemsErrorContext, req);
                            }
                            continue;
                        }
                        
                        if (totalItemsProcessed === 0) {
                            warn('ISO+™ Service', 'No items found for document view', { 
                                workspaceId, 
                                requestId, 
                                boardId: boardItem.id, 
                                viewId: viewItem.id,
                                folderId: viewItem.folder_id
                            }, req);
                        }
                        try {
                            await axios.put(`https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardItem.id}/views/${viewItem.id}`, viewItem, {
                                headers: {
                                    "Authorization": authorization,
                                    "Content-Type": "application/json",
                                    "Accept": "application/json"
                                }
                            });
                            info('ISO+™ Service', `Logo set successfully for view: ${viewItem.id}`);
                        } catch (err) {
                            const errorContext = {
                                workspaceId,
                                boardId: boardItem.id,
                                boardName: boardItem.name,
                                viewId: viewItem.id,
                                viewName: viewItem.name,
                                viewType: viewItem.type,
                                folderId: viewItem.folder_id,
                                requestId,
                                errorDetails: getErrorMessage(err),
                                statusCode: err.response?.status,
                                requestPayload: viewItem,
                                stackTrace: err.stack,
                                viewSettings: viewItem.settings,
                                editorItems: viewItem.settings?.editorItems || {}
                            };
                            
                            // Check for specific error types
                            if (errorMessageIncludes(err, 'not found') || err.response?.status === 404) {
                                logApiError('ISO+™ Service', 'View not found when setting document logo:', errorContext, req);
                            } else if (errorMessageIncludes(err, 'unauthorized') || err.response?.status === 401) {
                                logApiError('ISO+™ Service', 'Unauthorized when setting document logo:', errorContext, req);
                            } else if (errorMessageIncludes(err, 'forbidden') || err.response?.status === 403) {
                                logApiError('ISO+™ Service', 'Forbidden when setting document logo:', errorContext, req);
                            } else if (errorMessageIncludes(err, 'timeout') || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
                                logApiError('ISO+™ Service', 'Request timeout when setting document logo:', errorContext, req);
                            } else {
                                logApiError('ISO+™ Service', 'Error setting document logo for view:', errorContext, req);
                            }
                        }
                        await sleep(2000);
                    }
                }
            }
        } else {
            throw new Error("Failed to fetch boards");
        }
        
        logOperationEnd('ISO+™ Service', 'setLogo', { workspaceId, logoType: type, success: true }, req);
    } catch (err) {
        const errorContext = {
            workspaceId,
            logoType: type,
            requestId,
            errorDetails: getErrorMessage(err),
            statusCode: err?.response?.status,
            stackTrace: err?.stack,
            operation: 'setLogo',
            logoFileName: logo?.originalname,
            logoSize: logo?.size,
            logoMimeType: logo?.mimetype
        };
        
        // Categorize and log different error types
        if (errorMessageIncludes(err, 'required') || errorMessageIncludes(err, 'missing')) {
            error('ISO+™ Service', 'Error setting logo: Missing required parameter', errorContext, extractContextFromReq(req));
        } else if (errorMessageIncludes(err, 'unauthorized') || err?.response?.status === 401) {
            error('ISO+™ Service', 'Error setting logo: Unauthorized', errorContext, extractContextFromReq(req));
        } else if (errorMessageIncludes(err, 'forbidden') || err?.response?.status === 403) {
            error('ISO+™ Service', 'Error setting logo: Forbidden', errorContext, extractContextFromReq(req));
        } else if (errorMessageIncludes(err, 'timeout') || err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT') {
            error('ISO+™ Service', 'Error setting logo: Request timeout', errorContext, extractContextFromReq(req));
        } else if (errorMessageIncludes(err, 'network') || err?.code === 'ENOTFOUND' || err?.code === 'ECONNREFUSED') {
            error('ISO+™ Service', 'Error setting logo: Network error', errorContext, extractContextFromReq(req));
        } else if (errorMessageIncludes(err, 'Failed to fetch boards')) {
            error('ISO+™ Service', 'Error setting logo: Failed to fetch boards', errorContext, extractContextFromReq(req));
        } else {
            error('ISO+™ Service', 'Error setting logo:', errorContext, extractContextFromReq(req));
        }
        
        logOperationEnd('ISO+™ Service', 'setLogo', { 
            workspaceId, 
            logoType: type, 
            success: false, 
            error: getErrorMessage(err) 
        }, req);
        return null;
    }
}

export async function setGeneratedField(workspaceId, boardId, itemId, message) {
    try {
        const itemValues = await getItemValues(workspaceId, boardId, itemId);
        if (!itemValues) {
            throw new Error("Failed to update item with integration message");
        }
        const values = itemValues.values;
        const generatedField = values.find(v => v.attribute.name.includes("Generated") && v.attribute.name.includes("Number") && v.attribute.type === "text");
        if (generatedField) {
            const response = await axios.put(`https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/items/${itemId}`,
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
    try {
        // Get the board to find the PDF attribute ID
        const board = await Board.findOne({ boardId: boardId.toString() })
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

        const response = await axios.put(`https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/items/${itemId}`,
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
    const ServiceAreaMap = {
        'Non-Remote (ACT)': 'ACT($)',
        'Non-Remote (NSW)': 'NSW($)',
        'Non-Remote (NT)': 'NT($)',
        'Non-Remote (QLD)': 'QLD($)',
        'Non-Remote (SA)': 'SA($)',
        'Non-Remote (TAS)': 'TAS($)',
        'Non-Remote (VIC)': 'VIC($)',
        'Non-Remote (WA)': 'WA($)',
        'Remote': 'Remote($)',
        'Very Remote': 'Very Remote($)',
        '': 'ACT($)'
    }
    let serviceAreaValues = null, directSupportValues = null, providerTravelValues = null, activityBasedTransportValues = null, centreCapitalCostsValues = null, providerTravelLabourTravelTime = null;

    const referenceResponse = await getReferences(workspaceId, boardId, itemId);
    if (!referenceResponse) return [null, null];

    for (const reference of referenceResponse.data) {

        const attribute = await getAttribute(workspaceId, boardId, reference.attribute_id);
        if (!attribute) continue;

        switch (attribute.name) {
            case 'Service Area':
                {
                    const serviceValues = await getItemValues(workspaceId, boardId, reference.to_item_id);
                    if (serviceValues) {
                        const values = serviceValues.values;
                        if (!values.some(v => v.attribute.name === "Service Area")) {
                            throw new Error("Service Area is required");
                        }
                        const serviceAreaType = ServiceAreaMap[values.find(v => v.attribute.name === "Service Area").data.toString()] || 'ACT($)';

                        serviceAreaValues = {
                            serviceArea: values.find(v => v.attribute.name === "Service Area").data.toString(),
                            serviceAreaType: serviceAreaType
                        };
                    }
                    break;
                }
            case 'Direct Support Item Number':
                {
                    const directSupportItemValues = await getItemValues(workspaceId, boardId, reference.to_item_id);
                    if (directSupportItemValues) {
                        const values = directSupportItemValues.values;
                        if (!values.some(v => v.attribute.name === "Support Item Number")) {
                            throw new Error("Support Item Number is required");
                        }

                        directSupportValues = {
                            id: directSupportItemValues.id,
                            itemName: values.find(v => v.attribute.name === "Support Item Name").data.toString(),
                            unit: values.find(v => v.attribute.name === "Unit").data.toString(),
                            "ACT($)": values.find(v => v.attribute.name === "ACT($)").data.toString(),
                            "NSW($)": values.find(v => v.attribute.name === "NSW($)").data.toString(),
                            "NT($)": values.find(v => v.attribute.name === "NT($)").data.toString(),
                            "QLD($)": values.find(v => v.attribute.name === "QLD($)").data.toString(),
                            "SA($)": values.find(v => v.attribute.name === "SA($)").data.toString(),
                            "TAS($)": values.find(v => v.attribute.name === "TAS($)").data.toString(),
                            "VIC($)": values.find(v => v.attribute.name === "VIC($)").data.toString(),
                            "WA($)": values.find(v => v.attribute.name === "WA($)").data.toString(),
                            "Remote($)": values.find(v => v.attribute.name === "Remote($)").data.toString(),
                            "Very Remote($)": values.find(v => v.attribute.name === "Very Remote($)").data.toString(),
                        };
                    }
                    break;
                }
            case 'Provider Travel - Non-Labour Cost Item Number':
                {
                    const probiderTavelNonItemValues = await getItemValues(workspaceId, boardId, reference.to_item_id);
                    if (probiderTavelNonItemValues) {
                        const values = probiderTavelNonItemValues.values;
                        if (!values.some(v => v.attribute.name === "Support Item Number")) {
                            throw new Error("Support Item Number is required");
                        }

                        providerTravelValues = {
                            id: probiderTavelNonItemValues.id,
                            itemName: values.find(v => v.attribute.name === "Support Item Name").data.toString(),
                            unit: values.find(v => v.attribute.name === "Unit").data.toString(),
                            "ACT($)": values.find(v => v.attribute.name === "ACT($)").data.toString(),
                            "NSW($)": values.find(v => v.attribute.name === "NSW($)").data.toString(),
                            "NT($)": values.find(v => v.attribute.name === "NT($)").data.toString(),
                            "QLD($)": values.find(v => v.attribute.name === "QLD($)").data.toString(),
                            "SA($)": values.find(v => v.attribute.name === "SA($)").data.toString(),
                            "TAS($)": values.find(v => v.attribute.name === "TAS($)").data.toString(),
                            "VIC($)": values.find(v => v.attribute.name === "VIC($)").data.toString(),
                            "WA($)": values.find(v => v.attribute.name === "WA($)").data.toString(),
                            "Remote($)": values.find(v => v.attribute.name === "Remote($)").data.toString(),
                            "Very Remote($)": values.find(v => v.attribute.name === "Very Remote($)").data.toString(),
                        };
                    }
                    break;
                }
            case 'Activity Based Transport Item Number':
                {
                    const activityItemValues = await getItemValues(workspaceId, boardId, reference.to_item_id);
                    if (activityItemValues) {
                        const values = activityItemValues.values;
                        if (!values.some(v => v.attribute.name === "Support Item Number")) {
                            throw new Error("Support Item Number is required");
                        }

                        activityBasedTransportValues = {
                            id: activityItemValues.id,
                            itemName: values.find(v => v.attribute.name === "Support Item Name").data.toString(),
                            unit: values.find(v => v.attribute.name === "Unit").data.toString(),
                            "ACT($)": values.find(v => v.attribute.name === "ACT($)").data.toString(),
                            "NSW($)": values.find(v => v.attribute.name === "NSW($)").data.toString(),
                            "NT($)": values.find(v => v.attribute.name === "NT($)").data.toString(),
                            "QLD($)": values.find(v => v.attribute.name === "QLD($)").data.toString(),
                            "SA($)": values.find(v => v.attribute.name === "SA($)").data.toString(),
                            "TAS($)": values.find(v => v.attribute.name === "TAS($)").data.toString(),
                            "VIC($)": values.find(v => v.attribute.name === "VIC($)").data.toString(),
                            "WA($)": values.find(v => v.attribute.name === "WA($)").data.toString(),
                            "Remote($)": values.find(v => v.attribute.name === "Remote($)").data.toString(),
                            "Very Remote($)": values.find(v => v.attribute.name === "Very Remote($)").data.toString(),
                        };
                    }
                    break;
                }
            case 'Centre Capital Costs Item':
                {
                    const centreItemValues = await getItemValues(workspaceId, boardId, reference.to_item_id);
                    if (centreItemValues) {
                        const values = centreItemValues.values;
                        if (!values.some(v => v.attribute.name === "Support Item Number")) {
                            throw new Error("Support Item Number is required");
                        }

                        centreCapitalCostsValues = {
                            id: centreItemValues.id,
                            itemName: values.find(v => v.attribute.name === "Support Item Name").data.toString(),
                            unit: values.find(v => v.attribute.name === "Unit").data.toString(),
                            "ACT($)": values.find(v => v.attribute.name === "ACT($)").data.toString(),
                            "NSW($)": values.find(v => v.attribute.name === "NSW($)").data.toString(),
                            "NT($)": values.find(v => v.attribute.name === "NT($)").data.toString(),
                            "QLD($)": values.find(v => v.attribute.name === "QLD($)").data.toString(),
                            "SA($)": values.find(v => v.attribute.name === "SA($)").data.toString(),
                            "TAS($)": values.find(v => v.attribute.name === "TAS($)").data.toString(),
                            "VIC($)": values.find(v => v.attribute.name === "VIC($)").data.toString(),
                            "WA($)": values.find(v => v.attribute.name === "WA($)").data.toString(),
                            "Remote($)": values.find(v => v.attribute.name === "Remote($)").data.toString(),
                            "Very Remote($)": values.find(v => v.attribute.name === "Very Remote($)").data.toString(),
                        };
                    }
                    break;
                }
            case 'Provider Travel - Labour Travel Time Costs': {
                const providerTravelLabourTravelTimeValues = await getItemValues(workspaceId, boardId, reference.to_item_id);
                if (providerTravelLabourTravelTimeValues) {
                    const values = providerTravelLabourTravelTimeValues.values;
                    if (!values.some(v => v.attribute.name === "Labour Travel Time Costs")) {
                        throw new Error("Labour Travel Time Costs is required");
                    }
                    providerTravelLabourTravelTime = {
                        id: providerTravelLabourTravelTimeValues.id,
                        itemName: values.find(v => v.attribute.name === "Labour Travel Time Costs").data.toString(),
                    };
                }
                break;
            }
        }
    }
    return [serviceAreaValues, directSupportValues, providerTravelValues, activityBasedTransportValues, centreCapitalCostsValues, providerTravelLabourTravelTime];
}

export async function getNDISParticipantsServicePlanReferencedItems(workspaceId, boardId, itemId) {
    const ServiceAreaMap = {
        'Non-Remote (ACT)': 'ACT($)',
        'Non-Remote (NSW)': 'NSW($)',
        'Non-Remote (NT)': 'NT($)',
        'Non-Remote (QLD)': 'QLD($)',
        'Non-Remote (SA)': 'SA($)',
        'Non-Remote (TAS)': 'TAS($)',
        'Non-Remote (VIC)': 'VIC($)',
        'Non-Remote (WA)': 'WA($)',
        'Remote': 'Remote($)',
        'Very Remote': 'Very Remote($)',
        '': 'ACT($)'
    }
    let serviceAreaValues = null, directSupportValues = null, providerTravelValues = null, activityBasedTransportValues = null, centreCapitalCostsValues = null;

    const referenceResponse = await getReferences(workspaceId, boardId, itemId);
    if (!referenceResponse) return [null, null];

    for (const reference of referenceResponse.data) {

        const attribute = await getAttribute(workspaceId, boardId, reference.attribute_id);
        if (!attribute) continue;

        switch (attribute.name) {
            case 'Service Area':
                {
                    const serviceValues = await getItemValues(workspaceId, boardId, reference.to_item_id);
                    if (serviceValues) {
                        const values = serviceValues.values;
                        if (!values.some(v => v.attribute.name === "Service Area")) {
                            throw new Error("Service Area is required");
                        }
                        const serviceAreaType = ServiceAreaMap[values.find(v => v.attribute.name === "Service Area").data.toString()] || 'ACT($)';

                        serviceAreaValues = {
                            serviceArea: values.find(v => v.attribute.name === "Service Area").data.toString(),
                            serviceAreaType: serviceAreaType
                        };
                    }
                    break;
                }
            case 'Direct Support Item Number':
                {
                    const directSupportItemValues = await getItemValues(workspaceId, boardId, reference.to_item_id);
                    if (directSupportItemValues) {
                        const values = directSupportItemValues.values;
                        if (!values.some(v => v.attribute.name === "Support Item Number")) {
                            throw new Error("Support Item Number is required");
                        }

                        directSupportValues = {
                            id: directSupportItemValues.id,
                            itemName: values.find(v => v.attribute.name === "Support Item Name").data.toString(),
                            itemNumber: values.find(v => v.attribute.name === "Support Item Number").data.toString(),
                            unit: values.find(v => v.attribute.name === "Unit").data.toString(),
                            "ACT($)": values.find(v => v.attribute.name === "ACT($)").data.toString(),
                            "NSW($)": values.find(v => v.attribute.name === "NSW($)").data.toString(),
                            "NT($)": values.find(v => v.attribute.name === "NT($)").data.toString(),
                            "QLD($)": values.find(v => v.attribute.name === "QLD($)").data.toString(),
                            "SA($)": values.find(v => v.attribute.name === "SA($)").data.toString(),
                            "TAS($)": values.find(v => v.attribute.name === "TAS($)").data.toString(),
                            "VIC($)": values.find(v => v.attribute.name === "VIC($)").data.toString(),
                            "WA($)": values.find(v => v.attribute.name === "WA($)").data.toString(),
                            "Remote($)": values.find(v => v.attribute.name === "Remote($)").data.toString(),
                            "Very Remote($)": values.find(v => v.attribute.name === "Very Remote($)").data.toString(),
                            shortNoticeCancellations: values.find(v => v.attribute.name === "Short Notice Cancellations")?.data?.toString() || 'NA',
                        };
                    }
                    break;
                }
            case 'Provider Travel - Non-Labour Cost Item Number':
                {
                    const probiderTavelNonItemValues = await getItemValues(workspaceId, boardId, reference.to_item_id);
                    if (probiderTavelNonItemValues) {
                        const values = probiderTavelNonItemValues.values;
                        if (!values.some(v => v.attribute.name === "Support Item Number")) {
                            throw new Error("Support Item Number is required");
                        }

                        providerTravelValues = {
                            id: probiderTavelNonItemValues.id,
                            itemName: values.find(v => v.attribute.name === "Support Item Name").data.toString(),
                            itemNumber: values.find(v => v.attribute.name === "Support Item Number").data.toString(),
                            unit: values.find(v => v.attribute.name === "Unit").data.toString(),
                            "ACT($)": values.find(v => v.attribute.name === "ACT($)").data.toString(),
                            "NSW($)": values.find(v => v.attribute.name === "NSW($)").data.toString(),
                            "NT($)": values.find(v => v.attribute.name === "NT($)").data.toString(),
                            "QLD($)": values.find(v => v.attribute.name === "QLD($)").data.toString(),
                            "SA($)": values.find(v => v.attribute.name === "SA($)").data.toString(),
                            "TAS($)": values.find(v => v.attribute.name === "TAS($)").data.toString(),
                            "VIC($)": values.find(v => v.attribute.name === "VIC($)").data.toString(),
                            "WA($)": values.find(v => v.attribute.name === "WA($)").data.toString(),
                            "Remote($)": values.find(v => v.attribute.name === "Remote($)").data.toString(),
                            "Very Remote($)": values.find(v => v.attribute.name === "Very Remote($)").data.toString(),
                            shortNoticeCancellations: values.find(v => v.attribute.name === "Short Notice Cancellations")?.data?.toString() || 'NA',
                        };
                    }
                    break;
                }
            case 'Activity Based Transport Item Number':
                {
                    const activityItemValues = await getItemValues(workspaceId, boardId, reference.to_item_id);
                    if (activityItemValues) {
                        const values = activityItemValues.values;
                        if (!values.some(v => v.attribute.name === "Support Item Number")) {
                            throw new Error("Support Item Number is required");
                        }

                        activityBasedTransportValues = {
                            id: activityItemValues.id,
                            itemName: values.find(v => v.attribute.name === "Support Item Name").data.toString(),
                            itemNumber: values.find(v => v.attribute.name === "Support Item Number").data.toString(),
                            unit: values.find(v => v.attribute.name === "Unit").data.toString(),
                            "ACT($)": values.find(v => v.attribute.name === "ACT($)").data.toString(),
                            "NSW($)": values.find(v => v.attribute.name === "NSW($)").data.toString(),
                            "NT($)": values.find(v => v.attribute.name === "NT($)").data.toString(),
                            "QLD($)": values.find(v => v.attribute.name === "QLD($)").data.toString(),
                            "SA($)": values.find(v => v.attribute.name === "SA($)").data.toString(),
                            "TAS($)": values.find(v => v.attribute.name === "TAS($)").data.toString(),
                            "VIC($)": values.find(v => v.attribute.name === "VIC($)").data.toString(),
                            "WA($)": values.find(v => v.attribute.name === "WA($)").data.toString(),
                            "Remote($)": values.find(v => v.attribute.name === "Remote($)").data.toString(),
                            "Very Remote($)": values.find(v => v.attribute.name === "Very Remote($)").data.toString(),
                            shortNoticeCancellations: values.find(v => v.attribute.name === "Short Notice Cancellations")?.data?.toString() || 'NA',
                        };
                    }
                    break;
                }
            case 'Centre Capital Costs Item':
                {
                    const centreItemValues = await getItemValues(workspaceId, boardId, reference.to_item_id);
                    if (centreItemValues) {
                        const values = centreItemValues.values;
                        if (!values.some(v => v.attribute.name === "Support Item Number")) {
                            throw new Error("Support Item Number is required");
                        }

                        centreCapitalCostsValues = {
                            id: centreItemValues.id,
                            itemName: values.find(v => v.attribute.name === "Support Item Name").data.toString(),
                            itemNumber: values.find(v => v.attribute.name === "Support Item Number").data.toString(),
                            unit: values.find(v => v.attribute.name === "Unit").data.toString(),
                            "ACT($)": values.find(v => v.attribute.name === "ACT($)").data.toString(),
                            "NSW($)": values.find(v => v.attribute.name === "NSW($)").data.toString(),
                            "NT($)": values.find(v => v.attribute.name === "NT($)").data.toString(),
                            "QLD($)": values.find(v => v.attribute.name === "QLD($)").data.toString(),
                            "SA($)": values.find(v => v.attribute.name === "SA($)").data.toString(),
                            "TAS($)": values.find(v => v.attribute.name === "TAS($)").data.toString(),
                            "VIC($)": values.find(v => v.attribute.name === "VIC($)").data.toString(),
                            "WA($)": values.find(v => v.attribute.name === "WA($)").data.toString(),
                            "Remote($)": values.find(v => v.attribute.name === "Remote($)").data.toString(),
                            "Very Remote($)": values.find(v => v.attribute.name === "Very Remote($)").data.toString(),
                            shortNoticeCancellations: values.find(v => v.attribute.name === "Short Notice Cancellations")?.data?.toString() || 'NA',
                        };
                    }
                    break;
                }
        }
    }

    return [serviceAreaValues, directSupportValues, providerTravelValues, activityBasedTransportValues, centreCapitalCostsValues];
}

export async function getNDISMasterPlanReferencedItems(workspaceId, boardId, itemId) {
    let servicePlanValues = null, cancellationTypeValues = null, fundValues = null, participantProfileValues = null, participationTypeValues = null;

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
                        const [serviceAreaValues, directSupportValues, providerTravelValues, activityBasedTransportValues, centreCapitalCostsValues] = await getNDISParticipantsServicePlanReferencedItems(workspaceId, boardId, reference.to_item_id);
                        const values = servicePlan.values;
                        let
                            directSupportUnit = null,
                            directSupportUnitPrice = null,
                            nonLabourTravelUnit = null,
                            nonLabourTravelUnitPrice = null,
                            activityBasedTransportUnit = null,
                            activityBasedTransportUnitPrice = null,
                            centreCapitalCostsUnit = null,
                            centreCapitalCostsUnitPrice = null,
                            labourTravelTimeUnit = null,
                            labourTravelTimeUnitPrice = null,
                            usedAllowanceUnit = null,
                            usedAllowanceAmount = null,
                            nonFaceToFaceSupportUnit = null,
                            nonFaceToFaceSupportUnitPrice = null;
                        if (values.find(v => v.attribute.name === "Unit (Direct Support)")) {
                            directSupportUnit = values.find(v => v.attribute.name === "Unit (Direct Support)").data.toString();
                        }
                        if (values.find(v => v.attribute.name === "Agreed Unit Price for Direct Support ($)")) {
                            directSupportUnitPrice = values.find(v => v.attribute.name === "Agreed Unit Price for Direct Support ($)").data.toString();
                        }
                        if (values.find(v => v.attribute.name === "Unit (Provider Travel - Non-Labour Cost)")) {
                            nonLabourTravelUnit = values.find(v => v.attribute.name === "Unit (Provider Travel - Non-Labour Cost)").data.toString();
                        }
                        if (values.find(v => v.attribute.name === "Agreed Unit Price for Non-Labour Travel ($)")) {
                            nonLabourTravelUnitPrice = values.find(v => v.attribute.name === "Agreed Unit Price for Non-Labour Travel ($)").data.toString();
                        }
                        if (values.find(v => v.attribute.name === "Unit (Activity Based Transport)")) {
                            activityBasedTransportUnit = values.find(v => v.attribute.name === "Unit (Activity Based Transport)").data.toString();
                        }
                        if (values.find(v => v.attribute.name === "Agreed Price for Activity Based Transport ($)")) {
                            activityBasedTransportUnitPrice = values.find(v => v.attribute.name === "Agreed Price for Activity Based Transport ($)").data.toString();
                        }
                        if (values.find(v => v.attribute.name === "Unit (Centre Capital Costs)")) {
                            centreCapitalCostsUnit = values.find(v => v.attribute.name === "Unit (Centre Capital Costs)").data.toString();
                        }
                        if (values.find(v => v.attribute.name === "Agreed Unit Price for Centre Capital Costs($)")) {
                            centreCapitalCostsUnitPrice = values.find(v => v.attribute.name === "Agreed Unit Price for Centre Capital Costs($)").data.toString();
                        }
                        if (values.find(v => v.attribute.name === "Unit (Labour Travel Time)")) {
                            labourTravelTimeUnit = values.find(v => v.attribute.name === "Unit (Labour Travel Time)").data.toString();
                        }
                        if (values.find(v => v.attribute.name === "Agreed Unit Price for Labour Travel Time ($)")) {
                            labourTravelTimeUnitPrice = values.find(v => v.attribute.name === "Agreed Unit Price for Labour Travel Time ($)").data.toString();
                        }
                        if (values.find(v => v.attribute.name === "Unit (Allowances)")) {
                            usedAllowanceUnit = values.find(v => v.attribute.name === "Unit (Allowances)").data.toString();
                        }
                        if (values.find(v => v.attribute.name === "Agreed Price for Allowances($)")) {
                            usedAllowanceAmount = values.find(v => v.attribute.name === "Agreed Price for Allowances($)").data.toString();
                        }
                        if (values.find(v => v.attribute.name === "Unit (Non-Face-to-Face Support)")) {
                            nonFaceToFaceSupportUnit = values.find(v => v.attribute.name === "Unit (Non-Face-to-Face Support)").data.toString();
                        }
                        if (values.find(v => v.attribute.name === "Agreed Unit Price for Non-Face-to-Face Support($)")) {
                            nonFaceToFaceSupportUnitPrice = values.find(v => v.attribute.name === "Agreed Unit Price for Non-Face-to-Face Support($)").data.toString();
                        }

                        servicePlanValues = {
                            directSupportItemNumber: directSupportValues?.itemNumber || '',
                            directSupportItemName: directSupportValues?.itemName || '',
                            directSupportUnit: directSupportUnit,
                            directSupportUnitPrice: directSupportUnitPrice,
                            providerTravelItemNumber: providerTravelValues?.itemNumber || '',
                            providerTravelItemName: providerTravelValues?.itemName || '',
                            nonLabourTravelUnit: nonLabourTravelUnit,
                            nonLabourTravelUnitPrice: nonLabourTravelUnitPrice,
                            activityBasedTransportItemNumber: activityBasedTransportValues?.itemNumber || '',
                            activityBasedTransportItemName: activityBasedTransportValues?.itemName || '',
                            activityBasedTransportUnit: activityBasedTransportUnit,
                            activityBasedTransportUnitPrice: activityBasedTransportUnitPrice,
                            centreCapitalCostsItemNumber: centreCapitalCostsValues?.itemNumber || '',
                            centreCapitalCostsItemName: centreCapitalCostsValues?.itemName || '',
                            centreCapitalCostsUnit: centreCapitalCostsUnit,
                            centreCapitalCostsUnitPrice: centreCapitalCostsUnitPrice,
                            labourTravelTimeUnit: labourTravelTimeUnit,
                            labourTravelTimeUnitPrice: labourTravelTimeUnitPrice,
                            usedAllowanceUnit: usedAllowanceUnit,
                            usedAllowanceAmount: usedAllowanceAmount,
                            nonFaceToFaceSupportUnit: nonFaceToFaceSupportUnit,
                            nonFaceToFaceSupportUnitPrice: nonFaceToFaceSupportUnitPrice,
                            directSupportShortNoticeCancellations: directSupportValues?.shortNoticeCancellations || '',
                            providerTravelShortNoticeCancellations: providerTravelValues?.shortNoticeCancellations || '',
                            activityBasedTransportShortNoticeCancellations: activityBasedTransportValues?.shortNoticeCancellations || '',
                            centreCapitalCostsShortNoticeCancellations: centreCapitalCostsValues?.shortNoticeCancellations || '',
                        };
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
            case 'Fund':
                {
                    const fund = await getItemValues(workspaceId, boardId, reference.to_item_id);
                    const fundAmount = fund.values.find(v => v.attribute.name === "Fund Amount($)").data || 0;
                    const previouslyUsed = fund.values.find(v => v.attribute.name === "Previously Used ($)").data || 0;
                    const invoicedAndReceived = fund.values.find(v => v.attribute.name === "Invoiced and Received Amount($)").data || 0;

                    const availableFund = fundAmount - previouslyUsed - invoicedAndReceived;
                    const budgetSpent = availableFund * 100 / fundAmount;
                    const fundingBudgetStatus = budgetSpent > 0 ? "👍 Within Budget" : budgetSpent < 0 ? "👎 Over Budget" : "👌 On Budget";
                    fundValues = {
                        fundingBudgetStatus: fundingBudgetStatus,
                    };
                    break;
                }
            case 'Participant Profile':
                {
                    const participantProfile = await getItemValues(workspaceId, boardId, reference.to_item_id);
                    if (participantProfile) {
                        const values = participantProfile.values;
                        participantProfileValues = {
                            billingContact: values.find(v => v.attribute.name === "Billing Contact")?.data?.toString() || '',
                            billingAddress: values.find(v => v.attribute.name === "Billing Address")?.data?.toString() || '',
                            Phone: values.find(v => v.attribute.name === "Primary Phone Number")?.data?.toString() || '',
                            email: values.find(v => v.attribute.name === "Email")?.data?.toString() || '',
                            address: values.find(v => v.attribute.name === "Address")?.data?.toString() || '',
                            firstName: values.find(v => v.attribute.name === "First Name")?.data?.toString() || '',
                            lastName: values.find(v => v.attribute.name === "Last Name")?.data?.toString() || '',
                            fullName: values.find(v => v.attribute.name === "Full Name/Preferred Name")?.data?.toString() || '',
                        };
                    }
                    break;
                }
            case 'Participation Type':
                {
                    const participationType = await getItemValues(workspaceId, boardId, reference.to_item_id);
                    if (participationType) {
                        const values = participationType.values;
                        participationTypeValues = {
                            participationType: values.find(v => v.attribute.name === "Participation Type").data.toString(),
                            definition: values.find(v => v.attribute.name === "Definition").data.toString(),
                        }
                    }
                }
        }
    }

    return [servicePlanValues, cancellationTypeValues, fundValues, participantProfileValues, participationTypeValues];
}

export async function getAgeCareParticipantsServicePlanReferencedItems(workspaceId, boardId, itemId) {
    let participantsProfileValues = null, homeSupportValues = null, assistiveTechnologyShortTermValues = null, assistiveTechnologyOngoingValues = null, homeModificationValues = null, healthProfessionalValues = null, wraparoundValues = null;

    const referenceResponse = await getReferences(workspaceId, boardId, itemId);
    if (!referenceResponse) return [null, null];

    for (const reference of referenceResponse.data) {
        const attribute = await getAttribute(workspaceId, boardId, reference.attribute_id);
        if (!attribute) continue;
        switch (attribute.name) {
            case 'Participant Profile':
                {
                    const participantsProfile = await getItemValues(workspaceId, boardId, reference.to_item_id);
                    if (participantsProfile) {
                        const values = participantsProfile.values;
                        if (!values.some(v => v.attribute.name === "Full Name/Preferred Name")) {
                            throw new Error("Full Name/Preferred Name is required");
                        }

                        participantsProfileValues = {
                            id: participantsProfile.id,
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
            case 'Home Support (HS)':
                {
                    const homeSupport = await getItemValues(workspaceId, boardId, reference.to_item_id);
                    if (homeSupport) {
                        const values = homeSupport.values;
                        if (!values.some(v => v.attribute.name === "Service")) {
                            throw new Error("Service is required");
                        }

                        homeSupportValues = {
                            id: homeSupport.id,
                            service: values.find(v => v.attribute.name === "Service").data.toString() || '',
                            serviceType: values.find(v => v.attribute.name === "Service Type").data.toString() || '',
                            unit: values.find(v => v.attribute.name === "Unit Type").data.toString() || '',
                            unitPrice: values.find(v => v.attribute.name === "Price ($)").data.toString().replace('$', '') || '0',
                            participantContributionGuideline: values.find(v => v.attribute.name === "Participant Contribution Guideline (%)").data.toString() || '',
                            wraparound: values.find(v => v.attribute.name === "Wraparound")?.data?.toString() || '',
                        }
                    }
                    break;
                }
            case 'Assistive Technology (AT) - Short Term':
                {
                    const assistiveTechnologyShortTerm = await getItemValues(workspaceId, boardId, reference.to_item_id);
                    if (assistiveTechnologyShortTerm) {
                        const values = assistiveTechnologyShortTerm.values;
                        if (!values.some(v => v.attribute.name === "Service")) {
                            throw new Error("Service is required");
                        }

                        assistiveTechnologyShortTermValues = {
                            id: assistiveTechnologyShortTerm.id,
                            service: values.find(v => v.attribute.name === "Service").data.toString() || '',
                            serviceType: values.find(v => v.attribute.name === "Service Type").data.toString() || '',
                            unit: values.find(v => v.attribute.name === "Unit Type").data.toString() || '',
                            unitPrice: values.find(v => v.attribute.name === "Price ($)").data.toString().replace('$', '') || '0',
                            participantContributionGuideline: values.find(v => v.attribute.name === "Participant Contribution Guideline (%)").data.toString() || '',
                            wraparound: values.find(v => v.attribute.name === "Wraparound")?.data?.toString() || '',
                        }
                    }
                    break;
                }
            case 'Assistive Technology (AT) - Ongoing':
                {
                    const assistiveTechnologyOngoing = await getItemValues(workspaceId, boardId, reference.to_item_id);
                    if (assistiveTechnologyOngoing) {
                        const values = assistiveTechnologyOngoing.values;
                        if (!values.some(v => v.attribute.name === "Service")) {
                            throw new Error("Service is required");
                        }

                        assistiveTechnologyOngoingValues = {
                            id: assistiveTechnologyOngoing.id,
                            service: values.find(v => v.attribute.name === "Service").data.toString() || '',
                            serviceType: values.find(v => v.attribute.name === "Service Type").data.toString() || '',
                            unit: values.find(v => v.attribute.name === "Unit Type").data.toString() || '',
                            unitPrice: values.find(v => v.attribute.name === "Price ($)").data.toString().replace('$', '') || '0',
                            participantContributionGuideline: values.find(v => v.attribute.name === "Participant Contribution Guideline (%)").data.toString() || '',
                            wraparound: values.find(v => v.attribute.name === "Wraparound")?.data?.toString() || '',
                        }
                    }
                    break;
                }
            case 'Home Modification (HM)':
                {
                    const homeModification = await getItemValues(workspaceId, boardId, reference.to_item_id);
                    if (homeModification) {
                        const values = homeModification.values;
                        if (!values.some(v => v.attribute.name === "Service")) {
                            throw new Error("Service is required");
                        }

                        homeModificationValues = {
                            id: homeModification.id,
                            service: values.find(v => v.attribute.name === "Service").data.toString() || '',
                            serviceType: values.find(v => v.attribute.name === "Service Type").data.toString() || '',
                            unit: values.find(v => v.attribute.name === "Unit Type").data.toString() || '',
                            unitPrice: values.find(v => v.attribute.name === "Price ($)").data.toString().replace('$', '') || '0',
                            participantContributionGuideline: values.find(v => v.attribute.name === "Participant Contribution Guideline (%)").data.toString() || '',
                            wraparound: values.find(v => v.attribute.name === "Wraparound")?.data?.toString() || '',
                        }
                    }
                    break;
                }
            case 'Health Professional':
                {
                    const healthProfessional = await getItemValues(workspaceId, boardId, reference.to_item_id);
                    if (healthProfessional) {
                        const values = healthProfessional.values;
                        if (!values.some(v => v.attribute.name === "Service")) {
                            throw new Error("Service is required");
                        }

                        healthProfessionalValues = {
                            id: healthProfessional.id,
                            service: values.find(v => v.attribute.name === "Service").data.toString() || '',
                            serviceType: values.find(v => v.attribute.name === "Service Type").data.toString() || '',
                            unit: values.find(v => v.attribute.name === "Unit Type").data.toString() || '',
                            unitPrice: values.find(v => v.attribute.name === "Price ($)").data.toString().replace('$', '') || '0',
                            participantContributionGuideline: values.find(v => v.attribute.name === "Participant Contribution Guideline (%)").data.toString() || '',
                            wraparound: values.find(v => v.attribute.name === "Wraparound")?.data?.toString() || '',
                        }
                    }
                    break;
                }
            case 'Wraparound':
                {
                    const wraparound = await getItemValues(workspaceId, boardId, reference.to_item_id);
                    if (wraparound) {
                        const values = wraparound.values;
                        if (!values.some(v => v.attribute.name === "Wraparound Description")) {
                            throw new Error("Wraparound Description is required");
                        }

                        wraparoundValues = {
                            id: wraparound.id,
                            wraparoundDescription: values.find(v => v.attribute.name === "Wraparound Description").data.toString() || '',
                            unit: values.find(v => v.attribute.name === "Unit Type").data.toString() || '',
                            unitPrice: values.find(v => v.attribute.name === "Price ($)").data.toString().replace('$', '') || '0',
                            participantContributionGuideline: values.find(v => v.attribute.name === "Participant Contribution Guideline (%)").data.toString() || '',
                        }
                    }
                    break;
                }
        }
    }

    return [participantsProfileValues, homeSupportValues, assistiveTechnologyShortTermValues, assistiveTechnologyOngoingValues, homeModificationValues, healthProfessionalValues, wraparoundValues];
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
        const response = await axios.get(`https://app.isoplus.online/api/${workspaceId}/automations/${boardId}`, {
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

        const response = await axios.put(`https://app.isoplus.online/api/${workspaceId}/automations/${automationId}`, {
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
