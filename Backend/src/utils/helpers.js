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
        this.batchSize = options.batchSize || 5; // Process 5 requests at a time
        this.delayBetweenBatches = options.delayBetweenBatches || 200; // 200ms delay between batches
        this.maxRetries = options.maxRetries || 3;
        this.retryDelay = options.retryDelay || 1000; // Start with 1 second delay
    }

    /**
     * Process an array of promises in batches with rate limiting
     */
    async processBatches(promises, options = {}) {
        const batchSize = options.batchSize || this.batchSize;
        const delay = options.delayBetweenBatches || this.delayBetweenBatches;
        const results = [];

        for (let i = 0; i < promises.length; i += batchSize) {
            const batch = promises.slice(i, i + batchSize);
            const batchResults = await Promise.allSettled(batch);
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
                    // Exponential backoff: delay increases with each retry
                    const backoffDelay = delay * Math.pow(2, attempt);
                    await new Promise(resolve => setTimeout(resolve, backoffDelay));
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
    const rateLimiter = new RateLimiter(options);
    const promises = items.map(item => () => processor(item));
    
    const results = await rateLimiter.processBatches(
        promises.map(p => p()),
        options
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