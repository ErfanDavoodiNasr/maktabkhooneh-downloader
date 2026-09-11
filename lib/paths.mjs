/**
 * Safe filename / path helpers for untrusted remote titles.
 */
import path from 'path';
import fs from 'fs';

const WINDOWS_RESERVED = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
]);

/** Strip ANSI / C0 control chars that can poison terminals or paths. */
export function stripControlChars(input) {
    return String(input ?? '').replace(/[\u0000-\u001f\u007f\u009b\u2028\u2029]/g, '');
}

/**
 * Sanitize a remote title into a single path segment (no separators, no traversal).
 */
export function sanitizeName(name, {maxLen = 150, fallback = 'untitled'} = {}) {
    let s = stripControlChars(name);
    // Normalize to NFC so visually-equivalent Persian titles collide less often by accident.
    try {
        s = s.normalize('NFC');
    } catch {
        // ignore
    }
    s = s
        .replace(/[\/\\:*?"<>|]/g, ' ')
        .replace(/[\s\u200c\u200f\u202a\u202b\u202c\u202d\u202e]+/g, ' ')
        .trim();
    // Windows trailing dots/spaces
    s = s.replace(/[.\s]+$/g, '').replace(/^[.\s]+/g, '');
    // Collapse leftover dots that look like traversal
    if (s === '.' || s === '..' || !s) s = fallback;
    const baseNoExt = s.replace(/\.[^.]+$/, '');
    if (WINDOWS_RESERVED.has(baseNoExt.toUpperCase()) || WINDOWS_RESERVED.has(s.toUpperCase())) {
        s = `_${s}`;
    }
    if (s.length > maxLen) s = s.slice(0, maxLen).replace(/[.\s]+$/g, '');
    if (!s) s = fallback;
    return s;
}

export function normalizeCourseFolderNameFromSlug(courseSlug) {
    let decoded = String(courseSlug || '');
    try {
        decoded = decodeURIComponent(decoded);
    } catch {
        // keep raw
    }
    const withoutMkId = decoded.replace(/-mk\d+\s*$/i, '');
    const spaced = withoutMkId.replace(/[-_]+/g, ' ');
    return sanitizeName(spaced, {fallback: 'course'});
}

/**
 * Join segments under root and assert the resolved path stays inside root.
 * Throws if the result would escape.
 */
export function safePathJoin(rootDir, ...segments) {
    const root = path.resolve(rootDir);
    const joined = path.resolve(root, ...segments.map((seg) => {
        // Each segment must be a single sanitized name (no separators)
        const cleaned = sanitizeName(seg, {fallback: 'item'});
        if (cleaned.includes(path.sep) || cleaned.includes('/') || cleaned.includes('\\')) {
            throw new Error(`Unsafe path segment rejected: ${seg}`);
        }
        return cleaned;
    }));
    if (!isPathInsideRoot(root, joined)) {
        throw new Error(`Path escape blocked: ${joined} is outside ${root}`);
    }
    return joined;
}

export function isPathInsideRoot(rootDir, candidatePath) {
    const root = path.resolve(rootDir);
    const candidate = path.resolve(candidatePath);
    const rel = path.relative(root, candidate);
    if (rel === '') return true;
    if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
    return true;
}

/**
 * After resolving through symlinks (where possible), ensure still under root.
 * On platforms without realpath or if path does not exist yet, falls back to
 * lexical containment of the parent that exists.
 */
export function assertOutputPathSafe(rootDir, candidatePath) {
    const root = path.resolve(rootDir);
    const candidate = path.resolve(candidatePath);
    if (!isPathInsideRoot(root, candidate)) {
        throw new Error(`Output path escapes download root: ${candidate}`);
    }
    try {
        const rootReal = fs.realpathSync(root);
        // Resolve existing ancestors
        let probe = candidate;
        while (!fs.existsSync(probe)) {
            const parent = path.dirname(probe);
            if (parent === probe) break;
            probe = parent;
        }
        if (fs.existsSync(probe)) {
            const probeReal = fs.realpathSync(probe);
            if (!isPathInsideRoot(rootReal, probeReal) && probeReal !== rootReal) {
                throw new Error(`Output path resolves outside download root via symlink: ${candidate}`);
            }
        }
    } catch (e) {
        if (String(e.message || '').includes('outside')) throw e;
        // realpath failures on missing roots are non-fatal; lexical check already passed
    }
    return candidate;
}

export function sanitizeContentDispositionFilename(raw, fallback = 'attachment.bin') {
    let name = String(raw || '');
    // RFC 5987 / quoted-string basics
    const star = /filename\*\s*=\s*(?:UTF-8''|utf-8'')([^;]+)/i.exec(name);
    const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i.exec(name);
    if (star) {
        try {
            name = decodeURIComponent(star[1].trim());
        } catch {
            name = star[1].trim();
        }
    } else if (plain) {
        name = (plain[1] || plain[2] || '').trim();
    }
    name = path.basename(name.replace(/\\/g, '/'));
    return sanitizeName(name, {fallback});
}
