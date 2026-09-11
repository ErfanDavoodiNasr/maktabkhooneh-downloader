/**
 * Fuzz / property-style tests for path containment and content-range.
 */
import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import fs from 'fs';
import {assertOutputPathSafe, isPathInsideRoot, safePathJoin, sanitizeName} from '../../lib/paths.mjs';
import {parseContentRange} from '../../lib/http-util.mjs';
import {parseNumberSpec} from '../../lib/cli-parse.mjs';

function randStr(n) {
    const chars = 'aAzZ0۹۸۷./\\:*?"<>|\0\x1b[31m..\u200c\u202e';
    let s = '';
    for (let i = 0; i < n; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
}

describe('fuzz paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-fuzz-'));

    it('thousands of random titles stay under root', () => {
        for (let i = 0; i < 2000; i++) {
            const title = randStr(1 + (i % 80));
            const name = sanitizeName(title, {fallback: `item-${i}`});
            assert.ok(!name.includes('/') && !name.includes('\\'));
            assert.notEqual(name, '..');
            assert.notEqual(name, '.');
            const joined = safePathJoin(root, name);
            assert.ok(isPathInsideRoot(root, joined));
            assertOutputPathSafe(root, joined);
        }
    });
});

describe('fuzz content-range', () => {
    const bad = [
        'bytes 0-99/100',
        'bytes */100',
        'bytes x-y/z',
        'bytes -1-10/10',
        'bytes 10-5/20',
        'bytes 0-1/',
        'bytes 0-1/abc',
        'byterange 0-1/2',
        '',
        'null',
        'bytes 999999999999999999999-1/2'
    ];
    for (const h of bad) {
        it(`tolerates malformed: ${JSON.stringify(h)}`, () => {
            const r = parseContentRange(h);
            // either null or well-formed numbers
            if (r) {
                if (r.start != null) assert.ok(Number.isFinite(r.start) && r.start >= 0);
                if (r.end != null) assert.ok(Number.isFinite(r.end) && r.end >= 0);
                if (r.total != null) assert.ok(Number.isFinite(r.total) && r.total >= 0);
                if (r.start != null && r.end != null) assert.ok(r.start <= r.end);
            }
        });
    }
});

describe('fuzz chapter specs', () => {
    it('valid specs terminate', () => {
        for (const s of ['1', '1,3', '2-5', '5-2', '2-5,8', '1,2,3-4']) {
            const set = parseNumberSpec(s);
            assert.ok(set.size > 0);
        }
    });
    it('invalid specs throw', () => {
        for (const s of ['0', '-1', 'abc', '1,,2', '1-', '-3', '1.5']) {
            assert.throws(() => parseNumberSpec(s));
        }
    });
});
