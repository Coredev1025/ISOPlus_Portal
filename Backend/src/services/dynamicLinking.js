import Loki from 'lokijs';
import he from 'he';
import { collectLinksFromTemplateText } from '../utils/dynamicLinkingTemplateHelpers.js';
import {
  sanitizeApiPathSegment,
  buildIsoPlusV2BoardItemsRelativePath,
  buildIsoPlusV2ItemRelativePath,
} from '../utils/securityHelpers.js';
import { sanitizeLogValue } from '../utils/sanitizeLog.js';
import { info, warn, error as logError } from '../utils/logger.js';
import got from 'got';
import { getAllViews, getAutomation, getBoard, updateAutomation } from './isoplus.js';

const LOG_SOURCE = 'DynamicLinking-Service';

function replaceLinkInTemplateItemValues(workflow, originalMatch, replacement) {
  if (!Array.isArray(workflow)) return;
  for (let index = 0; index < workflow.length; index++) {
    const value = workflow[index];
    if (!value?.config?.templateItemValues) continue;
    for (let tivIndex = 0; tivIndex < value.config.templateItemValues.length; tivIndex++) {
      const templateItemValue = value.config.templateItemValues[tivIndex];
      if (!templateItemValue?.data?.includes(originalMatch)) continue;
      templateItemValue.data = templateItemValue.data.replace(originalMatch, replacement);
      workflow[index].config.templateItemValues[tivIndex] = templateItemValue;
    }
  }
}

function replaceLinkInWorkflowText(workflow, originalMatch, replacement) {
  if (!Array.isArray(workflow)) return;
  for (let index = 0; index < workflow.length; index++) {
    const value = workflow[index];
    if (!value?.config?.text?.includes(originalMatch)) continue;
    value.config.text = value.config.text.replace(originalMatch, replacement);
    workflow[index] = value;
  }
}

function applyAutomationLinkToWorkflow(source, link, destination) {
  const replacement = `<a href="${destination.selfLink}">${link.label}</a>`;
  if (source?.templateItemValues) {
    replaceLinkInTemplateItemValues(source.item.workflow, link.originalMatch, replacement);
    return;
  }
  replaceLinkInWorkflowText(source.item.workflow, link.originalMatch, replacement);
}

function recordStringDestination(destinations, host, boardName, boardId, item, textValue) {
  destinations.insert({
    name: textValue,
    boardName,
    selfLink: `${host}/b/${boardId}/${item.folder_id}/${item.id}`,
  });
}

function recordItemValueSources(sources, boardId, item, value, links) {
  if (links.length === 0) return;
  sources.insert({ boardId, item, value, links });
}

function processItemValueForLinking(ctx, item, value) {
  const textAttributeValue = value.data;
  if (typeof textAttributeValue !== 'string') return;

  recordStringDestination(ctx.destinations, ctx.host, ctx.boardName, ctx.boardId, item, textAttributeValue);
  const links = collectLinksFromTemplateText(textAttributeValue);
  recordItemValueSources(ctx.sources, ctx.boardId, item, value, links);
}

function processAutomationWorkflowValue(ctx, automation, value) {
  if (!value?.config) return;

  if (value.config.text) {
    const links = collectLinksFromTemplateText(value.config.text);
    if (links.length > 0) {
      ctx.sources.insert({
        boardId: ctx.boardId,
        item: automation,
        value,
        links,
        automation: true,
        templateItemValues: false,
      });
    }
  }

  if (!value.config.templateItemValues) return;
  for (let i = 0; i < value.config.templateItemValues.length; i++) {
    const templateItemValue = value.config.templateItemValues[i];
    const links = collectLinksFromTemplateText(templateItemValue?.data);
    if (links.length === 0) continue;
    ctx.sources.insert({
      boardId: ctx.boardId,
      item: automation,
      value,
      links,
      automation: true,
      templateItemValues: true,
    });
  }
}

async function fetchBoardItems(apiClient, workspaceId, boardId, boardName) {
  const itemsPath = buildIsoPlusV2BoardItemsRelativePath(workspaceId, boardId);
  return apiClient.paginate.all(itemsPath, {
    searchParams: {
      limit: 50,
      sort_by: 'created_at',
      sort_direction: 'desc',
      ['expand[]']: 'values',
    },
    pagination: {
      transform: (res) => JSON.parse(res.body).data,
    },
  }).catch((fetchError) => {
    logError(
      LOG_SOURCE,
      'Failed to fetch board items',
      sanitizeLogValue({
        boardName,
        message: fetchError.message,
      })
    );
    throw new Error(`Failed to fetch items: ${fetchError.message}`);
  });
}

async function processBoardViews(service, workspaceId, boardId, boardName, views) {
  for await (const view of views) {
    service.destinations.insert({
      boardName,
      name: view.name,
      selfLink: `${service.host}/b/${boardId}/${view.folder_id}?view=${view.id}`,
    });
    if (view.type === 'form' && view.settings?.formSettings?.enabled) {
      service.destinations.insert({
        boardName,
        name: `public ${view.name}`,
        selfLink: `${service.host}/form/${view.id}`,
      });
    }
  }
}

async function processBoardForLinking(service, workspaceId, board) {
  const boardId = sanitizeApiPathSegment(board.id, 'boardId');
  const boardName = board.name;
  const resultViews = await getAllViews(service.authorization, workspaceId, boardId);
  const paginateViews = resultViews.views;

  info(
    LOG_SOURCE,
    'Checking board views',
    sanitizeLogValue({ boardName, viewCount: paginateViews.length })
  );
  await processBoardViews(service, workspaceId, boardId, boardName, paginateViews);

  const paginateItems = await fetchBoardItems(service.api(), workspaceId, boardId, boardName);
  info(
    LOG_SOURCE,
    'Checking board items',
    sanitizeLogValue({ boardName, itemCount: paginateItems.length })
  );

  const linkingCtx = {
    host: service.host,
    boardId,
    boardName,
    destinations: service.destinations,
    sources: service.sources,
  };

  for await (const item of paginateItems) {
    for (let i = 0; i < item.values.length; i++) {
      processItemValueForLinking(linkingCtx, item, item.values[i]);
    }
  }

  const paginateAutomations = await getAutomation(workspaceId, boardId, service.authorization);
  for await (const automation of paginateAutomations) {
    for (let i = 0; i < automation.workflow.length; i++) {
      processAutomationWorkflowValue(linkingCtx, automation, automation.workflow[i]);
    }
  }
}

function applySourceLink(source, link, destinations, update, originItem) {
  const destination = destinations.findOne({ name: link.targetName, boardName: link.targetBoardName });
  if (!destination) {
    if (!update) {
      warn(
        LOG_SOURCE,
        'Failed to create link from source item',
        sanitizeLogValue({
          originItem,
          template: he.decode(link.originalMatch),
        })
      );
    }
    return null;
  }

  if (source?.automation) {
    applyAutomationLinkToWorkflow(source, link, destination);
  } else {
    source.value.data = source.value.data.replace(
      link.originalMatch,
      `<a href="${destination.selfLink}">${link.label}</a>`,
    );
  }
  return destination.selfLink;
}

async function persistSourceLinks(service, source, workspaceId, update) {
  let originItem = `${service.host}/b/${source.boardId}/${source.item.folder_id}/${source.item.id}`;
  if (source?.automation) {
    originItem = `${service.host}/b/${source.boardId}/?automations=true&t=manage&aid=${source.item.id}`;
  }

  const linksCreated = [];
  const totalLinksCreated = [];
  for (let i = 0; i < source.links.length; i++) {
    const link = source.links[i];
    const createdLink = applySourceLink(source, link, service.destinations, update, originItem);
    if (!createdLink) continue;
    linksCreated.push(createdLink);
    totalLinksCreated.push({ link, originItem, originalMatch: link.originalMatch });
  }

  if (linksCreated.length === 0 || !update) {
    return totalLinksCreated;
  }

  if (source?.automation) {
    updateAutomation(workspaceId, source.boardId, source.item.id, source.item, service.authorization);
    return totalLinksCreated;
  }

  const itemPath = buildIsoPlusV2ItemRelativePath(workspaceId, source.boardId, source.item.id);
  await service.api().put(itemPath, {
    json: {
      values: [{
        attribute_id: source.value.attribute_id,
        data: source.value.data,
      }],
    },
  });
  return totalLinksCreated;
}

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

        info(LOG_SOURCE, 'DynamicLinkingService initialized', sanitizeLogValue({ host: this.host }));

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
            const safeWorkspaceId = sanitizeApiPathSegment(workspaceId, 'workspaceId');
            if (safeWorkspaceId.includes('http') || safeWorkspaceId.includes('://')) {
                throw new Error(`Invalid workspaceId: "${safeWorkspaceId}". Expected a workspace ID, not a full URL.`);
            }

            info(LOG_SOURCE, 'Starting dynamic linking', sanitizeLogValue({
              host: this.host,
              workspaceId: safeWorkspaceId,
            }));

            const resultBoards = await getBoard(this.authorization, safeWorkspaceId);
            const boards = resultBoards.board;

            info(LOG_SOURCE, 'Checking boards', sanitizeLogValue({ boardCount: boards.length }));

            const fetchingItems = boards.map(async (board) => {
                try {
                    await processBoardForLinking(this, safeWorkspaceId, board);
                } catch (boardError) {
                    logError(
                      LOG_SOURCE,
                      'Error processing board',
                      sanitizeLogValue({
                        boardName: board?.name || 'unknown',
                        message: boardError?.message,
                        stack: boardError?.stack,
                      })
                    );
                }
            });

            await Promise.all(fetchingItems);
            const sources = this.sources.chain().data();
            const linkResults = await Promise.all(sources.map(async (source) => {
                try {
                    return await persistSourceLinks(this, source, safeWorkspaceId, update);
                } catch (sourceError) {
                    logError(
                      LOG_SOURCE,
                      'Error processing source',
                      sanitizeLogValue({
                        message: sourceError?.message,
                        stack: sourceError?.stack,
                      })
                    );
                    return [];
                }
            }));
            return linkResults.flat();
        } catch (mainError) {
            logError(
              LOG_SOURCE,
              'Error in main method',
              sanitizeLogValue({
                message: mainError?.message,
                stack: mainError?.stack,
              })
            );
            throw mainError;
        }
    }
}

export default DynamicLinkingService;
