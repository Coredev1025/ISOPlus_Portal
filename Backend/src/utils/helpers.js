import jwt from 'jsonwebtoken';

export const stripHtmlTags = (str) => {
    const regex = /(<([^>]+)>)/gi;
    return str.replace(regex, '');
}

export const isEmpty = (value) => {
    return (
        value === undefined ||
        value === null ||
        value === '' ||
        (Array.isArray(value) && value.length === 0)
    );
}

/**
 * Rate limiter to prevent 429 errors
 * Processes promises in batches with delays between batches
 */
export class RateLimiter {
    constructor(options = {}) {
        this.batchSize = options.batchSize || 2; // Process 2 requests at a time (reduced from 5)
        this.delayBetweenBatches = options.delayBetweenBatches || 500; // 500ms delay between batches (increased from 200ms)
        this.delayBetweenRequests = options.delayBetweenRequests || 100; // 100ms delay between individual requests in a batch
        this.maxRetries = options.maxRetries || 5; // Increased from 3
        this.retryDelay = options.retryDelay || 2000; // Start with 2 seconds delay (increased from 1 second)
    }

    /**
     * Process an array of promises in batches with rate limiting
     */
    async processBatches(promises, options = {}) {
        const batchSize = options.batchSize || this.batchSize;
        const delay = options.delayBetweenBatches || this.delayBetweenBatches;
        const requestDelay = options.delayBetweenRequests || this.delayBetweenRequests;
        const results = [];

        for (let i = 0; i < promises.length; i += batchSize) {
            const batch = promises.slice(i, i + batchSize);
            
            // Process requests in batch with delay between each request
            const batchResults = [];
            for (let j = 0; j < batch.length; j++) {
                if (j > 0) {
                    // Add delay between individual requests in the batch
                    await new Promise(resolve => setTimeout(resolve, requestDelay));
                }
                try {
                    const result = await batch[j];
                    batchResults.push({ status: 'fulfilled', value: result });
                } catch (error) {
                    batchResults.push({ status: 'rejected', reason: error });
                }
            }
            
            results.push(...batchResults);

            // Add delay between batches (except for the last batch)
            if (i + batchSize < promises.length) {
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }

        return results;
    }

    /**
     * Execute a function with retry logic and exponential backoff for 429 errors
     */
    async executeWithRetry(fn, context = {}) {
        let lastError = null;
        let delay = this.retryDelay;

        for (let attempt = 0; attempt < this.maxRetries; attempt++) {
            try {
                const result = await fn();
                return result;
            } catch (err) {
                lastError = err;
                
                // Check if it's a 429 error or rate limit error
                const isRateLimitError = err.response?.status === 429 || 
                                       err.message?.includes('429') ||
                                       err.message?.toLowerCase().includes('rate limit') ||
                                       err.message?.toLowerCase().includes('too many requests');

                if (isRateLimitError && attempt < this.maxRetries - 1) {
                    // Exponential backoff with jitter: delay increases with each retry
                    // Add random jitter (0-30%) to prevent thundering herd
                    const jitter = 1 + (Math.random() * 0.3);
                    const backoffDelay = Math.min(
                        delay * Math.pow(2, attempt) * jitter,
                        30000 // Cap at 30 seconds
                    );
                    await new Promise(resolve => setTimeout(resolve, Math.floor(backoffDelay)));
                    continue;
                }

                // If not a rate limit error or max retries reached, throw
                throw err;
            }
        }

        throw lastError;
    }
}

/**
 * Helper function to batch process items with rate limiting
 */
export async function batchProcess(items, processor, options = {}) {
    // Use more conservative defaults if not specified
    const defaultOptions = {
        batchSize: 2,
        delayBetweenBatches: 500,
        delayBetweenRequests: 100,
        ...options
    };
    
    const rateLimiter = new RateLimiter(defaultOptions);
    const promises = items.map(item => () => processor(item));
    
    const results = await rateLimiter.processBatches(
        promises.map(p => p()),
        defaultOptions
    );

    return results.map((result, index) => {
        if (result.status === 'fulfilled') {
            return result.value;
        } else {
            // Log error but continue processing
            console.warn(`Error processing item at index ${index}:`, result.reason);
            return null;
        }
    });
}

export async function batchProcessFast(items, processor, options = {}) {
    const defaultOptions = {
        batchSize: 100,
        delayBetweenBatches: 100,
        ...options
    };
    
    const results = [];
    
    for (let i = 0; i < items.length; i += defaultOptions.batchSize) {
        const batch = items.slice(i, i + defaultOptions.batchSize);
        
        const batchResults = await Promise.allSettled(
            batch.map(item => processor(item))
        );
        
        for (const result of batchResults) {
            if (result.status === 'fulfilled') {
                results.push(result.value);
            } else {
                results.push(null);
            }
        }

        if (i + defaultOptions.batchSize < items.length) {
            await new Promise(resolve => setTimeout(resolve, defaultOptions.delayBetweenBatches));
        }
    }
    
    return results;
}

export async function processParallel(items, processor, concurrencyLimit = 50) {
    const results = [];
    
    for (let i = 0; i < items.length; i += concurrencyLimit) {
        const batch = items.slice(i, i + concurrencyLimit);
        const batchResults = await Promise.allSettled(
            batch.map(item => processor(item))
        );
        
        for (const result of batchResults) {
            results.push(result.status === 'fulfilled' ? result.value : null);
        }
    }

    return results;
}

export function getFrontendBaseUrl() {
    const explicit = process.env.FRONTEND_URL;
    if (explicit) return explicit.replace(/\/+$/, '');

    const origins = (process.env.ALLOWED_ORIGINS || '')
        .split(/[\s,]+/)
        .filter(Boolean);
    if (origins.length > 0) return origins[0].replace(/\/+$/, '');

    return 'http://localhost:3000';
}

export function signOAuthState(payload = {}, expiresIn = '10m') {
    return jwt.sign({ ...payload, nonce: Math.random().toString(36).slice(2) }, process.env.JWT_SECRET, { expiresIn });
}

export function verifyOAuthState(state) {
    if (!state) return null;
    try {
        return jwt.verify(state, process.env.JWT_SECRET);
    } catch {
        return null;
    }
}