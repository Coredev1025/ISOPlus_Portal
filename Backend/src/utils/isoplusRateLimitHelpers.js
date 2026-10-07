/** Thrown by getItemValues, on request, when ISO+ is still answering 429 after the shared retries. */
export class IsoPlusRateLimitedError extends Error {
  constructor(message = 'ISO+ is rate limiting requests') {
    super(message);
    this.name = 'IsoPlusRateLimitedError';
  }
}

/** Returns run(fn): runs fn once fewer than `max` earlier calls are unfinished, in call order. */
export function createConcurrencyLimiter(max) {
  let active = 0;
  const waiting = [];

  const release = () => {
    active -= 1;
    waiting.shift()?.();
  };

  return async function run(fn) {
    if (active >= max) await new Promise((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

/** Returns dedupe(key, fn): callers with the same key while one is running share its promise. */
export function createInFlightDeduper() {
  const inFlight = new Map();

  return function dedupe(key, fn) {
    if (inFlight.has(key)) return inFlight.get(key);
    const promise = new Promise((resolve) => resolve(fn())).finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  };
}
