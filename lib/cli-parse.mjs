/**
 * CLI / filter / numeric parsing with strict validation (no silent coercion).
 */

import {MAX_JOBS} from './output.mjs';
import {buildSchedule} from './schedule.mjs';

export function parseNumberSpec(spec) {
    if (spec == null) return null;
    const text = String(spec).trim();
    if (!text) return null;
    const out = new Set();
    // Reject empty tokens from forms like "1,,2"
    if (/^,|,,|,$/.test(text.replace(/\s+/g, ''))) {
        throw new Error(`Invalid number token: (empty)`);
    }
    const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length === 0) throw new Error('Invalid number token: (empty)');
    for (const p of parts) {
        const m = p.match(/^(\d+)\s*-\s*(\d+)$/);
        if (m) {
            const a = Number.parseInt(m[1], 10);
            const b = Number.parseInt(m[2], 10);
            if (a <= 0 || b <= 0) throw new Error(`Invalid range: ${p}`);
            // Documented: reversed ranges (5-2) are normalized to ascending.
            const [start, end] = a <= b ? [a, b] : [b, a];
            for (let i = start; i <= end; i++) out.add(i);
            continue;
        }
        if (!/^\d+$/.test(p)) throw new Error(`Invalid number token: ${p}`);
        const n = Number.parseInt(p, 10);
        if (n <= 0) throw new Error(`Invalid number: ${p}`);
        out.add(n);
    }
    return out;
}

/**
 * Parse a non-negative integer from CLI. Rejects floats, NaN, empty, negatives.
 * @returns {number}
 */
export function parseStrictNonNegativeInt(raw, {name = 'value'} = {}) {
    if (raw == null || String(raw).trim() === '') {
        throw new Error(`Invalid ${name}: empty`);
    }
    const s = String(raw).trim();
    if (!/^\d+$/.test(s)) {
        throw new Error(`Invalid ${name}: ${raw}`);
    }
    const n = Number.parseInt(s, 10);
    if (!Number.isSafeInteger(n) || n < 0) {
        throw new Error(`Invalid ${name}: ${raw}`);
    }
    return n;
}

export function parseStrictPositiveInt(raw, {name = 'value'} = {}) {
    const n = parseStrictNonNegativeInt(raw, {name});
    if (n <= 0) throw new Error(`Invalid ${name}: must be > 0`);
    return n;
}

export function parseJobs(raw, {name = '--jobs', max = MAX_JOBS} = {}) {
    const n = parseStrictPositiveInt(raw, {name});
    if (n > max) {
        throw new Error(`Invalid ${name}: ${raw} (max ${max})`);
    }
    return n;
}

export function parsePositiveIntOrFallback(value, fallback) {
    const n = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function parseNonNegativeIntOrFallback(value, fallback) {
    const n = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function takeValue(args, i, flag) {
    const v = args[i + 1];
    if (v == null || v.startsWith('-')) throw new Error(`Missing value for ${flag}`);
    return v;
}

/**
 * Parse argv-like array (without node/script). Pure; does not exit.
 */
export function parseArgv(args, defaults = {}) {
    let inputCourseRef = null;
    let sampleBytesToDownload = defaults.sampleBytes ?? 0;
    let isVerboseLoggingEnabled = !!defaults.verbose;
    let isDryRun = !!defaults.dryRun;
    let chapterSpec = defaults.chapter ?? null;
    let lessonSpec = defaults.lesson ?? null;
    let forceLogin = !!defaults.forceLogin;
    let configPath = defaults.configPath ?? 'config.json';
    let jobs = defaults.jobs ?? 1;
    let outputDir = defaults.outputDir ?? null;
    let startAt = defaults.startAt ?? null;
    let stopAt = defaults.stopAt ?? null;
    let startTime = defaults.startTime ?? null;
    let stopTime = defaults.stopTime ?? null;
    let timezone = defaults.timezone ?? null;
    let noWait = !!defaults.noWait;
    let quiet = !!defaults.quiet;
    let positionalCourseSet = false;
    let help = false;
    let version = false;
    const unknown = [];

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--help' || a === '-h') {
            help = true;
        } else if (a === '--version') {
            version = true;
        } else if (a === '--config') {
            configPath = takeValue(args, i, '--config');
            i++;
        } else if (a.startsWith('--config=')) {
            configPath = a.slice('--config='.length);
            if (!configPath) throw new Error('Missing value for --config');
        } else if (a.startsWith('--sample-bytes=')) {
            sampleBytesToDownload = parseStrictNonNegativeInt(a.slice('--sample-bytes='.length), {name: '--sample-bytes'});
        } else if (a === '--sample-bytes') {
            sampleBytesToDownload = parseStrictNonNegativeInt(takeValue(args, i, '--sample-bytes'), {name: '--sample-bytes'});
            i++;
        } else if (a === '--chapter') {
            chapterSpec = takeValue(args, i, '--chapter');
            i++;
        } else if (a.startsWith('--chapter=')) {
            chapterSpec = a.slice('--chapter='.length);
        } else if (a === '--lesson') {
            lessonSpec = takeValue(args, i, '--lesson');
            i++;
        } else if (a.startsWith('--lesson=')) {
            lessonSpec = a.slice('--lesson='.length);
        } else if (a === '-j' || a === '--jobs') {
            jobs = parseJobs(takeValue(args, i, a), {name: a});
            i++;
        } else if (a.startsWith('--jobs=')) {
            jobs = parseJobs(a.slice('--jobs='.length), {name: '--jobs'});
        } else if (a.startsWith('-j') && a.length > 2 && /^\d+$/.test(a.slice(2))) {
            // Support -j4
            jobs = parseJobs(a.slice(2), {name: '-j'});
        } else if (a === '-o' || a === '--output-dir') {
            outputDir = takeValue(args, i, a);
            i++;
        } else if (a.startsWith('--output-dir=')) {
            outputDir = a.slice('--output-dir='.length);
            if (!outputDir) throw new Error('Missing value for --output-dir');
        } else if (a === '--start-at') {
            startAt = takeValue(args, i, '--start-at');
            i++;
        } else if (a.startsWith('--start-at=')) {
            startAt = a.slice('--start-at='.length);
        } else if (a === '--stop-at') {
            stopAt = takeValue(args, i, '--stop-at');
            i++;
        } else if (a.startsWith('--stop-at=')) {
            stopAt = a.slice('--stop-at='.length);
        } else if (a === '--start-time') {
            startTime = takeValue(args, i, '--start-time');
            i++;
        } else if (a.startsWith('--start-time=')) {
            startTime = a.slice('--start-time='.length);
        } else if (a === '--stop-time') {
            stopTime = takeValue(args, i, '--stop-time');
            i++;
        } else if (a.startsWith('--stop-time=')) {
            stopTime = a.slice('--stop-time='.length);
        } else if (a === '--timezone') {
            timezone = takeValue(args, i, '--timezone');
            i++;
        } else if (a.startsWith('--timezone=')) {
            timezone = a.slice('--timezone='.length);
        } else if (a === '--no-wait') {
            noWait = true;
        } else if (a === '--quiet' || a === '-q') {
            quiet = true;
        } else if (a === '--verbose' || a === '-v') {
            isVerboseLoggingEnabled = true;
        } else if (a === '--dry-run') {
            isDryRun = true;
        } else if (a === '--force-login') {
            forceLogin = true;
        } else if (a.startsWith('-')) {
            unknown.push(a);
        } else if (!positionalCourseSet) {
            inputCourseRef = a.trim();
            positionalCourseSet = true;
        }
    }

    if (unknown.length) {
        throw new Error(`Unknown option: ${unknown[0]}`);
    }

    const chapterSpecText = Array.isArray(chapterSpec) ? chapterSpec.join(',') : chapterSpec;
    const lessonSpecText = Array.isArray(lessonSpec) ? lessonSpec.join(',') : lessonSpec;
    const selectedChapters = parseNumberSpec(chapterSpecText);
    const selectedLessons = parseNumberSpec(lessonSpecText);

    const schedule = buildSchedule({startAt, stopAt, startTime, stopTime, timezone, noWait});

    return {
        help,
        version,
        inputCourseRef,
        sampleBytesToDownload,
        isVerboseLoggingEnabled,
        isDryRun,
        forceLogin,
        selectedChapters,
        selectedLessons,
        configPath,
        jobs,
        outputDir,
        startAt,
        stopAt,
        startTime,
        stopTime,
        timezone,
        noWait,
        quiet,
        schedule
    };
}
