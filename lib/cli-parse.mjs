/**
 * CLI / filter / numeric parsing with strict validation (no silent coercion).
 */

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

export function parsePositiveIntOrFallback(value, fallback) {
    const n = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function parseNonNegativeIntOrFallback(value, fallback) {
    const n = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
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
    let positionalCourseSet = false;
    let help = false;
    const unknown = [];

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--help' || a === '-h') {
            help = true;
        } else if (a === '--config') {
            const v = args[i + 1];
            if (!v || v.startsWith('-')) throw new Error('Missing value for --config');
            configPath = v;
            i++;
        } else if (a.startsWith('--config=')) {
            configPath = a.slice('--config='.length);
            if (!configPath) throw new Error('Missing value for --config');
        } else if (a.startsWith('--sample-bytes=')) {
            sampleBytesToDownload = parseStrictNonNegativeInt(a.slice('--sample-bytes='.length), {name: '--sample-bytes'});
        } else if (a === '--sample-bytes') {
            const v = args[i + 1];
            if (v == null || v.startsWith('-')) throw new Error('Missing value for --sample-bytes');
            sampleBytesToDownload = parseStrictNonNegativeInt(v, {name: '--sample-bytes'});
            i++;
        } else if (a === '--chapter') {
            const v = args[i + 1];
            if (v == null || v.startsWith('-')) throw new Error('Missing value for --chapter');
            chapterSpec = v;
            i++;
        } else if (a.startsWith('--chapter=')) {
            chapterSpec = a.slice('--chapter='.length);
        } else if (a === '--lesson') {
            const v = args[i + 1];
            if (v == null || v.startsWith('-')) throw new Error('Missing value for --lesson');
            lessonSpec = v;
            i++;
        } else if (a.startsWith('--lesson=')) {
            lessonSpec = a.slice('--lesson='.length);
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

    return {
        help,
        inputCourseRef,
        sampleBytesToDownload,
        isVerboseLoggingEnabled,
        isDryRun,
        forceLogin,
        selectedChapters,
        selectedLessons,
        configPath
    };
}
