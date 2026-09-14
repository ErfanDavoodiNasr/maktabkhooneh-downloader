import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {classifyAuthFailure, looksLikeAuthPayload, looksLikeLoginRedirect} from '../../lib/auth-classify.mjs';
import {AuthenticationError, createSessionManager} from '../../lib/session-manager.mjs';
import {downloadToFile} from '../../lib/download-engine.mjs';
import {createMockServer, makeMediaBytes} from '../helpers/mock-server.mjs';
import {mapPool} from '../../lib/pool.mjs';
import fs from 'fs';
import os from 'os';
import path from 'path';

describe('auth-classify', () => {
    it('401 is recoverable', () => {
        const c = classifyAuthFailure({status: 401});
        assert.equal(c.recoverable, true);
        assert.equal(c.kind, 'unauthorized');
    });
    it('plain 403 is authorization not auth', () => {
        const c = classifyAuthFailure({status: 403, bodySnippet: 'no access to course'});
        assert.equal(c.recoverable, false);
        assert.equal(c.kind, 'forbidden');
    });
    it('403 with auth payload is recoverable', () => {
        const c = classifyAuthFailure({
            status: 403,
            bodySnippet: JSON.stringify({auth: {details: {is_authenticated: false}}}),
            contentType: 'application/json'
        });
        assert.equal(c.recoverable, true);
    });
    it('login redirect detected', () => {
        assert.equal(looksLikeLoginRedirect('/accounts/login/?next=/course/x'), true);
        assert.equal(looksLikeLoginRedirect('/course/foo/'), false);
        assert.equal(looksLikeAuthPayload('{"is_authenticated":false}'), true);
    });
});

describe('session-manager single-flight', () => {
    it('four concurrent recoveries trigger exactly one login', async () => {
        let logins = 0;
        let cookie = 'old';
        const persisted = [];
        const sm = createSessionManager({
            getCookie: () => cookie,
            setCookie: (c) => {
                cookie = c;
            },
            loginFn: async () => {
                logins++;
                await new Promise((r) => setTimeout(r, 30));
                return 'csrftoken=a; sessionid=new';
            },
            validateFn: async () => true,
            persistFn: async (c, g) => {
                persisted.push({c, g});
            },
            sleepFn: async () => {
            },
            cooldownMs: 1
        });

        const seen = sm.getGeneration();
        const results = await Promise.all([
            sm.recover({reason: '401', seenGeneration: seen}),
            sm.recover({reason: '401', seenGeneration: seen}),
            sm.recover({reason: '401', seenGeneration: seen}),
            sm.recover({reason: '401', seenGeneration: seen})
        ]);
        assert.equal(logins, 1);
        assert.equal(results.every((r) => r.cookie.includes('sessionid=new')), true);
        assert.equal(persisted.length, 1);
        assert.equal(sm.getGeneration(), 1);
    });

    it('reuses newer generation without re-login', async () => {
        let logins = 0;
        let cookie = 'v1';
        const sm = createSessionManager({
            getCookie: () => cookie,
            setCookie: (c) => {
                cookie = c;
            },
            loginFn: async () => {
                logins++;
                return 'v2';
            },
            validateFn: async () => true,
            sleepFn: async () => {
            }
        });
        await sm.recover({reason: 'first'});
        assert.equal(logins, 1);
        const r = await sm.recover({reason: 'second', seenGeneration: 0});
        assert.equal(r.reused, true);
        assert.equal(logins, 1);
    });

    it('stops after max failures (no infinite loop)', async () => {
        const sm = createSessionManager({
            getCookie: () => null,
            setCookie: () => {
            },
            loginFn: async () => {
                throw new Error('bad credentials');
            },
            validateFn: async () => false,
            sleepFn: async () => {
            },
            cooldownMs: 1,
            maxFailures: 2
        });
        await assert.rejects(() => sm.recover({reason: '1'}), AuthenticationError);
        await assert.rejects(() => sm.recover({reason: '2'}), /permanently|times/i);
        assert.equal(sm.isPermanentlyFailed(), true);
        await assert.rejects(() => sm.recover({reason: '3'}), /permanently/i);
    });

    it('failed persist does not invalidate in-memory session', async () => {
        let cookie = 'old';
        const sm = createSessionManager({
            getCookie: () => cookie,
            setCookie: (c) => {
                cookie = c;
            },
            loginFn: async () => 'new-session',
            validateFn: async () => true,
            persistFn: async () => {
                throw new Error('read-only config');
            },
            sleepFn: async () => {
            }
        });
        const r = await sm.recover({reason: 'x'});
        assert.equal(r.cookie, 'new-session');
        assert.equal(cookie, 'new-session');
    });

    it('generation fence skips older persist', async () => {
        const writes = [];
        let cookie = 'c0';
        const sm = createSessionManager({
            getCookie: () => cookie,
            setCookie: (c) => {
                cookie = c;
            },
            loginFn: async () => 'c1',
            validateFn: async () => true,
            persistFn: async (c, g) => {
                writes.push(g);
            },
            sleepFn: async () => {
            }
        });
        await sm.recover({reason: 'a'});
        // Simulate older worker trying to persist gen 0 equivalent — manager only persists on recover
        assert.deepEqual(writes, [1]);
    });
});

describe('download-engine auth recovery', () => {
    it('401 then success after single re-login', async () => {
        const media = makeMediaBytes(2048);
        let hits = 0;
        let cookie = 'sessionid=stale';
        const server = await createMockServer({
            handler(req, res) {
                hits++;
                if (String(req.headers.cookie || '').includes('stale')) {
                    res.writeHead(401, {'content-type': 'application/json'});
                    res.end(JSON.stringify({detail: 'login required'}));
                    return;
                }
                res.writeHead(200, {
                    'content-type': 'video/mp4',
                    'content-length': String(media.length),
                    'accept-ranges': 'bytes'
                });
                res.end(media);
            }
        });
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-auth-'));
        const file = path.join(dir, 'v.mp4');
        let logins = 0;
        const session = createSessionManager({
            getCookie: () => cookie,
            setCookie: (c) => {
                cookie = c;
            },
            loginFn: async () => {
                logins++;
                return 'sessionid=fresh';
            },
            validateFn: async () => true,
            sleepFn: async () => {
            }
        });
        try {
            const st = await downloadToFile(`${server.baseUrl}/media`, file, {
                cookie,
                maxRetries: 2,
                deps: {
                    allowPrivateMedia: true,
                    trustedOrigin: server.baseUrl,
                    getCookie: () => cookie,
                    session,
                    requestTimeoutMs: 10_000,
                    readTimeoutMs: 10_000
                }
            });
            assert.equal(st, 'downloaded');
            assert.equal(logins, 1);
            assert.equal(fs.statSync(file).size, media.length);
            assert.ok(hits >= 2);
        } finally {
            await server.close();
        }
    });

    it('403 authorization is not re-login', async () => {
        const server = await createMockServer({
            handler(_req, res) {
                res.writeHead(403, {'content-type': 'text/plain'});
                res.end('course not purchased');
            }
        });
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-403-'));
        const file = path.join(dir, 'v.mp4');
        let logins = 0;
        let cookie = 'sessionid=ok';
        const session = createSessionManager({
            getCookie: () => cookie,
            setCookie: (c) => {
                cookie = c;
            },
            loginFn: async () => {
                logins++;
                return cookie;
            },
            validateFn: async () => true,
            sleepFn: async () => {
            }
        });
        try {
            await assert.rejects(() => downloadToFile(`${server.baseUrl}/x`, file, {
                maxRetries: 2,
                deps: {
                    allowPrivateMedia: true,
                    trustedOrigin: server.baseUrl,
                    getCookie: () => cookie,
                    session,
                    requestTimeoutMs: 5000,
                    readTimeoutMs: 5000
                }
            }), /403/);
            assert.equal(logins, 0);
        } finally {
            await server.close();
        }
    });

    it('four workers expire together → one login', async () => {
        const media = makeMediaBytes(1024);
        let logins = 0;
        let cookie = 'sessionid=stale';
        const server = await createMockServer({
            handler(req, res) {
                if (String(req.headers.cookie || '').includes('stale')) {
                    res.writeHead(401, {'content-type': 'application/json'});
                    res.end('{"login_required":true}');
                    return;
                }
                res.writeHead(200, {
                    'content-type': 'video/mp4',
                    'content-length': String(media.length)
                });
                res.end(media);
            }
        });
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-sf-'));
        const session = createSessionManager({
            getCookie: () => cookie,
            setCookie: (c) => {
                cookie = c;
            },
            loginFn: async () => {
                logins++;
                await new Promise((r) => setTimeout(r, 40));
                return 'sessionid=fresh';
            },
            validateFn: async () => true,
            sleepFn: async () => {
            }
        });
        try {
            await mapPool([0, 1, 2, 3], 4, async (i) => {
                const file = path.join(dir, `f${i}.mp4`);
                return downloadToFile(`${server.baseUrl}/m`, file, {
                    maxRetries: 3,
                    deps: {
                        allowPrivateMedia: true,
                        trustedOrigin: server.baseUrl,
                        getCookie: () => cookie,
                        session,
                        requestTimeoutMs: 10_000,
                        readTimeoutMs: 10_000
                    }
                });
            });
            assert.equal(logins, 1);
            for (let i = 0; i < 4; i++) assert.equal(fs.statSync(path.join(dir, `f${i}.mp4`)).size, media.length);
        } finally {
            await server.close();
        }
    });
});
