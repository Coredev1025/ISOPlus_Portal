import { warn } from '../utils/logger.js';

const URL_PATTERN = /https?:\/\/([^/]+)\/api\/([^/]+)\/([^/]+)\/([^/?]+)/;

function rewriteWorkflowUrl(url, workspaceId, boardId) {
  const match = url.match(URL_PATTERN);
  if (!match || !process.env.BACKEND_URL) {
    if (!process.env.BACKEND_URL) {
      warn('Automation-Service', 'BACKEND_URL not found in your environment variables');
    }
    return url;
  }

  const backendUrl = match[1];
  const apiPath = match[2];
  const currentWorkspaceId = match[3];
  const currentBoardId = match[4];
  const backendUrlWithoutProtocol = process.env.BACKEND_URL.replace(/^https?:\/\//, '');

  return url.replace(
    new RegExp(`${backendUrl}/api/${apiPath}/${currentWorkspaceId}/${currentBoardId}`),
    `${backendUrlWithoutProtocol}/api/${apiPath}/${workspaceId}/${boardId}`
  );
}

function updateWorkflowUrls(workflow, workspaceId, boardId) {
  if (!workflow.config?.url) return workflow;

  return {
    ...workflow,
    config: {
      ...workflow.config,
      url: rewriteWorkflowUrl(workflow.config.url, workspaceId, boardId),
    },
  };
}

export function shouldUpdatePortalAutomation(automationItem) {
  return automationItem.name.startsWith('Portal - ');
}

export function buildUpdatedAutomation(automationItem, workspaceId, boardId) {
  if (!shouldUpdatePortalAutomation(automationItem)) {
    return { needsUpdate: false, automation: automationItem };
  }

  const automation = { ...automationItem };
  if (Array.isArray(automationItem.workflow)) {
    automation.workflow = automationItem.workflow.map((workflow) =>
      updateWorkflowUrls(workflow, workspaceId, boardId)
    );
  }

  return { needsUpdate: true, automation };
}
