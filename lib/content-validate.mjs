/**
 * Response / body validation to prevent HTML-as-video and truncated completes.
 */

const HTML_SIG = /^\s*(<!DOCTYPE\s+html|<html[\s>]|<\?xml)/i;
const HTML_LOGINISH = /<\s*(html|head|body|form|title)[\s>]/i;

export function looksLikeHtmlBuffer(buf, maxCheck = 512) {
    if (!buf || buf.length === 0) return false;
    const head = Buffer.isBuffer(buf) ? buf.subarray(0, maxCheck).toString('utf8') : String(buf).slice(0, maxCheck);
    return HTML_SIG.test(head) || (HTML_LOGINISH.test(head) && /login|csrf|session|password|sign[\s-]?in/i.test(head));
}

export function contentTypeLooksHtml(contentType) {
    const ct = String(contentType || '').toLowerCase();
    return ct.includes('text/html') || ct.includes('application/xhtml');
}

export function contentTypeLooksJson(contentType) {
    const ct = String(contentType || '').toLowerCase();
    return ct.includes('application/json') || ct.includes('+json');
}

/**
 * Decide whether a media response should be rejected before writing as video.
 */
export function validateMediaResponse({status, contentType, firstBytes, expectedKind = 'video'} = {}) {
    if (status === 204) {
        return {ok: false, reason: 'Empty response (204)'};
    }
    if (contentTypeLooksHtml(contentType)) {
        return {ok: false, reason: `Refusing ${expectedKind}: Content-Type is HTML (${contentType})`};
    }
    if (expectedKind === 'video' && contentTypeLooksJson(contentType)) {
        return {ok: false, reason: `Refusing video: Content-Type is JSON (${contentType})`};
    }
    if (firstBytes && looksLikeHtmlBuffer(firstBytes)) {
        return {ok: false, reason: `Refusing ${expectedKind}: body looks like an HTML page (login/error), not media`};
    }
    return {ok: true};
}

export function assertFinalSize({actual, expected, allowUnknown = true, label = 'file'} = {}) {
    if (expected == null || !Number.isFinite(expected)) {
        if (!allowUnknown) throw new Error(`${label}: expected size unknown`);
        if (actual === 0) throw new Error(`${label}: unexpected zero-byte download`);
        return true;
    }
    if (!Number.isFinite(actual)) throw new Error(`${label}: actual size unknown`);
    if (actual !== expected) {
        throw new Error(`${label}: size mismatch (got ${actual}, expected ${expected})`);
    }
    if (actual === 0) throw new Error(`${label}: unexpected zero-byte download`);
    return true;
}
