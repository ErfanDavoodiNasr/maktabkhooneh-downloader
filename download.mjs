/**
 * CLI tool to download all lecture videos of a maktabkhooneh course
 *
 * Usage examples:
 *   node download.mjs "<slug>"
 *   node download.mjs "https://maktabkhooneh.org/course/<slug>/"
 *   node download.mjs "https://maktabkhooneh.org/lms/course/<slug>/unit/<unit_id>/"
 *   node download.mjs "<slug>" --sample-bytes 65536 --verbose
 *
 * Notes: Only download content you have legal rights to access.
 *
 * @repository https://github.com/NabiKAZ/maktabkhooneh-downloader
 * @author NabiKAZ <https://x.com/NabiKAZ>
 * @license GPL-3.0
 * @created 2025
 *
 * Copyright(C) 2025 NabiKAZ
 */

import fs from 'fs';
import path from 'path';
import {setTimeout as sleep} from 'timers/promises';
import https from 'https';

import {parseArgv, parseNonNegativeIntOrFallback as parseNonNegativeInt} from './lib/cli-parse.mjs';
import {
    assertOutputPathSafe,
    normalizeCourseFolderNameFromSlug,
    sanitizeContentDispositionFilename,
    sanitizeName,
    stripControlChars
} from './lib/paths.mjs';
import {
    cookieValueFromHeader,
    isRetriableNetworkError,
    isRetriableStatus,
    redactSecrets,
    toBackoffMs,
    TRUSTED_ORIGIN
} from './lib/http-util.mjs';
import {
    DEFAULT_CONFIG_FILE,
    DEFAULT_READ_TIMEOUT_MS,
    DEFAULT_REQUEST_TIMEOUT_MS,
    DEFAULT_RETRY_ATTEMPTS,
    discoverConfigPath,
    loadConfigFile,
    saveConfigFile,
    validateCourseBaseUrl,
    validateRuntimeConfig
} from './lib/config.mjs';
import {
    buildCourseUrlFromSlug,
    detectNewUnitFormat,
    extractCourseIdFromSlug,
    extractCourseSlug,
    getChapterUnits,
    isLikelyFullUrl,
    isUnitActive,
    isUnitLocked,
    isVideoLecture,
    pickBestVideoUrl,
    planLectures,
    unitIdOf
} from './lib/course-parse.mjs';
import {
    buildAuthAwareHeaders,
    downloadToFile as engineDownloadToFile,
    probeRemoteSize
} from './lib/download-engine.mjs';
import {ensureOutputDirectory, resolveCourseOutputRoot} from './lib/output.mjs';
import {mapPool} from './lib/pool.mjs';
import {createScheduleGate, ScheduleError, waitUntilAllowed} from './lib/schedule.mjs';
import {EXIT} from './lib/exit-codes.mjs';
import {createSessionManager} from './lib/session-manager.mjs';
import {createMetrics} from './lib/metrics.mjs';

// ===============
// Console styling (ANSI colors) and emojis
// ===============
const COLOR = {
    reset: '\u001b[0m',
    bold: '\u001b[1m',
    dim: '\u001b[2m',
    red: '\u001b[31m',
    green: '\u001b[32m',
    yellow: '\u001b[33m',
    blue: '\u001b[34m',
    magenta: '\u001b[35m',
    cyan: '\u001b[36m',
    lightBlue: '\u001b[94m'
};
const paint = (code, s) => `${code}${s}${COLOR.reset}`;
const paintBold = s => paint(COLOR.bold, s);
const paintGreen = s => paint(COLOR.green, s);
const paintRed = s => paint(COLOR.red, s);
const paintYellow = s => paint(COLOR.yellow, s);
const paintCyan = s => paint(COLOR.cyan, s);
// Combined style helpers
const paintBoldCyan = s => `${COLOR.bold}${COLOR.cyan}${s}${COLOR.reset}`; // bold + cyan
const paintBlue = s => paint(COLOR.blue, s);
const paintLightBlue = s => paint(COLOR.lightBlue, s);

const secretBag = () => [LOGIN_PASSWORD, ACTIVE_COOKIE, COOKIE].filter(Boolean);
const safeLogArgs = (args) => args.map((a) => typeof a === 'string' ? redactSecrets(stripControlChars(a), secretBag()) : a);
const logInfo = (...a) => console.log('ℹ️', ...safeLogArgs(a));
const logStep = (...a) => console.log('▶️', ...safeLogArgs(a));
const logSuccess = (...a) => console.log('✅', ...safeLogArgs(a));
const logWarn = (...a) => console.warn('⚠️', ...safeLogArgs(a));
const logError = (...a) => console.error('❌', ...safeLogArgs(a));

async function persistConfig(configPath, config) {
    try {
        await saveConfigFile(configPath, config);
        return true;
    } catch (e) {
        logWarn(`Could not persist config file (${configPath}): ${e.message}`);
        return false;
    }
}

const ACTIONABLE_URL_PLACEHOLDER = 'https://maktabkhooneh.org/course/<slug>/';
const ACTIONABLE_SLUG_PLACEHOLDER = '<slug>';

function trimUrlForHint(url) {
    const u = String(url || '').trim();
    return u || ACTIONABLE_URL_PLACEHOLDER;
}

function buildActionableError(code, why, next) {
    const nextLines = Array.isArray(next) ? next.filter(Boolean) : [next].filter(Boolean);
    const lines = [`[${code}] ${why}`];
    if (nextLines.length > 0) {
        lines.push('Next step:');
        for (const n of nextLines) lines.push(`- ${n}`);
    }
    return lines.join('\n');
}

function explainHttpFailure(status, context = 'request') {
    if (status === 401) {
        return buildActionableError(
            'AUTH_401',
            `${context} failed with 401 Unauthorized. Your session/cookie is invalid or expired.`,
            [
                `Re-login with: node download.mjs "${ACTIONABLE_URL_PLACEHOLDER}" --force-login`,
                'Or set auth.email/auth.password in config.json'
            ]
        );
    }
    if (status === 403) {
        return buildActionableError(
            'ACCESS_403',
            `${context} failed with 403 Forbidden. Your account does not have access to this course/content, or cookie was rejected.`,
            [
                'Make sure you are logged in with the account that purchased the course.',
                `Retry after re-login: node download.mjs "${ACTIONABLE_URL_PLACEHOLDER}" --force-login`
            ]
        );
    }
    if (status === 429) {
        return buildActionableError(
            'RATE_LIMIT_429',
            `${context} failed with 429 Too Many Requests.`,
            [
                'Wait a few minutes and retry.',
                'Optionally reduce pressure by selecting smaller scope: --chapter 1 --lesson 1-3'
            ]
        );
    }
    if (status >= 500) {
        return buildActionableError(
            `SERVER_${status}`,
            `${context} failed with ${status}. Temporary server-side issue.`,
            'Retry the same command after a short delay.'
        );
    }
    return buildActionableError(
        `HTTP_${status}`,
        `${context} failed with HTTP ${status}.`,
        'Run again with --verbose to inspect details.'
    );
}

let RUNTIME_CONFIG = {
    retryAttempts: DEFAULT_RETRY_ATTEMPTS,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
    readTimeoutMs: DEFAULT_READ_TIMEOUT_MS
};
let LOGIN_EMAIL = '';
let LOGIN_PASSWORD = '';
let COOKIE = 'PUT_YOUR_COOKIE_HERE';
// ACTIVE_COOKIE will be dynamically set after login/session load (fallback to COOKIE)
let ACTIVE_COOKIE = null;
/** @type {ReturnType<typeof createSessionManager>|null} */
let SESSION_MANAGER = null;
/** @type {ReturnType<typeof createMetrics>|null} */
let METRICS = null;
// Sample mode default (0 means full download)
const DEFAULT_SAMPLE_BYTES = 0;

// Ensure Node 20+ (maintained LTS) for global fetch and modern APIs
{
    const major = Number.parseInt(String(process.versions.node || '0').split('.')[0], 10);
    if (!Number.isFinite(major) || major < 20 || typeof fetch !== 'function') {
        logError('This script requires Node.js v20+ (maintained LTS) with global fetch.');
        process.exit(1);
    }
}

const ORIGIN = TRUSTED_ORIGIN;

// Node fetch headers must be ByteString; percent-encode non-ASCII URLs (e.g. Persian slugs).
function toHeaderSafeUrl(url) {
    try {
        return new URL(String(url || ''), ORIGIN).href;
    } catch {
        return `${ORIGIN}/`;
    }
}

/**
 * Headers for a request. Auth cookies are attached ONLY for the trusted origin.
 * Pass the request URL so media/CDN hosts never receive session cookies.
 */
function commonHeaders(referer, requestUrl = ORIGIN) {
    const ck = ACTIVE_COOKIE || COOKIE;
    return buildAuthAwareHeaders({
        cookie: ck,
        referer,
        url: requestUrl || ORIGIN,
        trustedOrigin: ORIGIN,
        accept: '*/*'
    });
}

// Human-friendly byte formatter
function formatBytes(bytes) {
    if (bytes == null || isNaN(bytes)) return '-';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    let n = Number(bytes);
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
    }
    return `${n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`;
}

function formatSpeed(bytesPerSec) {
    if (!bytesPerSec || !isFinite(bytesPerSec)) return '-';
    return `${formatBytes(bytesPerSec)}/s`;
}

function buildProgressBar(ratio, width = 24) {
    const r = Math.max(0, Math.min(1, ratio || 0));
    const filled = Math.round(r * width);
    const left = width - filled;
    const bar = `${'█'.repeat(filled)}${'░'.repeat(left)}`;
    return bar;
}

function ensureCookiePresent() {
    if (!(ACTIVE_COOKIE && ACTIVE_COOKIE !== 'PUT_YOUR_COOKIE_HERE') && !(COOKIE && COOKIE !== 'PUT_YOUR_COOKIE_HERE')) {
        logError(buildActionableError(
            'SESSION_MISSING',
            'No active session/cookie found.',
            [
                'Set credentials in config.json: auth.email and auth.password',
                'Or provide cookie in config.json: auth.cookie or auth.cookieFile',
                `Then run: node download.mjs "${ACTIONABLE_URL_PLACEHOLDER}"`
            ]
        ));
        process.exit(1);
    }
}

// CLI usage
function printUsage() {
    // Header section
    console.log(`${paintBoldCyan('Maktabkhooneh Downloader')} - ${paintYellow('version 1.1.0')} ${paint(COLOR.dim, '© 2025')}`);
    console.log(paint(COLOR.magenta, 'By ') + paint(COLOR.magenta, '@NabiKAZ') + ' ' + paintLightBlue('<www.nabi.ir>') + ' ' + paintGreen('<nabikaz@gmail.com>') + ' ' + paintLightBlue('<x.com/NabiKAZ>'));
    console.log(paint(COLOR.dim, 'Signup: ') + paintLightBlue('https://maktabkhooneh.org/'));
    console.log(paint(COLOR.dim, 'Project: ') + paintLightBlue('https://github.com/NabiKAZ/maktabkhooneh-downloader'));
    console.log(paint(COLOR.dim, '=============================================================\n'));

    // Usage
    console.log(paintBold('Usage:'));
    console.log(`  ${paintCyan('node download.mjs')} ${paintYellow('[slug|course_url]')} [options]`);

    // Options
    console.log('\n' + paintBold('Options:'));
    console.log(`  ${paintYellow('[slug|course_url]')}           Course slug (preferred) or full course URL`);
    console.log(`                                           Supports /course/<slug>/ and /lms/course/<slug>/unit/<id>/`);
    console.log(`  ${paintGreen('--sample-bytes')} ${paintYellow('N')}            Download only the first N bytes of each video`);
    console.log(`  ${paintGreen('--chapter')} ${paintYellow('SPEC')}           Select chapter(s): e.g. 2 or 1,3 or 2-4`);
    console.log(`  ${paintGreen('--lesson')} ${paintYellow('SPEC')}            Select lesson(s) inside selected chapter(s): e.g. 2 or 2-5,9`);
    console.log(`  ${paintGreen('-j')} | ${paintGreen('--jobs')} ${paintYellow('N')}             Concurrent downloads (default: 1, max: 32)`);
    console.log(`  ${paintGreen('-o')} | ${paintGreen('--output-dir')} ${paintYellow('PATH')}   Output parent directory (default: ./download)`);
    console.log(`  ${paintGreen('--start-at')} ${paintYellow('ISO')}            One-time window start (timezone required, e.g. ...+03:30)`);
    console.log(`  ${paintGreen('--stop-at')} ${paintYellow('ISO')}             One-time window stop (exclusive)`);
    console.log(`  ${paintGreen('--start-time')} ${paintYellow('HH:MM[:SS]')}    Daily window start`);
    console.log(`  ${paintGreen('--stop-time')} ${paintYellow('HH:MM[:SS]')}     Daily window stop (exclusive)`);
    console.log(`  ${paintGreen('--timezone')} ${paintYellow('IANA')}          Timezone for daily windows (e.g. Asia/Tehran)`);
    console.log(`  ${paintGreen('--no-wait')}                   Exit when outside the schedule window (do not sleep)`);
    console.log(`  ${paintGreen('--dry-run')}                   Preview files and estimated sizes without downloading`);
    console.log(`  ${paintGreen('--config')} ${paintYellow('<FILE>')}           Config file path (default: config.json)`);
    console.log(`  ${paintGreen('--force-login')}               Force fresh login even if stored session is valid`);
    console.log(`  ${paintGreen('--quiet')} | ${paintGreen('-q')}                Less progress noise (still prints errors/summary)`);
    console.log(`  ${paintGreen('--verbose')} | ${paintGreen('-v')}              Verbose debug / HTTP flow info`);
    console.log(`  ${paintGreen('--help')} | ${paintGreen('-h')}                 Show this help and exit`);
    console.log(`  ${paintGreen('--version')}                   Print version and exit`);
    console.log('\n' + paintBold('Config (config.json):'));
    console.log(`    auth.email / auth.password   Login credentials`);
    console.log(`    auth.cookie / auth.cookieFile Manual cookie override`);
    console.log(`    runtime.sampleBytes          Default sample bytes`);
    console.log(`    runtime.retryAttempts        Retry attempts for transient failures`);
    console.log(`    runtime.requestTimeoutMs     Request timeout in ms`);
    console.log(`    runtime.readTimeoutMs        Read timeout in ms`);
    console.log(`    course.baseUrl                   Base URL for slug input`);
    console.log(`    defaults.chapter / defaults.lesson / defaults.dryRun`);
    console.log('\n' + paintBold('Exit codes:'));
    console.log(`  0 success | 1 failure/partial | 2 usage/config | 130 interrupted`);

    // Examples
    console.log('\n' + paintBold('Examples:'));
    console.log('  ' + paintCyan('node download.mjs "<slug>"'));
    console.log('  ' + paintCyan('node download.mjs "https://maktabkhooneh.org/lms/course/<slug>/unit/<unit_id>/"'));
    console.log('  ' + paintCyan('node download.mjs "<slug>" -j 4 -o ./downloads'));
    console.log('  ' + paintCyan('node download.mjs "<slug>" --start-time 02:00 --stop-time 07:00 --timezone Asia/Tehran'));
    console.log('  ' + paintCyan('node download.mjs "<slug>" --start-at 2026-09-15T02:00:00+03:30 --stop-at 2026-09-15T07:00:00+03:30'));
    console.log('  ' + paintCyan('node download.mjs "<slug>" --sample-bytes 65536 --verbose'));
    console.log('  ' + paintCyan('node download.mjs "<slug>" --dry-run'));
    console.log('  ' + paintCyan('node download.mjs "<slug>" --chapter 2 --lesson 2-5,9'));
    console.log('  ' + paintCyan('node download.mjs "<slug>" --config ./config.json'));
    console.log('  ' + paintCyan('node download.mjs "<slug>" --force-login'));
    console.log('');
}

function parseCLI(config = {}, configPath = DEFAULT_CONFIG_FILE) {
    const args = process.argv.slice(2);
    const parsed = parseArgv(args, {
        sampleBytes: parseNonNegativeInt(config.sampleBytes, DEFAULT_SAMPLE_BYTES),
        verbose: !!config.verbose,
        dryRun: !!config.dryRun,
        chapter: config.chapter ?? null,
        lesson: config.lesson ?? null,
        forceLogin: !!config.forceLogin,
        configPath,
        jobs: config.jobs ?? 1,
        outputDir: config.outputDir ?? null,
        startAt: config.startAt ?? null,
        stopAt: config.stopAt ?? null,
        startTime: config.startTime ?? null,
        stopTime: config.stopTime ?? null,
        timezone: config.timezone ?? null,
        noWait: !!config.noWait,
        quiet: !!config.quiet
    });
    if (parsed.help) {
        printUsage();
        process.exit(EXIT.SUCCESS);
    }
    if (parsed.version) {
        console.log('1.1.0');
        process.exit(EXIT.SUCCESS);
    }
    return {
        inputCourseRef: parsed.inputCourseRef,
        sampleBytesToDownload: parsed.sampleBytesToDownload,
        isVerboseLoggingEnabled: parsed.isVerboseLoggingEnabled,
        isDryRun: parsed.isDryRun,
        forceLogin: parsed.forceLogin,
        selectedChapters: parsed.selectedChapters,
        selectedLessons: parsed.selectedLessons,
        configPath: parsed.configPath || configPath,
        jobs: parsed.jobs,
        outputDir: parsed.outputDir,
        schedule: parsed.schedule,
        quiet: parsed.quiet
    };
}

function createVerboseLogger(isVerbose) {
    return {
        verbose: (...a) => {
            if (isVerbose) console.log(...safeLogArgs(a));
        }
    };
}

// Fetch with timeout.
async function fetchWithTimeout(url, options = {}, timeoutMs = 60_000) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {...options, signal: controller.signal});
        return res;
    } finally {
        clearTimeout(t);
    }
}

async function fetchWithRetry(url, options = {}, {
    retries = RUNTIME_CONFIG.retryAttempts,
    timeoutMs = RUNTIME_CONFIG.requestTimeoutMs,
    onRetry,
    allowAuthRecover = true
} = {}) {
    let lastErr = null;
    let authRecovered = false;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await fetchWithTimeout(url, options, timeoutMs);
            if (allowAuthRecover && SESSION_MANAGER && !authRecovered &&
                (res.status === 401 || res.status === 403)) {
                let bodySnippet = '';
                try {
                    bodySnippet = (await res.clone().text()).slice(0, 512);
                } catch {
                    // ignore
                }
                const cls = SESSION_MANAGER.classify({
                    status: res.status,
                    location: res.headers.get('location'),
                    bodySnippet,
                    contentType: res.headers.get('content-type') || ''
                });
                if (cls.recoverable) {
                    const seenGen = SESSION_MANAGER.getGeneration();
                    await SESSION_MANAGER.recover({reason: cls.reason, seenGeneration: seenGen});
                    authRecovered = true;
                    const next = {...options, headers: {...(options.headers || {})}};
                    if (next.headers && typeof next.headers === 'object') {
                        const ck = ACTIVE_COOKIE || COOKIE;
                        if (ck && ck !== 'PUT_YOUR_COOKIE_HERE') next.headers.cookie = ck;
                    }
                    options = next;
                    attempt -= 1;
                    continue;
                }
            }
            if (isRetriableStatus(res.status) && attempt < retries) {
                if (typeof onRetry === 'function') onRetry({attempt, retries, reason: `HTTP ${res.status}`});
                METRICS?.inc('retries');
                await sleep(toBackoffMs(attempt));
                continue;
            }
            return res;
        } catch (err) {
            lastErr = err;
            if (attempt < retries && isRetriableNetworkError(err)) {
                if (typeof onRetry === 'function') onRetry({attempt, retries, reason: err.message || String(err)});
                METRICS?.inc('retries');
                await sleep(toBackoffMs(attempt));
                continue;
            }
            throw err;
        }
    }
    throw lastErr || new Error('Request failed after retries');
}

function ensureTrailingSlash(u) {
    return u.endsWith('/') ? u : u + '/';
}

// Try to detect remote file size and whether server supports Range (auth cookies only for trusted origin).
async function getRemoteSizeAndRanges(url, referer) {
    return probeRemoteSize(url, {
        cookie: ACTIVE_COOKIE || COOKIE,
        referer,
        retries: RUNTIME_CONFIG.retryAttempts,
        requestTimeoutMs: RUNTIME_CONFIG.requestTimeoutMs,
        trustedOrigin: ORIGIN,
        fetchFn: async (u, init, timeoutMs) => fetchWithTimeout(u, init, timeoutMs)
    });
}

function cookieValue(name) {
    return cookieValueFromHeader(ACTIVE_COOKIE || COOKIE || '', name);
}

// LMS video APIs return 403 until the account is enrolled on the course (idempotent).
async function ensureCourseEnrollment(courseSlug, referer) {
    const apiUrl = `${ORIGIN}/api/v1/courses/${courseSlug}/enroll/`;
    const headers = {
        ...commonHeaders(referer, apiUrl),
        accept: 'application/json',
        'content-type': 'application/json'
    };
    const csrf = cookieValue('csrftoken');
    if (csrf) headers['X-CSRFToken'] = csrf;
    const res = await fetchWithRetry(apiUrl, {method: 'POST', headers, body: '{}'});
    if (!res.ok) {
        throw new Error(buildActionableError(
            'ENROLL',
            `Cannot enroll in course (HTTP ${res.status}). LMS video APIs need enrollment.`,
            [
                'Confirm this account purchased/has access to the course.',
                `Retry: node download.mjs "${ACTIONABLE_SLUG_PLACEHOLDER}-mk<id>" --force-login`
            ]
        ));
    }
    return res.json().catch(() => ({}));
}

// API: fetch chapters JSON for a course.
// Tries LMS outline API first when numeric course id is known, then falls back to classic chapters API.
async function fetchChapters(courseSlug, referer, courseId) {
    if (courseId) {
        try {
            const apiUrl = `${ORIGIN}/api/v1/lms/courses/${courseId}/outline/`;
            const res = await fetchWithRetry(apiUrl, {
                method: 'GET',
                headers: {...commonHeaders(referer), accept: 'application/json'}
            });
            if (res.ok) {
                const json = await res.json();
                if (Array.isArray(json?.chapters)) return json;
            }
        } catch {
            // fall through to classic API
        }
    }
    const apiUrl = `${ORIGIN}/api/v1/courses/${courseSlug}/chapters/`;
    const res = await fetchWithRetry(apiUrl, {
        method: 'GET',
        headers: {...commonHeaders(referer), accept: 'application/json'}
    });
    if (!res.ok) {
        if (res.status === 404 && !courseId) {
            throw new Error(buildActionableError(
                'CHAPTERS_404',
                'Course chapters not found (HTTP 404). Slug is incomplete or invalid.',
                [
                    'Use the full slug ending with -mk<id> (example: my-course-mk12029).',
                    'Or paste an LMS URL: https://maktabkhooneh.org/lms/course/<slug>-mk<id>/unit/<unit_id>/'
                ]
            ));
        }
        throw new Error(explainHttpFailure(res.status, 'Fetch chapters'));
    }
    return res.json();
}

async function fetchUnitDetails(unitId, referer) {
    const apiUrl = `${ORIGIN}/api/v1/lms/units/${unitId}/`;
    const res = await fetchWithRetry(apiUrl, {
        method: 'GET',
        headers: {...commonHeaders(referer), accept: 'application/json'}
    });
    if (!res.ok) throw new Error(explainHttpFailure(res.status, 'Fetch unit details'));
    return res.json();
}

async function fetchUnitVideoUrl(unitId, referer) {
    const apiUrl = `${ORIGIN}/api/v1/lms/units/${unitId}/video_url/`;
    const res = await fetchWithRetry(apiUrl, {
        method: 'GET',
        headers: {...commonHeaders(referer, apiUrl), accept: 'application/json'}
    });
    if (!res.ok) throw new Error(explainHttpFailure(res.status, 'Fetch unit video URL'));
    return res.json();
}

async function resolveLmsUnitMedia(unitId, referer) {
    const [videoUrlData, unitDetails] = await Promise.all([
        fetchUnitVideoUrl(unitId, referer).catch(() => null),
        fetchUnitDetails(unitId, referer).catch(() => null)
    ]);
    const bestSourceUrl = pickBestVideoUrl(videoUrlData);
    if (!bestSourceUrl && !unitDetails) return null;
    const captionFile = unitDetails?.has_caption === true ? (unitDetails?.caption_file || null) : null;
    const attachmentLinks = Array.isArray(unitDetails?.resources)
        ? unitDetails.resources.filter(r => r && r.type !== 1 && r.download_url).map(r => r.download_url)
        : [];
    return {
        bestSourceUrl,
        subtitleLinks: captionFile ? [captionFile] : [],
        attachmentLinks,
        captionNeedsFileParam: true
    };
}

// Prefer LMS JSON APIs (classic lecture HTML pages are often 404 now). Fall back to HTML scrape.
async function resolveUnitMedia(unit, {lectureUrl, referer}) {
    const unitId = unitIdOf(unit);
    if (unitId) {
        const lms = await resolveLmsUnitMedia(unitId, referer);
        if (lms?.bestSourceUrl) return lms;
    }

    const res = await fetchWithRetry(lectureUrl, {headers: {...commonHeaders(referer), accept: 'text/html'}});
    if (!res.ok) {
        if (unitId) {
            throw new Error(buildActionableError(
                'UNIT_MEDIA',
                `Cannot fetch video for unit ${unitId} (LMS blocked and lecture page HTTP ${res.status}).`,
                [
                    'Confirm this account has access to the lecture.',
                    'Use the full course slug ending with -mk<id>.',
                    `Retry: node download.mjs "${ACTIONABLE_SLUG_PLACEHOLDER}-mk<id>" --force-login --verbose`
                ]
            ));
        }
        throw new Error(explainHttpFailure(res.status, 'Fetch lecture page'));
    }
    const html = await res.text();
    return {
        bestSourceUrl: pickBestSource(extractVideoSources(html)),
        subtitleLinks: extractSubtitleLinks(html),
        attachmentLinks: extractAttachmentLinks(html),
        captionNeedsFileParam: false
    };
}

// LMS caption URLs often end with "?file=" — frontend fills in the download filename.
function withCaptionFileParam(captionUrl, subtitleName) {
    try {
        const u = new URL(captionUrl, ORIGIN);
        const fileParam = u.searchParams.get('file');
        if (fileParam === '' || fileParam == null) u.searchParams.set('file', subtitleName);
        return u.toString();
    } catch {
        return captionUrl;
    }
}

// API: core-data to verify authentication and basic profile.
async function fetchCoreData(referer, {allowAuthRecover = true} = {}) {
    const url = `${ORIGIN}/api/v1/general/core-data/?profile=1`;
    const res = await fetchWithRetry(url, {
        method: 'GET',
        headers: {...commonHeaders(referer || ORIGIN), accept: 'application/json'}
    }, {allowAuthRecover});
    if (!res.ok) throw new Error(explainHttpFailure(res.status, 'Auth check (core-data)'));
    return res.json();
}

function printProfileSummary(core) {
    const isAuthenticated = !!core?.auth?.details?.is_authenticated;
    const email = core?.auth?.details?.email || core?.profile?.details?.email || '-';
    const userId = core?.auth?.details?.user_id ?? '-';
    const studentId = core?.auth?.details?.student_id ?? '-';
    const hasSubscription = !!core?.auth?.conditions?.has_subscription;
    const hasCoursePurchase = !!core?.auth?.conditions?.has_course_purchase;
    const statusText = isAuthenticated ? paintGreen('Authenticated') : paintRed('NOT authenticated');
    console.log(`🔐 Auth check: ${statusText}`);
    console.log(`👤 User: ${paintCyan(email)}  | user_id: ${paintCyan(userId)}  | student_id: ${paintCyan(studentId)}`);
    console.log(`💳 Subscription: ${hasSubscription ? paintGreen('yes') : paintYellow('no')}  | Has course purchase: ${hasCoursePurchase ? paintGreen('yes') : paintYellow('no')}`);
    return isAuthenticated;
}

// Build lecture page URL for a specific chapter/unit.
// Prefer LMS unit URL when unit id exists (classic course/.../unit-slug pages are often 404).
function buildLectureUrl(courseSlug, chapter, unit) {
    const unitId = unitIdOf(unit);
    if (unitId) {
        return `${ORIGIN}/lms/course/${encodeURIComponent(courseSlug)}/unit/${unitId}/`;
    }
    const chapterSegment = `${encodeURIComponent(chapter.slug)}-ch${chapter.id}`;
    const unitSegment = encodeURIComponent(unit.slug);
    return `${ORIGIN}/course/${courseSlug}/${chapterSegment}/${unitSegment}/`;
}

// Minimal HTML entities decoder for attribute values.
function decodeHtmlEntities(str) {
    if (!str) return str;
    return str
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// Extract <source ... src="..."> URLs from lecture page HTML.
function extractVideoSources(html) {
    const urls = [];
    const re = /<source\b[^>]*?src=["']([^"'>]+)["'][^>]*>/gim;
    let m;
    while ((m = re.exec(html)) !== null) {
        const raw = m[1];
        const url = decodeHtmlEntities(raw);
        if (url && url.includes('/videos/')) urls.push(url);
    }
    return Array.from(new Set(urls));
}

// Pick best source, prefer HQ.
function pickBestSource(urls) {
    if (!urls || urls.length === 0) return null;
    const hq = urls.find(u => /\/videos\/hq\d+/.test(u) || u.includes('/videos/hq'));
    return hq || urls[0];
}

// Extract attachment links from lecture HTML.
function extractAttachmentLinks(html) {
    const results = new Set();
    if (!html) return [];
    // Regex to capture <div class="...unit-content--download..."> ... <a href="..."> inside
    const blockRe = /<div[^>]*class=["'][^"'>]*unit-content--download[^"'>]*["'][^>]*>[\s\S]*?<\/div>/gim;
    let m;
    while ((m = blockRe.exec(html)) !== null) {
        const block = m[0];
        // Find anchor hrefs inside this block
        const aRe = /<a[^>]+href=["']([^"'>]+)["'][^>]*>/gim;
        let a;
        while ((a = aRe.exec(block)) !== null) {
            const raw = a[1];
            const url = decodeHtmlEntities(raw);
            if (url && /attachments/i.test(url)) {
                results.add(url);
            }
        }
    }
    return Array.from(results);
}

// --- Session / Login helpers ---

async function fetchJson(url, referer) {
    const res = await fetchWithRetry(url, {headers: {...commonHeaders(referer), accept: 'application/json'}});
    const text = await res.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {
    }
    return {res, text, json};
}

function extractSetCookie(res) {
    // Node fetch in Node 18 does not expose raw set-cookie headers directly. We rely on cookie from config or inline login.
    return null;
}

async function obtainCsrfToken() {
    const {json} = await fetchJson(`${ORIGIN}/api/v1/general/core-data/?profile=1`, ORIGIN);
    let csrf = json?.auth?.csrf;
    // Try to parse cookie from ACTIVE_COOKIE fallback
    if (!csrf) {
        // Not critical; some endpoints may still set it later.
    }
    return csrf;
}

// Manual minimal cookie store (in-memory) for login flow only
class SimpleCookieStore {
    constructor() {
        this.map = new Map();
    }

    setCookieLine(line) {
        if (!line) return;
        const seg = line.split(';')[0];
        const eq = seg.indexOf('=');
        if (eq === -1) return;
        const k = seg.slice(0, eq).trim();
        const v = seg.slice(eq + 1).trim();
        if (k) this.map.set(k, v);
    }

    applySetCookie(arr) {
        (arr || []).forEach(l => this.setCookieLine(l));
    }

    get(name) {
        return this.map.get(name);
    }

    headerString() {
        return Array.from(this.map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
    }
}

function rawRequest(urlStr, {method = 'GET', headers = {}, body = null} = {}) {
    const u = new URL(urlStr);
    return new Promise((resolve, reject) => {
        const opts = {
            method,
            hostname: u.hostname,
            path: u.pathname + (u.search || ''),
            protocol: u.protocol,
            headers
        };
        const req = https.request(opts, (res) => {
            const chunks = [];
            res.setTimeout(RUNTIME_CONFIG.readTimeoutMs, () => req.destroy(new Error(`Read timeout after ${RUNTIME_CONFIG.readTimeoutMs}ms`)));
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                resolve({
                    status: res.statusCode || 0,
                    headers: res.headers,
                    body: Buffer.concat(chunks).toString('utf8')
                });
            });
        });
        req.setTimeout(RUNTIME_CONFIG.requestTimeoutMs, () => req.destroy(new Error(`Request timeout after ${RUNTIME_CONFIG.requestTimeoutMs}ms`)));
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

async function rawRequestWithRetry(urlStr, reqOpts = {}, verbose = () => {
}) {
    let lastErr = null;
    for (let attempt = 1; attempt <= RUNTIME_CONFIG.retryAttempts; attempt++) {
        try {
            const r = await rawRequest(urlStr, reqOpts);
            if (isRetriableStatus(r.status) && attempt < RUNTIME_CONFIG.retryAttempts) {
                verbose(`[retry] ${reqOpts.method || 'GET'} ${urlStr} -> HTTP ${r.status} (attempt ${attempt}/${RUNTIME_CONFIG.retryAttempts})`);
                await sleep(toBackoffMs(attempt));
                continue;
            }
            return r;
        } catch (err) {
            lastErr = err;
            if (attempt < RUNTIME_CONFIG.retryAttempts && isRetriableNetworkError(err)) {
                verbose(`[retry] ${reqOpts.method || 'GET'} ${urlStr} -> ${err.message} (attempt ${attempt}/${RUNTIME_CONFIG.retryAttempts})`);
                await sleep(toBackoffMs(attempt));
                continue;
            }
            throw err;
        }
    }
    throw lastErr || new Error('Raw request failed after retries');
}

async function loginWithCredentialsInline(email, password, verbose = () => {
}) {
    if (!email || !password) {
        throw new Error(buildActionableError(
            'LOGIN_INPUT',
            'Email and password are required for login.',
            'Set auth.email and auth.password in config.json, then retry with --force-login.'
        ));
    }
    const store = new SimpleCookieStore();
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';
    const dbg = (...a) => verbose('[login]', ...a);
    const referer = `${ORIGIN}/`;

    // CSRF: prefer core-data (login HTML page is often 404 / flaky). Optionally warm cookies from homepage.
    let csrf = null;
    try {
        const rHome = await rawRequestWithRetry(`${ORIGIN}/`, {
            method: 'GET',
            headers: {'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'}
        }, verbose);
        store.applySetCookie(rHome.headers['set-cookie']);
        csrf = store.get('csrftoken') || null;
    } catch (e) {
        dbg('Homepage warm-up skipped:', e.message);
    }

    const rCore = await rawRequestWithRetry(`${ORIGIN}/api/v1/general/core-data/?profile=1`, {
        method: 'GET',
        headers: {
            'User-Agent': UA,
            'Accept': 'application/json',
            ...(store.headerString() ? {Cookie: store.headerString()} : {})
        }
    }, verbose);
    store.applySetCookie(rCore.headers['set-cookie']);
    try {
        const jCore = JSON.parse(rCore.body);
        csrf = csrf || jCore?.auth?.csrf || null;
    } catch {
    }
    csrf = csrf || store.get('csrftoken') || null;
    dbg('CSRF bootstrap status:', rCore.status);

    if (!csrf) {
        throw new Error(buildActionableError(
            'LOGIN_CSRF',
            'Cannot obtain CSRF token from server.',
            [
                'Your session/cookie may be stale or blocked.',
                `Retry: node download.mjs "${ACTIONABLE_URL_PLACEHOLDER}" --force-login --verbose`
            ]
        ));
    }
    dbg('CSRF token:', csrf.slice(0, 8) + '...');

    const cookieHeader = () => store.headerString();
    const baseHeaders = () => ({
        'User-Agent': UA,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'X-Requested-With': 'XMLHttpRequest'
    });
    const addCsrfHeaders = (h = {}) => ({
        ...h,
        'X-CSRFToken': csrf,
        'Origin': ORIGIN,
        'Referer': referer
    });

    // 1. check-active-user
    const formCheck = new URLSearchParams();
    formCheck.append('csrfmiddlewaretoken', csrf);
    formCheck.append('tessera', email);
    formCheck.append('g-recaptcha-response', '');
    let r = await rawRequestWithRetry(`${ORIGIN}/api/v1/auth/check-active-user`, {
        method: 'POST',
        headers: addCsrfHeaders({
            ...baseHeaders(),
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Cookie': cookieHeader()
        }),
        body: formCheck.toString()
    }, verbose);
    store.applySetCookie(r.headers['set-cookie']);
    if (r.status < 200 || r.status >= 300) {
        throw new Error(explainHttpFailure(r.status, 'Login step check-active-user'));
    }
    let jCheck = null;
    try {
        jCheck = JSON.parse(r.body);
    } catch {
    }
    if (!jCheck) {
        dbg('check-active-user raw body:', r.body.slice(0, 300));
        throw new Error(buildActionableError(
            'LOGIN_CHECK_JSON',
            `check-active-user returned invalid JSON (HTTP ${r.status}).`,
            'Retry with --verbose. If it persists, retry later.'
        ));
    }
    dbg('check-active-user response:', jCheck.status, jCheck.message);
    if (jCheck.status !== 'success') {
        throw new Error(buildActionableError(
            'LOGIN_CHECK_FAILED',
            `check-active-user failed (status=${jCheck.status}, message=${jCheck.message}).`,
            'Verify auth.email in config.json, then retry with --force-login.'
        ));
    }
    if (jCheck.message !== 'get-pass') {
        throw new Error(buildActionableError(
            'LOGIN_FLOW',
            `Unsupported login flow (expected get-pass, got ${jCheck.message}).`,
            'Run with --verbose and update script if site login flow changed.'
        ));
    }
    dbg('check-active-user OK');

    // 2. login-authentication
    const formLogin = new URLSearchParams();
    formLogin.append('csrfmiddlewaretoken', csrf);
    formLogin.append('tessera', email);
    formLogin.append('hidden_username', email);
    formLogin.append('password', password);
    formLogin.append('g-recaptcha-response', '');
    r = await rawRequestWithRetry(`${ORIGIN}/api/v1/auth/login-authentication`, {
        method: 'POST',
        headers: addCsrfHeaders({
            ...baseHeaders(),
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Cookie': cookieHeader()
        }),
        body: formLogin.toString()
    }, verbose);
    store.applySetCookie(r.headers['set-cookie']);
    if (r.status < 200 || r.status >= 300) {
        throw new Error(explainHttpFailure(r.status, 'Login step login-authentication'));
    }
    let jLogin = null;
    try {
        jLogin = JSON.parse(r.body);
    } catch {
    }
    if (!jLogin) {
        dbg('login-authentication raw body:', r.body.slice(0, 300));
        throw new Error(buildActionableError(
            'LOGIN_AUTH_JSON',
            `login-authentication returned invalid JSON (HTTP ${r.status}).`,
            'Retry with --verbose. If it persists, try again later.'
        ));
    }
    dbg('login-authentication response:', jLogin.status, jLogin.message);
    if (jLogin.status !== 'success') {
        throw new Error(buildActionableError(
            'LOGIN_AUTH_FAILED',
            `login-authentication failed (message=${jLogin.message}).`,
            'Check auth.email/auth.password in config.json and retry with --force-login.'
        ));
    }
    dbg('login-authentication OK');

    const sessionid = store.get('sessionid');
    const csrftoken = store.get('csrftoken') || csrf;
    if (!sessionid) {
        throw new Error(buildActionableError(
            'LOGIN_COOKIE',
            'Session cookie (sessionid) is missing after login.',
            'Retry with --verbose. Server response/cookies may have changed.'
        ));
    }
    ACTIVE_COOKIE = `csrftoken=${csrftoken}; sessionid=${sessionid}`;
    dbg('ACTIVE_COOKIE prepared');
    return true;
}

async function prepareSession({userEmail, userPassword, verbose, courseUrl, forceLogin, config, configPath}) {
    // Helper to verify current ACTIVE_COOKIE by calling core-data
    const verify = async () => {
        try {
            if (!ACTIVE_COOKIE) return null;
            verbose('Verifying existing session cookie...');
            const core = await fetchCoreData(courseUrl || ORIGIN);
            const ok = !!core?.auth?.details?.is_authenticated;
            if (ok) {
                logInfo('Session valid' + (userEmail ? ` (user: ${userEmail})` : ''));
                return core;
            }
            logWarn('Stored session is expired/invalid (not authenticated).');
            return null;
        } catch (e) {
            verbose('Verify failed: ' + e.message);
            return null;
        }
    };

    const authCfg = (config.auth && typeof config.auth === 'object') ? config.auth : (config.auth = {});
    const storedSessionCookie = String(authCfg.sessionCookie || '').trim();

    // 1. Explicit cookie override from config has highest priority
    if (COOKIE && COOKIE !== 'PUT_YOUR_COOKIE_HERE') {
        ACTIVE_COOKIE = COOKIE;
        verbose('Using cookie from config override');
        const core = await verify();
        if (core) return {core, source: 'config-cookie'};
        if (!forceLogin) {
            logWarn('Cookie from config.auth.cookie/cookieFile is invalid; trying stored session/login fallback.');
        }
    }

    // 2. Reuse session persisted in config.auth.sessionCookie
    if (storedSessionCookie && !forceLogin) {
        ACTIVE_COOKIE = storedSessionCookie;
        logStep('Loaded stored session from config.auth.sessionCookie');
        const core = await verify();
        if (core) return {core, source: 'config-session'};
        logWarn('Stored config session is invalid; will attempt fresh login.');
        ACTIVE_COOKIE = null;
    }

    // 3. Login with credentials and persist session back into config
    if (userEmail && userPassword && (!ACTIVE_COOKIE || forceLogin)) {
        try {
            logStep('Attempting login for ' + userEmail.trim().toLowerCase());
            await loginWithCredentialsInline(userEmail, userPassword, verbose);
            if (ACTIVE_COOKIE) {
                authCfg.sessionCookie = ACTIVE_COOKIE;
                authCfg.sessionUpdated = new Date().toISOString();
                authCfg.sessionGeneration = Number(authCfg.sessionGeneration || 0) + 1;
                await persistConfig(configPath, config);
                logSuccess('Login success; session saved to config.auth.sessionCookie');
            }
            const core = await verify();
            if (core) return {core, source: 'fresh-login'};
        } catch (e) {
            logWarn('Inline login failed: ' + e.message);
        }
    }

    // 4. If we reach here, maybe we still have ACTIVE_COOKIE but verification failed or no cookie
    if (!ACTIVE_COOKIE) {
        logWarn(buildActionableError(
            'SESSION_INVALID',
            'No usable session found in config, or stored session is expired.',
            [
                'Set auth.email and auth.password in config.json',
                `Then run: node download.mjs "${trimUrlForHint(courseUrl)}" --force-login`
            ]
        ));
    }
    return {core: null, source: 'none'};
}

// Extract <track ... src="..."> subtitle URLs from lecture HTML.
function extractSubtitleLinks(html) {
    const results = new Set();
    if (!html) return [];
    const re = /<track\b[^>]*?src=["']([^"'>]+)["'][^>]*>/gim;
    let m;
    while ((m = re.exec(html)) !== null) {
        const raw = m[1];
        const url = decodeHtmlEntities(raw);
        if (url) results.add(url);
    }
    return Array.from(results);
}

// Download a URL to a file via hardened streaming engine (auth cookies origin-scoped).
async function downloadToFile(url, filePath, referer, maxRetries = RUNTIME_CONFIG.retryAttempts, sampleBytes = 0, label = '', expectedKind = 'video', outputRoot = null, {
    signal = null,
    scheduleGate = null,
    quiet = false,
    concurrent = false
} = {}) {
    const isTTY = process.stdout.isTTY && !quiet && !concurrent;
    const truncate = (s, max = 70) => {
        if (!s) return '';
        const str = stripControlChars(String(s));
        return str.length > max ? str.slice(0, max - 1) + '…' : str;
    };
    const render = (ratio, downloadedBytes, expectedTotal, name) => {
        if (!isTTY && ratio < 1) return;
        const bar = buildProgressBar(ratio || 0);
        const pct = expectedTotal ? `${(Math.min(1, ratio || 0) * 100).toFixed(1)}%` : (ratio >= 1 ? '100.0%' : '--%');
        const sizeStr = `${formatBytes(downloadedBytes)}${expectedTotal ? ' / ' + formatBytes(expectedTotal) : ''}`;
        const nm = name ? `  -  ${truncate(name, 80)}` : '';
        const line = `  ⬇️  [${bar}] ${pct}  ${sizeStr}${nm}`;
        if (isTTY) process.stdout.write(`\r${line}`);
        else if (ratio >= 1) process.stdout.write(`${line}\n`);
    };
    try {
        const status = await engineDownloadToFile(url, filePath, {
            cookie: ACTIVE_COOKIE || COOKIE,
            referer,
            maxRetries,
            sampleBytes,
            label,
            expectedKind,
            outputRoot,
            deps: {
                trustedOrigin: ORIGIN,
                requestTimeoutMs: RUNTIME_CONFIG.requestTimeoutMs,
                readTimeoutMs: RUNTIME_CONFIG.readTimeoutMs,
                onWarn: (m) => logWarn(m),
                onProgress: (ratio, got, total, name) => render(ratio, got, total, name || label),
                fetchFn: async (u, init, timeoutMs) => fetchWithTimeout(u, init, timeoutMs),
                signal,
                scheduleGate,
                getCookie: () => ACTIVE_COOKIE || COOKIE,
                session: SESSION_MANAGER
            }
        });
        if (isTTY) process.stdout.write('\n');
        return status;
    } catch (err) {
        if (isTTY) {
            try {
                process.stdout.write('\n');
            } catch {
            }
        }
        throw err;
    }
}

function toAbsoluteUrl(url, base = ORIGIN) {
    try {
        return new URL(url, base).toString();
    } catch {
        return url;
    }
}

async function main() {
    const argv = process.argv.slice(2);
    const {path: configArgPath, explicit: configPathExplicit} = discoverConfigPath(argv);
    const {config, configPath, exists: configExists} = loadConfigFile(configArgPath);
    if (configPathExplicit && !configExists) {
        logError(buildActionableError(
            'CONFIG_MISSING',
            `Config file not found: ${configPath}`,
            'Create the file, or omit --config to use ./config.json.'
        ));
        process.exit(1);
    }
    const runtimeCfg = (config.runtime && typeof config.runtime === 'object') ? config.runtime : {};
    const defaultsCfg = (config.defaults && typeof config.defaults === 'object') ? config.defaults : {};
    const authCfg = (config.auth && typeof config.auth === 'object') ? config.auth : {};
    const courseCfg = (config.course && typeof config.course === 'object') ? config.course : {};
    const parserDefaults = {
        sampleBytes: runtimeCfg.sampleBytes ?? defaultsCfg.sampleBytes ?? 0,
        verbose: defaultsCfg.verbose ?? false,
        dryRun: defaultsCfg.dryRun ?? false,
        chapter: defaultsCfg.chapter ?? null,
        lesson: defaultsCfg.lesson ?? null,
        forceLogin: defaultsCfg.forceLogin ?? false
    };
    const {
        inputCourseRef,
        sampleBytesToDownload,
        isVerboseLoggingEnabled,
        isDryRun,
        forceLogin,
        selectedChapters,
        selectedLessons,
        jobs,
        outputDir,
        schedule,
        quiet
    } = parseCLI(parserDefaults, configPath);
    LOGIN_EMAIL = String(authCfg.email || '').trim();
    LOGIN_PASSWORD = String(authCfg.password || '').trim();
    if (authCfg.cookie && String(authCfg.cookie).trim()) {
        COOKIE = String(authCfg.cookie).trim();
    } else if (authCfg.cookieFile) {
        try {
            COOKIE = fs.readFileSync(String(authCfg.cookieFile), 'utf8').trim() || 'PUT_YOUR_COOKIE_HERE';
        } catch {
            COOKIE = 'PUT_YOUR_COOKIE_HERE';
        }
    } else {
        COOKIE = 'PUT_YOUR_COOKIE_HERE';
    }
    RUNTIME_CONFIG = validateRuntimeConfig(runtimeCfg);
    const userEmail = LOGIN_EMAIL || null;
    const userPassword = LOGIN_PASSWORD || null;
    const {verbose} = createVerboseLogger(isVerboseLoggingEnabled);
    if (!inputCourseRef) {
        printUsage();
        process.exit(EXIT.USAGE);
    }
    let baseUrl;
    try {
        baseUrl = validateCourseBaseUrl(courseCfg.baseUrl || `${ORIGIN}/course/`);
    } catch (e) {
        logError(buildActionableError(
            'CONFIG_BASEURL',
            e.message,
            'Set course.baseUrl to https://maktabkhooneh.org/course/'
        ));
        process.exit(1);
    }
    const resolvedCourseUrl = isLikelyFullUrl(inputCourseRef)
        ? String(inputCourseRef).trim()
        : buildCourseUrlFromSlug(baseUrl, inputCourseRef);
    if (!resolvedCourseUrl) {
        logError(buildActionableError(
            'COURSE_INPUT',
            'Course slug/url is missing.',
            [
                `Pass slug in CLI: node download.mjs "${ACTIONABLE_SLUG_PLACEHOLDER}"`,
                `Or pass full URL: node download.mjs "${ACTIONABLE_URL_PLACEHOLDER}"`
            ]
        ));
        process.exit(1);
    }
    verbose(`Config file: ${configPath}${fs.existsSync(configPath) ? '' : ' (not found, using defaults)'}`);
    verbose(`Resolved course URL: ${resolvedCourseUrl}`);
    verbose(`Runtime config => retries=${RUNTIME_CONFIG.retryAttempts}, request-timeout=${RUNTIME_CONFIG.requestTimeoutMs}ms, read-timeout=${RUNTIME_CONFIG.readTimeoutMs}ms`);
    const normalizedCourseUrl = toHeaderSafeUrl(ensureTrailingSlash(resolvedCourseUrl.trim()));
    const courseSlug = extractCourseSlug(normalizedCourseUrl);
    const courseId = extractCourseIdFromSlug(courseSlug);
    const urlIsLmsFormat = /\/lms\/course\//.test(normalizedCourseUrl);

    // Validate output path before any network I/O
    const courseDisplayName = normalizeCourseFolderNameFromSlug(courseSlug);
    let outputRootFolder;
    try {
        ({outputRoot: outputRootFolder} = resolveCourseOutputRoot({
            outputDir,
            courseDisplayName,
            cwd: process.cwd()
        }));
    } catch (e) {
        logError(String(e.message || e));
        process.exit(EXIT.USAGE);
    }

    const runAbort = new AbortController();
    let interrupted = false;
    const onInterrupt = () => {
        if (interrupted) return;
        interrupted = true;
        logWarn('Interrupt received — stopping new work and cancelling active downloads...');
        try {
            runAbort.abort();
        } catch {
            // ignore
        }
    };
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onInterrupt);

    const scheduleGate = createScheduleGate(schedule, {
        onStatus: (st) => {
            if (quiet && st.phase === 'active') return;
            if (st.phase === 'waiting_start' || st.phase === 'waiting_daily') {
                logInfo(st.message);
            } else if (st.phase === 'stopping') {
                logWarn(`Schedule boundary: ${st.message}`);
            } else if (st.phase === 'active' && schedule) {
                logInfo(st.message);
            }
        }
    });

    // Schedule gate before login / metadata / downloads (no intentional HTTP outside window)
    try {
        await waitUntilAllowed(schedule, {
            signal: runAbort.signal,
            onStatus: (st) => {
                if (st.phase === 'waiting_start' || st.phase === 'waiting_daily') logInfo(st.message);
                else if (st.phase === 'active' && schedule) logInfo(st.message);
            }
        });
    } catch (e) {
        if (e?.code === 'INTERRUPTED' || interrupted) {
            logWarn('Interrupted while waiting for schedule window');
            process.exit(EXIT.INTERRUPTED);
        }
        if (e instanceof ScheduleError || e?.name === 'ScheduleError') {
            logError(buildActionableError(
                e.code || 'SCHEDULE',
                e.message,
                schedule?.noWait
                    ? 'Omit --no-wait to wait for the next window, or adjust the schedule flags.'
                    : 'Fix schedule flags, or omit them to run immediately.'
            ));
            process.exit(EXIT.USAGE);
        }
        throw e;
    }

    // Attempt to load / create / verify session (may already return core)
    const prep = await prepareSession({
        userEmail,
        userPassword,
        verbose,
        courseUrl: normalizedCourseUrl,
        forceLogin,
        config,
        configPath
    });
    ensureCookiePresent();

    METRICS = createMetrics();
    SESSION_MANAGER = createSessionManager({
        getCookie: () => ACTIVE_COOKIE || COOKIE,
        setCookie: (ck) => {
            ACTIVE_COOKIE = ck;
        },
        loginFn: async () => {
            if (!(userEmail && userPassword)) {
                throw new Error('Cannot re-login: auth.email/auth.password not configured');
            }
            await loginWithCredentialsInline(userEmail, userPassword, verbose);
            if (!ACTIVE_COOKIE) throw new Error('Re-login produced no session cookie');
            return ACTIVE_COOKIE;
        },
        validateFn: async (ck) => {
            const prev = ACTIVE_COOKIE;
            ACTIVE_COOKIE = ck;
            try {
                const core = await fetchCoreData(normalizedCourseUrl, {allowAuthRecover: false});
                return !!core?.auth?.details?.is_authenticated;
            } catch {
                return false;
            } finally {
                ACTIVE_COOKIE = ck || prev;
            }
        }, persistFn: async (ck, generation) => {
            const authCfg = (config.auth && typeof config.auth === 'object') ? config.auth : (config.auth = {});
            // Generation fence: refuse to write if a newer session was already persisted
            const prevGen = Number(authCfg.sessionGeneration) || 0;
            if (generation < prevGen) return;
            authCfg.sessionCookie = ck;
            authCfg.sessionUpdated = new Date().toISOString();
            authCfg.sessionGeneration = generation;
            await persistConfig(configPath, config);
        },
        scheduleGate,
        onInfo: (msg) => logInfo(msg),
        onWarn: (msg) => logWarn(msg),
        metrics: METRICS.raw,
        cooldownMs: 5_000,
        maxFailures: 3
    });

    // Ensure base output folder exists only for real downloads (after auth)
    if (!isDryRun) {
        try {
            await ensureOutputDirectory(outputRootFolder);
        } catch (e) {
            logError(String(e.message || e));
            process.exit(EXIT.FAILURE);
        }
    }

    // Verify auth profile (reuse from prepareSession if available)
    let coreData = prep.core;
    if (!coreData) {
        try {
            coreData = await fetchCoreData(normalizedCourseUrl);
        } catch (e) {
            logError(buildActionableError(
                'AUTH_VERIFY',
                `Failed to verify authentication. ${e.message}`,
                [
                    `Retry login: node download.mjs "${trimUrlForHint(normalizedCourseUrl)}" --force-login`,
                    'Or set auth.email/auth.password in config.json if missing.'
                ]
            ));
            process.exit(1);
        }
    }
    const ok = printProfileSummary(coreData);
    if (!ok) {
        logError(buildActionableError(
            'AUTH_REQUIRED',
            'Not logged in. Session is invalid/expired.',
            [
                `Run: node download.mjs "${trimUrlForHint(normalizedCourseUrl)}" --force-login`,
                'Or set auth.email/auth.password (or auth.cookie) in config.json.'
            ]
        ));
        process.exit(1);
    }

    console.log(`📚 Course slug: ${paintBold(decodeURIComponent(courseSlug))}`);
    console.log(`📁 Output folder: ${paintCyan(outputRootFolder)}`);
    if (jobs > 1) console.log(`⚙️ Jobs: ${paintBold(String(jobs))}`);
    if (schedule) {
        const mode = schedule.mode === 'once' ? 'one-time' : `daily (${schedule.timezone})`;
        console.log(`🗓️ Schedule: ${paintCyan(mode)}`);
    }
    if (sampleBytesToDownload && sampleBytesToDownload > 0) {
        console.log(`🎯 Sample mode: downloading first ${paintBold(String(sampleBytesToDownload))} bytes of each video (saved as .sample.mp4)`);
    }
    if (selectedChapters) {
        console.log(`🧭 Chapter filter: ${paintCyan(Array.from(selectedChapters).sort((a, b) => a - b).join(', '))}`);
    }
    if (selectedLessons) {
        console.log(`🧭 Lesson filter: ${paintCyan(Array.from(selectedLessons).sort((a, b) => a - b).join(', '))}`);
    }
    if (isDryRun) {
        console.log(`🧪 Mode: ${paintYellow('DRY RUN')} (no files will be downloaded)`);
    }

    // Activate LMS access (required before video_url / outline work)
    verbose(paintCyan('Ensuring course enrollment...'));
    try {
        const enrolled = await ensureCourseEnrollment(courseSlug, normalizedCourseUrl);
        const access = enrolled?.access_level_text || enrolled?.access_level;
        if (access) console.log(`🎫 Course access: ${paintGreen(access)}`);
        else verbose('Enrollment OK');
    } catch (e) {
        logWarn(String(e.message || e));
        verbose('Continuing without fresh enrollment (may already be enrolled)');
    }

    // Fetch chapters
    verbose(paintCyan('Fetching chapters...'));
    if (courseId) verbose(`Course id from slug: ${courseId}`);
    const chaptersData = await fetchChapters(courseSlug, normalizedCourseUrl, courseId);
    const chapters = Array.isArray(chaptersData?.chapters) ? chaptersData.chapters : [];
    if (chapters.length === 0) {
        logError(buildActionableError(
            'CHAPTERS_EMPTY',
            'No chapters returned for this course URL.',
            [
                'Check that the URL is a valid course page.',
                'Ensure this account has access to the course.',
                `Retry: node download.mjs "${trimUrlForHint(normalizedCourseUrl)}" --force-login`
            ]
        ));
        process.exit(2);
    }
    const useNewFormat = detectNewUnitFormat(chapters, urlIsLmsFormat);
    if (useNewFormat) verbose('Using LMS outline unit format');
    else verbose('Using classic chapters format (LMS media APIs still preferred per unit)');

    if (isDryRun) {
        let totalLectures = 0;
        let totalLocked = 0;
        let totalUnknownSize = 0;
        let totalSubtitleCount = 0;
        let totalAttachmentCount = 0;
        let totalKnownBytes = 0;
        console.log('—'.repeat(40));
        console.log(paintBold('Dry-run preview (estimated sizes):'));
        console.log(`📁 Planned output root: ${paintCyan(outputRootFolder)}`);
        for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex++) {
            const chapter = chapters[chapterIndex];
            const chapterNo = chapterIndex + 1;
            if (selectedChapters && !selectedChapters.has(chapterNo)) continue;
            const chapterFolderName = `فصل ${chapterNo} - ${sanitizeName(chapter.title || chapter.slug || 'chapter')}`;
            const chapterFolder = path.join(outputRootFolder, chapterFolderName);
            assertOutputPathSafe(outputRootFolder, chapterFolder);
            const units = getChapterUnits(chapter);
            let chapterLectureNo = 0;
            let chapterKnownBytes = 0;
            let chapterUnknownSize = 0;
            let chapterLocked = 0;
            let chapterSelected = 0;
            let chapterSubtitleCount = 0;
            let chapterAttachmentCount = 0;
            console.log(`\n📖 Chapter ${chapterNo}: ${paintBold(chapter.title || chapter.slug)}`);
            console.log(`📂 Output: ${paintCyan(chapterFolder)}`);
            for (let unitIndex = 0; unitIndex < units.length; unitIndex++) {
                const unit = units[unitIndex];
                if (!isUnitActive(unit) || !isVideoLecture(unit)) continue;
                chapterLectureNo++;
                if (selectedLessons && !selectedLessons.has(chapterLectureNo)) continue;
                chapterSelected++;
                totalLectures++;
                const unitNo = chapterLectureNo;
                const baseFileName = `قسمت ${unitNo} - ${sanitizeName(unit.title || unit.slug || 'lecture')}.mp4`;
                const finalFileName = (sampleBytesToDownload && sampleBytesToDownload > 0)
                    ? baseFileName.replace(/\.mp4$/i, '.sample.mp4')
                    : baseFileName;
                if (isUnitLocked(unit)) {
                    chapterLocked++;
                    totalLocked++;
                    console.log(`  🔒 ${finalFileName}  | locked / no access`);
                    continue;
                }
                const lectureUrl = buildLectureUrl(courseSlug, chapter, unit);
                try {
                    const media = await resolveUnitMedia(unit, {lectureUrl, referer: normalizedCourseUrl});
                    const bestSourceUrl = media.bestSourceUrl;
                    if (!bestSourceUrl) {
                        console.log(`  ⚠️ ${finalFileName}  | no video source found`);
                        chapterUnknownSize++;
                        totalUnknownSize++;
                        continue;
                    }
                    const videoInfo = await getRemoteSizeAndRanges(bestSourceUrl, lectureUrl);
                    const videoBytes = Number.isFinite(videoInfo?.size) ? videoInfo.size : null;
                    const subtitleLinks = media.subtitleLinks.map(s => toAbsoluteUrl(s, ORIGIN));
                    const attachmentLinks = media.attachmentLinks.map(a => toAbsoluteUrl(a, ORIGIN));
                    let subtitleKnownBytes = 0;
                    let subtitleUnknown = 0;
                    let attachmentKnownBytes = 0;
                    let attachmentUnknown = 0;
                    for (const sUrl of subtitleLinks) {
                        const info = await getRemoteSizeAndRanges(sUrl, lectureUrl);
                        if (Number.isFinite(info?.size)) subtitleKnownBytes += info.size;
                        else subtitleUnknown++;
                    }
                    for (const aUrl of attachmentLinks) {
                        const info = await getRemoteSizeAndRanges(aUrl, lectureUrl);
                        if (Number.isFinite(info?.size)) attachmentKnownBytes += info.size;
                        else attachmentUnknown++;
                    }
                    chapterSubtitleCount += subtitleLinks.length;
                    chapterAttachmentCount += attachmentLinks.length;
                    totalSubtitleCount += subtitleLinks.length;
                    totalAttachmentCount += attachmentLinks.length;
                    const unitKnownBytes =
                        (videoBytes || 0) +
                        subtitleKnownBytes +
                        attachmentKnownBytes;
                    const unitUnknownCount =
                        (videoBytes == null ? 1 : 0) +
                        subtitleUnknown +
                        attachmentUnknown;
                    chapterKnownBytes += unitKnownBytes;
                    totalKnownBytes += unitKnownBytes;
                    if (unitUnknownCount > 0) {
                        chapterUnknownSize++;
                        totalUnknownSize++;
                    }
                    const unitOutPath = path.join(chapterFolder, finalFileName);
                    const videoText = videoBytes == null ? 'unknown' : formatBytes(videoBytes);
                    const subtitleText = subtitleLinks.length === 0
                        ? 'none'
                        : `${subtitleLinks.length} file(s), ${formatBytes(subtitleKnownBytes)}${subtitleUnknown ? ` + ${subtitleUnknown} unknown` : ''}`;
                    const attachmentText = attachmentLinks.length === 0
                        ? 'none'
                        : `${attachmentLinks.length} file(s), ${formatBytes(attachmentKnownBytes)}${attachmentUnknown ? ` + ${attachmentUnknown} unknown` : ''}`;
                    const totalText = `${formatBytes(unitKnownBytes)}${unitUnknownCount ? ` + ${unitUnknownCount} unknown` : ''}`;
                    console.log(`  🎬 ${finalFileName}`);
                    console.log(`     size(video): ${videoText} | subtitles: ${subtitleText} | attachments: ${attachmentText} | total: ${totalText}`);
                    console.log(`     output: ${paintCyan(unitOutPath)}`);
                } catch (err) {
                    chapterUnknownSize++;
                    totalUnknownSize++;
                    console.log(`  ⚠️ ${finalFileName}  | size estimate failed: ${err.message}`);
                }
            }
            console.log(`  ─ chapter summary: selected=${chapterSelected}, locked=${chapterLocked}, subtitles=${chapterSubtitleCount}, attachments=${chapterAttachmentCount}, estimated=${formatBytes(chapterKnownBytes)}${chapterUnknownSize ? ` + ${chapterUnknownSize} unknown item(s)` : ''}`);
        }
        console.log('\n' + '—'.repeat(40));
        console.log(paintBold('Dry-run total summary:'));
        console.log(`🎞️ Lectures selected: ${paintBold(String(totalLectures))}`);
        console.log(`🔒 Locked lectures: ${paintYellow(String(totalLocked))}`);
        console.log(`📝 Subtitle files: ${paintBold(String(totalSubtitleCount))}`);
        console.log(`📎 Attachment files: ${paintBold(String(totalAttachmentCount))}`);
        console.log(`💾 Estimated total (known sizes): ${paintGreen(formatBytes(totalKnownBytes))}`);
        console.log(`❓ Unknown-size items: ${paintYellow(String(totalUnknownSize))}`);
        console.log(`ℹ️ Note: This is an estimate based on server-reported sizes (HEAD/Range). Final size may differ.`);
        if (totalLectures === 0 && (selectedChapters || selectedLessons)) {
            logError(buildActionableError(
                'FILTER_EMPTY',
                'No lectures matched the given --chapter/--lesson filters.',
                [
                    'Check chapter/lesson numbers (lesson numbers count only video lectures per chapter).',
                    'Omit filters to preview the whole course, or widen the range.'
                ]
            ));
            process.exit(2);
        }
        return;
    }

    // Iterate chapters and units (plan first, then bounded concurrent workers)
    let totalUnits = 0, downloadedCount = 0, skippedCount = 0, failedCount = 0, cancelledCount = 0, deferredCount = 0,
        nonLectureUnits = 0;
    const planned = planLectures(chapters, {selectedChapters, selectedLessons});
    // Count non-video units for messaging (same as before)
    for (const chapter of chapters) {
        for (const unit of getChapterUnits(chapter)) {
            if (!isUnitActive(unit)) continue;
            if (!isVideoLecture(unit)) nonLectureUnits++;
        }
    }

    // Deduplicate by unit id or stable output path key
    const seenKeys = new Set();
    const jobsList = [];
    for (const item of planned) {
        const chapterFolderName = `فصل ${item.chapterNo} - ${sanitizeName(item.chapter.title || item.chapter.slug || 'chapter')}`;
        const chapterFolder = path.join(outputRootFolder, chapterFolderName);
        assertOutputPathSafe(outputRootFolder, chapterFolder);
        const baseFileName = `قسمت ${item.lessonNo} - ${sanitizeName(item.unit.title || item.unit.slug || 'lecture')}.mp4`;
        const finalFileName = (sampleBytesToDownload && sampleBytesToDownload > 0)
            ? baseFileName.replace(/\.mp4$/i, '.sample.mp4')
            : baseFileName;
        const key = item.unitId != null ? `id:${item.unitId}` : `path:${chapterFolder}/${finalFileName}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        jobsList.push({
            ...item,
            chapterFolder,
            finalFileName,
            outputFilePath: path.join(chapterFolder, finalFileName),
            lectureUrl: buildLectureUrl(courseSlug, item.chapter, item.unit)
        });
    }
    totalUnits = jobsList.length;

    const dlOpts = {
        signal: runAbort.signal,
        scheduleGate,
        quiet,
        concurrent: jobs > 1
    };

    async function processLectureJob(job) {
        if (runAbort.signal.aborted) {
            cancelledCount++;
            return 'cancelled';
        }
        try {
            scheduleGate.assertAllowed();
        } catch {
            deferredCount++;
            return 'deferred';
        }

        if (job.locked) {
            logWarn(`🔒 Locked/No access: ${job.finalFileName}`);
            skippedCount++;
            return 'skipped';
        }

        try {
            await fs.promises.mkdir(job.chapterFolder, {recursive: true});
            const media = await resolveUnitMedia(job.unit, {lectureUrl: job.lectureUrl, referer: normalizedCourseUrl});
            const bestSourceUrl = media.bestSourceUrl;
            if (!bestSourceUrl) {
                logWarn(`No video source found for: ${job.finalFileName}`);
                skippedCount++;
                return 'skipped';
            }

            if (!quiet) console.log(`📥 Downloading: ${job.finalFileName}`);
            const status = await downloadToFile(
                bestSourceUrl,
                job.outputFilePath,
                job.lectureUrl,
                RUNTIME_CONFIG.retryAttempts,
                sampleBytesToDownload,
                '',
                'video',
                outputRootFolder,
                dlOpts
            );
            if (status === 'exists') {
                console.log(paintYellow(`🟡 SKIP exists: ${job.finalFileName}`));
                skippedCount++;
            } else if (status === 'deferred') {
                logWarn(`Deferred (schedule window): ${job.finalFileName}`);
                deferredCount++;
                return 'deferred';
            } else {
                logSuccess(`DOWNLOADED: ${job.finalFileName}`);
                downloadedCount++;
            }

            // ---- Subtitles ----
            try {
                if (media.subtitleLinks.length > 0) {
                    const videoBaseNoExt = job.finalFileName.replace(/\.sample\.mp4$/i, '').replace(/\.mp4$/i, '');
                    for (const sUrl of media.subtitleLinks) {
                        try {
                            scheduleGate.assertAllowed();
                            let ext = '.vtt';
                            let absUrl = sUrl;
                            if (media.captionNeedsFileParam) {
                                const subtitleName = `${videoBaseNoExt}.vtt`;
                                absUrl = withCaptionFileParam(sUrl, subtitleName);
                            } else {
                                absUrl = toAbsoluteUrl(sUrl, ORIGIN);
                                try {
                                    const up = new URL(absUrl);
                                    ext = path.extname(up.pathname) || '.vtt';
                                } catch {
                                }
                            }
                            const subtitleName = `${videoBaseNoExt}${ext}`;
                            const subtitlePath = path.join(job.chapterFolder, subtitleName);
                            if (fs.existsSync(subtitlePath) && fs.statSync(subtitlePath).size > 0) {
                                console.log(paintYellow(`🟡 Subtitle exists: ${subtitleName}`));
                                continue;
                            }
                            if (!quiet) console.log(`📝 Subtitle: ${subtitleName}`);
                            const sStatus = await downloadToFile(absUrl, subtitlePath, job.lectureUrl, RUNTIME_CONFIG.retryAttempts, 0, '', 'subtitle', outputRootFolder, dlOpts);
                            if (sStatus === 'deferred') {
                                deferredCount++;
                                return 'deferred';
                            }
                            if (sStatus === 'exists') console.log(paintYellow(`🟡 Subtitle exists: ${subtitleName}`));
                            else logSuccess(`SUBTITLE: ${subtitleName}`);
                            if (jobs === 1) await sleep(150);
                        } catch (subErr) {
                            if (subErr?.code === 'INTERRUPTED' || /cancelled/i.test(String(subErr?.message || ''))) throw subErr;
                            logWarn(`Subtitle fail: ${subErr.message}`);
                        }
                    }
                }
            } catch (subOuter) {
                if (subOuter?.code === 'INTERRUPTED' || /cancelled/i.test(String(subOuter?.message || ''))) throw subOuter;
                logWarn(`Subtitle parse error: ${subOuter.message}`);
            }

            // ---- Attachments ----
            try {
                if (media.attachmentLinks.length > 0) {
                    const videoBaseNoExt = job.finalFileName.replace(/\.sample\.mp4$/i, '').replace(/\.mp4$/i, '');
                    for (const attUrl of media.attachmentLinks) {
                        try {
                            scheduleGate.assertAllowed();
                            let filePart;
                            try {
                                const u = new URL(attUrl);
                                filePart = u.pathname.split('/').pop() || 'attachment.bin';
                            } catch {
                                filePart = attUrl.split('?')[0].split('/').pop() || 'attachment.bin';
                            }
                            const sanitizedAttachment = sanitizeContentDispositionFilename(filePart, 'attachment.bin');
                            const finalAttachmentName = `${videoBaseNoExt} - ${sanitizedAttachment}`;
                            const attachmentPath = path.join(job.chapterFolder, finalAttachmentName);
                            assertOutputPathSafe(outputRootFolder, attachmentPath);
                            if (fs.existsSync(attachmentPath) && fs.statSync(attachmentPath).size > 0) {
                                console.log(paintYellow(`🟡 Attachment exists: ${finalAttachmentName}`));
                                continue;
                            }
                            if (!quiet) console.log(`📎 Attachment: ${finalAttachmentName}`);
                            const aStatus = await downloadToFile(attUrl, attachmentPath, job.lectureUrl, RUNTIME_CONFIG.retryAttempts, 0, '', 'attachment', outputRootFolder, dlOpts);
                            if (aStatus === 'deferred') {
                                deferredCount++;
                                return 'deferred';
                            }
                            if (aStatus === 'exists') console.log(paintYellow(`🟡 Attachment exists: ${finalAttachmentName}`));
                            else logSuccess(`ATTACHMENT: ${finalAttachmentName}`);
                            if (jobs === 1) await sleep(200);
                        } catch (attErr) {
                            if (attErr?.code === 'INTERRUPTED' || /cancelled/i.test(String(attErr?.message || ''))) throw attErr;
                            logWarn(`Attachment fail: ${attErr.message}`);
                        }
                    }
                }
            } catch (attOuterErr) {
                if (attOuterErr?.code === 'INTERRUPTED' || /cancelled/i.test(String(attOuterErr?.message || ''))) throw attOuterErr;
                logWarn(`Attachment parse error: ${attOuterErr.message}`);
            }
            if (jobs === 1) await sleep(400);
            return 'ok';
        } catch (err) {
            if (err?.code === 'SCHEDULE_STOP' || err?.deferred) {
                deferredCount++;
                return 'deferred';
            }
            if (err?.code === 'INTERRUPTED' || /cancelled/i.test(String(err?.message || '')) || runAbort.signal.aborted) {
                cancelledCount++;
                return 'cancelled';
            }
            logError(`FAIL ${job.finalFileName}: ${err.message}`);
            failedCount++;
            return 'failed';
        }
    }

    try {
        // Group log by chapter for readability when sequential; concurrent still processes all jobs
        if (jobs === 1) {
            let lastChapter = null;
            for (const job of jobsList) {
                if (interrupted || runAbort.signal.aborted) {
                    cancelledCount += 1;
                    continue;
                }
                if (job.chapterNo !== lastChapter) {
                    lastChapter = job.chapterNo;
                    console.log(`📖 Chapter ${job.chapterNo}/${chapters.length}: ${paintBold(job.chapter.title || job.chapter.slug)}`);
                }
                await processLectureJob(job);
            }
        } else {
            const byChapter = new Map();
            for (const job of jobsList) {
                if (!byChapter.has(job.chapterNo)) byChapter.set(job.chapterNo, job.chapter);
            }
            for (const [no, ch] of byChapter) {
                console.log(`📖 Chapter ${no}/${chapters.length}: ${paintBold(ch.title || ch.slug)}`);
            }
            await mapPool(jobsList, jobs, processLectureJob, {signal: runAbort.signal});
        }
    } finally {
        process.off('SIGINT', onInterrupt);
        process.off('SIGTERM', onInterrupt);
        console.log('—'.repeat(40));
        console.log(`📊 Total lecture units: ${paintBold(String(totalUnits))}`);
        console.log(`✅ Downloaded: ${paintGreen(String(downloadedCount))}`);
        console.log(`🟡 Skipped: ${paintYellow(String(skippedCount))}`);
        console.log(`⏸️ Deferred: ${paintYellow(String(deferredCount))}`);
        console.log(`⛔ Cancelled: ${paintYellow(String(cancelledCount))}`);
        console.log(`❌ Failed: ${paintRed(String(failedCount))}`);
        if (METRICS && isVerboseLoggingEnabled) {
            const snap = METRICS.snapshot();
            verbose(`Metrics: authRecover=${snap.authRecoverOk}/${snap.authRecoverAttempts} reuse=${snap.authReuse} retries=${snap.retries} bytes=${snap.bytesDownloaded}`);
        }
        if (interrupted || runAbort.signal.aborted) {
            process.exitCode = EXIT.INTERRUPTED;
        } else if (failedCount > 0) {
            process.exitCode = EXIT.FAILURE;
        } else if (deferredCount > 0 && downloadedCount === 0 && skippedCount === 0) {
            // Entire run deferred to next window — not a hard failure
            process.exitCode = EXIT.SUCCESS;
        }
        if (totalUnits === 0) {
            if (selectedChapters || selectedLessons) {
                logError(buildActionableError(
                    'FILTER_EMPTY',
                    'No lectures matched the given --chapter/--lesson filters.',
                    [
                        'Check chapter/lesson numbers (lesson numbers count only video lectures per chapter).',
                        'Omit filters to download the whole course, or widen the range.'
                    ]
                ));
                process.exitCode = EXIT.USAGE;
            } else if (nonLectureUnits > 0) {
                logInfo(`No downloadable video lectures found. This course appears to contain only non-video units (e.g. assignment/quiz).`);
            } else {
                logInfo('No downloadable video lectures found for this course with current access/session.');
            }
        }
    }
}

main().catch(err => {
    if (/Invalid (range|number token|number)|Unknown option|Missing value|Invalid --|Invalid -j|Invalid timezone|Invalid --start|Invalid --stop|Cannot mix|requires both|must be after|must differ|empty daily|max \d+/.test(String(err?.message || '')) ||
        err?.name === 'ScheduleError') {
        logError(buildActionableError(
            err?.code || 'CLI_INPUT',
            err.message,
            'See --help for jobs (-j), output (-o), and schedule flags.'
        ));
        process.exit(EXIT.USAGE);
    }
    if (/Invalid (range|number token|number)/.test(String(err?.message || ''))) {
        logError(buildActionableError(
            'FILTER_FORMAT',
            `Invalid --chapter/--lesson format: ${err.message}`,
            'Examples: --chapter 2 | --chapter 1,3 | --chapter 2-4 | --lesson 2-5,9'
        ));
        process.exit(EXIT.USAGE);
    }
    if (err?.code === 'INTERRUPTED' || /interrupted/i.test(String(err?.message || ''))) {
        logWarn(String(err.message || 'Interrupted'));
        process.exit(EXIT.INTERRUPTED);
    }
    const rawMsg = redactSecrets(String(err?.message || err || ''), secretBag());
    if (/^\[[A-Z0-9_]+\]/.test(rawMsg) && rawMsg.includes('Next step:')) {
        logError(rawMsg);
        process.exit(EXIT.FAILURE);
    }
    logError(buildActionableError(
        'FATAL',
        rawMsg,
        'Retry with --verbose to see more details.'
    ));
    process.exit(EXIT.FAILURE);
});
