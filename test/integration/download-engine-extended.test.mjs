/**
 * Extra download-engine / performance coverage.
 */
import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import {buildAuthAwareHeaders, downloadToFile, probeRemoteSize} from '../../lib/download-engine.mjs';
import {createMockServer, makeMediaBytes} from '../helpers/mock-server.mjs';

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

describe('download-engine extended', () => {
    let tmp;

    before(() => {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-ext-'));
    });

    after(() => {
        fs.rmSync(tmp, {recursive: true, force: true});
    });

    function deps(trustedOrigin, extra = {}) {
        return {
            trustedOrigin,
            allowPrivateMedia: true,
            sleepFn: async () => {
            },
            backoffMs: () => 0,
            ...extra
        };
    }

    it('buildAuthAwareHeaders omits cookie for foreign hosts', () => {
        const h1 = buildAuthAwareHeaders({
            cookie: 'sessionid=abc',
            url: 'https://cdn.example.com/v.mp4',
            trustedOrigin: 'https://maktabkhooneh.org'
        });
        assert.equal(h1.cookie, undefined);
        const h2 = buildAuthAwareHeaders({
            cookie: 'sessionid=abc',
            url: 'https://maktabkhooneh.org/api/x',
            trustedOrigin: 'https://maktabkhooneh.org'
        });
        assert.equal(h2.cookie, 'sessionid=abc');
    });

    it('rejects HTML body served as video', async () => {
        const s = await createMockServer();
        try {
            const out = path.join(tmp, 'bad.mp4');
            await assert.rejects(
                () => downloadToFile(`${s.baseUrl}/media/html-as-video`, out, {
                    maxRetries: 1,
                    expectedKind: 'video',
                    deps: deps(s.baseUrl)
                }),
                /HTML|Refusing/i
            );
            assert.equal(fs.existsSync(out), false);
        } finally {
            await s.close();
        }
    });

    it('sample-bytes never exceeds requested size', async () => {
        const mediaBytes = makeMediaBytes(2_000_000);
        const s = await createMockServer({mediaBytes});
        try {
            const out = path.join(tmp, 'sample.bin');
            await downloadToFile(`${s.baseUrl}/media/full`, out, {
                sampleBytes: 4096,
                maxRetries: 2,
                expectedKind: 'attachment',
                deps: deps(s.baseUrl)
            });
            const st = fs.statSync(out);
            assert.ok(st.size <= 4096);
            assert.ok(st.size > 0);
        } finally {
            await s.close();
        }
    });

    it('resume when server ignores Range restarts cleanly (no append corruption)', async () => {
        const payload = makeMediaBytes(64 * 1024);
        const s = await createMockServer({mediaBytes: payload});
        try {
            const out = path.join(tmp, 'resume-ignore.bin');
            const part = `${out}.part`;
            fs.writeFileSync(part, payload.subarray(0, 10_000));
            await downloadToFile(`${s.baseUrl}/media/ignore-range`, out, {
                maxRetries: 4,
                expectedKind: 'attachment',
                deps: deps(s.baseUrl)
            });
            const got = fs.readFileSync(out);
            assert.equal(got.length, payload.length);
            assert.equal(sha256(got), sha256(payload));
        } finally {
            await s.close();
        }
    });

    it('memory stays bounded for large stream (approx)', async () => {
        const size = 64 * 1024 * 1024; // 64MB
        const mediaBytes = makeMediaBytes(size);
        const s = await createMockServer({mediaBytes});
        try {
            const out = path.join(tmp, 'big.bin');
            const before = process.memoryUsage().rss;
            await downloadToFile(`${s.baseUrl}/media/full`, out, {
                maxRetries: 2,
                expectedKind: 'attachment',
                deps: deps(s.baseUrl)
            });
            const after = process.memoryUsage().rss;
            const delta = after - before;
            assert.equal(fs.statSync(out).size, size);
            // RSS growth should be far below buffering the whole file
            assert.ok(delta < size * 0.85, `RSS grew too much: ${delta} for file ${size}`);
            // record for report
            fs.writeFileSync(
                path.join(tmp, 'perf-result.json'),
                JSON.stringify({size, deltaRss: delta, before, after, ok: true})
            );
        } finally {
            await s.close();
        }
    });

    it('probeRemoteSize works via HEAD', async () => {
        const mediaBytes = makeMediaBytes(12345);
        const s = await createMockServer({mediaBytes});
        try {
            const info = await probeRemoteSize(`${s.baseUrl}/media/full`, {
                allowPrivateMedia: true,
                trustedOrigin: s.baseUrl
            });
            assert.equal(info.size, 12345);
        } finally {
            await s.close();
        }
    });

    it('chunked transfer without Content-Length succeeds', async () => {
        const mediaBytes = makeMediaBytes(16_384);
        const s = await createMockServer({mediaBytes});
        try {
            const out = path.join(tmp, 'chunked.bin');
            await downloadToFile(`${s.baseUrl}/media/chunked`, out, {
                maxRetries: 2,
                expectedKind: 'attachment',
                deps: deps(s.baseUrl)
            });
            assert.equal(sha256(fs.readFileSync(out)), sha256(mediaBytes));
        } finally {
            await s.close();
        }
    });
});
