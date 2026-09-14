import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {allocateUniquePath, ensureOutputDirectory, resolveCourseOutputRoot} from '../../lib/output.mjs';

describe('resolveCourseOutputRoot', () => {
    it('defaults to cwd/download/<course>', () => {
        const cwd = '/tmp/mkd-cwd';
        const {outputRoot, baseDir} = resolveCourseOutputRoot({
            courseDisplayName: 'My Course',
            cwd
        });
        assert.equal(baseDir, path.resolve(cwd, 'download'));
        assert.equal(outputRoot, path.resolve(cwd, 'download', 'My Course'));
    });
    it('uses -o parent', () => {
        const cwd = '/tmp/mkd-cwd';
        const {outputRoot} = resolveCourseOutputRoot({
            outputDir: './downloads',
            courseDisplayName: 'اکسل',
            cwd
        });
        assert.equal(outputRoot, path.resolve(cwd, 'downloads', 'اکسل'));
    });
    it('rejects path that is a file', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-out-'));
        const file = path.join(dir, 'not-a-dir');
        fs.writeFileSync(file, 'x');
        assert.throws(() => resolveCourseOutputRoot({
            outputDir: file,
            courseDisplayName: 'c',
            cwd: dir
        }), /file/);
    });
});

describe('ensureOutputDirectory / collisions', () => {
    it('creates nested dirs and is writable', async () => {
        const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-out-')), 'a', 'b', 'فارسی path');
        await ensureOutputDirectory(dir);
        assert.ok(fs.statSync(dir).isDirectory());
    });
    it('allocateUniquePath avoids overwrite', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-col-'));
        const target = path.join(dir, 'lesson.mp4');
        fs.writeFileSync(target, '1');
        const next = allocateUniquePath(target);
        assert.equal(path.basename(next), 'lesson-2.mp4');
        fs.writeFileSync(next, '2');
        const next3 = allocateUniquePath(target);
        assert.equal(path.basename(next3), 'lesson-3.mp4');
    });
    it('considers .part as occupied', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-part-'));
        const target = path.join(dir, 'v.mp4');
        fs.writeFileSync(`${target}.part`, 'partial');
        const next = allocateUniquePath(target);
        assert.equal(path.basename(next), 'v-2.mp4');
    });
});
