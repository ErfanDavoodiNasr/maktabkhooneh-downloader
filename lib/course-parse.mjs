/**
 * Course URL / outline unit helpers.
 */
import {assertTrustedCourseUrl, TRUSTED_ORIGIN} from './http-util.mjs';

export function extractCourseSlug(courseUrl, trustedOrigin = TRUSTED_ORIGIN) {
    const parsed = assertTrustedCourseUrl(courseUrl, trustedOrigin);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const lmsIdx = parts.indexOf('lms');
    if (lmsIdx !== -1 && parts[lmsIdx + 1] === 'course' && parts[lmsIdx + 2]) {
        return parts[lmsIdx + 2];
    }
    const idx = parts.indexOf('course');
    if (idx === -1 || !parts[idx + 1]) {
        throw new Error(
            `[URL_FORMAT] Cannot parse course slug from URL path.\nNext step:\n- Expected: ${trustedOrigin}/course/<slug>/`
        );
    }
    return parts[idx + 1];
}

export function extractCourseIdFromSlug(slug) {
    const m = String(slug || '').match(/-mk(\d+)$/i);
    return m ? Number.parseInt(m[1], 10) : null;
}

export function normalizeBaseUrl(baseUrl) {
    const b = String(baseUrl || '').trim();
    if (!b) return `${TRUSTED_ORIGIN}/course/`;
    return b.endsWith('/') ? b : `${b}/`;
}

export function isLikelyFullUrl(text) {
    return /^https?:\/\//i.test(String(text || '').trim());
}

export function buildCourseUrlFromSlug(baseUrl, slug) {
    const s = String(slug || '').trim().replace(/^\/+|\/+$/g, '');
    if (!s) return null;
    const b = normalizeBaseUrl(baseUrl);
    return `${b}${encodeURIComponent(s)}/`;
}

export function getChapterUnits(chapter) {
    if (Array.isArray(chapter?.units)) return chapter.units;
    if (Array.isArray(chapter?.unit_set)) return chapter.unit_set;
    return [];
}

export function isUnitActive(unit) {
    return !unit || !('status' in unit) || !!unit.status;
}

export function isVideoLecture(unit) {
    return unit?.type === 1 || unit?.type === 'lecture';
}

export function isUnitLocked(unit) {
    return unit?.locked === true;
}

export function detectNewUnitFormat(chapters, urlHint = false) {
    const firstUnit = getChapterUnits(chapters?.[0] || {})[0];
    if (firstUnit) return typeof firstUnit.type === 'number';
    return !!urlHint;
}

export function unitIdOf(unit) {
    return unit?.id || unit?.unit_id || null;
}

export function pickBestVideoUrl(videoUrlData) {
    if (!videoUrlData) return null;
    const qualities = Array.isArray(videoUrlData.qualities) ? videoUrlData.qualities : [];
    if (qualities.length > 0) {
        const sorted = [...qualities].sort((a, b) => (b.resolution || 0) - (a.resolution || 0));
        const withUrl = sorted.find((q) => q.download_url);
        if (withUrl) return withUrl.download_url;
    }
    const v = videoUrlData.video_urls;
    return v?.hq || v?.lq || null;
}

/**
 * Build a flat plan of downloadable video lectures with stable numbering.
 * Lesson numbers reset per chapter and count only active video lectures.
 */
export function planLectures(chapters, {selectedChapters = null, selectedLessons = null} = {}) {
    const list = [];
    const arr = Array.isArray(chapters) ? chapters : [];
    for (let chapterIndex = 0; chapterIndex < arr.length; chapterIndex++) {
        const chapter = arr[chapterIndex];
        const chapterNo = chapterIndex + 1;
        if (selectedChapters && !selectedChapters.has(chapterNo)) continue;
        const units = getChapterUnits(chapter);
        let chapterLectureNo = 0;
        for (const unit of units) {
            if (!isUnitActive(unit)) continue;
            if (!isVideoLecture(unit)) continue;
            chapterLectureNo++;
            if (selectedLessons && !selectedLessons.has(chapterLectureNo)) continue;
            list.push({
                chapter,
                chapterNo,
                chapterIndex,
                unit,
                lessonNo: chapterLectureNo,
                unitId: unitIdOf(unit),
                locked: isUnitLocked(unit)
            });
        }
    }
    return list;
}
