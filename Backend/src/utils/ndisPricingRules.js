import { getBoardAttributes } from '../services/isoplus.js';
import Item from '../models/Item.js';
import { getReferences, getAttribute } from '../services/isoplus.js';

export const LEGACY_DIRECT_SUPPORT_ATTR = 'Direct Support Item Number';
export const NEW_SUPPORT_ITEM_ATTR = 'Support Item Number';
export const NEW_ACTIVITY_TRANSPORT_ITEM_ATTR = 'Activity Based Transport Item Number';

const BOARD_RULE_CACHE_MS = 5 * 60 * 1000;
const boardRuleCache = new Map();

export function hasSelectionValue(itemsValues, key) {
    const raw = itemsValues?.[key];
    if (Array.isArray(raw)) return raw.length > 0;
    return raw !== undefined && raw !== null && raw !== '';
}

export function boardAttributesUseLegacyNdisPricing(attributes) {
    const list = Array.isArray(attributes)
        ? attributes
        : (attributes?.attribute || []);
    return list.some((attr) =>
        attr?.name === LEGACY_DIRECT_SUPPORT_ATTR &&
        String(attr?.type || '').toLowerCase() === 'reference'
    );
}

export function boardAttributesUseNewNdisPricing(attributes) {
    return !boardAttributesUseLegacyNdisPricing(attributes);
}

/** @returns {'legacy' | 'new' | null} */
export function inferPricingRuleFromServicePlanData(servicePlanData) {
    if (!servicePlanData || typeof servicePlanData !== 'object') return null;
    const hasLegacyKey = Object.prototype.hasOwnProperty.call(servicePlanData, LEGACY_DIRECT_SUPPORT_ATTR);
    const hasNewKey = Object.prototype.hasOwnProperty.call(servicePlanData, NEW_SUPPORT_ITEM_ATTR);
    if (hasLegacyKey && !hasNewKey) return 'legacy';
    if (hasNewKey && !hasLegacyKey) return 'new';
    if (hasLegacyKey && hasNewKey) {
        if (hasSelectionValue(servicePlanData, NEW_SUPPORT_ITEM_ATTR)) return 'new';
        return 'legacy';
    }
    return null;
}

export async function boardUsesLegacyNdisPricing(workspaceId, boardId) {
    if (!workspaceId || !boardId) return true;

    const cacheKey = `${workspaceId}:${boardId}`;
    const cached = boardRuleCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < BOARD_RULE_CACHE_MS) {
        return cached.legacy;
    }

    const result = await getBoardAttributes(workspaceId, boardId);
    if (result?.status !== 200) {
        boardRuleCache.set(cacheKey, { legacy: true, fetchedAt: Date.now() });
        return true;
    }

    const attributes = result?.attribute || [];
    if (attributes.length === 0) {
        boardRuleCache.set(cacheKey, { legacy: true, fetchedAt: Date.now() });
        return true;
    }

    const legacy = boardAttributesUseLegacyNdisPricing(attributes);
    boardRuleCache.set(cacheKey, { legacy, fetchedAt: Date.now() });
    return legacy;
}

export async function boardUsesNewNdisPricing(workspaceId, boardId) {
    return !(await boardUsesLegacyNdisPricing(workspaceId, boardId));
}

/** @returns {'legacy' | 'new'} */
export async function resolveNdisPricingRuleForBoard(workspaceId, boardId) {
    const legacy = await boardUsesLegacyNdisPricing(workspaceId, boardId);
    return legacy ? 'legacy' : 'new';
}

/** @returns {'legacy' | 'new'} */
export async function resolveNdisPricingRuleForServicePlan(workspaceId, servicePlanItem, fallbackBoardId) {
    const inferred = inferPricingRuleFromServicePlanData(servicePlanItem?.data);
    if (inferred) return inferred;

    const boardId = servicePlanItem?.boardId || fallbackBoardId;
    if (!boardId) return 'legacy';
    return resolveNdisPricingRuleForBoard(workspaceId, boardId);
}

export async function getServicePlanBoardIdFromMasterPlan(workspaceId, masterPlanBoardId, masterPlanItemId) {
    const referenceResponse = await getReferences(workspaceId, masterPlanBoardId, masterPlanItemId);
    const refs = referenceResponse?.data ?? [];
    for (const reference of refs) {
        const attribute = await getAttribute(workspaceId, masterPlanBoardId, reference.attribute_id);
        if (attribute?.name !== 'Service Plan') continue;
        const servicePlanItemId = reference.to_item_id;
        const doc = await Item.findOne({
            workspaceId: workspaceId.toString(),
            itemId: servicePlanItemId,
        }).select('boardId').lean();
        if (doc?.boardId) return doc.boardId;
        return masterPlanBoardId;
    }
    return null;
}

export async function masterPlanBoardUsesNewNdisPricing(workspaceId, masterPlanBoardId, masterPlanItemId) {
    const servicePlanBoardId = await getServicePlanBoardIdFromMasterPlan(
        workspaceId, masterPlanBoardId, masterPlanItemId
    );
    if (!servicePlanBoardId) return false;
    return boardUsesNewNdisPricing(workspaceId, servicePlanBoardId);
}

export function isShiftCancelled(itemsValues) {
    const status = itemsValues?.['Job Status'] ?? itemsValues?.['Shift Status'];
    if (Array.isArray(status)) {
        return status.some((s) => String(s).toLowerCase() === 'cancelled');
    }
    return String(status || '').toLowerCase() === 'cancelled';
}
