/**
 * CLI tool to download all lecture videos of a maktabkhooneh course
 * 
 * Usage examples:
 *   node download.mjs "https://maktabkhooneh.org/course/<slug>/"
 *   node download.mjs "https://maktabkhooneh.org/course/<slug>/" --sample-bytes 65536 --verbose
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
import { Transform, Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { setTimeout as sleep } from 'timers/promises';

// ===============
// Console styling (ANSI colors) and emojis
// ===============
const COLOR = {
    reset: '\u001b[0m', bold: '\u001b[1m', dim: '\u001b[2m',
    red: '\u001b[31m', green: '\u001b[32m', yellow: '\u001b[33m', blue: '\u001b[34m', magenta: '\u001b[35m', cyan: '\u001b[36m',
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

const logInfo = (...a) => console.log('ℹ️', ...a);
const logStep = (...a) => console.log('▶️', ...a);
const logSuccess = (...a) => console.log('✅', ...a);
const logWarn = (...a) => console.warn('⚠️', ...a);
const logError = (...a) => console.error('❌', ...a);

// ===============
// Configuration
// ===============
const DEFAULT_CONFIG_FILE = 'config.json';
const DEFAULT_RETRY_ATTEMPTS = 4;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_READ_TIMEOUT_MS = 120_000;

function parsePositiveInt(value, fallback) {
    const n = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseNonNegativeInt(value, fallback) {
    const n = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function discoverConfigPath(args) {
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--config') {
            const v = args[i + 1];
            return v ? v : DEFAULT_CONFIG_FILE;
        }
        if (a.startsWith('--config=')) {
            return a.slice('--config='.length);
        }
    }
    return DEFAULT_CONFIG_FILE;
}

function loadConfigFile(filePath) {
    const resolved = path.resolve(process.cwd(), filePath || DEFAULT_CONFIG_FILE);
    if (!fs.existsSync(resolved)) return { config: {}, configPath: resolved, exists: false };
    try {
        const txt = fs.readFileSync(resolved, 'utf8');
        const cfg = JSON.parse(txt);
        if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
            throw new Error('config root must be a JSON object');
        }
        return { config: cfg, configPath: resolved, exists: true };
    } catch (e) {
        throw new Error(buildActionableError(
            'CONFIG_PARSE',
            `Cannot parse config file: ${resolved}. ${e.message}`,
            'Fix JSON syntax, or pass another path with --config <file>.'
        ));
    }
}

async function saveConfigFile(configPath, config) {
    try {
        await fs.promises.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
        return true;
    } catch (e) {
        logWarn(`Could not persist config file (${configPath}): ${e.message}`);
        return false;
    }
}

function toBackoffMs(attempt) {
    return Math.min(30_000, 700 * (2 ** Math.max(0, attempt - 1)));
}

function isRetriableStatus(status) {
    return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599);
}

function isTimeoutError(err) {
    const m = String(err?.message || '').toLowerCase();
    return err?.name === 'AbortError' || m.includes('timeout') || m.includes('timed out');
}

function isRetriableNetworkError(err) {
    if (isTimeoutError(err)) return true;
    const c = String(err?.cause?.code || '').toUpperCase();
    return ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EHOSTUNREACH', 'EAI_AGAIN'].includes(c);
}

const ACTIONABLE_URL_PLACEHOLDER = 'https://maktabkhooneh.org/course/<slug>/';

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
// Sample mode default (0 means full download)
const DEFAULT_SAMPLE_BYTES = 0;

// Ensure Node 18+ for global fetch
if (typeof fetch !== 'function') {
    logError('This script requires Node.js v18+ with global fetch.');
    process.exit(1);
}

const ORIGIN = 'https://maktabkhooneh.org';

// Build common headers for authenticated requests.
function commonHeaders(referer) {
    /** @type {Record<string,string>} */
    const headers = {
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.9,fa;q=0.8',
        'cache-control': 'no-cache',
        'pragma': 'no-cache',
        'x-requested-with': 'XMLHttpRequest',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
    };
    const ck = ACTIVE_COOKIE || COOKIE;
    if (ck && ck !== 'PUT_YOUR_COOKIE_HERE') headers['cookie'] = ck;
    if (referer) headers['referer'] = referer;
    return headers;
}

// Human-friendly byte formatter
function formatBytes(bytes) {
    if (bytes == null || isNaN(bytes)) return '-';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0; let n = Number(bytes);
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
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
    console.log(`${paintBoldCyan('Maktabkhooneh Downloader')} - ${paintYellow('version 1.0.0')} ${paint(COLOR.dim, '© 2025')}`);
    console.log(paint(COLOR.magenta, 'By ') + paint(COLOR.magenta, '@NabiKAZ') + ' ' + paintLightBlue('<www.nabi.ir>') + ' ' + paintGreen('<nabikaz@gmail.com>') + ' ' + paintLightBlue('<x.com/NabiKAZ>'));
    console.log(paint(COLOR.dim, 'Signup: ') + paintLightBlue('https://maktabkhooneh.org/'));
    console.log(paint(COLOR.dim, 'Project: ') + paintLightBlue('https://github.com/NabiKAZ/maktabkhooneh-downloader'));
    console.log(paint(COLOR.dim, '=============================================================\n'));

    // Usage
    console.log(paintBold('Usage:'));
    console.log(`  ${paintCyan('node download.mjs')} ${paintYellow('<course_url>')} [options]`);

    // Options
    console.log('\n' + paintBold('Options:'));
    console.log(`  ${paintYellow('<course_url>')}                The maktabkhooneh course URL (e.g., https://maktabkhooneh.org/course/<slug>/)`);
    console.log(`  ${paintGreen('--sample-bytes')} ${paintYellow('N')}            Download only the first N bytes of each video`);
    console.log(`  ${paintGreen('--chapter')} ${paintYellow('SPEC')}           Select chapter(s): e.g. 2 or 1,3 or 2-4`);
    console.log(`  ${paintGreen('--lesson')} ${paintYellow('SPEC')}            Select lesson(s) inside selected chapter(s): e.g. 2 or 2-5,9`);
    console.log(`  ${paintGreen('--dry-run')}                   Preview files and estimated sizes without downloading`);
    console.log(`  ${paintGreen('--config')} ${paintYellow('<FILE>')}           Config file path (default: config.json)`);
    console.log(`  ${paintGreen('--force-login')}               Force fresh login even if stored session is valid`);
    console.log(`  ${paintGreen('--verbose')} | ${paintGreen('-v')}              Verbose debug / HTTP flow info`);
    console.log(`  ${paintGreen('--help')} | ${paintGreen('-h')}                 Show this help and exit`);
    console.log('\n' + paintBold('Config (config.json):'));
    console.log(`    auth.email / auth.password   Login credentials`);
    console.log(`    auth.cookie / auth.cookieFile Manual cookie override`);
    console.log(`    runtime.sampleBytes          Default sample bytes`);
    console.log(`    runtime.retryAttempts        Retry attempts for transient failures`);
    console.log(`    runtime.requestTimeoutMs     Request timeout in ms`);
    console.log(`    runtime.readTimeoutMs        Read timeout in ms`);
    console.log(`    defaults.chapter / defaults.lesson / defaults.dryRun`);

    // Examples
    console.log('\n' + paintBold('Examples:'));
    console.log('  ' + paintCyan('node download.mjs "https://maktabkhooneh.org/course/<slug>/"'));
    console.log('  ' + paintCyan('node download.mjs "https://maktabkhooneh.org/course/<slug>/" --sample-bytes 65536 --verbose'));
    console.log('  ' + paintCyan('node download.mjs "https://maktabkhooneh.org/course/<slug>/" --dry-run'));
    console.log('  ' + paintCyan('node download.mjs "https://maktabkhooneh.org/course/<slug>/" --chapter 2 --lesson 2-5,9'));
    console.log('  ' + paintCyan('node download.mjs "https://maktabkhooneh.org/course/<slug>/" --config ./config.json'));
    console.log('  ' + paintCyan('node download.mjs "https://maktabkhooneh.org/course/<slug>/" --force-login'));
    console.log('');
}

function parseNumberSpec(spec) {
    if (!spec || !String(spec).trim()) return null;
    const out = new Set();
    const parts = String(spec).split(',').map(s => s.trim()).filter(Boolean);
    for (const p of parts) {
        const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
        if (m) {
            const a = parseInt(m[1], 10);
            const b = parseInt(m[2], 10);
            if (a <= 0 || b <= 0) throw new Error(`Invalid range: ${p}`);
            const [start, end] = a <= b ? [a, b] : [b, a];
            for (let i = start; i <= end; i++) out.add(i);
            continue;
        }
        if (!/^\d+$/.test(p)) throw new Error(`Invalid number token: ${p}`);
        const n = parseInt(p, 10);
        if (n <= 0) throw new Error(`Invalid number: ${p}`);
        out.add(n);
    }
    return out;
}

function parseCLI(config = {}, configPath = DEFAULT_CONFIG_FILE) {
    const args = process.argv.slice(2);
    let inputCourseUrl = typeof config.courseUrl === 'string' ? config.courseUrl.trim() : null;
    let sampleBytesToDownload = parseNonNegativeInt(config.sampleBytes, DEFAULT_SAMPLE_BYTES);
    let isVerboseLoggingEnabled = !!config.verbose;
    let isDryRun = !!config.dryRun;
    let chapterSpec = config.chapter ?? null;
    let lessonSpec = config.lesson ?? null;
    let forceLogin = !!config.forceLogin;
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--help' || a === '-h') {
            printUsage();
            process.exit(0);
        } else if (a === '--config') {
            if (args[i + 1]) i++;
            continue;
        } else if (a.startsWith('--config=')) {
            continue;
        } else if (a.startsWith('--sample-bytes=')) {
            const v = a.split('=')[1];
            sampleBytesToDownload = parseInt(v, 10) || 0;
        } else if (a === '--sample-bytes') {
            const v = args[i + 1];
            if (v) { sampleBytesToDownload = parseInt(v, 10) || 0; i++; }
        } else if (a === '--chapter') {
            const v = args[i + 1]; if (v) { chapterSpec = v; i++; }
        } else if (a.startsWith('--chapter=')) {
            chapterSpec = a.split('=')[1];
        } else if (a === '--lesson') {
            const v = args[i + 1]; if (v) { lessonSpec = v; i++; }
        } else if (a.startsWith('--lesson=')) {
            lessonSpec = a.split('=')[1];
        } else if (a === '--verbose' || a === '-v') {
            isVerboseLoggingEnabled = true;
        } else if (a === '--dry-run') {
            isDryRun = true;
        } else if (a === '--force-login') {
            forceLogin = true;
        } else if (!inputCourseUrl) {
            inputCourseUrl = a;
        }
    }
    const chapterSpecText = Array.isArray(chapterSpec) ? chapterSpec.join(',') : chapterSpec;
    const lessonSpecText = Array.isArray(lessonSpec) ? lessonSpec.join(',') : lessonSpec;
    const selectedChapters = parseNumberSpec(chapterSpecText);
    const selectedLessons = parseNumberSpec(lessonSpecText);
    return {
        inputCourseUrl,
        sampleBytesToDownload,
        isVerboseLoggingEnabled,
        isDryRun,
        forceLogin,
        selectedChapters,
        selectedLessons,
        configPath
    };
}

function createVerboseLogger(isVerbose) {
    return { verbose: (...a) => { if (isVerbose) console.log(...a); } };
}

// Parse the course slug from the full course URL.
function extractCourseSlug(courseUrl) {
    try {
        const parsed = new URL(courseUrl);
        if (parsed.origin !== ORIGIN) {
            throw new Error(buildActionableError(
                'URL_ORIGIN',
                `Unexpected origin: ${parsed.origin}. Only ${ORIGIN} is supported.`,
                `Use a full course URL like: ${ACTIONABLE_URL_PLACEHOLDER}`
            ));
        }
        const parts = parsed.pathname.split('/').filter(Boolean);
        const idx = parts.indexOf('course');
        if (idx === -1 || !parts[idx + 1]) {
            throw new Error(buildActionableError(
                'URL_FORMAT',
                'Cannot parse course slug from URL path.',
                `Expected format: ${ACTIONABLE_URL_PLACEHOLDER}`
            ));
        }
        return parts[idx + 1];
    } catch (e) {
        if (String(e?.message || '').includes('[URL_')) {
            throw e;
        }
        throw new Error(buildActionableError(
            'URL_INVALID',
            `Invalid course URL: ${e.message}`,
            `Example: node download.mjs "${ACTIONABLE_URL_PLACEHOLDER}"`
        ));
    }
}

// Fetch with timeout.
async function fetchWithTimeout(url, options = {}, timeoutMs = 60_000) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        return res;
    } finally {
        clearTimeout(t);
    }
}

async function fetchWithRetry(url, options = {}, { retries = RUNTIME_CONFIG.retryAttempts, timeoutMs = RUNTIME_CONFIG.requestTimeoutMs, onRetry } = {}) {
    let lastErr = null;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await fetchWithTimeout(url, options, timeoutMs);
            if (isRetriableStatus(res.status) && attempt < retries) {
                if (typeof onRetry === 'function') onRetry({ attempt, retries, reason: `HTTP ${res.status}` });
                await sleep(toBackoffMs(attempt));
                continue;
            }
            return res;
        } catch (err) {
            lastErr = err;
            if (attempt < retries && isRetriableNetworkError(err)) {
                if (typeof onRetry === 'function') onRetry({ attempt, retries, reason: err.message || String(err) });
                await sleep(toBackoffMs(attempt));
                continue;
            }
            throw err;
        }
    }
    throw lastErr || new Error('Request failed after retries');
}

function ensureTrailingSlash(u) { return u.endsWith('/') ? u : u + '/'; }

// Try to detect remote file size and whether server supports Range
async function getRemoteSizeAndRanges(url, referer) {
    // HEAD first
    try {
        const res = await fetchWithRetry(url, { method: 'HEAD', headers: { ...commonHeaders(referer), accept: '*/*' } }, { retries: RUNTIME_CONFIG.retryAttempts, timeoutMs: RUNTIME_CONFIG.requestTimeoutMs });
        if (res.ok) {
            const len = res.headers.get('content-length');
            const size = len ? parseInt(len, 10) : undefined;
            const acceptRanges = (res.headers.get('accept-ranges') || '').toLowerCase().includes('bytes');
            return { size, acceptRanges };
        }
    } catch { }
    // Fallback: GET single byte
    try {
        const res = await fetchWithRetry(url, { method: 'GET', headers: { ...commonHeaders(referer), range: 'bytes=0-0', accept: '*/*' } }, { retries: RUNTIME_CONFIG.retryAttempts, timeoutMs: RUNTIME_CONFIG.requestTimeoutMs });
        if (res.status === 206) {
            const cr = res.headers.get('content-range');
            // e.g. bytes 0-0/123456
            const m = cr && cr.match(/\/(\d+)$/);
            const size = m ? parseInt(m[1], 10) : undefined;
            try { if (res.body) { const rb = Readable.fromWeb(res.body); rb.resume(); } } catch { }
            return { size, acceptRanges: true };
        }
    } catch { }
    return { size: undefined, acceptRanges: false };
}

// API: fetch chapters JSON for a course.
async function fetchChapters(courseSlug, referer) {
    const apiUrl = `${ORIGIN}/api/v1/courses/${courseSlug}/chapters/`;
    const res = await fetchWithRetry(apiUrl, { method: 'GET', headers: { ...commonHeaders(referer), accept: 'application/json' } });
    if (!res.ok) throw new Error(explainHttpFailure(res.status, 'Fetch chapters'));
    return res.json();
}

// API: core-data to verify authentication and basic profile.
async function fetchCoreData(referer) {
    const url = `${ORIGIN}/api/v1/general/core-data/?profile=1`;
    const res = await fetchWithRetry(url, { method: 'GET', headers: { ...commonHeaders(referer || ORIGIN), accept: 'application/json' } });
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
function buildLectureUrl(courseSlug, chapter, unit) {
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

// Sanitize a string for safe Windows filenames.
function sanitizeName(name) {
    return name.replace(/[\/:*?"<>|]/g, ' ').replace(/[\s\u200c\u200f\u202a\u202b]+/g, ' ').trim().slice(0, 150);
}

function normalizeCourseFolderNameFromSlug(courseSlug) {
    const decoded = decodeURIComponent(courseSlug || '');
    // Remove trailing course id token like "-mk748" / "-MK12345"
    const withoutMkId = decoded.replace(/-mk\d+\s*$/i, '');
    // Replace slug separators with spaces for cleaner folder names
    const spaced = withoutMkId.replace(/[-_]+/g, ' ');
    return sanitizeName(spaced);
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
    const res = await fetchWithRetry(url, { headers: { ...commonHeaders(referer), accept: 'application/json' } });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { }
    return { res, text, json };
}

function extractSetCookie(res) {
    // Node fetch in Node 18 does not expose raw set-cookie headers directly. We rely on cookie from config or inline login.
    return null;
}

async function obtainCsrfToken() {
    const { json } = await fetchJson(`${ORIGIN}/api/v1/general/core-data/?profile=1`, ORIGIN);
    let csrf = json?.auth?.csrf;
    // Try to parse cookie from ACTIVE_COOKIE fallback
    if (!csrf) {
        // Not critical; some endpoints may still set it later.
    }
    return csrf;
}

import https from 'https';

// Manual minimal cookie store (in-memory) for login flow only
class SimpleCookieStore {
    constructor() { this.map = new Map(); }
    setCookieLine(line) {
        if (!line) return;
        const seg = line.split(';')[0];
        const eq = seg.indexOf('=');
        if (eq === -1) return;
        const k = seg.slice(0, eq).trim();
        const v = seg.slice(eq + 1).trim();
        if (k) this.map.set(k, v);
    }
    applySetCookie(arr) { (arr || []).forEach(l => this.setCookieLine(l)); }
    get(name) { return this.map.get(name); }
    headerString() { return Array.from(this.map.entries()).map(([k, v]) => `${k}=${v}`).join('; '); }
}

function rawRequest(urlStr, { method = 'GET', headers = {}, body = null } = {}) {
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

async function rawRequestWithRetry(urlStr, reqOpts = {}, verbose = () => { }) {
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

async function loginWithCredentialsInline(email, password, verbose = () => { }) {
    if (!email || !password) {
        throw new Error(buildActionableError(
            'LOGIN_INPUT',
            'Email and password are required for login.',
            'Set auth.email and auth.password in config.json, then retry with --force-login.'
        ));
    }
    const store = new SimpleCookieStore();
    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';
    // Helper small debug printer (always go through verbose)
    const dbg = (...a) => verbose('[login]', ...a);

    // 0. Visit login page to obtain initial csrftoken cookie
    let r = await rawRequestWithRetry(`${ORIGIN}/accounts/login/`, {
        method: 'GET',
        headers: {
            'User-Agent': UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        }
    }, verbose);
    store.applySetCookie(r.headers['set-cookie']);
    let csrf = store.get('csrftoken') || null;
    if (!csrf) {
        // 0b. fallback: core-data json endpoint (sometimes returns csrf in body)
        const r2 = await rawRequestWithRetry(`${ORIGIN}/api/v1/general/core-data/?profile=1`, {
            method: 'GET',
            headers: { 'User-Agent': UA, 'Accept': 'application/json' }
        }, verbose);
        store.applySetCookie(r2.headers['set-cookie']);
        try { const j2 = JSON.parse(r2.body); csrf = csrf || j2?.auth?.csrf || null; } catch { }
        if (!csrf) csrf = store.get('csrftoken') || null;
        dbg('Fallback core-data for CSRF status:', r2.status);
    }
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
        'Referer': `${ORIGIN}/accounts/login/`
    });

    // 1. check-active-user
    const formCheck = new URLSearchParams();
    formCheck.append('csrfmiddlewaretoken', csrf);
    formCheck.append('tessera', email);
    // recaptcha sometimes optional; keep param but empty to mimic browser before token set
    formCheck.append('g-recaptcha-response', '');
    r = await rawRequestWithRetry(`${ORIGIN}/api/v1/auth/check-active-user`, {
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
    let jCheck = null; try { jCheck = JSON.parse(r.body); } catch { }
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
        // Provide clearer error details
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
    let jLogin = null; try { jLogin = JSON.parse(r.body); } catch { }
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

    // Compose final cookie header (only what we need for reuse)
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

async function prepareSession({ userEmail, userPassword, verbose, courseUrl, forceLogin, config, configPath }) {
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
        if (core) return { core, source: 'config-cookie' };
        if (!forceLogin) {
            logWarn('Cookie from config.auth.cookie/cookieFile is invalid; trying stored session/login fallback.');
        }
    }

    // 2. Reuse session persisted in config.auth.sessionCookie
    if (storedSessionCookie && !forceLogin) {
        ACTIVE_COOKIE = storedSessionCookie;
        logStep('Loaded stored session from config.auth.sessionCookie');
        const core = await verify();
        if (core) return { core, source: 'config-session' };
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
                await saveConfigFile(configPath, config);
                logSuccess('Login success; session saved to config.auth.sessionCookie');
            }
            const core = await verify();
            if (core) return { core, source: 'fresh-login' };
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
    return { core: null, source: 'none' };
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

// Transform stream to limit to first N bytes and optionally signal upstream.
class ByteLimit extends Transform {
    // Limits the stream to the first `limit` bytes, then signals upstream to stop.
    constructor(limit, onLimit) { super(); this.limit = limit; this.seen = 0; this._hit = false; this._onLimit = onLimit; }
    _transform(chunk, enc, cb) {
        if (this.limit <= 0) { this.push(chunk); return cb(); }
        const remaining = this.limit - this.seen;
        if (remaining <= 0) { return cb(); }
        const buf = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        this.push(buf);
        this.seen += buf.length;
        if (!this._hit && this.seen >= this.limit) {
            this.end();
            this._hit = true;
            if (typeof this._onLimit === 'function') {
                try { this._onLimit(); } catch { }
            }
        }
        cb();
    }
}

// Download a URL to a file (with retries). If sampleBytes > 0, request a Range and also enforce a local limit.
// label: optional display name to show in the progress line (e.g., final file name)
async function downloadToFile(url, filePath, referer, maxRetries = RUNTIME_CONFIG.retryAttempts, sampleBytes = 0, label = '') {
    // Skip if already exists with non-zero size
    let existingFinalSize = 0;
    try { const stat = fs.statSync(filePath); existingFinalSize = stat.size; if (existingFinalSize > 0 && sampleBytes > 0) return 'exists'; } catch { }
    const tmpPath = filePath + '.part';
    let existingTmpSize = 0;
    try { const stat = fs.statSync(tmpPath); existingTmpSize = stat.size; } catch { }

    // For full downloads, see if final is already complete
    let remoteInfo;
    if (sampleBytes === 0 && existingFinalSize > 0) {
        remoteInfo = await getRemoteSizeAndRanges(url, referer);
        if (remoteInfo.size && existingFinalSize >= remoteInfo.size) {
            return 'exists';
        }
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // Decide resume offset
            let resumeOffset = 0;
            let writingTo = tmpPath;
            if (sampleBytes > 0) {
                resumeOffset = 0; // do not resume sample downloads
            } else {
                if (existingTmpSize > 0) {
                    resumeOffset = existingTmpSize;
                } else if (existingFinalSize > 0) {
                    // Only resume from final if server supports ranges
                    if (!remoteInfo) remoteInfo = await getRemoteSizeAndRanges(url, referer);
                    if (remoteInfo.acceptRanges) {
                        // Move final to tmp to resume appending
                        try { await fs.promises.rename(filePath, tmpPath); existingTmpSize = existingFinalSize; resumeOffset = existingFinalSize; existingFinalSize = 0; } catch { }
                    } else {
                        // Cannot resume; start from scratch
                        resumeOffset = 0;
                    }
                }
            }

            const requestInit = { method: 'GET', headers: { ...commonHeaders(referer), accept: 'video/mp4,application/octet-stream,*/*' } };
            if (sampleBytes && sampleBytes > 0) {
                requestInit.headers['range'] = `bytes=0-${Math.max(0, sampleBytes - 1)}`;
            } else if (resumeOffset > 0) {
                requestInit.headers['range'] = `bytes=${resumeOffset}-`;
            }

            const controller = new AbortController();
            const to = setTimeout(() => controller.abort(), RUNTIME_CONFIG.requestTimeoutMs);
            const res = await fetch(url, { ...requestInit, signal: controller.signal });
            if (!res.ok || !res.body) throw new Error(explainHttpFailure(res.status, 'Download'));
            if (resumeOffset > 0 && res.status !== 206) {
                // Server didn't honor Range; restart from 0
                try { await fs.promises.unlink(tmpPath); } catch { }
                existingTmpSize = 0; resumeOffset = 0;
                clearTimeout(to);
                throw new Error('Server did not honor range; restarting from 0');
            }

            await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
            const write = fs.createWriteStream(writingTo, { flags: (sampleBytes > 0 || resumeOffset === 0) ? 'w' : 'a' });
            const readable = Readable.fromWeb(res.body);
            let readIdleTimer = null;
            const resetReadTimeout = () => {
                if (readIdleTimer) clearTimeout(readIdleTimer);
                readIdleTimer = setTimeout(() => {
                    try { controller.abort(); } catch { }
                }, RUNTIME_CONFIG.readTimeoutMs);
            };
            resetReadTimeout();

            // Progress bar state
            const contentLengthHeader = res.headers.get('content-length');
            const fullLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : undefined;
            // Try content-range for total size when resuming
            let expectedTotal;
            const contentRange = res.headers.get('content-range');
            const crMatch = contentRange && contentRange.match(/\/(\d+)$/);
            if (sampleBytes && sampleBytes > 0) expectedTotal = sampleBytes;
            else if (crMatch) expectedTotal = parseInt(crMatch[1], 10);
            else if (fullLength && resumeOffset > 0) expectedTotal = resumeOffset + fullLength;
            else expectedTotal = fullLength;
            let downloadedBytes = resumeOffset;
            const startedAt = Date.now();

            // Progress render helper
            const truncate = (s, max = 70) => {
                if (!s) return '';
                const str = String(s);
                return str.length > max ? str.slice(0, max - 1) + '…' : str;
            };
            const render = (final = false) => {
                const elapsedSec = Math.max(0.001, (Date.now() - startedAt) / 1000);
                const speed = downloadedBytes / elapsedSec;
                // clamp bytes to expected total when finalizing or very close (to avoid 99.9% stuck)
                let shownDownloaded = downloadedBytes;
                if (expectedTotal && (final || downloadedBytes > expectedTotal)) {
                    // Tolerate tiny overflow due to headers/rounding
                    const overflow = downloadedBytes - expectedTotal;
                    if (overflow <= 65536) shownDownloaded = expectedTotal;
                }
                // Decide ratio; if final, force full bar
                let ratio = 0;
                if (final) {
                    ratio = 1;
                } else if (expectedTotal) {
                    ratio = (shownDownloaded / expectedTotal);
                } else {
                    ratio = 0; // unknown total
                }
                const bar = buildProgressBar(ratio);
                const pct = final ? '100.0%' : (expectedTotal ? `${(Math.min(1, ratio) * 100).toFixed(1)}%` : '--%');
                const sizeStr = `${formatBytes(shownDownloaded)}${expectedTotal ? ' / ' + formatBytes(expectedTotal) : ''}`;
                const name = label ? `  -  ${truncate(label, 80)}` : '';
                const line = `  ⬇️  [${bar}] ${pct}  ${sizeStr}  ${formatSpeed(speed)}${name}`;
                process.stdout.write(`\r${line}`);
            };

            // Counting transform
            const counter = new Transform({
                transform(chunk, _enc, cb) {
                    resetReadTimeout();
                    downloadedBytes += chunk.length;
                    // throttle render slightly by size steps
                    if (downloadedBytes === chunk.length || downloadedBytes % 65536 < 8192) render();
                    cb(null, chunk);
                }
            });
            let byteLimitReached = false;
            try {
                if (sampleBytes && sampleBytes > 0) {
                    const limiter = new ByteLimit(sampleBytes, () => {
                        byteLimitReached = true;
                        try { readable.destroy(new Error('byte-limit')); } catch { }
                        try { controller.abort(); } catch { }
                    });
                    await pipeline(readable, counter, limiter, write);
                } else {
                    await pipeline(readable, counter, write);
                }
            } catch (pipeErr) {
                if (sampleBytes && byteLimitReached) {
                    try { clearTimeout(to); } catch { }
                    try { render(true); process.stdout.write('\n'); } catch { }
                    try {
                        await fs.promises.rename(tmpPath, filePath);
                    } catch (e) {
                        try { await fs.promises.copyFile(writingTo, filePath); } catch { }
                    }
                    try { await fs.promises.unlink(tmpPath); } catch { }
                    return 'downloaded';
                }
                throw pipeErr;
            } finally {
                clearTimeout(to);
                if (readIdleTimer) clearTimeout(readIdleTimer);
            }

            // finalize progress bar to 100%
            try { render(true); } catch { }
            process.stdout.write('\n');
            try {
                await fs.promises.rename(tmpPath, filePath);
            } catch (e) {
                try { await fs.promises.copyFile(writingTo, filePath); } catch { }
            }
            try { await fs.promises.unlink(tmpPath); } catch { }
            return 'downloaded';
            } catch (err) {
                try { process.stdout.write('\n'); } catch { }
                // Keep .part file for future resume; do not delete on error
            const retryable = isRetriableNetworkError(err) || /HTTP (408|425|429|5\d\d)/.test(String(err?.message || ''));
            if (attempt < maxRetries && retryable) {
                logWarn(`Retry ${attempt}/${maxRetries} for ${path.basename(filePath)} after error: ${err.message}`);
                await sleep(toBackoffMs(attempt));
                continue;
            }
            throw err;
        }
    }
}

function toAbsoluteUrl(url, base = ORIGIN) {
    try { return new URL(url, base).toString(); } catch { return url; }
}

async function main() {
    const argv = process.argv.slice(2);
    const configArgPath = discoverConfigPath(argv);
    const { config, configPath } = loadConfigFile(configArgPath);
    const runtimeCfg = (config.runtime && typeof config.runtime === 'object') ? config.runtime : {};
    const defaultsCfg = (config.defaults && typeof config.defaults === 'object') ? config.defaults : {};
    const authCfg = (config.auth && typeof config.auth === 'object') ? config.auth : {};
    const parserDefaults = {
        courseUrl: typeof config.courseUrl === 'string' ? config.courseUrl : null,
        sampleBytes: runtimeCfg.sampleBytes ?? defaultsCfg.sampleBytes ?? 0,
        verbose: defaultsCfg.verbose ?? false,
        dryRun: defaultsCfg.dryRun ?? false,
        chapter: defaultsCfg.chapter ?? null,
        lesson: defaultsCfg.lesson ?? null,
        forceLogin: defaultsCfg.forceLogin ?? false
    };
    const {
        inputCourseUrl, sampleBytesToDownload, isVerboseLoggingEnabled, isDryRun, forceLogin, selectedChapters, selectedLessons
    } = parseCLI(parserDefaults, configPath);
    LOGIN_EMAIL = String(authCfg.email || '').trim();
    LOGIN_PASSWORD = String(authCfg.password || '').trim();
    if (authCfg.cookie && String(authCfg.cookie).trim()) {
        COOKIE = String(authCfg.cookie).trim();
    } else if (authCfg.cookieFile) {
        try { COOKIE = fs.readFileSync(String(authCfg.cookieFile), 'utf8').trim() || 'PUT_YOUR_COOKIE_HERE'; } catch { COOKIE = 'PUT_YOUR_COOKIE_HERE'; }
    } else {
        COOKIE = 'PUT_YOUR_COOKIE_HERE';
    }
    RUNTIME_CONFIG = {
        retryAttempts: parsePositiveInt(runtimeCfg.retryAttempts, DEFAULT_RETRY_ATTEMPTS),
        requestTimeoutMs: parsePositiveInt(runtimeCfg.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
        readTimeoutMs: parsePositiveInt(runtimeCfg.readTimeoutMs, DEFAULT_READ_TIMEOUT_MS)
    };
    const userEmail = LOGIN_EMAIL || null;
    const userPassword = LOGIN_PASSWORD || null;
    const { verbose } = createVerboseLogger(isVerboseLoggingEnabled);
    if (!inputCourseUrl) { printUsage(); process.exit(1); }
    verbose(`Config file: ${configPath}${fs.existsSync(configPath) ? '' : ' (not found, using defaults)'}`);
    verbose(`Runtime config => retries=${RUNTIME_CONFIG.retryAttempts}, request-timeout=${RUNTIME_CONFIG.requestTimeoutMs}ms, read-timeout=${RUNTIME_CONFIG.readTimeoutMs}ms`);
    // Attempt to load / create / verify session (may already return core)
    const prep = await prepareSession({ userEmail, userPassword, verbose, courseUrl: inputCourseUrl, forceLogin, config, configPath });
    ensureCookiePresent();

    const normalizedCourseUrl = ensureTrailingSlash(inputCourseUrl.trim());
    const courseSlug = extractCourseSlug(normalizedCourseUrl);
    // Build a cleaner course folder name: remove trailing mk id and replace dashes with spaces.
    const courseDisplayName = normalizeCourseFolderNameFromSlug(courseSlug);
    const outputRootFolder = path.resolve(process.cwd(), 'download', courseDisplayName);
    // Ensure base output folder exists only for real downloads
    if (!isDryRun) {
        try { await fs.promises.mkdir(outputRootFolder, { recursive: true }); } catch { }
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

    // Fetch chapters
    verbose(paintCyan('Fetching chapters...'));
    const chaptersData = await fetchChapters(courseSlug, normalizedCourseUrl);
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
            const chapterFolder = path.join(outputRootFolder, `فصل ${chapterNo} - ${sanitizeName(chapter.title || chapter.slug || 'chapter')}`);
            const units = Array.isArray(chapter.unit_set) ? chapter.unit_set : [];
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
                if (!unit?.status || unit?.type !== 'lecture') continue;
                chapterLectureNo++;
                if (selectedLessons && !selectedLessons.has(chapterLectureNo)) continue;
                chapterSelected++;
                totalLectures++;
                const unitNo = chapterLectureNo;
                const baseFileName = `قسمت ${unitNo} - ${sanitizeName(unit.title || unit.slug || 'lecture')}.mp4`;
                const finalFileName = (sampleBytesToDownload && sampleBytesToDownload > 0)
                    ? baseFileName.replace(/\.mp4$/i, '.sample.mp4')
                    : baseFileName;
                if (unit.locked) {
                    chapterLocked++;
                    totalLocked++;
                    console.log(`  🔒 ${finalFileName}  | locked / no access`);
                    continue;
                }
                const lectureUrl = buildLectureUrl(courseSlug, chapter, unit);
                try {
                    const res = await fetchWithRetry(lectureUrl, { headers: { ...commonHeaders(normalizedCourseUrl), accept: 'text/html' } });
                    if (!res.ok) throw new Error(explainHttpFailure(res.status, 'Fetch lecture page'));
                    const html = await res.text();
                    const videoSources = extractVideoSources(html);
                    const bestSourceUrl = pickBestSource(videoSources);
                    if (!bestSourceUrl) {
                        console.log(`  ⚠️ ${finalFileName}  | no video source found`);
                        chapterUnknownSize++;
                        totalUnknownSize++;
                        continue;
                    }
                    const videoInfo = await getRemoteSizeAndRanges(bestSourceUrl, lectureUrl);
                    const videoBytes = Number.isFinite(videoInfo?.size) ? videoInfo.size : null;
                    const subtitleLinks = extractSubtitleLinks(html).map(s => toAbsoluteUrl(s, ORIGIN));
                    const attachmentLinks = extractAttachmentLinks(html).map(a => toAbsoluteUrl(a, ORIGIN));
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
        return;
    }

    // Iterate chapters and units
    let totalUnits = 0, downloadedCount = 0, skippedCount = 0, failedCount = 0, nonLectureUnits = 0;
    try {
        for (let chapterIndex = 0; chapterIndex < chapters.length; chapterIndex++) {
            const chapter = chapters[chapterIndex];
            const chapterNo = chapterIndex + 1;
            if (selectedChapters && !selectedChapters.has(chapterNo)) continue;
            const chapterFolder = path.join(outputRootFolder, `فصل ${chapterNo} - ${sanitizeName(chapter.title || chapter.slug || 'chapter')}`);
            console.log(`📖 Chapter ${chapterIndex + 1}/${chapters.length}: ${paintBold(chapter.title || chapter.slug)}`);

            const units = Array.isArray(chapter.unit_set) ? chapter.unit_set : [];
            let chapterLectureNo = 0;
            for (let unitIndex = 0; unitIndex < units.length; unitIndex++) {
                const unit = units[unitIndex];
                if (!unit?.status) continue; // inactive
                if (unit?.type !== 'lecture') { nonLectureUnits++; continue; } // skip non-video units
                chapterLectureNo++;
                if (selectedLessons && !selectedLessons.has(chapterLectureNo)) continue;
                totalUnits++;
                const unitNo = chapterLectureNo;
                const baseFileName = `قسمت ${unitNo} - ${sanitizeName(unit.title || unit.slug || 'lecture')}.mp4`;
                const finalFileName = (sampleBytesToDownload && sampleBytesToDownload > 0)
                    ? baseFileName.replace(/\.mp4$/i, '.sample.mp4')
                    : baseFileName;
                const outputFilePath = path.join(chapterFolder, finalFileName);
                verbose(`  🎬 Unit ${unitIndex + 1}/${units.length}: ${unit.title || unit.slug}`);

                // Skip locked content or content requiring purchase
                if (unit.locked) {
                    logWarn(`🔒 Locked/No access: ${finalFileName}`);
                    skippedCount++;
                    continue;
                }

                const lectureUrl = buildLectureUrl(courseSlug, chapter, unit);
                try {
                    // Fetch lecture page HTML
                    const res = await fetchWithRetry(lectureUrl, { headers: { ...commonHeaders(normalizedCourseUrl), accept: 'text/html' } });
                    if (!res.ok) throw new Error(explainHttpFailure(res.status, 'Fetch lecture page'));
                    const html = await res.text();
                    const videoSources = extractVideoSources(html);
                    const bestSourceUrl = pickBestSource(videoSources);
                    if (!bestSourceUrl) { logWarn(`No video source found for: ${finalFileName}`); skippedCount++; continue; }


                    // Print the filename on its own line; progress bar will render on the next line
                    console.log(`📥 Downloading: ${finalFileName}`);
                    const status = await downloadToFile(bestSourceUrl, outputFilePath, lectureUrl, RUNTIME_CONFIG.retryAttempts, sampleBytesToDownload, '');
                    if (status === 'exists') { console.log(paintYellow(`🟡 SKIP exists: ${finalFileName}`)); skippedCount++; }
                    else { logSuccess(`DOWNLOADED: ${finalFileName}`); downloadedCount++; }

                    // ---- Subtitles (download beside video, same base name) ----
                    try {
                        const subtitleLinks = extractSubtitleLinks(html);
                        if (subtitleLinks.length > 0) {
                            const videoBaseNoExt = finalFileName.replace(/\.sample\.mp4$/i, '').replace(/\.mp4$/i, '');
                            for (const sUrl of subtitleLinks) {
                                try {
                                    const absUrl = (() => { try { return new URL(sUrl, ORIGIN).toString(); } catch { return sUrl; } })();
                                    // determine extension from pathname or fallback to .vtt
                                    let ext = '.vtt';
                                    try { const up = new URL(absUrl); ext = path.extname(up.pathname) || '.vtt'; } catch { }
                                    const subtitleName = `${videoBaseNoExt}${ext}`;
                                    const subtitlePath = path.join(chapterFolder, subtitleName);
                                    if (fs.existsSync(subtitlePath) && fs.statSync(subtitlePath).size > 0) {
                                        console.log(paintYellow(`🟡 Subtitle exists: ${subtitleName}`));
                                        continue;
                                    }
                                    console.log(`📝 Subtitle: ${subtitleName}`);
                                    const sStatus = await downloadToFile(absUrl, subtitlePath, lectureUrl, RUNTIME_CONFIG.retryAttempts, 0, '');
                                    if (sStatus === 'exists') console.log(paintYellow(`🟡 Subtitle exists: ${subtitleName}`));
                                    else logSuccess(`SUBTITLE: ${subtitleName}`);
                                    await sleep(150);
                                } catch (subErr) { logWarn(`Subtitle fail: ${subErr.message}`); }
                            }
                        }
                    } catch (subOuter) { logWarn(`Subtitle parse error: ${subOuter.message}`); }

                    // ---- Attachments (download beside video) ----
                    try {
                        const attachmentLinks = extractAttachmentLinks(html);
                        if (attachmentLinks.length > 0) {
                            // Derive base (remove .sample.mp4 or .mp4)
                            const videoBaseNoExt = finalFileName.replace(/\.sample\.mp4$/i, '').replace(/\.mp4$/i, '');
                            for (const attUrl of attachmentLinks) {
                                try {
                                    // Extract original filename from URL path (strip query)
                                    let filePart;
                                    try {
                                        const u = new URL(attUrl);
                                        filePart = u.pathname.split('/').pop() || 'attachment.bin';
                                    } catch { filePart = attUrl.split('?')[0].split('/').pop() || 'attachment.bin'; }
                                    // Keep original name (with underscores) but sanitize forbidden characters
                                    const sanitizedAttachment = sanitizeName(filePart);
                                    const finalAttachmentName = `${videoBaseNoExt} - ${sanitizedAttachment}`;
                                    const attachmentPath = path.join(chapterFolder, finalAttachmentName);
                                    if (fs.existsSync(attachmentPath) && fs.statSync(attachmentPath).size > 0) {
                                        console.log(paintYellow(`🟡 Attachment exists: ${finalAttachmentName}`));
                                        continue;
                                    }
                                    console.log(`📎 Attachment: ${finalAttachmentName}`);
                                    const aStatus = await downloadToFile(attUrl, attachmentPath, lectureUrl, RUNTIME_CONFIG.retryAttempts, 0, '');
                                    if (aStatus === 'exists') console.log(paintYellow(`🟡 Attachment exists: ${finalAttachmentName}`));
                                    else logSuccess(`ATTACHMENT: ${finalAttachmentName}`);
                                    await sleep(200);
                                } catch (attErr) {
                                    logWarn(`Attachment fail: ${attErr.message}`);
                                }
                            }
                        }
                    } catch (attOuterErr) {
                        logWarn(`Attachment parse error: ${attOuterErr.message}`);
                    }
                    // polite pause
                    await sleep(400);
                } catch (err) {
                    logError(`FAIL ${finalFileName}: ${err.message}`);
                    failedCount++;
                }
            }
        }
    } finally {
        console.log('—'.repeat(40));
        console.log(`📊 Total lecture units: ${paintBold(String(totalUnits))}`);
        console.log(`✅ Downloaded: ${paintGreen(String(downloadedCount))}`);
        console.log(`🟡 Skipped: ${paintYellow(String(skippedCount))}`);
        console.log(`❌ Failed: ${paintRed(String(failedCount))}`);
        if (totalUnits === 0) {
            if (nonLectureUnits > 0) {
                logInfo(`No downloadable video lectures found. This course appears to contain only non-video units (e.g. assignment/quiz).`);
            } else {
                logInfo('No downloadable video lectures found for this course with current access/session.');
            }
        }
    }
}

main().catch(err => {
    if (/Invalid (range|number token|number)/.test(String(err?.message || ''))) {
        logError(buildActionableError(
            'FILTER_FORMAT',
            `Invalid --chapter/--lesson format: ${err.message}`,
            'Examples: --chapter 2 | --chapter 1,3 | --chapter 2-4 | --lesson 2-5,9'
        ));
        process.exit(2);
    }
    logError(buildActionableError(
        'FATAL',
        String(err?.message || err),
        'Retry with --verbose to see more details.'
    ));
    process.exit(1);
});
