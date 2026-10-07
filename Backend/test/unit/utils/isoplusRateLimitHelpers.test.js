import { describe, it, expect } from 'vitest';
import {
  IsoPlusRateLimitedError,
  createConcurrencyLimiter,
  createInFlightDeduper,
} from '../../../src/utils/isoplusRateLimitHelpers.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('IsoPlusRateLimitedError', () => {
  it('is an Error that can be told apart by name', () => {
    const err = new IsoPlusRateLimitedError('slow down');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('IsoPlusRateLimitedError');
    expect(err.message).toBe('slow down');
  });
});

describe('createConcurrencyLimiter', () => {
  it('never runs more than the cap at once and runs the rest in order', async () => {
    const limit = createConcurrencyLimiter(2);
    const gates = [deferred(), deferred(), deferred(), deferred()];
    const started = [];
    let active = 0;
    let peak = 0;
    const jobs = gates.map((gate, i) =>
      limit(async () => {
        started.push(i);
        active += 1;
        peak = Math.max(peak, active);
        await gate.promise;
        active -= 1;
        return i;
      }),
    );

    await tick();
    expect(started).toEqual([0, 1]);
    gates[0].resolve();
    await tick();
    expect(started).toEqual([0, 1, 2]);
    gates.slice(1).forEach((g) => g.resolve());
    expect(await Promise.all(jobs)).toEqual([0, 1, 2, 3]);
    expect(peak).toBe(2);
  });

  it('frees the slot when a job throws', async () => {
    const limit = createConcurrencyLimiter(1);
    await expect(limit(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await limit(async () => 'next')).toBe('next');
  });
});

describe('createInFlightDeduper', () => {
  it('shares one run between callers with the same key and clears it on settle', async () => {
    const dedupe = createInFlightDeduper();
    const gate = deferred();
    let runs = 0;
    const work = () => { runs += 1; return gate.promise; };

    const a = dedupe('item-1', work);
    const b = dedupe('item-1', work);
    const other = dedupe('item-2', async () => 'other');
    expect(runs).toBe(1);
    gate.resolve('found');
    expect(await a).toBe('found');
    expect(await b).toBe('found');
    expect(await other).toBe('other');

    expect(await dedupe('item-1', async () => 'again')).toBe('again');
  });

  it('clears the key when the run rejects so a later call tries again', async () => {
    const dedupe = createInFlightDeduper();
    await expect(dedupe('k', async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(await dedupe('k', async () => 'ok')).toBe('ok');
  });
});
