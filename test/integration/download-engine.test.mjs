import {after, before, describe, it} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {createMockServer, makeMediaBytes} from '../helpers/mock-server.mjs';
import {buildAuthAwareHeaders, downloadToFile, probeRemoteSize} from '../../lib/download-engine.mjs';

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

describe('download-engine integration', () => {
    let server;
    let mediaBytes;
    let trustedOrigin;
    let tmpRoot;

    before(async () => {
        mediaBytes = makeMediaBytes(32 * 1024);
        server = await createMockServer({mediaBytes});
        trustedOrigin = server.baseUrl;
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-dl-'));
    });

    after(async () => {
        await server.close();
    });

    function deps(extra = {}) {
        return {
            trustedOrigin,
            allowPrivateMedia: true,
            sleepFn: async () => {
            },
            backoffMs: () => 0,
            ...extra
        };
    }

    it('full download matches SHA-256', async () => {
        const out = path.join(fs.mkdtempSync(path.join(tmpRoot, 'full-')), 'v.mp4');
        const status = await downloadToFile(`${server.baseUrl}/media/full`, out, {
            cookie: 'sessionid=abc',
            maxRetries: 2,
            deps: deps()
        });
        assert.equal(status, 'downloaded');
        assert.equal(sha256(fs.readFileSync(out)), sha256(mediaBytes));
    });

    it('sample-bytes limits output', async () => {
        const out = path.join(fs.mkdtempSync(path.join(tmpRoot, 'sample-')), 'v.mp4');
        await downloadToFile(`${server.baseUrl}/media/full`, out, {
            sampleBytes: 1000,
            deps: deps()
        });
        assert.equal(fs.statSync(out).size, 1000);
    });


    it('sample re-downloads when existing sample is smaller than requested', async () => {
        const out = path.join(fs.mkdtempSync(path.join(tmpRoot, 'sample-up-')), 'v.mp4');
        fs.writeFileSync(out, Buffer.alloc(100, 1));
        await downloadToFile(`${server.baseUrl}/media/full`, out, {
            sampleBytes: 1000,
            deps: deps()
        });
        assert.equal(fs.statSync(out).size, 1000);
    });

    it('resumes from .part', async () => {
        const dir = fs.mkdtempSync(path.join(tmpRoot, 'resume-'));
        const out = path.join(dir, 'v.mp4');
        const part = `${out}.part`;
        const half = Math.floor(mediaBytes.length / 2);
        fs.writeFileSync(part, mediaBytes.subarray(0, half));
        await downloadToFile(`${server.baseUrl}/media/full`, out, {
            maxRetries: 3,
            deps: deps()
        });
        assert.equal(sha256(fs.readFileSync(out)), sha256(mediaBytes));
        assert.ok(!fs.existsSync(part));
    });

    it('server ignore-range must not corrupt', async () => {
        const dir = fs.mkdtempSync(path.join(tmpRoot, 'ign-'));
        const out = path.join(dir, 'v.mp4');
        const part = `${out}.part`;
        fs.writeFileSync(part, mediaBytes.subarray(0, 500));
        // probe will see accept-ranges none via HEAD? Our ignore-range path is GET only.
        // Seed remoteInfo by custom deps probe — engine probes when part exists.
        // When acceptRanges false, engine deletes part and restarts.
        // For ignore-range URL, HEAD isn't used on that path; probe uses HEAD /media/ignore-range
        // which falls through to full media with accept-ranges bytes. So override via setHandler?
        // Simpler: use ignore-range and when resume gets 200 (not 206), engine restarts.
        await downloadToFile(`${server.baseUrl}/media/ignore-range`, out, {
            maxRetries: 4,
            deps: deps()
        });
        assert.equal(sha256(fs.readFileSync(out)), sha256(mediaBytes));
        assert.equal(fs.statSync(out).size, mediaBytes.length);
    });

    it('416 restarts then succeeds on next attempt against full', async () => {
        // First request to 416 endpoint fails; we use a counter handler
        let hits = 0;
        const custom = await createMockServer({mediaBytes});
        custom.setHandler((req, res, ctx) => {
            hits++;
            if (hits === 1) {
                res.writeHead(416, {'content-range': `bytes */${ctx.mediaBytes.length}`});
                res.end();
                return;
            }
            // serve full
            const bytes = ctx.mediaBytes;
            res.writeHead(200, {
                'content-type': 'video/mp4',
                'content-length': String(bytes.length),
                'accept-ranges': 'bytes'
            });
            res.end(bytes);
        });
        const out = path.join(fs.mkdtempSync(path.join(tmpRoot, '416-')), 'v.mp4');
        // Create oversized part so 416 path triggers restart logic
        fs.writeFileSync(`${out}.part`, Buffer.alloc(10));
        await downloadToFile(`${custom.baseUrl}/x`, out, {
            maxRetries: 4,
            deps: {
                trustedOrigin: custom.baseUrl,
                allowPrivateMedia: true,
                sleepFn: async () => {
                },
                backoffMs: () => 0
            }
        });
        assert.equal(sha256(fs.readFileSync(out)), sha256(mediaBytes));
        await custom.close();
    });

    it('rejects HTML-as-mp4', async () => {
        const out = path.join(fs.mkdtempSync(path.join(tmpRoot, 'html-')), 'v.mp4');
        await assert.rejects(
            () => downloadToFile(`${server.baseUrl}/media/html-as-video`, out, {
                maxRetries: 1,
                deps: deps()
            }),
            /HTML|Refusing/i
        );
    });

    it('chunked transfer without Content-Length', async () => {
        const out = path.join(fs.mkdtempSync(path.join(tmpRoot, 'chunk-')), 'v.mp4');
        await downloadToFile(`${server.baseUrl}/media/chunked`, out, {
            maxRetries: 2,
            deps: deps()
        });
        assert.equal(sha256(fs.readFileSync(out)), sha256(mediaBytes));
    });

    it('wrong Content-Length truncated fails size check', async () => {
        const out = path.join(fs.mkdtempSync(path.join(tmpRoot, 'wlen-')), 'v.mp4');
        // Synthetic Response: Content-Length lies; body ends early (no hang on undici wait).
        const fetchFn = async () => {
            const stream = new ReadableStream({
                start(controller) {
                    controller.enqueue(mediaBytes);
                    controller.close();
                }
            });
            return new Response(stream, {
                status: 200,
                headers: {
                    'content-type': 'video/mp4',
                    'content-length': String(mediaBytes.length + 1000)
                }
            });
        };
        await assert.rejects(
            () => downloadToFile(`${server.baseUrl}/media/full`, out, {
                maxRetries: 1,
                deps: deps({fetchFn, requestTimeoutMs: 5000})
            }),
            /mismatch/i
        );
    });

    it('cookie NOT sent to foreign media host', async () => {
        const media = await createMockServer({mediaBytes});
        const auth = await createMockServer({mediaBytes});
        const out = path.join(fs.mkdtempSync(path.join(tmpRoot, 'xori-')), 'v.mp4');
        await downloadToFile(`${media.baseUrl}/media/full`, out, {
            cookie: 'sessionid=SHOULD_NOT_LEAK',
            maxRetries: 2,
            deps: {
                trustedOrigin: auth.baseUrl,
                allowPrivateMedia: true,
                sleepFn: async () => {
                },
                backoffMs: () => 0
            }
        });
        const mediaReqs = media.requests.filter((r) => r.url?.includes('/media/'));
        assert.ok(mediaReqs.length >= 1);
        for (const r of mediaReqs) {
            assert.equal(r.cookie, null);
            assert.ok(!r.headers.cookie);
        }
        await media.close();
        await auth.close();
    });

    it('HEAD probe fallbacks', async () => {
        const ok = await probeRemoteSize(`${server.baseUrl}/head/200`, {
            fetchFn: async (url, init) => fetch(url, init),
            trustedOrigin,
            allowPrivateMedia: true,
            requestTimeoutMs: 5000
        });
        assert.equal(ok.size, mediaBytes.length);
        assert.equal(ok.acceptRanges, true);

        const denied = await probeRemoteSize(`${server.baseUrl}/head/403`, {
            fetchFn: async (url, init) => fetch(url, init),
            trustedOrigin,
            allowPrivateMedia: true,
            requestTimeoutMs: 5000
        });
        // falls back to range GET on /head/403 which returns 403 — size undefined
        assert.equal(denied.size, undefined);
    });

    it('buildAuthAwareHeaders respects origin', () => {
        const withAuth = buildAuthAwareHeaders({
            cookie: 'sessionid=x',
            url: `${trustedOrigin}/api`,
            trustedOrigin
        });
        assert.equal(withAuth.cookie, 'sessionid=x');
        const noAuth = buildAuthAwareHeaders({
            cookie: 'sessionid=x',
            url: 'https://cdn.example.com/v.mp4',
            trustedOrigin
        });
        assert.equal(noAuth.cookie, undefined);
    });
});
