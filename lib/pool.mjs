/**
 * Bounded concurrency pool. Never spawns more than `concurrency` workers.
 */

/**
 * Run `worker` over `items` with at most `concurrency` in flight.
 * Failures are collected; other items continue unless `signal` aborts.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T, index: number) => Promise<R>} worker
 * @param {{signal?: AbortSignal, onItemError?: (err: Error, item: T, index: number) => void}} [opts]
 * @returns {Promise<{results: (R|undefined)[], errors: Array<{index:number, item:T, error:Error}>}>}
 */
export async function mapPool(items, concurrency, worker, opts = {}) {
    const list = Array.isArray(items) ? items : [];
    const n = Math.max(1, Math.min(Number(concurrency) || 1, list.length || 1));
    const {signal, onItemError} = opts;
    /** @type {(R|undefined)[]} */
    const results = new Array(list.length);
    /** @type {Array<{index:number, item:T, error:Error}>} */
    const errors = [];
    let next = 0;

    async function runOne() {
        while (true) {
            if (signal?.aborted) return;
            const i = next++;
            if (i >= list.length) return;
            try {
                results[i] = await worker(list[i], i);
            } catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                errors.push({index: i, item: list[i], error});
                if (typeof onItemError === 'function') onItemError(error, list[i], i);
            }
        }
    }

    const workers = Array.from({length: Math.min(n, list.length)}, () => runOne());
    await Promise.all(workers);
    return {results, errors};
}

/**
 * Track how many async slots are active (for tests / instrumentation).
 */
export function createConcurrencyProbe() {
    let active = 0;
    let peak = 0;
    return {
        get active() {
            return active;
        },
        get peak() {
            return peak;
        },
        async run(fn) {
            active++;
            if (active > peak) peak = active;
            try {
                return await fn();
            } finally {
                active--;
            }
        }
    };
}
