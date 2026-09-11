import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {createMockServer, makeMediaBytes} from '../helpers/mock-server.mjs';
import {downloadToFile} from '../../lib/download-engine.mjs';

describe('fault-injection', () => {
    it('429 / 503 are retried then succeed', async () => {
        const mediaBytes = makeMediaBytes(4096);
        let hits = 0;
        const server = await createMockServer({mediaBytes});
        try {
            server.setHandler((req, res, ctx) => {
                hits++;
                if (hits === 1) {
                    res.writeHead(429, {'retry-after': '0'});
                    res.end('slow down');
                    return;
                }
                if (hits === 2) {
                    res.writeHead(503);
                    res.end('busy');
                    return;
                }
                res.writeHead(200, {
                    'content-type': 'video/mp4',
                    'content-length': String(ctx.mediaBytes.length)
                });
                res.end(ctx.mediaBytes);
            });

            const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-fault-')), 'v.mp4');
            let sleeps = 0;
            await downloadToFile(`${server.baseUrl}/x`, out, {
                maxRetries: 5,
                deps: {
                    trustedOrigin: server.baseUrl,
                    allowPrivateMedia: true,
                    sleepFn: async () => {
                        sleeps++;
                    },
                    backoffMs: () => 0,
                    requestTimeoutMs: 5000,
                    readTimeoutMs: 5000
                }
            });
            assert.ok(hits >= 3);
            assert.ok(sleeps >= 2);
            assert.equal(fs.statSync(out).size, mediaBytes.length);
        } finally {
            await server.close();
        }
    });

    it('permanent 404 is not retried endlessly', async () => {
        const server = await createMockServer({mediaBytes: makeMediaBytes(100)});
        try {
            let hits = 0;
            server.setHandler((req, res) => {
                hits++;
                res.writeHead(404);
                res.end('gone');
            });
            const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-404-')), 'v.mp4');
            await assert.rejects(
                () => downloadToFile(`${server.baseUrl}/missing`, out, {
                    maxRetries: 6,
                    deps: {
                        trustedOrigin: server.baseUrl,
                        allowPrivateMedia: true,
                        sleepFn: async () => {
                        },
                        backoffMs: () => 0
                    }
                }),
                /404/
            );
            assert.equal(hits, 1);
        } finally {
            await server.close();
        }
    });

    it('connection reset style via destroying socket is retried', async () => {
        const mediaBytes = makeMediaBytes(8192);
        let hits = 0;
        const server = await createMockServer({mediaBytes});
        try {
            server.setHandler((req, res, ctx) => {
                hits++;
                if (hits === 1) {
                    res.writeHead(200, {
                        'content-type': 'video/mp4',
                        'content-length': String(ctx.mediaBytes.length)
                    });
                    res.write(ctx.mediaBytes.subarray(0, 64));
                    setImmediate(() => req.socket.destroy());
                    return;
                }
                res.writeHead(200, {
                    'content-type': 'video/mp4',
                    'content-length': String(ctx.mediaBytes.length)
                });
                res.end(ctx.mediaBytes);
            });

            const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-reset-')), 'v.mp4');
            await downloadToFile(`${server.baseUrl}/reset`, out, {
                maxRetries: 4,
                deps: {
                    trustedOrigin: server.baseUrl,
                    allowPrivateMedia: true,
                    sleepFn: async () => {
                    },
                    backoffMs: () => 0,
                    requestTimeoutMs: 5000,
                    readTimeoutMs: 5000
                }
            });
            assert.ok(hits >= 2);
            assert.equal(fs.statSync(out).size, mediaBytes.length);
        } finally {
            await server.close();
        }
    });
});
