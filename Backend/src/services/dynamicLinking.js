import axios from "axios";
import Loki from 'lokijs';
import sanitizeHtml from 'sanitize-html';
import he from 'he';
import { tokenizeString } from '../utils/dynamicLinking.js';
import { info, warn, error } from '../utils/logger.js';

const TEMPLATE_REGEX = /{{\s*([^}]+)\s*}}/g;

class DynamicLinkingService {
    constructor() {
        this.db = new Loki('dynamicLinking');
        this.sources = this.db.addCollection('links');
        this.destinationsRepository = this.db.addCollection('items', { indices: ['boardName', 'name'] });
    }

    async checkLinks(authorization, workspaceId, host) {
        try {
            info('DynamicLinking-Service', 'Starting link check', { workspaceId }, null);
            
            // Clear previous data
            this.sources.clear();
            this.destinationsRepository.clear();

            const boards = await this.fetchAllBoards(authorization, workspaceId);
            info('DynamicLinking-Service', `Checking ${boards.length} boards`, { workspaceId, boardCount: boards.length }, null);

            const results = {
                boardsChecked: boards.length,
                potentialLinks: 0,
                destinationsFound: 0,
                errors: []
            };

            for (const board of boards) {
                try {
                    await this.processBoard(authorization, workspaceId, board, host, results);
                } catch (boardError) {
                    results.errors.push({
                        boardId: board.id,
                        boardName: board.name,
                        error: boardError.message
                    });
                }
            }

            info('DynamicLinking-Service', 'Link check completed', { workspaceId, results }, null);
            return results;

        } catch (err) {
            error('DynamicLinking-Service', 'Link check failed', { workspaceId, error: err.message }, null);
            throw err;
        }
    }

    async createLinks(authorization, workspaceId, host) {
        try {
            info('DynamicLinking-Service', 'Starting link creation', { workspaceId }, null);
            
            // First check links to get current state
            await this.checkLinks(authorization, workspaceId, host);

            const results = {
                linksCreated: 0,
                boardsUpdated: 0,
                errors: []
            };

            // Process all sources and create links
            const sources = this.sources.chain().data();
            for (const source of sources) {
                try {
                    const linksCreated = await this.processSource(authorization, workspaceId, source, host);
                    if (linksCreated > 0) {
                        results.linksCreated += linksCreated;
                        results.boardsUpdated++;
                    }
                } catch (sourceError) {
                    results.errors.push({
                        boardId: source.boardId,
                        itemId: source.item?.id,
                        error: sourceError.message
                    });
                }
            }

            info('DynamicLinking-Service', 'Link creation completed', { workspaceId, results }, null);
            return results;

        } catch (err) {
            error('DynamicLinking-Service', 'Link creation failed', { workspaceId, error: err.message }, null);
            throw err;
        }
    }

    async fetchAllBoards(authorization, workspaceId) {
        const url = `https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards`;
        const headers = {
            "Authorization": authorization,
            "Content-Type": "application/json",
            "Accept": "application/json",
        };
        const params = {
            "limit": "100",
            "sort_by": "created_at",
            "sort_direction": "desc",
        };

        let boards = [];
        const result = await axios.get(url, { headers, params });

        if (result.status === 200) {
            boards = boards.concat(result.data.data);
            let has_more = result.data.has_more, after = result.data.after;

            while (has_more) {
                const response = await axios.get(url, { headers, params: { ...params, after } });
                if (response.status === 200) {
                    boards = boards.concat(response.data.data);
                    has_more = response.data.has_more;
                    after = response.data.after;
                } else {
                    has_more = false;
                }
            }
        }

        return boards;
    }

    async processBoard(authorization, workspaceId, board, host, results) {
        const boardId = board.id;

        // Process views
        await this.processViews(authorization, workspaceId, boardId, board, host, results);

        // Process items
        await this.processItems(authorization, workspaceId, boardId, board, host, results);
    }

    async processViews(authorization, workspaceId, boardId, board, host, results) {
        try {
            const url = `https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/views`;
            const headers = {
                "Authorization": authorization,
                "Content-Type": "application/json",
                "Accept": "application/json",
            };
            const params = {
                "limit": "50",
                "sort_by": "created_at",
                "sort_direction": "desc",
            };

            let views = [];
            const result = await axios.get(url, { headers, params });

            if (result.status === 200) {
                views = views.concat(result.data.data);
                let has_more = result.data.has_more, after = result.data.after;

                while (has_more) {
                    const response = await axios.get(url, { headers, params: { ...params, after } });
                    if (response.status === 200) {
                        views = views.concat(response.data.data);
                        has_more = response.data.has_more;
                        after = response.data.after;
                    } else {
                        has_more = false;
                    }
                }
            }

            for (const view of views) {
                this.destinationsRepository.insert({
                    boardName: board.name,
                    name: view.name,
                    selfLink: `${host}/b/${boardId}/${view.folder_id}?view=${view.id}`
                });
                results.destinationsFound++;

                if (view.type === 'form' && view.settings?.formSettings?.enabled) {
                    this.destinationsRepository.insert({
                        boardName: board.name,
                        name: `public ${view.name}`,
                        selfLink: `${host}/form/${view.id}`
                    });
                    results.destinationsFound++;
                }
            }
        } catch (err) {
            warn('DynamicLinking-Service', 'Failed to process views', { boardId, error: err.message }, null);
        }
    }

    async processItems(authorization, workspaceId, boardId, board, host, results) {
        try {
            const url = `https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardId}/items`;
            const headers = {
                "Authorization": authorization,
                "Content-Type": "application/json",
                "Accept": "application/json",
            };
            const params = {
                "limit": "50",
                "sort_by": "created_at",
                "sort_direction": "desc",
                ['expand[]']: 'values'
            };

            let items = [];
            const result = await axios.get(url, { headers, params });

            if (result.status === 200) {
                items = items.concat(result.data.data);
                let has_more = result.data.has_more, after = result.data.after;

                while (has_more) {
                    const response = await axios.get(url, { headers, params: { ...params, after } });
                    if (response.status === 200) {
                        items = items.concat(response.data.data);
                        has_more = response.data.has_more;
                        after = response.data.after;
                    } else {
                        has_more = false;
                    }
                }
            }

            for (const item of items) {
                for (const value of item.values || []) {
                    const textAttributeValue = value.data;

                    if (typeof textAttributeValue !== 'string') {
                        continue;
                    }

                    this.destinationsRepository.insert({
                        name: textAttributeValue,
                        boardName: board.name,
                        selfLink: `${host}/b/${boardId}/${item.folder_id}/${item.id}`
                    });
                    results.destinationsFound++;

                    const links = [];
                    let match;
                    while ((match = TEMPLATE_REGEX.exec(textAttributeValue)) !== null) {
                        try {
                            const [label, targetBoardName, targetName] = tokenizeString(
                                he.decode(
                                    sanitizeHtml(match[1], {
                                        allowedTags: [],
                                        allowedAttributes: {}
                                    })
                                )
                            ).map(x => x.replace(/\s+/g, ' ').trim());

                            links.push({
                                label,
                                targetBoardName,
                                targetName,
                                originalMatch: match[0]
                            });
                        } catch (parseError) {
                            warn('DynamicLinking-Service', 'Failed to parse template', { 
                                template: match[0], 
                                error: parseError.message 
                            }, null);
                        }
                    }

                    if (links.length > 0) {
                        this.sources.insert({
                            boardId,
                            item,
                            value,
                            links
                        });
                        results.potentialLinks += links.length;
                    }
                }
            }
        } catch (err) {
            warn('DynamicLinking-Service', 'Failed to process items', { boardId, error: err.message }, null);
        }
    }

    async processSource(authorization, workspaceId, source, host) {
        const originItem = `${host}/b/${source.boardId}/${source.item.folder_id}/${source.item.id}`;
        const linksCreated = [];

        for (const link of source.links) {
            const destination = this.destinationsRepository.findOne({
                name: link.targetName, 
                boardName: link.targetBoardName
            });

            if (!destination) {
                warn('DynamicLinking-Service', 'Destination not found', { 
                    targetName: link.targetName, 
                    targetBoardName: link.targetBoardName 
                }, null);
                continue;
            }

            source.value.data = source.value.data.replace(
                link.originalMatch, 
                `<a href="${destination.selfLink}">${link.label}</a>`
            );
            linksCreated.push(destination.selfLink);
        }

        if (linksCreated.length > 0) {
            try {
                const url = `https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${source.boardId}/items/${source.item.id}`;
                const headers = {
                    "Authorization": authorization,
                    "Content-Type": "application/json",
                };
                const data = {
                    "values": [{
                        attribute_id: source.value.attribute_id,
                        data: source.value.data
                    }],
                };

                await axios.put(url, data, { headers });
                info('DynamicLinking-Service', 'Links created', { 
                    originItem, 
                    linksCreated: linksCreated.length 
                }, null);
            } catch (updateError) {
                error('DynamicLinking-Service', 'Failed to update item', { 
                    originItem, 
                    error: updateError.message 
                }, null);
                throw updateError;
            }
        }

        return linksCreated.length;
    }
}

export default DynamicLinkingService;
