import axios from 'axios';
import FormData from 'form-data';
import { randomAlphanumeric } from './securityHelpers.js';

function buildSetLogoContext(deps) {
  const { workspaceId, logo, type, req } = deps;
  const requestId = req?.headers?.['x-request-id'] || `logo_${Date.now()}_${randomAlphanumeric(9)}`;
  return {
    requestId,
    operationContext: {
      workspaceId,
      logoType: type,
      requestId,
      logoFileName: logo?.originalname,
      logoSize: logo?.size,
      logoMimeType: logo?.mimetype,
    },
  };
}

function validateSetLogoParams(deps) {
  const { authorization, workspaceId, logo, type } = deps;
  if (!authorization) throw new Error('Authorization token is required');
  if (!workspaceId) throw new Error('Workspace ID is required');
  if (!logo) throw new Error('Logo file is required');
  if (!logo.buffer) throw new Error('Logo buffer is required');
  if (!logo.originalname) throw new Error('Logo filename is required');
  if (!type || (type !== 'form' && type !== 'document')) {
    throw new Error('Logo type must be either "form" or "document"');
  }
}

function validateLogoUploadResponse(uploadImageURL, type) {
  if (!uploadImageURL || uploadImageURL.status !== 201) {
    throw new Error(`Logo upload failed with status ${uploadImageURL?.status || 'unknown'}`);
  }
  if (!uploadImageURL.data || !uploadImageURL.data.id) {
    throw new Error('Logo upload response missing required data (id)');
  }
  if (!uploadImageURL.data.link && type === 'form') {
    throw new Error('Logo upload response missing required data (link) for form type');
  }
}

function logUploadLogoError(deps, ctx, err) {
  const { workspaceId, logo, req, getErrorMessage, errorMessageIncludes, error } = deps;
  const uploadErrorContext = {
    workspaceId,
    requestId: ctx.requestId,
    errorDetails: getErrorMessage(err),
    statusCode: err.response?.status,
    stackTrace: err.stack,
    logoFileName: logo?.originalname,
    logoSize: logo?.size,
    logoMimeType: logo?.mimetype,
  };
  if (errorMessageIncludes(err, 'unauthorized') || err.response?.status === 401) {
    error('ISO+™ Service', 'Error uploading logo: Unauthorized', uploadErrorContext, req ?? null);
  } else if (errorMessageIncludes(err, 'forbidden') || err.response?.status === 403) {
    error('ISO+™ Service', 'Error uploading logo: Forbidden', uploadErrorContext, req ?? null);
  } else if (errorMessageIncludes(err, 'timeout') || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
    error('ISO+™ Service', 'Error uploading logo: Request timeout', uploadErrorContext, req ?? null);
  } else {
    error('ISO+™ Service', 'Error uploading logo file:', uploadErrorContext, req ?? null);
  }
}

async function uploadLogoAttachment(deps, ctx) {
  const { authorization, workspaceId, logo } = deps;
  const formBody = new FormData();
  formBody.append('file', logo.buffer, logo.originalname);
  try {
    return await axios.post(
      `https://app.isoplus.online/api/v2/workspaces/${workspaceId}/attachments/file`,
      formBody,
      {
        headers: {
          Authorization: authorization,
          ...formBody.getHeaders(),
          Accept: 'application/json',
        },
      },
    );
  } catch (err) {
    logUploadLogoError(deps, ctx, err);
    throw err;
  }
}

function logSetLogoFailure(deps, ctx, err) {
  const { workspaceId, logo, type, req, getErrorMessage, errorMessageIncludes, error, logOperationEnd } = deps;
  const errorContext = {
    workspaceId,
    logoType: type,
    requestId: ctx.requestId,
    errorDetails: getErrorMessage(err),
    statusCode: err?.response?.status,
    stackTrace: err?.stack,
    operation: 'setLogo',
    logoFileName: logo?.originalname,
    logoSize: logo?.size,
    logoMimeType: logo?.mimetype,
  };
  if (errorMessageIncludes(err, 'required') || errorMessageIncludes(err, 'missing')) {
    error('ISO+™ Service', 'Error setting logo: Missing required parameter', errorContext, req ?? null);
  } else if (errorMessageIncludes(err, 'unauthorized') || err?.response?.status === 401) {
    error('ISO+™ Service', 'Error setting logo: Unauthorized', errorContext, req ?? null);
  } else if (errorMessageIncludes(err, 'forbidden') || err?.response?.status === 403) {
    error('ISO+™ Service', 'Error setting logo: Forbidden', errorContext, req ?? null);
  } else if (errorMessageIncludes(err, 'timeout') || err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT') {
    error('ISO+™ Service', 'Error setting logo: Request timeout', errorContext, req ?? null);
  } else if (errorMessageIncludes(err, 'network') || err?.code === 'ENOTFOUND' || err?.code === 'ECONNREFUSED') {
    error('ISO+™ Service', 'Error setting logo: Network error', errorContext, req ?? null);
  } else if (errorMessageIncludes(err, 'Failed to fetch boards')) {
    error('ISO+™ Service', 'Error setting logo: Failed to fetch boards', errorContext, req ?? null);
  } else {
    error('ISO+™ Service', 'Error setting logo:', errorContext, req ?? null);
  }
  logOperationEnd('ISO+™ Service', 'setLogo', {
    workspaceId,
    logoType: type,
    success: false,
    error: getErrorMessage(err),
  }, req);
}

function handleSetLogoFailure(deps, ctx, err) {
  logSetLogoFailure(deps, ctx, err);
  return null;
}


async function processBoardsForLogo(deps, ctx, boards, uploadImageURL) {
  const {
    authorization, workspaceId, logo, type, req,
    getAllViews, iterateBoardItems, validateBoardAttributes, getItemValues,
    getErrorMessage, errorMessageIncludes, sleep, logoItemsPageSize,
    info, warn, error, logAttributeError, logApiError,
  } = deps;
  const { requestId } = ctx;
  info('ISO+™ Service', 'Logo uploaded successfully, processing boards', {
    workspaceId,
    requestId,
    uploadId: uploadImageURL.data.id,
    boardCount: boards.board.length,
    boards: boards.board.map((b) => ({ id: b.id, name: b.name })),
  }, req);
  for (const boardItem of boards.board) {
    await processSingleBoardLogo(deps, ctx, boardItem, uploadImageURL);
  }
}

async function processSingleBoardLogo(deps, ctx, boardItem, uploadImageURL) {
  const {
    authorization, workspaceId, logo, type, req,
    getAllViews, iterateBoardItems, validateBoardAttributes, getItemValues,
    getErrorMessage, errorMessageIncludes, sleep, logoItemsPageSize,
    info, warn, error, logAttributeError, logApiError,
  } = deps;
  const { requestId } = ctx;
  info('ISO+™ Service', 'Processing board for logo update', {
    workspaceId,
    requestId,
    boardId: boardItem.id,
    boardName: boardItem.name,
    boardDescription: boardItem.description,
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
      stackTrace: err.stack,
    };
    if (errorMessageIncludes(err, 'timeout') || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      warn('ISO+™ Service', `Request timeout when fetching views for board ${boardItem.id}`, viewsErrorContext, req);
    } else if (errorMessageIncludes(err, 'network') || err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
      warn('ISO+™ Service', `Network error when fetching views for board ${boardItem.id}`, viewsErrorContext, req);
    } else {
      warn('ISO+™ Service', `Failed to fetch views for board ${boardItem.id}`, viewsErrorContext, req);
    }
    return;
  }

  if (!response || response.status !== 200) {
    warn('ISO+™ Service', `Failed to fetch views for board ${boardItem.id}`, {
      workspaceId,
      requestId,
      boardId: boardItem.id,
      responseStatus: response?.status,
      responseData: response?.data,
    }, req);
    return;
  }

  info('ISO+™ Service', 'Views fetched successfully', {
    workspaceId,
    requestId,
    boardId: boardItem.id,
    totalViews: response.views?.length || 0,
    viewTypes: response.views?.map((v) => ({ id: v.id, name: v.name, type: v.type })) || [],
  }, req);

  const views = response.views.filter((item) => item.type.toLowerCase() === type);
  if (!views.length) {
    warn('ISO+™ Service', `No views found for board ${boardItem.id}`, {
      workspaceId,
      requestId,
      boardId: boardItem.id,
      requestedType: type,
      availableTypes: response.views?.map((v) => v.type) || [],
      allViews: response.views?.map((v) => ({ id: v.id, name: v.name, type: v.type })) || [],
    }, req);
    return;
  }

  info('ISO+™ Service', `Found ${views.length} ${type} views for processing`, {
    workspaceId,
    requestId,
    boardId: boardItem.id,
    viewCount: views.length,
    views: views.map((v) => ({ id: v.id, name: v.name, type: v.type })),
  }, req);

  if (type === 'form') {
    await applyFormLogoToViews(deps, ctx, boardItem, views, uploadImageURL);
  } else if (type === 'document') {
    await applyDocumentLogoToViews(deps, ctx, boardItem, views, uploadImageURL);
  }
}

function logFormViewLogoError(deps, err, boardItem, viewItem, updateView, requestId) {
  const { workspaceId, req, getErrorMessage, errorMessageIncludes, logApiError } = deps;
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
    requestPayload: updateView,
  };
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

async function applyFormLogoToViews(deps, ctx, boardItem, views, uploadImageURL) {
  const {
    authorization, workspaceId, logo, type, req,
    getAllViews, iterateBoardItems, validateBoardAttributes, getItemValues,
    getErrorMessage, errorMessageIncludes, sleep, logoItemsPageSize,
    info, warn, error, logAttributeError, logApiError,
  } = deps;
  const { requestId } = ctx;
  for (const viewItem of views) {
    const updateView = {
      ...viewItem,
      settings: {
        ...viewItem.settings,
        formSettings: {
          ...viewItem.settings.formSettings,
          logoImageUrl: uploadImageURL.data.link,
        },
      },
    };
    try {
      await axios.put(
        `https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardItem.id}/views/${viewItem.id}`,
        updateView,
        {
          headers: {
            Authorization: authorization,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
        },
      );
      info('ISO+™ Service', `Logo set successfully for view: ${viewItem.id}`);
    } catch (err) {
      logFormViewLogoError(deps, err, boardItem, viewItem, updateView, requestId);
    }
    await sleep(2000);
  }
}

async function applyDocumentLogoToViews(deps, ctx, boardItem, views, uploadImageURL) {
  const {
    authorization, workspaceId, logo, type, req,
    getAllViews, iterateBoardItems, validateBoardAttributes, getItemValues,
    getErrorMessage, errorMessageIncludes, sleep, logoItemsPageSize,
    info, warn, error, logAttributeError, logApiError,
  } = deps;
  const { requestId } = ctx;
  for (const viewItem of views) {
    await applyDocumentLogoToView(deps, ctx, boardItem, viewItem, uploadImageURL);
  }
}

async function resolveDocumentCoverAttributeId(deps, ctx, boardItem, viewItem) {
  const {
    authorization, workspaceId, logo, type, req,
    getAllViews, iterateBoardItems, validateBoardAttributes, getItemValues,
    getErrorMessage, errorMessageIncludes, sleep, logoItemsPageSize,
    info, warn, error, logAttributeError, logApiError,
  } = deps;
  const { requestId } = ctx;
  let coverAttributeId = viewItem.settings?.editorCoverAttributeId;
  if (!coverAttributeId) {
    warn('ISO+™ Service', `No cover attribute id found for view ${viewItem.id}; attempting fallback`, {
      workspaceId,
      requestId,
      boardId: boardItem.id,
      viewId: viewItem.id,
      viewName: viewItem.name,
      viewSettings: viewItem.settings,
      availableSettings: Object.keys(viewItem.settings || {}),
    }, req);
  }

  const attributeValidation = await validateBoardAttributes(
    workspaceId,
    boardItem.id,
    viewItem.id,
    coverAttributeId,
    req,
  );
  const resolvedCoverAttributeId = attributeValidation?.attribute?.id;
  if (!resolvedCoverAttributeId) {
    warn('ISO+™ Service', 'Skipping view due to invalid cover attribute', {
      workspaceId,
      requestId,
      boardId: boardItem.id,
      viewId: viewItem.id,
      coverAttributeId,
    }, req);
    return null;
  }

  if (!coverAttributeId || coverAttributeId !== resolvedCoverAttributeId) {
    viewItem.settings = viewItem.settings || {};
    viewItem.settings.editorCoverAttributeId = resolvedCoverAttributeId;
    coverAttributeId = resolvedCoverAttributeId;
  } else {
    coverAttributeId = resolvedCoverAttributeId;
  }
  return coverAttributeId;
}

function logDocumentItemCoverError(deps, ctx, err, boardItem, viewItem, item, itemValues, coverAttributeId, uploadImageURL) {
  const {
    authorization, workspaceId, logo, type, req,
    getAllViews, iterateBoardItems, validateBoardAttributes, getItemValues,
    getErrorMessage, errorMessageIncludes, sleep, logoItemsPageSize,
    info, warn, error, logAttributeError, logApiError,
  } = deps;
  const { requestId } = ctx;
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
    coverAttributeId,
    requestId,
    errorDetails: getErrorMessage(err),
    statusCode: err.response?.status,
    requestPayload: {
      values: [{ data: uploadImageURL?.data?.id, attribute_id: coverAttributeId }],
    },
    stackTrace: err.stack,
    itemValues: itemValues?.values?.map((v) => ({
      attributeId: v.attribute?.id,
      attributeName: v.attribute?.name,
      attributeType: v.attribute?.type,
      data: v.data,
    })) || [],
    viewSettings: viewItem.settings,
    uploadDetails: {
      uploadId: uploadImageURL?.data?.id,
      fileName: logo?.originalname,
      fileSize: logo?.size,
      mimeType: logo?.mimetype,
    },
  };

  if (errorMessageIncludes(err, 'Attribute(s) not recognized')) {
    logAttributeError('ISO+™ Service', 'Error updating item for document logo: Attribute not recognized', coverAttributeId, errorContext, req);
  } else if (errorMessageIncludes(err, 'not found') || err.response?.status === 404) {
    logApiError('ISO+™ Service', 'Error updating item for document logo: Item or attribute not found', errorContext, req);
  } else if (errorMessageIncludes(err, 'unauthorized') || err.response?.status === 401) {
    logApiError('ISO+™ Service', 'Error updating item for document logo: Unauthorized', errorContext, req);
  } else if (errorMessageIncludes(err, 'forbidden') || err.response?.status === 403) {
    logApiError('ISO+™ Service', 'Error updating item for document logo: Forbidden', errorContext, req);
  } else if (errorMessageIncludes(err, 'timeout') || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
    logApiError('ISO+™ Service', 'Error updating item for document logo: Request timeout', errorContext, req);
  } else {
    logApiError('ISO+™ Service', 'Error updating item for document logo:', errorContext, req);
  }
}

async function updateDocumentItemCover(deps, ctx, boardItem, viewItem, item, coverAttributeId, uploadImageURL) {
  const {
    authorization, workspaceId, logo, type, req,
    getAllViews, iterateBoardItems, validateBoardAttributes, getItemValues,
    getErrorMessage, errorMessageIncludes, sleep, logoItemsPageSize,
    info, warn, error, logAttributeError, logApiError,
  } = deps;
  const { requestId } = ctx;
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
      coverAttributeId,
      errorDetails: getErrorMessage(err),
      statusCode: err.response?.status,
      stackTrace: err.stack,
    };
    if (errorMessageIncludes(err, 'timeout') || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      warn('ISO+™ Service', 'Request timeout when fetching item values', itemValuesErrorContext, req);
    } else if (errorMessageIncludes(err, 'network') || err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
      warn('ISO+™ Service', 'Network error when fetching item values', itemValuesErrorContext, req);
    } else {
      warn('ISO+™ Service', 'Error fetching item values', itemValuesErrorContext, req);
    }
    return;
  }

  if (!itemValues) return;

  let doc = itemValues.values.find((v) => v.attribute.id == coverAttributeId);
  const coverData = [{ id: uploadImageURL.data.id }];
  if (doc) {
    doc.data = coverData;
  } else {
    doc = { data: coverData, attribute: { id: coverAttributeId } };
  }

  try {
    const itemUpdateResponse = await axios.put(
      `https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardItem.id}/items/${item.id}`,
      { values: [{ data: doc.data, attribute_id: doc.attribute.id }] },
      {
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      },
    );
    viewItem.settings = viewItem.settings || {};
    viewItem.settings.editorItems = viewItem.settings.editorItems || {};
    if (itemUpdateResponse.status === 200) {
      if (item.id in viewItem.settings.editorItems) {
        viewItem.settings.editorItems[item.id].cover = uploadImageURL.data.id;
      } else {
        viewItem.settings.editorItems[item.id] = { cover: uploadImageURL.data.id };
      }
    }
  } catch (err) {
    logDocumentItemCoverError(deps, ctx, err, boardItem, viewItem, item, itemValues, coverAttributeId, uploadImageURL);
  }
  await sleep(2000);
}

async function processDocumentViewItemPages(deps, ctx, boardItem, viewItem, coverAttributeId, uploadImageURL) {
  const {
    authorization, workspaceId, logo, type, req,
    getAllViews, iterateBoardItems, validateBoardAttributes, getItemValues,
    getErrorMessage, errorMessageIncludes, sleep, logoItemsPageSize,
    info, warn, error, logAttributeError, logApiError,
  } = deps;
  const { requestId } = ctx;
  let totalItemsProcessed = 0;
  let pageNumber = 0;
  try {
    const itemIterator = iterateBoardItems(workspaceId, boardItem.id, viewItem.folder_id, {
      limit: logoItemsPageSize,
    });
    while (true) {
      const { value: itemsPage, done } = await itemIterator.next();
      if (done) break;
      pageNumber += 1;
      totalItemsProcessed += itemsPage.length;
      for (const item of itemsPage) {
        await updateDocumentItemCover(deps, ctx, boardItem, viewItem, item, coverAttributeId, uploadImageURL);
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
      coverAttributeId,
      errorDetails: getErrorMessage(err),
      statusCode: err.response?.status,
      stackTrace: err.stack,
    };
    if (errorMessageIncludes(err, 'timeout') || err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') {
      warn('ISO+™ Service', 'Request timeout when fetching items for document view', itemsErrorContext, req);
    } else if (errorMessageIncludes(err, 'network') || err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
      warn('ISO+™ Service', 'Network error when fetching items for document view', itemsErrorContext, req);
    } else {
      warn('ISO+™ Service', 'Error fetching items for document view', itemsErrorContext, req);
    }
    return 0;
  }

  if (totalItemsProcessed === 0) {
    warn('ISO+™ Service', 'No items found for document view', {
      workspaceId,
      requestId,
      boardId: boardItem.id,
      viewId: viewItem.id,
      folderId: viewItem.folder_id,
    }, req);
  }
  return totalItemsProcessed;
}

function logDocumentViewSaveError(deps, err, boardItem, viewItem, requestId) {
  const { workspaceId, req, getErrorMessage, errorMessageIncludes, logApiError } = deps;
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
    editorItems: viewItem.settings?.editorItems || {},
  };
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

async function applyDocumentLogoToView(deps, ctx, boardItem, viewItem, uploadImageURL) {
  const {
    authorization, workspaceId, logo, type, req,
    getAllViews, iterateBoardItems, validateBoardAttributes, getItemValues,
    getErrorMessage, errorMessageIncludes, sleep, logoItemsPageSize,
    info, warn, error, logAttributeError, logApiError,
  } = deps;
  const { requestId } = ctx;
  info('ISO+™ Service', 'Processing document view for logo update', {
    workspaceId,
    requestId,
    boardId: boardItem.id,
    viewId: viewItem.id,
    viewName: viewItem.name,
    viewType: viewItem.type,
    folderId: viewItem.folder_id,
    settings: viewItem.settings,
  }, req);

  const coverAttributeId = await resolveDocumentCoverAttributeId(deps, ctx, boardItem, viewItem);
  if (!coverAttributeId) return;

  await processDocumentViewItemPages(deps, ctx, boardItem, viewItem, coverAttributeId, uploadImageURL);

  try {
    await axios.put(
      `https://app.isoplus.online/api/v2/workspaces/${workspaceId}/boards/${boardItem.id}/views/${viewItem.id}`,
      viewItem,
      {
        headers: {
          Authorization: authorization,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      },
    );
    info('ISO+™ Service', `Logo set successfully for view: ${viewItem.id}`);
  } catch (err) {
    logDocumentViewSaveError(deps, err, boardItem, viewItem, requestId);
  }
  await sleep(2000);
}

export async function executeSetLogo(deps) {
  const ctx = buildSetLogoContext(deps);
  deps.logOperationStart('ISO+™ Service', 'setLogo', ctx.operationContext, deps.req);
  try {
    validateSetLogoParams(deps);
    deps.info('ISO+™ Service', 'Validating workspace access', { workspaceId: deps.workspaceId, requestId: ctx.requestId }, deps.req ?? null);
    const boards = await deps.getBoard(deps.authorization, deps.workspaceId);
    if (!boards || boards.status !== 200) {
      throw new Error(`Failed to fetch boards: ${deps.getErrorMessage(boards?.error || { message: 'Unknown error' })}`);
    }
    const uploadImageURL = await uploadLogoAttachment(deps, ctx);
    validateLogoUploadResponse(uploadImageURL, deps.type);
    if (uploadImageURL.status === 201 && boards.status === 200 && boards.board?.length > 0) {
      await processBoardsForLogo(deps, ctx, boards, uploadImageURL);
    } else {
      throw new Error('Failed to fetch boards');
    }
    deps.logOperationEnd('ISO+™ Service', 'setLogo', { workspaceId: deps.workspaceId, logoType: deps.type, success: true }, deps.req);
  } catch (err) {
    return handleSetLogoFailure(deps, ctx, err);
  }
}
