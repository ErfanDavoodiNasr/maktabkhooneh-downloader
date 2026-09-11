import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {
    assertSafeMediaUrl,
    assertTrustedCourseUrl,
    cookieValueFromHeader,
    isPermanentStatus,
    isRetriableStatus,
    parseContentRange,
    parseRetryAfterMs,
    redactSecrets,
    redactUrl,
    shouldAttachAuth,
    toBackoffMs,
    TRUSTED_ORIGIN
} from '../../lib/http-util.mjs';

describe('retry classification', () => {
    it('retriable vs permanent', () => {
        assert.equal(isRetriableStatus(429), true);
        assert.equal(isRetriableStatus(503), true);
        assert.equal(isRetriableStatus(408), true);
        assert.equal(isRetriableStatus(404), false);
        assert.equal(isPermanentStatus(404), true);
        assert.equal(isPermanentStatus(403), true);
        assert.equal(isPermanentStatus(500), false);
    });
});

describe('backoff / Retry-After', () => {
    it('exponential backoff capped', () => {
        assert.equal(toBackoffMs(1, {base: 100, cap: 1000}), 100);
        assert.equal(toBackoffMs(2, {base: 100, cap: 1000}), 200);
        assert.equal(toBackoffMs(10, {base: 100, cap: 1000}), 1000);
    });

    it('parses Retry-After seconds and HTTP-date, capped', () => {
        assert.equal(parseRetryAfterMs('5'), 5000);
        assert.equal(parseRetryAfterMs('99999', {maxMs: 120_000}), 120_000);
        assert.equal(parseRetryAfterMs(''), null);
        const future = new Date(Date.now() + 60_000).toUTCString();
        const ms = parseRetryAfterMs(future, {maxMs: 120_000});
        assert.ok(ms > 50_000 && ms <= 120_000);
    });
});

describe('cookie origin', () => {
    it('only trusted origin gets auth', () => {
        assert.equal(shouldAttachAuth(`${TRUSTED_ORIGIN}/api`), true);
        assert.equal(shouldAttachAuth('https://cdn.example.com/v.mp4'), false);
        assert.equal(shouldAttachAuth('http://127.0.0.1:9/x'), false);
    });
});

describe('redaction', () => {
    it('redacts signed URL query keys', () => {
        const u = redactUrl('https://cdn.example.com/v.mp4?token=abc&signature=xyz&ok=1');
        assert.ok(/REDACTED/i.test(u));
        assert.ok(!u.includes('abc'));
        assert.ok(!u.includes('xyz'));
        assert.ok(u.includes('ok=1'));
    });

    it('redactSecrets covers password/session/csrf', () => {
        const raw = 'password=sekrit123 sessionid=sessVALUE csrftoken=csrfVALUE Authorization: Bearer tok12345';
        const out = redactSecrets(raw, ['sekrit123']);
        assert.ok(!out.includes('sekrit123'));
        assert.ok(!out.includes('sessVALUE'));
        assert.ok(!out.includes('csrfVALUE'));
        assert.ok(!out.includes('tok12345'));
    });
});

describe('parseContentRange fuzz', () => {
    it('valid forms', () => {
        assert.deepEqual(parseContentRange('bytes 0-99/100'), {start: 0, end: 99, total: 100});
        assert.deepEqual(parseContentRange('bytes */500'), {start: null, end: null, total: 500});
        assert.deepEqual(parseContentRange('bytes 10-20/*'), {start: 10, end: 20, total: null});
    });

    it('rejects garbage', () => {
        assert.equal(parseContentRange(''), null);
        assert.equal(parseContentRange('bytes 99-10/100'), null);
        assert.equal(parseContentRange('items 0-1/2'), null);
        assert.equal(parseContentRange('bytes abc'), null);
    });
});

describe('cookieValueFromHeader', () => {
    it('extracts named cookie', () => {
        assert.equal(cookieValueFromHeader('a=1; sessionid=abc; b=2', 'sessionid'), 'abc');
        assert.equal(cookieValueFromHeader('x=y', 'sessionid'), null);
    });
});

describe('SSRF / URL guards', () => {
    it('assertTrustedCourseUrl', () => {
        assert.ok(assertTrustedCourseUrl(`${TRUSTED_ORIGIN}/course/foo-mk1/`));
        assert.throws(() => assertTrustedCourseUrl('http://maktabkhooneh.org/course/x/'), /https/);
        assert.throws(() => assertTrustedCourseUrl('https://evil.com/course/x/'), /origin/i);
        assert.throws(() => assertTrustedCourseUrl('https://user:pass@maktabkhooneh.org/course/x/'), /credential/i);
    });

    it('assertSafeMediaUrl blocks private hosts', () => {
        assert.throws(() => assertSafeMediaUrl('http://127.0.0.1/v.mp4'), /private|local/i);
        assert.throws(() => assertSafeMediaUrl('http://192.168.1.1/v.mp4'), /private|local/i);
        assert.throws(() => assertSafeMediaUrl('http://10.0.0.2/v.mp4'), /private|local/i);
        assert.ok(assertSafeMediaUrl('https://cdn.example.com/v.mp4'));
        assert.ok(assertSafeMediaUrl('http://127.0.0.1/v.mp4', {allowPrivate: true}));
    });
});
