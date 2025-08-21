import Loki from 'lokijs';
import sanitizeHtml from 'sanitize-html';
import he from 'he';
import { tokenizeString } from '../utils/dynamicLinking.js';
import { info, warn, error } from '../utils/logger.js';
import got from 'got';
import { getAllViews, getAutomation, getBoard, updateAutomation } from './isoplus.js';

const TEMPLATE_REGEX = /{{\s*([^}]+)\s*}}/g;

class DynamicLinkingService {
    constructor(authorization, host) {
        if (!authorization || typeof authorization !== 'string') {
            throw new Error('Invalid authorization parameter. Expected a string authorization token.');
        }

        if (!host || typeof host !== 'string') {
            throw new Error('Invalid host parameter. Expected a string host URL.');
        }

        this.host = host.endsWith('/') ? host.slice(0, -1) : host;
        this.authorization = authorization.startsWith('Bearer ') ? authorization : `Bearer ${authorization}`;

        console.log(`DynamicLinkingService initialized with host: ${this.host}`);

        this.db = new Loki('entries');
        this.sources = this.db.addCollection('links');
        this.destinations = this.db.addCollection('items', { indices: ['boardName', 'name'] });
        this.api = () => {
            return got.extend({
                prefixUrl: `${this.host}/api/v2/`,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `${this.authorization}`
                }
            });
        };
    }

    async main(workspaceId, update) {
        try {
            if (!workspaceId || typeof workspaceId !== 'string') {
                throw new Error('Invalid workspaceId parameter. Expected a string workspace ID.');
            }

            if (workspaceId.includes('http') || workspaceId.includes('://')) {
                throw new Error(`Invalid workspaceId: "${workspaceId}". Expected a workspace ID, not a full URL.`);
            }

            console.log("Starting dynamic linking");
            console.log(`Host: ${this.host}`);
            console.log(`Workspace ID: ${workspaceId}`);

            const resultBoards = await getBoard(this.authorization, workspaceId);
            const boards = resultBoards.board;

            console.log(`Checking ${boards.length} boards...`);

            const fetchingItems = boards.map(async board => {
                try {
                    const boardId = board.id;

                    const resultViews = await getAllViews(this.authorization, workspaceId, boardId);
                    const paginateViews = resultViews.views;

                    console.log(`Checking ${paginateViews.length} views in ${board.name}...`);

                    for await (const view of paginateViews) {
                        this.destinations.insert({
                            boardName: board.name,
                            name: view.name,
                            selfLink: `${this.host}/b/${boardId}/${view.folder_id}?view=${view.id}`
                        });
                        if (view.type === 'form' && view.settings?.formSettings?.enabled) {
                            this.destinations.insert({
                                boardName: board.name,
                                name: `public ${view.name}`,
                                selfLink: `${this.host}/form/${view.id}`
                            });
                        }
                    }

                    const paginateItems = await this.api().paginate.all(`workspaces/${workspaceId}/boards/${boardId}/items`, {
                        searchParams: {
                            limit: 50,
                            sort_by: 'created_at',
                            sort_direction: 'desc',
                            ['expand[]']: 'values'
                        },
                        pagination: {
                            transform: (res) => JSON.parse(res.body).data
                        }
                    }).catch(error => {
                        console.error(`Failed to fetch items for board ${board.name}:`, error.message);
                        throw new Error(`Failed to fetch items: ${error.message}`);
                    });

                    console.log(`Checking ${paginateItems.length} items in ${board.name}...`);

                    for await (const item of paginateItems) {
                        item.values.forEach(value => {
                            const textAttributeValue = value.data;

                            if (typeof textAttributeValue !== 'string') {
                                return;
                            }
                            this.destinations.insert({
                                name: textAttributeValue,
                                boardName: board.name,
                                selfLink: `${this.host}/b/${boardId}/${item.folder_id}/${item.id}`
                            });
                            const links = [];
                            let match;
                            while ((match = TEMPLATE_REGEX.exec(textAttributeValue)) !== null) {
                                const [label, targetBoardName, targetName] = tokenizeString(
                                    he.decode(
                                        sanitizeHtml(match[1], {
                                            allowedTags: [],  // Remove all tags
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
                            }
                            if (links.length > 0) {
                                this.sources.insert({
                                    boardId,
                                    item,
                                    value,
                                    links
                                });
                            }
                        });
                    }

                    const paginateAutomations = await getAutomation(workspaceId, boardId, this.authorization);

                    for await (const automation of paginateAutomations) {
                        automation.workflow.forEach(value => {
                            if (value && value.config) {
                                if (value.config.text) {
                                    const links = [];
                                    let match;

                                    while ((match = TEMPLATE_REGEX.exec(value.config.text)) !== null) {
                                        const [label, targetBoardName, targetName] = tokenizeString(
                                            he.decode(
                                                sanitizeHtml(match[1], {
                                                    allowedTags: [],  // Remove all tags
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
                                    }
                                    if (links.length > 0) {
                                        this.sources.insert({
                                            boardId,
                                            item: automation,
                                            value,
                                            links,
                                            automation: true,
                                            templateItemValues: false
                                        });
                                    }
                                }
                                if (value.config.templateItemValues) {
                                    value.config.templateItemValues.forEach(templateItemValue => {
                                        const links = [];
                                        let match;

                                        while ((match = TEMPLATE_REGEX.exec(templateItemValue.data)) !== null) {
                                            const [label, targetBoardName, targetName] = tokenizeString(
                                                he.decode(
                                                    sanitizeHtml(match[1], {
                                                        allowedTags: [],  // Remove all tags
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
                                        }
                                        if (links.length > 0) {
                                            this.sources.insert({
                                                boardId,
                                                item: automation,
                                                value,
                                                links,
                                                automation: true,
                                                templateItemValues: true
                                            });
                                        }
                                    });
                                }
                            }
                        });
                    }
                } catch (boardError) {
                    console.error(`Error processing board ${board?.name || 'unknown'}:`, boardError);
                }
            });

            await Promise.all(fetchingItems);
            let totalLinksCreated = [], totalLinksFailed = [];
            await Promise.all(this.sources.chain().data().map(async source => {
                try {
                    let _originItem = `${this.host}/b/${source.boardId}/${source.item.folder_id}/${source.item.id}`;
                    const linksCreated = [];

                    if (source && source?.automation) {
                        _originItem = `${this.host}/b/${source.boardId}/?automations=true&t=manage&aid=${source.item.id}`;
                    }

                    source.links.forEach(link => {
                        const destination = this.destinations.findOne({ name: link.targetName, boardName: link.targetBoardName });

                        if (!destination) {
                            if (!update) {
                                totalLinksFailed.push({ link, originItem: _originItem, originalMatch: link.originalMatch });
                                console.warn(`Failed to create link from ${_originItem}\n\t Trying to parse template "${he.decode(link.originalMatch)}"\n`);
                            }
                            return;
                        }
                        if (source && source?.automation) {
                            if (source?.templateItemValues) {
                                source.item.workflow.forEach((value, index) => {
                                    if (value && value.config && value.config.templateItemValues) {
                                        value.config.templateItemValues.forEach((templateItemValue, templateItemValueIndex) => {
                                            if (templateItemValue.data.includes(link.originalMatch)) {
                                                templateItemValue.data = templateItemValue.data.replace(link.originalMatch, `<a href="${destination.selfLink}">${link.label}</a>`);
                                                source.item.workflow[index].config.templateItemValues[templateItemValueIndex] = templateItemValue;
                                            }
                                        });
                                    }
                                });
                            } else {                                
                                source.item.workflow.forEach((value, index) => {
                                    if (value && value.config && value.config.text && value.config.text.includes(link.originalMatch)) {
                                        console.log(link.originalMatch)
                                        value.config.text = value.config.text.replace(link.originalMatch, `<a href="${destination.selfLink}">${link.label}</a>`);
                                        source.item.workflow[index] = value;
                                    }
                                });
                            }
                        } else {
                            source.value.data = source.value.data.replace(link.originalMatch, `<a href="${destination.selfLink}">${link.label}</a>`);
                        }
                        linksCreated.push(destination.selfLink);
                        totalLinksCreated.push({ link, originItem: _originItem, originalMatch: link.originalMatch });
                    });

                    if (linksCreated.length > 0) {
                        console.log(`Link created from ${_originItem} to:\n\t> ${linksCreated.join('\n\t> ')}`);
                        if (update) {
                            if (source && source?.automation) {
                                console.log("Update Automation", source.item.workflow);
                                updateAutomation(workspaceId, source.boardId, source.item.id, source.item, this.authorization);
                            } else {
                                await this.api().put(`workspaces/${workspaceId}/boards/${source.boardId}/items/${source.item.id}`, {
                                    json: {
                                        "values": [{
                                            attribute_id: source.value.attribute_id,
                                            data: source.value.data
                                        }],
                                    }
                                });
                            }
                        }
                    }
                } catch (sourceError) {
                    console.error('Error processing source:', sourceError);
                }
            }));

            if (update) {
                console.log(`Links created: ${totalLinksCreated.length}`);
                return totalLinksCreated;
            } else {
                console.log(`Links failed: ${totalLinksFailed.length}`);
                return totalLinksFailed;
            }
        } catch (error) {
            console.error('Error in main method:', error);
            throw error;
        }
    }
}

export default DynamicLinkingService;
