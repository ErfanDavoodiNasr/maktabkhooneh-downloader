import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';
import {
    extractCourseIdFromSlug,
    extractCourseSlug,
    getChapterUnits,
    isVideoLecture,
    pickBestVideoUrl,
    planLectures
} from '../../lib/course-parse.mjs';
import {TRUSTED_ORIGIN} from '../../lib/http-util.mjs';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures');

describe('extractCourseSlug / id', () => {
    it('classic URL', () => {
        const slug = extractCourseSlug(`${TRUSTED_ORIGIN}/course/foo-bar-mk1234/`);
        assert.equal(slug, 'foo-bar-mk1234');
        assert.equal(extractCourseIdFromSlug(slug), 1234);
    });

    it('LMS URL', () => {
        const slug = extractCourseSlug(`${TRUSTED_ORIGIN}/lms/course/baz-mk9/`);
        assert.equal(slug, 'baz-mk9');
        assert.equal(extractCourseIdFromSlug(slug), 9);
    });

    it('rejects bad path', () => {
        assert.throws(() => extractCourseSlug(`${TRUSTED_ORIGIN}/not-course/x/`), /URL_FORMAT|slug/i);
    });
});

describe('getChapterUnits / isVideoLecture', () => {
    it('unit_set and units', () => {
        assert.equal(getChapterUnits({unit_set: [1]}).length, 1);
        assert.equal(getChapterUnits({units: [1, 2]}).length, 2);
        assert.equal(getChapterUnits({}).length, 0);
    });

    it('video types', () => {
        assert.equal(isVideoLecture({type: 1}), true);
        assert.equal(isVideoLecture({type: 'lecture'}), true);
        assert.equal(isVideoLecture({type: 2}), false);
    });
});

describe('planLectures', () => {
    it('classic fixture numbering skips inactive / non-video', () => {
        const data = JSON.parse(fs.readFileSync(path.join(fixtures, 'classic-chapters.json'), 'utf8'));
        const all = planLectures(data.chapters);
        assert.equal(all.length, 3); // ch1: 2 active lectures; ch2: 1 lecture
        assert.equal(all[0].lessonNo, 1);
        assert.equal(all[1].lessonNo, 2);
        assert.equal(all[2].chapterNo, 2);
        assert.equal(all[2].lessonNo, 1);
    });

    it('LMS fixture includes locked videos in plan; skips quiz', () => {
        const data = JSON.parse(fs.readFileSync(path.join(fixtures, 'lms-outline.json'), 'utf8'));
        const all = planLectures(data.chapters);
        assert.equal(all.length, 4); // 3 videos ch1 + 1 ch2 (quiz skipped)
        assert.equal(all.filter((x) => x.locked).length, 1);
    });

    it('filters chapter/lesson', () => {
        const data = JSON.parse(fs.readFileSync(path.join(fixtures, 'lms-outline.json'), 'utf8'));
        const filtered = planLectures(data.chapters, {
            selectedChapters: new Set([1]),
            selectedLessons: new Set([1])
        });
        assert.equal(filtered.length, 1);
        assert.equal(filtered[0].unit.id, 1);
    });

    it('unknown fields are safe', () => {
        const chapters = [{title: 'x', units: [{id: 1, type: 1, weird: {nested: true}}], extra: 1}];
        assert.equal(planLectures(chapters).length, 1);
    });
});

describe('pickBestVideoUrl', () => {
    it('picks highest resolution with url', () => {
        const url = pickBestVideoUrl({
            qualities: [
                {resolution: 360, download_url: 'http://a/low'},
                {resolution: 720, download_url: 'http://a/hi'}
            ]
        });
        assert.equal(url, 'http://a/hi');
    });

    it('falls back to video_urls', () => {
        assert.equal(pickBestVideoUrl({video_urls: {hq: 'H', lq: 'L'}}), 'H');
        assert.equal(pickBestVideoUrl({video_urls: {lq: 'L'}}), 'L');
        assert.equal(pickBestVideoUrl(null), null);
    });
});
