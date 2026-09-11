import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    defaultConfigTemplate,
    discoverConfigPath,
    loadConfigFile,
    saveConfigFile,
    validateCourseBaseUrl,
    validateRuntimeConfig
} from '../../lib/config.mjs';
import {TRUSTED_ORIGIN} from '../../lib/http-util.mjs';

describe('discoverConfigPath', () => {
    it('defaults and explicit', () => {
        assert.deepEqual(discoverConfigPath([]), {path: 'config.json', explicit: false});
        assert.deepEqual(discoverConfigPath(['--config', 'x.json']), {path: 'x.json', explicit: true});
        assert.deepEqual(discoverConfigPath(['--config=y.json']), {path: 'y.json', explicit: true});
    });
});

describe('loadConfigFile', () => {
    it('missing file returns empty', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-cfg-miss-'));
        const p = path.join(dir, 'nope.json');
        const r = loadConfigFile(p);
        assert.equal(r.exists, false);
        assert.deepEqual(r.config, {});
    });

    it('rejects empty file', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-cfg-empty-'));
        const p = path.join(dir, 'c.json');
        fs.writeFileSync(p, '   \n');
        assert.throws(() => loadConfigFile(p), /empty/i);
    });

    it('rejects invalid JSON', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-cfg-bad-'));
        const p = path.join(dir, 'c.json');
        fs.writeFileSync(p, '{not json');
        assert.throws(() => loadConfigFile(p), /CONFIG_PARSE|parse/i);
    });

    it('rejects non-object root', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-cfg-arr-'));
        const p = path.join(dir, 'c.json');
        fs.writeFileSync(p, '[1]');
        assert.throws(() => loadConfigFile(p), /object/i);
    });

    it('loads valid object', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-cfg-ok-'));
        const p = path.join(dir, 'c.json');
        fs.writeFileSync(p, JSON.stringify({auth: {email: 'a@b.c'}}));
        const r = loadConfigFile(p);
        assert.equal(r.exists, true);
        assert.equal(r.config.auth.email, 'a@b.c');
    });
});

describe('validateRuntimeConfig', () => {
    it('applies defaults', () => {
        const r = validateRuntimeConfig({});
        assert.equal(r.retryAttempts, 4);
        assert.ok(r.requestTimeoutMs > 0);
    });

    it('rejects bad values', () => {
        assert.throws(() => validateRuntimeConfig({retryAttempts: 0}), /retryAttempts/);
        assert.throws(() => validateRuntimeConfig({requestTimeoutMs: -1}), /requestTimeoutMs/);
        assert.throws(() => validateRuntimeConfig({sampleBytes: -5}), /sampleBytes/);
    });
});

describe('validateCourseBaseUrl', () => {
    it('accepts trusted course base', () => {
        assert.equal(validateCourseBaseUrl(`${TRUSTED_ORIGIN}/course/`), `${TRUSTED_ORIGIN}/course/`);
    });

    it('rejects foreign origin', () => {
        assert.throws(() => validateCourseBaseUrl('https://evil.com/course/'), /origin|Unexpected/i);
    });
});

describe('saveConfigFile', () => {
    it('atomic save preserves content', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mkd-cfg-save-'));
        const p = path.join(dir, 'config.json');
        const cfg = defaultConfigTemplate();
        cfg.auth.email = 'user@example.com';
        await saveConfigFile(p, cfg);
        const loaded = JSON.parse(fs.readFileSync(p, 'utf8'));
        assert.equal(loaded.auth.email, 'user@example.com');
        assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')));
    });
});
