/**
 * Local HTTP mock for download / auth / media edge cases.
 * Ephemeral port; no external network.
 */
import http from 'http';
import {URL} from 'url';

/** Deterministic payload of N bytes (repeating pattern). */
export function makeMediaBytes(n, pattern = 'MKD-MEDIA-') {
    const seed = Buffer.from(pattern);
    const out = Buffer.alloc(n);
    for (let i = 0; i < n; i++) out[i] = seed[i % seed.length];
    return out;
}

/**
 * @param {object} [options]
 * @param {(req:http.IncomingMessage, res:http.ServerResponse, ctx:object)=>void|Promise<void>} [options.handler]
 * @param {Buffer} [options.mediaBytes]
 * @returns {Promise<{baseUrl:string, port:number, close:()=>Promise<void>, requests:object[], setHandler:Function, mediaBytes:Buffer}>}
 */
export function createMockServer(options = {}) {
    const mediaBytes = options.mediaBytes || makeMediaBytes(options.mediaSize ?? 64 * 1024);
    const requests = [];
    let handler = options.handler || defaultHandler;

    function defaultHandler(req, res, ctx) {
        const u = new URL(req.url || '/', ctx.baseUrl);
        const path = u.pathname;

        if (path === '/auth/ok') {
            res.writeHead(200, {'content-type': 'application/json'});
            res.end(JSON.stringify({ok: true}));
            return;
        }
        if (path === '/auth/fail') {
            res.writeHead(401, {'content-type': 'application/json'});
            res.end(JSON.stringify({ok: false}));
            return;
        }
        if (path === '/outline/classic') {
            res.writeHead(200, {'content-type': 'application/json'});
            res.end(JSON.stringify({chapters: ctx.classicChapters || []}));
            return;
        }
        if (path === '/outline/lms') {
            res.writeHead(200, {'content-type': 'application/json'});
            res.end(JSON.stringify({chapters: ctx.lmsChapters || []}));
            return;
        }
        if (path.startsWith('/media/')) {
            return serveMedia(req, res, path.slice('/media/'.length), ctx);
        }
        if (path.startsWith('/head/')) {
            return serveHead(req, res, path.slice('/head/'.length));
        }
        if (path.startsWith('/redirect/')) {
            return serveRedirect(req, res, path, u, ctx);
        }
        res.writeHead(404, {'content-type': 'text/plain'});
        res.end('not found');
    }

    function serveHead(req, res, kind) {
        const map = {
            '200': 200,
            '403': 403,
            '404': 404,
            '405': 405,
            '500': 500
        };
        const status = map[kind] ?? 404;
        if (req.method === 'HEAD') {
            const headers = {'content-type': 'video/mp4'};
            if (status === 200) {
                headers['content-length'] = String(mediaBytes.length);
                headers['accept-ranges'] = 'bytes';
            }
            res.writeHead(status, headers);
            res.end();
            return;
        }
        if (status === 200) {
            res.writeHead(200, {
                'content-type': 'video/mp4',
                'content-length': String(mediaBytes.length),
                'accept-ranges': 'bytes'
            });
            res.end(mediaBytes);
            return;
        }
        res.writeHead(status, {'content-type': 'text/plain', 'content-length': '0'});
        res.end();
    }

    function serveRedirect(req, res, path, u, ctx) {
        // /redirect/same -> /media/full
        // /redirect/cross?to=http://other/media/full
        if (path === '/redirect/same') {
            res.writeHead(302, {location: '/media/full'});
            res.end();
            return;
        }
        if (path === '/redirect/cross') {
            const to = u.searchParams.get('to') || '/';
            res.writeHead(302, {location: to});
            res.end();
            return;
        }
        if (path === '/redirect/chain') {
            res.writeHead(302, {location: '/redirect/same'});
            res.end();
            return;
        }
        res.writeHead(404);
        res.end();
    }

    function serveMedia(req, res, kind, ctx) {
        const range = req.headers.range;
        const bytes = ctx.mediaBytes;

        if (kind === 'html-as-video') {
            const body = Buffer.from('<!DOCTYPE html><html><body>login csrf session</body></html>');
            res.writeHead(200, {
                'content-type': 'text/html; charset=utf-8',
                'content-length': String(body.length)
            });
            res.end(body);
            return;
        }
        if (kind === 'json-as-video') {
            const body = Buffer.from(JSON.stringify({error: 'not a video'}));
            res.writeHead(200, {
                'content-type': 'application/json',
                'content-length': String(body.length)
            });
            res.end(body);
            return;
        }
        if (kind === '429') {
            res.writeHead(429, {'retry-after': '1', 'content-type': 'text/plain'});
            res.end('rate limited');
            return;
        }
        if (kind === '503') {
            res.writeHead(503, {'content-type': 'text/plain'});
            res.end('unavailable');
            return;
        }
        if (kind === '500') {
            res.writeHead(500, {'content-type': 'text/plain'});
            res.end('error');
            return;
        }
        if (kind === '404') {
            res.writeHead(404, {'content-type': 'text/plain'});
            res.end('missing');
            return;
        }
        if (kind === 'ignore-range') {
            // Always 200 full body even when Range present
            res.writeHead(200, {
                'content-type': 'video/mp4',
                'content-length': String(bytes.length),
                'accept-ranges': 'none'
            });
            res.end(bytes);
            return;
        }
        if (kind === 'chunked') {
            res.writeHead(200, {
                'content-type': 'video/mp4',
                'transfer-encoding': 'chunked'
            });
            // send in a few chunks
            const mid = Math.floor(bytes.length / 2);
            res.write(bytes.subarray(0, mid));
            res.write(bytes.subarray(mid));
            res.end();
            return;
        }
        if (kind === 'wrong-length') {
            // Claim more bytes than we send, then hard-close so clients observe truncation.
            res.writeHead(200, {
                'content-type': 'video/mp4',
                'content-length': String(bytes.length + 1000)
            });
            res.write(bytes);
            req.socket.destroy();
            return;
        }
        if (kind === 'slow') {
            const delay = Number(ctx.slowDelayMs ?? 50);
            res.writeHead(200, {
                'content-type': 'video/mp4',
                'content-length': String(bytes.length)
            });
            let offset = 0;
            const chunk = 1024;
            const tick = () => {
                if (offset >= bytes.length) {
                    res.end();
                    return;
                }
                const end = Math.min(offset + chunk, bytes.length);
                res.write(bytes.subarray(offset, end));
                offset = end;
                setTimeout(tick, delay);
            };
            tick();
            return;
        }
        if (kind === 'stall') {
            res.writeHead(200, {
                'content-type': 'video/mp4',
                'content-length': String(bytes.length)
            });
            res.write(bytes.subarray(0, 16));
            // never finish — caller aborts / times out
            return;
        }
        if (kind === 'reset') {
            res.writeHead(200, {
                'content-type': 'video/mp4',
                'content-length': String(bytes.length)
            });
            res.write(bytes.subarray(0, 32));
            req.socket.destroy();
            return;
        }
        if (kind === 'attachment') {
            const name = ctx.attachmentName || 'notes.pdf';
            const body = Buffer.from('%PDF-1.4 mock');
            res.writeHead(200, {
                'content-type': 'application/pdf',
                'content-disposition': `attachment; filename="${name}"`,
                'content-length': String(body.length)
            });
            res.end(body);
            return;
        }
        if (kind === 'subtitle') {
            const body = Buffer.from('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nhi\n');
            res.writeHead(200, {
                'content-type': 'text/vtt',
                'content-length': String(body.length)
            });
            res.end(body);
            return;
        }
        if (kind === '416') {
            res.writeHead(416, {
                'content-range': `bytes */${bytes.length}`
            });
            res.end();
            return;
        }

        // full / range-aware default
        if (range && /^bytes=(\d+)-(\d*)$/i.test(range)) {
            const m = range.match(/^bytes=(\d+)-(\d*)$/i);
            const start = Number.parseInt(m[1], 10);
            let end = m[2] ? Number.parseInt(m[2], 10) : bytes.length - 1;
            if (start >= bytes.length) {
                res.writeHead(416, {'content-range': `bytes */${bytes.length}`});
                res.end();
                return;
            }
            end = Math.min(end, bytes.length - 1);
            const slice = bytes.subarray(start, end + 1);
            res.writeHead(206, {
                'content-type': 'video/mp4',
                'content-length': String(slice.length),
                'content-range': `bytes ${start}-${end}/${bytes.length}`,
                'accept-ranges': 'bytes'
            });
            res.end(slice);
            return;
        }

        res.writeHead(200, {
            'content-type': 'video/mp4',
            'content-length': String(bytes.length),
            'accept-ranges': 'bytes'
        });
        res.end(bytes);
    }

    const ctx = {
        mediaBytes,
        classicChapters: options.classicChapters,
        lmsChapters: options.lmsChapters,
        slowDelayMs: options.slowDelayMs,
        attachmentName: options.attachmentName,
        get baseUrl() {
            return serverBaseUrl;
        }
    };

    let serverBaseUrl = '';

    const server = http.createServer(async (req, res) => {
        const entry = {
            method: req.method,
            url: req.url,
            headers: {...req.headers},
            cookie: req.headers.cookie || null,
            bytesSent: 0
        };
        requests.push(entry);
        const origWrite = res.write.bind(res);
        const origEnd = res.end.bind(res);
        res.write = (chunk, ...rest) => {
            if (chunk) entry.bytesSent += Buffer.byteLength(chunk);
            return origWrite(chunk, ...rest);
        };
        res.end = (chunk, ...rest) => {
            if (chunk) entry.bytesSent += Buffer.byteLength(chunk);
            return origEnd(chunk, ...rest);
        };
        try {
            await handler(req, res, ctx);
        } catch (e) {
            if (!res.headersSent) res.writeHead(500);
            res.end(String(e?.message || e));
        }
    });

    return new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            const port = addr.port;
            serverBaseUrl = `http://127.0.0.1:${port}`;
            resolve({
                baseUrl: serverBaseUrl,
                port,
                requests,
                mediaBytes,
                setHandler(fn) {
                    handler = fn || defaultHandler;
                },
                close() {
                    return new Promise((res, rej) => {
                        server.close((err) => (err ? rej(err) : res()));
                    });
                }
            });
        });
        server.on('error', reject);
    });
}
