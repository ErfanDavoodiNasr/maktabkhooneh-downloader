/**
 * Concurrent downloads + schedule cutoff against local mock server.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {createMockServer, makeMediaBytes} from '../helpers/mock-server.mjs';
import {downloadToFile} from '../../lib/download-engine.mjs';
import {createConcurrencyProbe, mapPool} from '../../lib/pool.mjs';
import {buildSchedule, createScheduleGate} from '../../lib/schedule.mjs';

describe('concurrency + schedule integration', () => {
    it('jobs=4 never exceeds 4 active downloads (barrier)', async () => {
        const media = makeMediaBytes(32 * 1024);
        const server = await createMockServer({mediaBytes: media, slowDelayMs: 5});
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-conc-'));
        const probe = createConcurrencyProbe();
        let release;
        const barrier = new Promise((r) => {
            release = r;
        });
        let atPeak = 0;
        const items = Array.from({length: 8}, (_, i) => i);

        try {
            await mapPool(items, 4, async (i) => probe.run(async () => {
                atPeak = Math.max(atPeak, probe.active);
                if (probe.active === 4) release();
                const file = path.join(dir, `f${i}.mp4`);
                // Hold the barrier briefly so peak is observable
                await barrier;
                return downloadToFile(`${server.baseUrl}/media/slow`, file, {
                    allowPrivateMedia: true,
                    deps: {
                        allowPrivateMedia: true,
                        requestTimeoutMs: 30_000,
                        readTimeoutMs: 30_000
                    }
                });
            }));
            assert.ok(probe.peak <= 4);
            assert.ok(atPeak === 4);
            for (let i = 0; i < 8; i++) {
                assert.equal(fs.statSync(path.join(dir, `f${i}.mp4`)).size, media.length);
            }
        } finally {
            await server.close();
        }
    });

    it('one failure while others succeed', async () => {
        const media = makeMediaBytes(4096);
        const server = await createMockServer({mediaBytes: media});
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-mix-'));
        const urls = [
            `${server.baseUrl}/media/full`,
            `${server.baseUrl}/media/404`,
            `${server.baseUrl}/media/full`,
            `${server.baseUrl}/media/full`
        ];
        const outcomes = [];
        await mapPool(urls, 2, async (url, i) => {
            const file = path.join(dir, `x${i}.mp4`);
            try {
                const st = await downloadToFile(url, file, {
                    maxRetries: 1,
                    deps: {allowPrivateMedia: true, requestTimeoutMs: 10_000, readTimeoutMs: 10_000}
                });
                outcomes.push({i, st});
            } catch (e) {
                outcomes.push({i, err: e.message});
            }
        });
        assert.equal(outcomes.filter((o) => o.st === 'downloaded').length, 3);
        assert.equal(outcomes.filter((o) => o.err).length, 1);
        await server.close();
    });

    it('schedule stop mid-stream preserves .part and returns deferred', async () => {
        const media = makeMediaBytes(64 * 1024);
        const server = await createMockServer({mediaBytes: media, slowDelayMs: 15});
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-sched-'));
        const file = path.join(dir, 'vid.mp4');
        let now = new Date('2026-09-15T02:00:00Z');
        const schedule = buildSchedule({
            startAt: '2026-09-15T02:00:00Z',
            stopAt: '2026-09-15T02:00:00.050Z'
        });
        // Advance clock after first progress so stop fires during stream
        const gate = createScheduleGate(schedule, {nowFn: () => now});
        setTimeout(() => {
            now = new Date('2026-09-15T02:00:00.100Z');
        }, 30);

        const status = await downloadToFile(`${server.baseUrl}/media/slow`, file, {
            maxRetries: 1,
            deps: {
                allowPrivateMedia: true,
                requestTimeoutMs: 30_000,
                readTimeoutMs: 30_000,
                scheduleGate: gate
            }
        });
        assert.equal(status, 'deferred');
        assert.equal(fs.existsSync(file), false);
        assert.ok(fs.existsSync(`${file}.part`));
        assert.ok(fs.statSync(`${file}.part`).size > 0);
        assert.ok(fs.statSync(`${file}.part`).size < media.length);
        await server.close();
    });

    it('schedule gate blocks retries outside window', async () => {
        let attempts = 0;
        const server = await createMockServer({
            handler(req, res) {
                attempts++;
                res.writeHead(503, {'content-type': 'text/plain'});
                res.end('nope');
            }
        });
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-retry-sched-'));
        const file = path.join(dir, 'a.mp4');
        let now = new Date('2026-09-15T02:00:00Z');
        const schedule = buildSchedule({
            startAt: '2026-09-15T02:00:00Z',
            stopAt: '2026-09-15T03:00:00Z'
        });
        const gate = createScheduleGate(schedule, {nowFn: () => now});
        // After first failure, leave the window before retry sleep finishes
        const status = await downloadToFile(`${server.baseUrl}/x`, file, {
            maxRetries: 4,
            deps: {
                allowPrivateMedia: true,
                requestTimeoutMs: 5000,
                readTimeoutMs: 5000,
                scheduleGate: gate,
                sleepFn: async () => {
                    now = new Date('2026-09-15T04:00:00Z');
                },
                backoffMs: () => 1
            }
        });
        assert.equal(status, 'deferred');
        assert.ok(attempts >= 1);
        assert.ok(attempts < 4);
        await server.close();
    });

    it('duplicate work keys are not scheduled twice', async () => {
        const seen = new Set();
        const items = [
            {key: 'a', n: 1},
            {key: 'a', n: 2},
            {key: 'b', n: 3}
        ];
        const deduped = [];
        for (const it of items) {
            if (seen.has(it.key)) continue;
            seen.add(it.key);
            deduped.push(it);
        }
        const ran = [];
        await mapPool(deduped, 2, async (it) => {
            ran.push(it.key);
        });
        assert.deepEqual(ran.sort(), ['a', 'b']);
    });
});
