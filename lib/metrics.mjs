/**
 * Lightweight process metrics (no secrets). Safe for concurrent workers (single-threaded ++).
 */
export function createMetrics() {
    const m = {
        downloadsOk: 0,
        downloadsFail: 0,
        downloadsSkip: 0,
        downloadsDeferred: 0,
        retries: 0,
        authRecoverAttempts: 0,
        authRecoverOk: 0,
        authRecoverFail: 0,
        authReuse: 0,
        authWait: 0,
        authPersistOk: 0,
        authPersistFail: 0,
        bytesDownloaded: 0,
        activeWorkers: 0,
        peakWorkers: 0
    };
    return {
        raw: m,
        inc(key, n = 1) {
            if (key in m) m[key] += n;
        },
        addBytes(n) {
            if (Number.isFinite(n) && n > 0) m.bytesDownloaded += n;
        },
        trackWorker(delta) {
            m.activeWorkers += delta;
            if (m.activeWorkers > m.peakWorkers) m.peakWorkers = m.activeWorkers;
        },
        snapshot() {
            return {...m};
        }
    };
}
