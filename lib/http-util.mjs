/**
 * HTTP retry / backoff / cookie-origin / redaction helpers.
 */

export const TRUSTED_ORIGIN = 'https://maktabkhooneh.org';

export function isRetriableStatus(status) {
    return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

export function isPermanentStatus(status) {
    return status === 400 || status === 401 || status === 403 || status === 404 || status === 405 || status === 410 || status === 451;
}

export function isTimeoutError(err) {
    const m = String(err?.message || '').toLowerCase();
    return err?.name === 'AbortError' || m.includes('timeout') || m.includes('timed out');
}

export function isRetriableNetworkError(err) {
    if (isTimeoutError(err)) return true;
    const c = String(err?.cause?.code || err?.code || '').toUpperCase();
    if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EHOSTUNREACH', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(c)) {
        return true;
    }
    const m = String(err?.cause?.message || err?.message || '').toLowerCase();
    return m.includes('other side closed') || m.includes('socket hang up') || m.includes('econnreset');
}

/** Bounded exponential backoff without jitter (tests inject clock). Cap 30s. */
export function toBackoffMs(attempt, {base = 700, cap = 30_000} = {}) {
    return Math.min(cap, base * (2 ** Math.max(0, attempt - 1)));
}

/**
 * Parse Retry-After header. Caps at maxMs (default 120s) to avoid absurd sleeps.
 * @returns {number|null} milliseconds to wait, or null if absent/invalid
 */
export function parseRetryAfterMs(headerValue, {maxMs = 120_000, now = Date.now()} = {}) {
    if (headerValue == null || headerValue === '') return null;
    const s = String(headerValue).trim();
    if (/^\d+$/.test(s)) {
        const sec = Number.parseInt(s, 10);
        if (!Number.isFinite(sec) || sec < 0) return null;
        return Math.min(maxMs, sec * 1000);
    }
    const when = Date.parse(s);
    if (!Number.isFinite(when)) return null;
    const delta = when - now;
    if (delta <= 0) return 0;
    return Math.min(maxMs, delta);
}

export function originOf(url, base = TRUSTED_ORIGIN) {
    try {
        return new URL(String(url || ''), base).origin;
    } catch {
        return null;
    }
}

/** Auth cookies / CSRF only for the trusted Maktabkhooneh origin. */
export function shouldAttachAuth(url, trustedOrigin = TRUSTED_ORIGIN) {
    const o = originOf(url);
    return o === trustedOrigin;
}

const SENSITIVE_QUERY_KEYS = /^(token|signature|sig|expires|expire|auth|key|password|session|sessionid|csrftoken|access_token|refresh_token|X-Amz-Signature|X-Amz-Credential|Policy|Signature)$/i;

export function redactUrl(url) {
    try {
        const u = new URL(String(url));
        let changed = false;
        for (const key of [...u.searchParams.keys()]) {
            if (SENSITIVE_QUERY_KEYS.test(key) || /sign|token|secret|auth|key/i.test(key)) {
                u.searchParams.set(key, '[REDACTED]');
                changed = true;
            }
        }
        return changed ? u.toString() : u.toString();
    } catch {
        return '[invalid-url]';
    }
}

export function redactSecrets(text, secrets = []) {
    let out = String(text ?? '');
    for (const s of secrets) {
        if (!s || String(s).length < 4) continue;
        out = out.split(String(s)).join('[REDACTED]');
    }
    out = out.replace(/sessionid=[^;\s&]+/gi, 'sessionid=[REDACTED]');
    out = out.replace(/csrftoken=[^;\s&]+/gi, 'csrftoken=[REDACTED]');
    out = out.replace(/(password["']?\s*[:=]\s*["']?)([^"'\s,;}]+)/gi, '$1[REDACTED]');
    out = out.replace(/Authorization:\s*Bearer\s+\S+/gi, 'Authorization: Bearer [REDACTED]');
    // Best-effort signed URL query redaction inside free text
    out = out.replace(/([?&](?:token|signature|sig|expires|access_token)=)[^&\s]+/gi, '$1[REDACTED]');
    return out;
}

// Parse Content-Range header. Returns {start,end,total} or null.
export function parseContentRange(header) {
    if (!header) return null;
    const m = String(header).trim().match(/^bytes\s+(?:\*|(\d+)-(\d+))\/(?:(\d+)|\*)$/i);
    if (!m) return null;
    const start = m[1] != null ? Number.parseInt(m[1], 10) : null;
    const end = m[2] != null ? Number.parseInt(m[2], 10) : null;
    const total = m[3] != null ? Number.parseInt(m[3], 10) : null;
    if (start != null && (!Number.isFinite(start) || start < 0)) return null;
    if (end != null && (!Number.isFinite(end) || end < 0)) return null;
    if (total != null && (!Number.isFinite(total) || total < 0)) return null;
    if (start != null && end != null && start > end) return null;
    return {start, end, total};
}

export function cookieValueFromHeader(cookieHeader, name) {
    const ck = String(cookieHeader || '');
    const m = ck.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
    if (!m) return null;
    try {
        return decodeURIComponent(m[1]);
    } catch {
        return m[1];
    }
}

export function isPrivateOrLocalHostname(hostname) {
    const h = String(hostname || '').toLowerCase();
    if (!h) return true;
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0') return true;
    if (h.endsWith('.local') || h.endsWith('.internal')) return true;
    // IPv4 private ranges
    const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (m) {
        const a = +m[1], b = +m[2];
        if (a === 10) return true;
        if (a === 127) return true;
        if (a === 192 && b === 168) return true;
        if (a === 169 && b === 254) return true;
        if (a === 172 && b >= 16 && b <= 31) return true;
    }
    return false;
}

/**
 * User-supplied course URLs must be https + trusted host.
 * Media URLs returned by the API may be on CDNs (different host) — validated separately.
 */
export function assertTrustedCourseUrl(urlStr, trustedOrigin = TRUSTED_ORIGIN) {
    let u;
    try {
        u = new URL(String(urlStr || '').trim());
    } catch {
        throw new Error(`Invalid course URL`);
    }
    if (u.protocol !== 'https:') {
        throw new Error(`Course URL must use https (got ${u.protocol})`);
    }
    if (u.origin !== trustedOrigin) {
        throw new Error(`Unexpected origin: ${u.origin}. Only ${trustedOrigin} is supported.`);
    }
    if (u.username || u.password) {
        throw new Error('Course URL must not embed credentials');
    }
    return u;
}

/** Media download targets: https only; block obvious SSRF to private nets unless same trusted origin. */
export function assertSafeMediaUrl(urlStr, {allowPrivate = false} = {}) {
    let u;
    try {
        u = new URL(String(urlStr || '').trim());
    } catch {
        throw new Error('Invalid media URL');
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        throw new Error(`Unsupported media URL protocol: ${u.protocol}`);
    }
    // Prefer https for non-localhost
    if (!allowPrivate && isPrivateOrLocalHostname(u.hostname)) {
        throw new Error(`Refusing media URL to private/local host: ${u.hostname}`);
    }
    return u;
}
