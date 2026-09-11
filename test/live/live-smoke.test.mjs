import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'child_process';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const liveEnabled = process.env.MKD_LIVE === '1';
const configPath = process.env.MKD_LIVE_CONFIG || '.test-config.local.json';

function redact(s) {
    return String(s || '')
        .replace(/sessionid=[^;\s&]+/gi, 'sessionid=[REDACTED]')
        .replace(/csrftoken=[^;\s&]+/gi, 'csrftoken=[REDACTED]')
        .replace(/(password["']?\s*[:=]\s*["']?)([^"'\s,;}]+)/gi, '$1[REDACTED]');
}

function runDownload(args, timeoutMs = 120_000) {
    return new Promise((resolve) => {
        const child = spawn('node', ['download.mjs', ...args], {
            cwd: root,
            env: {...process.env},
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve({code: -1, stdout, stderr, timedOut: true});
        }, timeoutMs);
        child.stdout.on('data', (d) => {
            stdout += d.toString();
        });
        child.stderr.on('data', (d) => {
            stderr += d.toString();
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({code, stdout, stderr, timedOut: false});
        });
    });
}

describe('live-smoke', {skip: !liveEnabled}, () => {
    const fixturesPath = path.join(root, 'test/fixtures/live-courses.json');
    const courses = JSON.parse(fs.readFileSync(fixturesPath, 'utf8')).courses;

    it('config exists for live run', () => {
        const abs = path.resolve(root, configPath);
        assert.ok(fs.existsSync(abs), `Missing live config at ${configPath}`);
    });

    for (const [i, url] of courses.entries()) {
        it(`dry-run course ${i + 1}`, async () => {
            const r = await runDownload([url, '--config', configPath, '--dry-run', '--chapter', '1', '--lesson', '1']);
            if (r.code !== 0) {
                // Document failure without leaking secrets
                const msg = redact(`exit=${r.code} timedOut=${r.timedOut}\n${r.stderr}\n${r.stdout}`.slice(0, 2000));
                assert.fail(`dry-run failed for course ${i + 1}: ${msg}`);
            }
        });
    }

    it('sample-bytes for first course only', async () => {
        const url = courses[0];
        const r = await runDownload([
            url,
            '--config', configPath,
            '--sample-bytes', '65536',
            '--chapter', '1',
            '--lesson', '1'
        ]);
        if (r.code !== 0) {
            const msg = redact(`exit=${r.code}\n${r.stderr}\n${r.stdout}`.slice(0, 2000));
            assert.fail(`sample download failed: ${msg}`);
        }
    });
});
