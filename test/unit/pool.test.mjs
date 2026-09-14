import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createConcurrencyProbe, mapPool} from '../../lib/pool.mjs';

describe('mapPool', () => {
    it('jobs=1 is sequential', async () => {
        const order = [];
        await mapPool([1, 2, 3], 1, async (x) => {
            order.push(`start-${x}`);
            order.push(`end-${x}`);
            return x * 2;
        });
        assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2', 'start-3', 'end-3']);
    });

    it('never exceeds concurrency (barrier-based)', async () => {
        const probe = createConcurrencyProbe();
        const n = 8;
        const jobs = 3;
        let release;
        const gate = new Promise((r) => {
            release = r;
        });
        let entered = 0;
        const started = [];

        const run = mapPool(Array.from({length: n}, (_, i) => i), jobs, async (i) => probe.run(async () => {
            started.push(i);
            entered++;
            if (entered === jobs) release();
            await gate;
            return i;
        }));

        await gate;
        assert.equal(probe.active, jobs);
        assert.equal(probe.peak, jobs);
        // unblock all
        // gate already resolved; workers finish
        await run;
        assert.ok(probe.peak <= jobs);
        assert.equal(started.length, n);
    });

    it('one failure does not stop others', async () => {
        const {results, errors} = await mapPool([1, 2, 3, 4], 2, async (x) => {
            if (x === 2) throw new Error('boom');
            return x;
        });
        assert.equal(errors.length, 1);
        assert.equal(errors[0].item, 2);
        assert.deepEqual(results.filter((x) => x != null).sort((a, b) => a - b), [1, 3, 4]);
    });

    it('abort stops scheduling new work', async () => {
        const ac = new AbortController();
        let started = 0;
        const {results} = await mapPool(Array.from({length: 20}, (_, i) => i), 2, async () => {
            started++;
            if (started === 2) ac.abort();
            await new Promise((r) => setTimeout(r, 20));
            return true;
        }, {signal: ac.signal});
        assert.ok(started < 20);
        assert.ok(results.filter(Boolean).length < 20);
    });
});
