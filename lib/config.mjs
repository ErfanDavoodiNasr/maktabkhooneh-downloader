/**
 * Config load / validate / atomic save with restrictive permissions when possible.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import {parseNonNegativeIntOrFallback, parsePositiveIntOrFallback} from './cli-parse.mjs';
import {assertTrustedCourseUrl, TRUSTED_ORIGIN} from './http-util.mjs';

export const DEFAULT_CONFIG_FILE = 'config.json';
export const DEFAULT_RETRY_ATTEMPTS = 4;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_READ_TIMEOUT_MS = 120_000;

export function discoverConfigPath(args) {
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--config') {
            const v = args[i + 1];
            return {path: v ? v : DEFAULT_CONFIG_FILE, explicit: true};
        }
        if (a.startsWith('--config=')) {
            return {path: a.slice('--config='.length) || DEFAULT_CONFIG_FILE, explicit: true};
        }
    }
    return {path: DEFAULT_CONFIG_FILE, explicit: false};
}

export function loadConfigFile(filePath) {
    const resolved = path.resolve(process.cwd(), filePath || DEFAULT_CONFIG_FILE);
    if (!fs.existsSync(resolved)) return {config: {}, configPath: resolved, exists: false};
    let txt;
    try {
        txt = fs.readFileSync(resolved, 'utf8');
    } catch (e) {
        throw new Error(`[CONFIG_READ] Cannot read config file: ${resolved}. ${e.message}`);
    }
    if (!String(txt).trim()) {
        throw new Error(`[CONFIG_PARSE] Config file is empty: ${resolved}\nNext step:\n- Restore from config.example.json`);
    }
    let cfg;
    try {
        cfg = JSON.parse(txt);
    } catch (e) {
        throw new Error(`[CONFIG_PARSE] Cannot parse config file: ${resolved}. ${e.message}\nNext step:\n- Fix JSON syntax, or pass another path with --config <file>.`);
    }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
        throw new Error(`[CONFIG_PARSE] config root must be a JSON object`);
    }
    return {config: cfg, configPath: resolved, exists: true};
}

export function validateRuntimeConfig(runtimeCfg = {}) {
    const retryAttempts = parsePositiveIntOrFallback(runtimeCfg.retryAttempts, DEFAULT_RETRY_ATTEMPTS);
    const requestTimeoutMs = parsePositiveIntOrFallback(runtimeCfg.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    const readTimeoutMs = parsePositiveIntOrFallback(runtimeCfg.readTimeoutMs, DEFAULT_READ_TIMEOUT_MS);
    const sampleBytes = parseNonNegativeIntOrFallback(runtimeCfg.sampleBytes, 0);

    if (runtimeCfg.retryAttempts != null && runtimeCfg.retryAttempts !== '' &&
        !(Number.parseInt(String(runtimeCfg.retryAttempts), 10) > 0)) {
        throw new Error('[CONFIG_RUNTIME] runtime.retryAttempts must be a positive integer');
    }
    if (runtimeCfg.requestTimeoutMs != null && runtimeCfg.requestTimeoutMs !== '' &&
        !(Number.parseInt(String(runtimeCfg.requestTimeoutMs), 10) > 0)) {
        throw new Error('[CONFIG_RUNTIME] runtime.requestTimeoutMs must be a positive integer');
    }
    if (runtimeCfg.readTimeoutMs != null && runtimeCfg.readTimeoutMs !== '' &&
        !(Number.parseInt(String(runtimeCfg.readTimeoutMs), 10) > 0)) {
        throw new Error('[CONFIG_RUNTIME] runtime.readTimeoutMs must be a positive integer');
    }
    if (runtimeCfg.sampleBytes != null && runtimeCfg.sampleBytes !== '' &&
        Number.parseInt(String(runtimeCfg.sampleBytes), 10) < 0) {
        throw new Error('[CONFIG_RUNTIME] runtime.sampleBytes must be >= 0');
    }

    return {retryAttempts, requestTimeoutMs, readTimeoutMs, sampleBytes};
}

export function validateCourseBaseUrl(baseUrl) {
    const b = String(baseUrl || '').trim() || `${TRUSTED_ORIGIN}/course/`;
    const normalized = b.endsWith('/') ? b : `${b}/`;
    assertTrustedCourseUrl(normalized.endsWith('/course/') ? normalized : new URL('/course/', normalized).href);
    // Also accept exactly trusted course base
    const u = new URL(normalized);
    if (u.origin !== TRUSTED_ORIGIN) {
        throw new Error(`[CONFIG_BASEURL] course.baseUrl origin must be ${TRUSTED_ORIGIN}`);
    }
    if (!u.pathname.includes('/course')) {
        throw new Error('[CONFIG_BASEURL] course.baseUrl must point at /course/ on maktabkhooneh.org');
    }
    return normalized;
}

/** Restrictive mode for credential-bearing files on Unix. No-op / best-effort on Windows. */
export function tightenFilePermissions(filePath) {
    if (process.platform === 'win32') return;
    try {
        fs.chmodSync(filePath, 0o600);
    } catch {
        // ignore
    }
}

/**
 * Atomic write: temp file in same directory + rename.
 * Preserves unrelated keys; caller passes full config object.
 */
export async function saveConfigFile(configPath, config) {
    const dir = path.dirname(configPath);
    const tmp = path.join(dir, `.${path.basename(configPath)}.${process.pid}.${Date.now()}.tmp`);
    const payload = `${JSON.stringify(config, null, 2)}\n`;
    try {
        await fs.promises.writeFile(tmp, payload, {encoding: 'utf8', mode: 0o600});
        await fs.promises.rename(tmp, configPath);
        tightenFilePermissions(configPath);
        return true;
    } catch (e) {
        try {
            await fs.promises.unlink(tmp);
        } catch {
            // ignore
        }
        throw e;
    }
}

export function defaultConfigTemplate() {
    return {
        course: {baseUrl: `${TRUSTED_ORIGIN}/course/`},
        auth: {
            email: '',
            password: '',
            cookie: '',
            cookieFile: '',
            sessionCookie: '',
            sessionUpdated: ''
        },
        runtime: {
            sampleBytes: 0,
            retryAttempts: DEFAULT_RETRY_ATTEMPTS,
            requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
            readTimeoutMs: DEFAULT_READ_TIMEOUT_MS
        },
        defaults: {
            chapter: '',
            lesson: '',
            dryRun: false,
            forceLogin: false,
            verbose: false
        }
    };
}

export function tmpDirForTests(prefix = 'mkd-') {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
