/**
 * Transformation Cache for Invoice Generator Data
 * 
 * Caches transformed item data to speed up CSV export, PDF generation, and XERO invoice.
 * Uses in-memory Map with TTL (time-to-live) and version-based invalidation.
 */

// In-memory cache store
const cache = new Map();

// Cache configuration
const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes default TTL
const MAX_CACHE_SIZE = 10000; // Maximum number of items to cache
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // Clean up expired entries every 5 minutes

/**
 * Generate a cache key for a transformed item
 * @param {string} workspaceId 
 * @param {string} boardId 
 * @param {string} itemId 
 * @returns {string}
 */
const generateCacheKey = (workspaceId, boardId, itemId) => {
    return `transform:${workspaceId}:${boardId}:${itemId}`;
};

/**
 * Get cached transformed item data
 * @param {string} workspaceId 
 * @param {string} boardId 
 * @param {string} itemId 
 * @param {Date|string} itemUpdatedAt - The item's last update timestamp for version validation
 * @returns {object|null} - Returns cached data if valid, null otherwise
 */
export const getCachedTransform = (workspaceId, boardId, itemId, itemUpdatedAt = null) => {
    const key = generateCacheKey(workspaceId, boardId, itemId);
    const entry = cache.get(key);

    if (!entry) {
        return null;
    }

    // Check if entry has expired
    if (Date.now() > entry.expiresAt) {
        cache.delete(key);
        return null;
    }

    // Check if item was updated since cache was created (version validation)
    if (itemUpdatedAt) {
        const itemUpdateTime = new Date(itemUpdatedAt).getTime();
        if (itemUpdateTime > entry.cachedAt) {
            cache.delete(key);
            return null;
        }
    }

    return entry.data;
};

/**
 * Set cached transformed item data
 * @param {string} workspaceId 
 * @param {string} boardId 
 * @param {string} itemId 
 * @param {object} data - The transformed data to cache
 * @param {number} ttlMs - Optional TTL in milliseconds
 */
export const setCachedTransform = (workspaceId, boardId, itemId, data, ttlMs = DEFAULT_TTL_MS) => {
    // Enforce max cache size by removing oldest entries if needed
    if (cache.size >= MAX_CACHE_SIZE) {
        cleanupOldestEntries(Math.floor(MAX_CACHE_SIZE * 0.1)); // Remove 10% of entries
    }

    const key = generateCacheKey(workspaceId, boardId, itemId);
    const now = Date.now();

    cache.set(key, {
        data,
        cachedAt: now,
        expiresAt: now + ttlMs
    });
};

/**
 * Get multiple cached items at once
 * @param {string} workspaceId 
 * @param {string} boardId 
 * @param {Array<{itemId: string, updatedAt?: Date|string}>} items - Array of items with ID and optional updatedAt
 * @returns {Map<string, object>} - Map of itemId to cached data (only includes items found in cache)
 */
export const getMultipleCachedTransforms = (workspaceId, boardId, items) => {
    const results = new Map();
    
    for (const item of items) {
        const cached = getCachedTransform(workspaceId, boardId, item.itemId, item.updatedAt);
        if (cached) {
            results.set(item.itemId, cached);
        }
    }

    return results;
};

/**
 * Set multiple cached items at once
 * @param {string} workspaceId 
 * @param {string} boardId 
 * @param {Array<{itemId: string, data: object}>} items - Array of items with ID and transformed data
 * @param {number} ttlMs - Optional TTL in milliseconds
 */
export const setMultipleCachedTransforms = (workspaceId, boardId, items, ttlMs = DEFAULT_TTL_MS) => {
    for (const item of items) {
        setCachedTransform(workspaceId, boardId, item.itemId, item.data, ttlMs);
    }
};

/**
 * Invalidate cache for a specific item
 * @param {string} workspaceId 
 * @param {string} boardId 
 * @param {string} itemId 
 */
export const invalidateCacheForItem = (workspaceId, boardId, itemId) => {
    const key = generateCacheKey(workspaceId, boardId, itemId);
    cache.delete(key);
};

/**
 * Invalidate cache for all items in a board
 * @param {string} workspaceId 
 * @param {string} boardId 
 */
export const invalidateCacheForBoard = (workspaceId, boardId) => {
    const prefix = `transform:${workspaceId}:${boardId}:`;
    for (const key of cache.keys()) {
        if (key.startsWith(prefix)) {
            cache.delete(key);
        }
    }
};

/**
 * Invalidate entire cache for a workspace
 * @param {string} workspaceId 
 */
export const invalidateCacheForWorkspace = (workspaceId) => {
    const prefix = `transform:${workspaceId}:`;
    for (const key of cache.keys()) {
        if (key.startsWith(prefix)) {
            cache.delete(key);
        }
    }
};

/**
 * Clean up expired entries from the cache
 */
export const cleanupExpiredEntries = () => {
    const now = Date.now();
    for (const [key, entry] of cache.entries()) {
        if (now > entry.expiresAt) {
            cache.delete(key);
        }
    }
};

/**
 * Clean up oldest entries from the cache
 * @param {number} count - Number of entries to remove
 */
const cleanupOldestEntries = (count) => {
    // Sort entries by cachedAt and remove oldest ones
    const entries = Array.from(cache.entries())
        .sort((a, b) => a[1].cachedAt - b[1].cachedAt)
        .slice(0, count);
    
    for (const [key] of entries) {
        cache.delete(key);
    }
};

/**
 * Get cache statistics
 * @returns {object}
 */
export const getCacheStats = () => {
    const now = Date.now();
    let validCount = 0;
    let expiredCount = 0;

    for (const entry of cache.values()) {
        if (now <= entry.expiresAt) {
            validCount++;
        } else {
            expiredCount++;
        }
    }

    return {
        totalSize: cache.size,
        validEntries: validCount,
        expiredEntries: expiredCount,
        maxSize: MAX_CACHE_SIZE,
        ttlMs: DEFAULT_TTL_MS
    };
};

/**
 * Clear entire cache
 */
export const clearCache = () => {
    cache.clear();
};

// Start periodic cleanup
setInterval(cleanupExpiredEntries, CLEANUP_INTERVAL_MS);

export default {
    getCachedTransform,
    setCachedTransform,
    getMultipleCachedTransforms,
    setMultipleCachedTransforms,
    invalidateCacheForItem,
    invalidateCacheForBoard,
    invalidateCacheForWorkspace,
    cleanupExpiredEntries,
    getCacheStats,
    clearCache
};
