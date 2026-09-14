/**
 * Extra unit coverage for course-parse / config edge paths.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
    buildCourseUrlFromSlug,
    detectNewUnitFormat,
    isLikelyFullUrl,
    isUnitActive,
    isUnitLocked,
    normalizeBaseUrl
} from '../../lib/course-parse.mjs';
import {
    defaultConfigTemplate,
    discoverConfigPath,
    loadConfigFile,
    saveConfigFile,
    validateRuntimeConfig
} from '../../lib/config.mjs';
import {isPermanentStatus, isRetriableStatus, parseRetryAfterMs, redactUrl, toBackoffMs} from '../../lib/http-util.mjs';
import {assertFinalSize, contentTypeLooksHtml, looksLikeHtmlBuffer} from '../../lib/content-validate.mjs';

describe('course-parse extras', () => {
    it('normalizeBaseUrl / buildCourseUrlFromSlug', () => {
        assert.ok(normalizeBaseUrl('https://maktabkhooneh.org/course').endsWith('/'));
        assert.ok(isLikelyFullUrl('https://x.com'));
        assert.equal(isLikelyFullUrl('slug'), false);
        const u = buildCourseUrlFromSlug('https://maktabkhooneh.org/course/', 'foo-mk1');
        assert.match(u, /foo-mk1/);
    });
    it('unit helpers', () => {
        assert.equal(isUnitActive({status: 0}), false);
        assert.equal(isUnitActive({}), true);
        assert.equal(isUnitLocked({locked: true}), true);
        assert.equal(detectNewUnitFormat([{units: [{type: 1}]}], false), true);
        assert.equal(detectNewUnitFormat([], true), true);
    });
});

describe('config extras', () => {
    it('discoverConfigPath and atomic save', async () => {
        const d = discoverConfigPath(['--config', 'x.json']);
        assert.equal(d.path, 'x.json');
        assert.equal(d.explicit, true);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-cfg-'));
        const cfgPath = path.join(dir, 'c.json');
        const cfg = defaultConfigTemplate();
        cfg.auth.email = 'a@b.c';
        await saveConfigFile(cfgPath, cfg);
        const loaded = loadConfigFile(cfgPath);
        assert.equal(loaded.config.auth.email, 'a@b.c');
        assert.throws(() => validateRuntimeConfig({retryAttempts: 0}), /retryAttempts/);
    });
});

describe('http-util extras', () => {
    it('backoff and retry-after caps', () => {
        assert.ok(toBackoffMs(1, {jitter: 0}) < toBackoffMs(5, {jitter: 0}));
        assert.equal(parseRetryAfterMs('999999'), 120_000);
        assert.equal(parseRetryAfterMs('2'), 2000);
        assert.equal(isRetriableStatus(503), true);
        assert.equal(isPermanentStatus(404), true);
        assert.match(redactUrl('https://cdn.example/v?token=secret&x=1'), /REDACTED/);
    });
});

describe('content-validate extras', () => {
    it('html / size helpers', () => {
        assert.equal(contentTypeLooksHtml('text/html; charset=utf-8'), true);
        assert.equal(looksLikeHtmlBuffer(Buffer.from('<html><form>login password')), true);
        assert.throws(() => assertFinalSize({actual: 0, expected: null}), /zero-byte/);
        assert.throws(() => assertFinalSize({actual: 10, expected: 11}), /mismatch/);
    });
});
