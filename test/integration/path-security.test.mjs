import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {assertOutputPathSafe, isPathInsideRoot, safePathJoin, sanitizeName} from '../../lib/paths.mjs';

describe('path-security', () => {
    it('malicious titles stay under download root', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-dlroot-'));
        const malicious = [
            '../../../etc/passwd',
            '..\\..\\windows\\system32',
            'foo/../../escape',
            'a\u0000b',
            'CON',
            '....//....//evil'
        ];
        for (const title of malicious) {
            const safe = sanitizeName(title);
            assert.ok(!safe.includes('/') && !safe.includes('\\'));
            assert.notEqual(safe, '..');
            assert.notEqual(safe, '.');
            const joined = safePathJoin(root, safe, `${safe}.mp4`);
            assert.ok(isPathInsideRoot(root, joined));
            assertOutputPathSafe(root, joined);
        }
    });

    it('nested chapter/lesson names cannot escape', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-nest-'));
        const course = sanitizeName('../../outside-course');
        const chapter = sanitizeName('../ch');
        const lesson = sanitizeName('..\\lesson');
        const file = safePathJoin(root, course, chapter, `${lesson}.mp4`);
        assert.ok(file.startsWith(path.resolve(root)));
        assert.ok(isPathInsideRoot(root, file));
    });
});
