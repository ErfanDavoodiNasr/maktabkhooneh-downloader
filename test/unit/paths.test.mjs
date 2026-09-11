import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    assertOutputPathSafe,
    isPathInsideRoot,
    normalizeCourseFolderNameFromSlug,
    safePathJoin,
    sanitizeContentDispositionFilename,
    sanitizeName,
    stripControlChars
} from '../../lib/paths.mjs';

describe('stripControlChars / sanitizeName', () => {
    it('strips ANSI and C0 controls', () => {
        assert.equal(stripControlChars('a\u001b[31mb\u0000c'), 'a[31mbc');
        assert.equal(sanitizeName('hi\nthere'), 'hithere');
    });

    it('blocks traversal and separators', () => {
        assert.equal(sanitizeName('../../etc/passwd'), 'etc passwd');
        assert.equal(sanitizeName('a/b\\c'), 'a b c');
        assert.equal(sanitizeName('..'), 'untitled');
        assert.equal(sanitizeName('.'), 'untitled');
    });

    it('handles Windows reserved names', () => {
        assert.equal(sanitizeName('CON'), '_CON');
        assert.equal(sanitizeName('nul.txt'), '_nul.txt');
    });

    it('keeps Persian Unicode NFC', () => {
        const fa = 'آموزش پایتون';
        assert.equal(sanitizeName(fa), fa.normalize('NFC'));
    });
});

describe('sanitizeContentDispositionFilename', () => {
    it('rejects path traversal in filename', () => {
        const n = sanitizeContentDispositionFilename('attachment; filename="../../evil.pdf"');
        assert.equal(n, 'evil.pdf');
        assert.ok(!n.includes('..'));
    });

    it('handles filename*', () => {
        const n = sanitizeContentDispositionFilename("attachment; filename*=UTF-8''%D9%81%D8%A7.pdf");
        assert.ok(n.endsWith('.pdf'));
    });
});

describe('normalizeCourseFolderNameFromSlug', () => {
    it('strips -mk id and dashes', () => {
        assert.equal(normalizeCourseFolderNameFromSlug('foo-bar-mk123'), 'foo bar');
    });
});

describe('path containment', () => {
    it('isPathInsideRoot', () => {
        const root = path.resolve('/tmp/mkd-root');
        assert.equal(isPathInsideRoot(root, path.join(root, 'a', 'b')), true);
        assert.equal(isPathInsideRoot(root, path.resolve(root, '..', 'escape')), false);
    });

    it('safePathJoin stays under root', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-path-'));
        const joined = safePathJoin(dir, 'فصل', 'درس');
        assert.ok(isPathInsideRoot(dir, joined));
        // ".." is sanitized to a safe segment, not a traversal
        const escaped = safePathJoin(dir, '..', 'x');
        assert.ok(isPathInsideRoot(dir, escaped));
        assert.ok(escaped.includes('untitled') || path.basename(path.dirname(escaped)) !== '..');
    });

    it('assertOutputPathSafe blocks lexical escape', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-out-'));
        assert.throws(
            () => assertOutputPathSafe(dir, path.join(dir, '..', 'out.bin')),
            /escapes/
        );
        const ok = assertOutputPathSafe(dir, path.join(dir, 'ok.bin'));
        assert.ok(ok.endsWith('ok.bin'));
    });

    it('detects symlink escape on unix', {skip: process.platform === 'win32'}, () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-sym-root-'));
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-sym-out-'));
        const link = path.join(root, 'escape-link');
        fs.symlinkSync(outside, link);
        assert.throws(
            () => assertOutputPathSafe(root, path.join(link, 'secret.bin')),
            /symlink|outside|escapes/
        );
    });
});
