import axios from "axios";

export async function getWorkspace(authorization) {
    try {
        const url = "https://app.isoplus.online/api/v2/workspaces";

        const headers = {
            "Authorization": authorization,
            "Content-Type": "application/json",
            "Accept": "application/json",
        }, params = {
            "limit": "100",
            "sort_by": "created_at",
            "sort_direction": "desc",
        };

        let workspace = [];

        const result = await axios.get(url, { headers, params });
        if (result.status === 200) {
            workspace = workspace.concat(result.data.data);
            let has_more = result.data.has_more, after = result.data.after;

            while (has_more) {
                const response = await axios.get(url, { headers, params: { ...params, after } });
                if (response.status === 200) {
                    workspace = workspace.concat(response.data.data);
                    has_more = response.data.has_more;
                    after = response.data.after;
                } else {
                    has_more = false;
                }
            }
        }
        return { workspace: workspace, status: 200 };
    } catch (err) {
        return { message: err.message, status: 500 };
    }
};

export async function getBoard(authorization, workspaceId) {
    try {
        const url = `https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards`;

        const headers = {
            "Authorization": authorization,
            "Content-Type": "application/json",
            "Accept": "application/json",
        }, params = {
            "limit": "100",
            "sort_by": "created_at",
            "sort_direction": "desc",
        };

        let board = [];

        const result = await axios.get(url, { headers, params });
        if (result.status === 200) {
            board = board.concat(result.data.data);
            let has_more = result.data.has_more, after = result.data.after;

            while (has_more) {
                const response = await axios.get(url, { headers, params: { ...params, after } });
                if (response.status === 200) {
                    board = board.concat(response.data.data);
                    has_more = response.data.has_more;
                    after = response.data.after;
                } else {
                    has_more = false;
                }
            }
        }
        return { board: board, status: 200 };
    } catch (err) {
        return { message: err.message, status: 500 };
    }
};

export async function getFolder(workspaceId, boardId) {
    try {
        const url = `https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/folders/`;
        const headers = {
            "Authorization": `Bearer ${process.env.PERSONAL_ACCESS_TOKEN}`,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-API-Version": "2025-02-26.morava",
        }, params = {
            "limit": "100",
            "sort_by": "created_at",
            "sort_direction": "desc",
        };

        let folder = [];

        const result = await axios.get(url, { headers, params });
        if (result.status === 200) {
            folder = folder.concat(result.data.data);
            let has_more = result.data.has_more, after = result.data.after;

            while (has_more) {
                const response = await axios.get(url, { headers, params: { ...params, after } });
                if (response.status === 200) {
                    folder = folder.concat(response.data.data);
                    has_more = response.data.has_more;
                    after = response.data.after;
                } else {
                    has_more = false;
                }
            }
        }
        return { folder: folder, status: 200 };
    } catch (err) {
        return { message: err.message, status: 500 };
    }
};

export async function getItem(workspaceId, boardId, folderId) {
    try {
        const url = `https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/items/`;

        const headers = {
            "Authorization": `Bearer ${process.env.PERSONAL_ACCESS_TOKEN}`,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "X-API-Version": "2025-02-26.morava",
        }, params = {
            "limit": "100",
            "sort_by": "created_at",
            "sort_direction": "desc",
            "expand[0]": "values.attribute",
            "folder_id": folderId,
        };

        let item = [];

        const result = await axios.get(url, { headers, params });
        if (result.status === 200) {
            item = item.concat(result.data.data);
            let has_more = result.data.has_more, after = result.data.after;

            while (has_more) {
                const response = await axios.get(url, { headers, params: { ...params, after } });
                if (response.status === 200) {
                    item = item.concat(response.data.data);
                    has_more = response.data.has_more;
                    after = response.data.after;
                } else {
                    has_more = false;
                }
            }
        }
        return { item: item, status: 200 };
    } catch (err) {
        return { message: err.message, status: 500 };
    }
};

export function putInternalMessage(workspaceId, boardId, itemId, message) {
    axios.put(`https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/items/${itemId}`, {
        "values": [
            {
                "attribute_id": "b84bf475-b4f7-4e35-891a-72c24631468f",
                "data": `<p>${message}</p>`
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
