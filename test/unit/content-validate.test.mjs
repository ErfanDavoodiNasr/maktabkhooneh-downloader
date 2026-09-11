import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {assertFinalSize, looksLikeHtmlBuffer, validateMediaResponse} from '../../lib/content-validate.mjs';

describe('looksLikeHtmlBuffer', () => {
    it('detects doctype / html', () => {
        assert.equal(looksLikeHtmlBuffer(Buffer.from('<!DOCTYPE html><html></html>')), true);
        assert.equal(looksLikeHtmlBuffer(Buffer.from('<html><body>login csrf</body></html>')), true);
        assert.equal(looksLikeHtmlBuffer(Buffer.from('\x00\x00ftypisom')), false);
    });
});

describe('validateMediaResponse', () => {
    it('rejects HTML content-type as video', () => {
        const r = validateMediaResponse({status: 200, contentType: 'text/html', expectedKind: 'video'});
        assert.equal(r.ok, false);
        assert.match(r.reason, /HTML/i);
    });

    it('rejects JSON as video', () => {
        const r = validateMediaResponse({status: 200, contentType: 'application/json', expectedKind: 'video'});
        assert.equal(r.ok, false);
        assert.match(r.reason, /JSON/i);
    });

    it('rejects HTML body signature', () => {
        const r = validateMediaResponse({
            status: 200,
            contentType: 'video/mp4',
            firstBytes: Buffer.from('<!DOCTYPE html><html><form>password</form></html>'),
            expectedKind: 'video'
        });
        assert.equal(r.ok, false);
    });

    it('accepts normal video headers', () => {
        const r = validateMediaResponse({status: 200, contentType: 'video/mp4', expectedKind: 'video'});
        assert.equal(r.ok, true);
    });
});

describe('assertFinalSize', () => {
    it('matches expected', () => {
        assert.equal(assertFinalSize({actual: 100, expected: 100}), true);
    });

    it('throws on mismatch', () => {
        assert.throws(() => assertFinalSize({actual: 50, expected: 100}), /mismatch/);
    });

    it('throws on zero-byte when unknown expected', () => {
        assert.throws(() => assertFinalSize({actual: 0, expected: null}), /zero-byte/);
    });

    it('throws on zero expected match', () => {
        assert.throws(() => assertFinalSize({actual: 0, expected: 0}), /zero-byte/);
    });
});
