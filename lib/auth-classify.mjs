/**
 * Classify HTTP auth/authorization failures without treating every 403 as expired session.
 */

export function looksLikeLoginRedirect(location) {
    const loc = String(location || '');
    if (!loc) return false;
    try {
        const path = loc.startsWith('http') ? new URL(loc).pathname : loc;
        return /\/(login|signin|auth|accounts?\/login)\b/i.test(path) || /[?&]next=.*login/i.test(loc);
    } catch {
        return /login|signin|auth/i.test(loc);
    }
}

export function looksLikeAuthPayload(bodySnippet) {
    const s = String(bodySnippet || '').slice(0, 2048).toLowerCase();
    if (!s) return false;
    if (/is_authenticated\s*"?\s*:\s*false/.test(s)) return true;
    if (/not[_ ]?authenticated|login[_ ]?required|session[_ ]?(expired|invalid)|please[_ ]?log[_ ]?in/.test(s)) {
        return true;
    }
    if (/csrf|recaptcha/.test(s) && /login|password|tessera/.test(s)) return true;
    return false;
}

/**
 * @returns {{kind: string, recoverable: boolean, reason: string}}
 */
export function classifyAuthFailure({
                                        status,
                                        location = null,
                                        bodySnippet = '',
                                        contentType = ''
                                    } = {}) {
    const st = Number(status) || 0;

    if (st === 401) {
        return {kind: 'unauthorized', recoverable: true, reason: 'HTTP 401 Unauthorized'};
    }

    if (st >= 300 && st < 400 && looksLikeLoginRedirect(location)) {
        return {kind: 'login_redirect', recoverable: true, reason: `Redirect to login (${location})`};
    }

    if (st === 403) {
        if (looksLikeLoginRedirect(location) || looksLikeAuthPayload(bodySnippet)) {
            return {kind: 'auth_forbidden', recoverable: true, reason: 'HTTP 403 looks like auth challenge'};
        }
        // Course not purchased / locked content — do not re-login
        return {kind: 'forbidden', recoverable: false, reason: 'HTTP 403 Forbidden (authorization)'};
    }

    if (looksLikeAuthPayload(bodySnippet) && /json/i.test(String(contentType || ''))) {
        return {kind: 'auth_payload', recoverable: true, reason: 'Response indicates unauthenticated'};
    }

    return {kind: 'other', recoverable: false, reason: `HTTP ${st || 'unknown'}`};
}
