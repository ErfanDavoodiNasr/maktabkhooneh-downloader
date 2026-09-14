/**
 * Streaming download engine with resume safety, HTML rejection, and size checks.
 */
import fs from 'fs';
import path from 'path';
import {Readable, Transform} from 'stream';
import {pipeline} from 'stream/promises';
import {
    assertSafeMediaUrl,
    isRetriableNetworkError,
    isRetriableStatus,
    parseContentRange,
    parseRetryAfterMs,
    redactUrl,
    shouldAttachAuth,
    toBackoffMs,
    TRUSTED_ORIGIN
} from './http-util.mjs';
import {assertFinalSize, validateMediaResponse} from './content-validate.mjs';
import {assertOutputPathSafe} from './paths.mjs';
import {setTimeout as sleep} from 'timers/promises';
import {ScheduleStoppedError} from './schedule.mjs';
import {classifyAuthFailure} from './auth-classify.mjs';

/**
 * @typedef {object} DownloadDeps
 * @property {(url:string, init:RequestInit, timeoutMs?:number)=>Promise<Response>} fetchFn
 * @property {(attempt:number)=>number} [backoffMs]
 * @property {(ms:number)=>Promise<void>} [sleepFn]
 * @property {(msg:string)=>void} [onWarn]
 * @property {(msg:string)=>void} [onProgress]
 * @property {string} [trustedOrigin]
 * @property {number} [requestTimeoutMs]
 * @property {number} [readTimeoutMs]
 * @property {boolean} [allowPrivateMedia]
 * @property {AbortSignal} [signal]
 * @property {{assertAllowed?:()=>void, shouldContinue?:()=>boolean}} [scheduleGate]
 */

function defaultFetch(url, init, timeoutMs = 30_000) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const parent = init.signal;
    if (parent) {
        if (parent.aborted) controller.abort();
        else parent.addEventListener('abort', () => controller.abort(), {once: true});
    }
    return fetch(url, {...init, signal: controller.signal}).finally(() => clearTimeout(t));
}

function mergeSignals(...signals) {
    const list = signals.filter(Boolean);
    if (list.length === 0) return undefined;
    if (list.length === 1) return list[0];
    const ac = new AbortController();
    for (const s of list) {
        if (s.aborted) {
            ac.abort(s.reason);
            return ac.signal;
        }
        s.addEventListener('abort', () => ac.abort(s.reason), {once: true});
    }
    return ac.signal;
}

export function buildAuthAwareHeaders({cookie, referer, accept, trustedOrigin = TRUSTED_ORIGIN, url} = {}) {
    /** @type {Record<string,string>} */
    const headers = {
        accept: accept || '*/*',
        'accept-language': 'en-US,en;q=0.9,fa;q=0.8',
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36'
    };
    if (referer) {
        try {
            headers.referer = new URL(String(referer), trustedOrigin).href;
        } catch {
            // skip bad referer
        }
    }
    const attach = url ? shouldAttachAuth(url, trustedOrigin) : true;
    if (attach && cookie && cookie !== 'PUT_YOUR_COOKIE_HERE') {
        headers.cookie = cookie;
        headers['x-requested-with'] = 'XMLHttpRequest';
    }
    return headers;
}

export async function probeRemoteSize(url, {
    cookie,
    referer,
    fetchFn = defaultFetch,
    retries = 3,
    requestTimeoutMs = 30_000,
    trustedOrigin = TRUSTED_ORIGIN,
    allowPrivateMedia = false,
    signal = null,
    scheduleGate = null
} = {}) {
    scheduleGate?.assertAllowed?.();
    assertSafeMediaUrl(url, {allowPrivate: allowPrivateMedia || shouldAttachAuth(url, trustedOrigin)});
    const headers = buildAuthAwareHeaders({cookie, referer, url, trustedOrigin});

    try {
        const res = await fetchFn(url, {method: 'HEAD', headers, redirect: 'manual', signal}, requestTimeoutMs);
        // Do not follow cross-origin redirects with auth; probe without cookies after hop is caller's job.
        if (res.status >= 300 && res.status < 400) {
            const loc = res.headers.get('location');
            if (loc) {
                const next = new URL(loc, url).toString();
                return probeRemoteSize(next, {
                    cookie: shouldAttachAuth(next, trustedOrigin) ? cookie : null,
                    referer,
                    fetchFn,
                    retries,
                    requestTimeoutMs,
                    trustedOrigin,
                    allowPrivateMedia,
                    signal,
                    scheduleGate
                });
            }
        }
        if (res.ok) {
            const len = res.headers.get('content-length');
            const size = len != null && /^\d+$/.test(len) ? Number.parseInt(len, 10) : undefined;
            const acceptRanges = (res.headers.get('accept-ranges') || '').toLowerCase().includes('bytes');
            return {size, acceptRanges};
        }
    } catch {
        // fall through
    }

    try {
        scheduleGate?.assertAllowed?.();
        const res = await fetchFn(url, {
            method: 'GET',
            headers: {...headers, range: 'bytes=0-0'},
            redirect: 'follow',
            signal
        }, requestTimeoutMs);
        if (res.status === 206) {
            const parsed = parseContentRange(res.headers.get('content-range'));
            const size = parsed?.total != null ? parsed.total : undefined;
            try {
                if (res.body) Readable.fromWeb(res.body).resume();
            } catch {
                // ignore
            }
            return {size, acceptRanges: true};
        }
        try {
            if (res.body) {
                // Cancel unread error bodies so undici does not emit delayed "terminated".
                if (typeof res.body.cancel === 'function') await res.body.cancel();
                else Readable.fromWeb(res.body).resume();
            }
        } catch {
            // ignore
        }
    } catch {
        // ignore
    }
    return {size: undefined, acceptRanges: false};
}

/**
 * Download URL to filePath using .part then atomic rename.
 * Returns 'downloaded' | 'exists' | 'deferred'
 */
export async function downloadToFile(url, filePath, {
    cookie = null,
    referer = null,
    maxRetries = 4,
    sampleBytes = 0,
    label = '',
    expectedKind = 'video',
    outputRoot = null,
    deps = {}
} = {}) {
    const {
        fetchFn = defaultFetch,
        backoffMs = toBackoffMs,
        sleepFn = sleep,
        onWarn = () => {
        },
        onProgress = () => {
        },
        trustedOrigin = TRUSTED_ORIGIN,
        requestTimeoutMs = 30_000,
        readTimeoutMs = 120_000,
        allowPrivateMedia = false,
        signal = null,
        scheduleGate = null,
        getCookie = null,
        session = null
    } = deps;

    const currentCookie = () => (typeof getCookie === 'function' ? getCookie() : cookie);

    const throwIfAborted = () => {
        if (signal?.aborted) {
            const err = new Error('Download cancelled');
            err.code = 'INTERRUPTED';
            throw err;
        }
    };

    throwIfAborted();
    scheduleGate?.assertAllowed?.();

    assertSafeMediaUrl(url, {
        allowPrivate: allowPrivateMedia || shouldAttachAuth(url, trustedOrigin)
    });
    if (outputRoot) assertOutputPathSafe(outputRoot, filePath);

    let existingFinalSize = 0;
    try {
        existingFinalSize = fs.statSync(filePath).size;
        // Sample mode: only skip if we already have at least the requested bytes
        if (sampleBytes > 0 && existingFinalSize >= sampleBytes) return 'exists';
    } catch {
        // missing
    }

    const tmpPath = `${filePath}.part`;
    let existingTmpSize = 0;
    try {
        existingTmpSize = fs.statSync(tmpPath).size;
    } catch {
        // missing
    }

    let remoteInfo;
    if (sampleBytes === 0 && existingFinalSize > 0) {
        remoteInfo = await probeRemoteSize(url, {
            cookie: currentCookie(),
            referer,
            fetchFn,
            requestTimeoutMs,
            trustedOrigin,
            allowPrivateMedia,
            signal,
            scheduleGate
        });
        if (remoteInfo.size != null && existingFinalSize === remoteInfo.size) {
            return 'exists';
        }
        // Wrong size final file: move aside into .part for resume/restart
        if (remoteInfo.size != null && existingFinalSize !== remoteInfo.size) {
            try {
                await fs.promises.rename(filePath, tmpPath);
                existingTmpSize = existingFinalSize;
                existingFinalSize = 0;
            } catch {
                // ignore
            }
        }
    }

    let authRecoveredOnce = false;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            throwIfAborted();
            scheduleGate?.assertAllowed?.();

            let resumeOffset = 0;
            if (sampleBytes > 0) {
                resumeOffset = 0;
            } else if (existingTmpSize > 0) {
                if (!remoteInfo) {
                    remoteInfo = await probeRemoteSize(url, {
                        cookie: currentCookie(),
                        referer,
                        fetchFn,
                        requestTimeoutMs,
                        trustedOrigin,
                        allowPrivateMedia,
                        signal,
                        scheduleGate
                    });
                }
                if (remoteInfo.size != null && existingTmpSize > remoteInfo.size) {
                    // Local partial larger than remote — restart
                    await fs.promises.unlink(tmpPath).catch(() => {
                    });
                    existingTmpSize = 0;
                    resumeOffset = 0;
                } else if (remoteInfo.size != null && existingTmpSize === remoteInfo.size) {
                    await fs.promises.rename(tmpPath, filePath);
                    return 'downloaded';
                } else if (remoteInfo.acceptRanges === false && existingTmpSize > 0) {
                    await fs.promises.unlink(tmpPath).catch(() => {
                    });
                    existingTmpSize = 0;
                    resumeOffset = 0;
                } else {
                    resumeOffset = existingTmpSize;
                }
            }

            const headers = buildAuthAwareHeaders({
                cookie: currentCookie(),
                referer,
                url,
                trustedOrigin,
                accept: expectedKind === 'video' ? 'video/mp4,application/octet-stream,*/*' : '*/*'
            });
            if (sampleBytes > 0) {
                headers.range = `bytes=0-${Math.max(0, sampleBytes - 1)}`;
            } else if (resumeOffset > 0) {
                headers.range = `bytes=${resumeOffset}-`;
            }

            const seenGen = session?.getGeneration?.() ?? null;
            const res = await fetchFn(url, {
                method: 'GET',
                headers,
                redirect: 'follow',
                signal
            }, requestTimeoutMs);

            if (res.status === 416) {
                if (remoteInfo?.size != null && existingTmpSize >= remoteInfo.size) {
                    await fs.promises.rename(tmpPath, filePath);
                    return 'downloaded';
                }
                // Restart
                await fs.promises.unlink(tmpPath).catch(() => {
                });
                existingTmpSize = 0;
                resumeOffset = 0;
                throw new Error('HTTP 416 Range Not Satisfiable; restarting');
            }

            if (!res.ok || !res.body) {
                let bodySnippet = '';
                try {
                    bodySnippet = (await res.text()).slice(0, 512);
                } catch {
                    // ignore
                }
                const cls = (session?.classify || classifyAuthFailure)({
                    status: res.status,
                    location: res.headers.get('location'),
                    bodySnippet,
                    contentType: res.headers.get('content-type') || ''
                });

                if (session && cls.recoverable && !authRecoveredOnce) {
                    onWarn(`Auth challenge during download (${cls.reason}); recovering session…`);
                    await session.recover({reason: cls.reason, seenGeneration: seenGen});
                    authRecoveredOnce = true;
                    // Retry same attempt without consuming a failure slot
                    attempt -= 1;
                    continue;
                }

                const permanent = cls.kind === 'forbidden' ||
                    res.status === 400 || res.status === 404 ||
                    (cls.recoverable && authRecoveredOnce) ||
                    (res.status === 401 && (!session || authRecoveredOnce)) ||
                    (res.status === 403 && !cls.recoverable);
                const err = new Error(`Download failed HTTP ${res.status} for ${redactUrl(url)}`);
                err.status = res.status;
                err.permanent = permanent;
                if (isRetriableStatus(res.status)) {
                    const ms = parseRetryAfterMs(res.headers.get('retry-after'));
                    if (ms != null) err.retryAfterMs = ms;
                }
                throw err;
            }

            // Server ignored Range → must not append
            if (resumeOffset > 0 && res.status !== 206) {
                await fs.promises.unlink(tmpPath).catch(() => {
                });
                existingTmpSize = 0;
                resumeOffset = 0;
                throw new Error('Server did not honor range; restarting from 0');
            }

            const ct = res.headers.get('content-type') || '';
            const precheck = validateMediaResponse({status: res.status, contentType: ct, expectedKind});
            if (!precheck.ok) {
                try {
                    if (res.body) Readable.fromWeb(res.body).resume();
                } catch {
                    // ignore
                }
                const err = new Error(precheck.reason);
                err.permanent = true;
                throw err;
            }

            await fs.promises.mkdir(path.dirname(filePath), {recursive: true});

            if (sampleBytes > 0) {
                const raw = Buffer.from(await res.arrayBuffer());
                const bodyCheck = validateMediaResponse({
                    status: res.status,
                    contentType: ct,
                    firstBytes: raw.subarray(0, Math.min(512, raw.length)),
                    expectedKind
                });
                if (!bodyCheck.ok) {
                    const err = new Error(bodyCheck.reason);
                    err.permanent = true;
                    throw err;
                }
                const out = raw.subarray(0, Math.min(raw.length, sampleBytes));
                if (out.length === 0) {
                    const err = new Error('Unexpected zero-byte sample download');
                    err.permanent = true;
                    throw err;
                }
                const sampleTmp = `${filePath}.part`;
                await fs.promises.writeFile(sampleTmp, out);
                await fs.promises.rename(sampleTmp, filePath);
                onProgress(1, out.length, sampleBytes, label);
                return 'downloaded';
            }

            const contentLengthHeader = res.headers.get('content-length');
            const fullLength = contentLengthHeader && /^\d+$/.test(contentLengthHeader)
                ? Number.parseInt(contentLengthHeader, 10)
                : undefined;
            const cr = parseContentRange(res.headers.get('content-range'));
            let expectedTotal = cr?.total != null ? cr.total
                : (fullLength != null && resumeOffset > 0 ? resumeOffset + fullLength : fullLength);

            // Peek first chunk for HTML signature without buffering whole file
            const readable = Readable.fromWeb(res.body);
            let downloadedBytes = resumeOffset;
            let firstChunkChecked = false;
            let scheduleStop = false;
            let readIdleTimer = null;
            const resetReadTimeout = () => {
                if (readIdleTimer) clearTimeout(readIdleTimer);
                readIdleTimer = setTimeout(() => {
                    try {
                        readable.destroy(new Error(`Read timeout after ${readTimeoutMs}ms`));
                    } catch {
                        // ignore
                    }
                }, readTimeoutMs);
            };
            resetReadTimeout();

            const onAbort = () => {
                try {
                    readable.destroy(new Error('Download cancelled'));
                } catch {
                    // ignore
                }
            };
            if (signal) {
                if (signal.aborted) onAbort();
                else signal.addEventListener('abort', onAbort, {once: true});
            }

            const write = fs.createWriteStream(tmpPath, {flags: resumeOffset === 0 ? 'w' : 'a'});
            const counter = new Transform({
                transform(chunk, _enc, cb) {
                    resetReadTimeout();
                    if (signal?.aborted) {
                        cb(new Error('Download cancelled'));
                        return;
                    }
                    if (scheduleGate && typeof scheduleGate.shouldContinue === 'function' && !scheduleGate.shouldContinue()) {
                        scheduleStop = true;
                        // Stop cooperatively: end stream without failing permanently; keep .part
                        cb(new ScheduleStoppedError());
                        return;
                    }
                    if (!firstChunkChecked) {
                        firstChunkChecked = true;
                        const check = validateMediaResponse({
                            status: res.status,
                            contentType: ct,
                            firstBytes: chunk,
                            expectedKind
                        });
                        if (!check.ok) {
                            cb(new Error(check.reason));
                            return;
                        }
                    }
                    downloadedBytes += chunk.length;
                    if (expectedTotal != null && downloadedBytes > expectedTotal + 65536) {
                        cb(new Error(`Download exceeded expected size (${downloadedBytes} > ${expectedTotal})`));
                        return;
                    }
                    onProgress(
                        expectedTotal ? Math.min(1, downloadedBytes / expectedTotal) : 0,
                        downloadedBytes,
                        expectedTotal,
                        label
                    );
                    cb(null, chunk);
                }
            });

            try {
                await pipeline(readable, counter, write);
            } catch (pipeErr) {
                if (scheduleStop || pipeErr instanceof ScheduleStoppedError || pipeErr?.code === 'SCHEDULE_STOP') {
                    try {
                        if (typeof res.body?.cancel === 'function') await res.body.cancel();
                    } catch {
                        // ignore
                    }
                    return 'deferred';
                }
                throw pipeErr;
            } finally {
                if (readIdleTimer) clearTimeout(readIdleTimer);
                if (signal) signal.removeEventListener('abort', onAbort);
            }

            const finalSize = downloadedBytes;
            if (expectedTotal != null) {
                assertFinalSize({actual: finalSize, expected: expectedTotal, label: path.basename(filePath)});
            } else {
                assertFinalSize({
                    actual: finalSize,
                    expected: null,
                    allowUnknown: true,
                    label: path.basename(filePath)
                });
            }

            await fs.promises.rename(tmpPath, filePath);
            return 'downloaded';
        } catch (err) {
            if (err instanceof ScheduleStoppedError || err?.code === 'SCHEDULE_STOP') {
                return 'deferred';
            }
            if (err?.code === 'INTERRUPTED' || /Download cancelled/i.test(String(err?.message || ''))) {
                throw err;
            }
            const msg = String(err?.message || err);
            const permanent = err?.permanent || /Refusing |size mismatch|zero-byte|HTML/i.test(msg);
            const status = err?.status;
            const retryable = !permanent && (
                isRetriableNetworkError(err) ||
                (status != null && isRetriableStatus(status)) ||
                /did not honor range|416|Read timeout|AbortError/i.test(msg)
            );
            if (attempt < maxRetries && retryable) {
                try {
                    scheduleGate?.assertAllowed?.();
                } catch (schedErr) {
                    if (schedErr instanceof ScheduleStoppedError || schedErr?.code === 'SCHEDULE_STOP') {
                        return 'deferred';
                    }
                    throw schedErr;
                }
                throwIfAborted();
                onWarn(`Retry ${attempt}/${maxRetries} for ${path.basename(filePath)}: ${msg}`);
                const ra = err?.retryAfterMs != null ? err.retryAfterMs : null;
                await sleepFn(ra != null ? ra : backoffMs(attempt));
                // refresh tmp size
                try {
                    existingTmpSize = fs.statSync(tmpPath).size;
                } catch {
                    existingTmpSize = 0;
                }
                continue;
            }
            throw err;
        }
    }
    throw new Error(`Download failed after retries: ${redactUrl(url)}`);
}

export function attachRetryAfter(err, response) {
    if (!response) return err;
    const ms = parseRetryAfterMs(response.headers?.get?.('retry-after'));
    if (ms != null) err.retryAfterMs = ms;
    return err;
}

export {mergeSignals};
