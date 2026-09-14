/**
 * Output directory resolution and collision-safe filenames.
 */
import fs from 'fs';
import path from 'path';
import {assertOutputPathSafe, sanitizeName} from './paths.mjs';

export const DEFAULT_DOWNLOAD_SUBDIR = 'download';
export const MAX_JOBS = 32;

/**
 * Resolve course output root.
 * Default (no -o): <cwd>/download/<course>  — preserved for backward compatibility.
 * With -o PATH:     <resolved PATH>/<course>
 */
export function resolveCourseOutputRoot({
                                            outputDir = null,
                                            courseDisplayName,
                                            cwd = process.cwd()
                                        } = {}) {
    const courseSeg = sanitizeName(courseDisplayName, {fallback: 'course'});
    let base;
    if (outputDir == null || String(outputDir).trim() === '') {
        base = path.resolve(cwd, DEFAULT_DOWNLOAD_SUBDIR);
    } else {
        base = path.resolve(cwd, String(outputDir).trim());
    }
    if (fs.existsSync(base) && fs.statSync(base).isFile()) {
        throw new Error(`[OUTPUT_DIR] Path points to a file, not a directory: ${base}`);
    }
    const root = path.join(base, courseSeg);
    assertOutputPathSafe(base, root);
    return {baseDir: base, outputRoot: root, courseFolderName: courseSeg};
}

/**
 * Ensure output directory exists and is writable (best-effort write probe).
 */
export async function ensureOutputDirectory(dirPath) {
    const resolved = path.resolve(dirPath);
    try {
        await fs.promises.mkdir(resolved, {recursive: true});
    } catch (e) {
        if (e?.code === 'EEXIST') {
            if (!fs.statSync(resolved).isDirectory()) {
                throw new Error(`[OUTPUT_DIR] Path exists but is not a directory: ${resolved}`);
            }
        } else if (e?.code === 'EACCES' || e?.code === 'EPERM') {
            throw new Error(`[OUTPUT_DIR] Permission denied creating: ${resolved}`);
        } else if (e?.code === 'ENOSPC') {
            throw new Error(`[OUTPUT_DIR] Disk full while creating: ${resolved}`);
        } else {
            throw new Error(`[OUTPUT_DIR] Cannot create directory ${resolved}: ${e.message}`);
        }
    }
    // Write probe
    const probe = path.join(resolved, `.mkd-write-probe-${process.pid}`);
    try {
        await fs.promises.writeFile(probe, 'ok');
        await fs.promises.unlink(probe);
    } catch (e) {
        if (e?.code === 'ENOSPC') {
            throw new Error(`[OUTPUT_DIR] Disk full (cannot write under ${resolved})`);
        }
        if (e?.code === 'EACCES' || e?.code === 'EPERM') {
            throw new Error(`[OUTPUT_DIR] No write permission under ${resolved}`);
        }
        throw new Error(`[OUTPUT_DIR] Directory not writable: ${resolved} (${e.message})`);
    }
    return resolved;
}

/**
 * If `filePath` exists (or reserved), append -2, -3, ... before extension.
 * Deterministic; does not overwrite.
 */
export function allocateUniquePath(filePath, {existsSync = fs.existsSync} = {}) {
    if (!existsSync(filePath) && !existsSync(`${filePath}.part`)) return filePath;
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    const base = path.basename(filePath, ext);
    for (let i = 2; i < 10_000; i++) {
        const candidate = path.join(dir, `${base}-${i}${ext}`);
        if (!existsSync(candidate) && !existsSync(`${candidate}.part`)) return candidate;
    }
    throw new Error(`[OUTPUT_COLLISION] Cannot allocate unique name for ${filePath}`);
}
