import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'child_process';
import fs from 'fs';
import path from 'path';
import {fileURLToPath} from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

describe('installers', () => {
    const bashScripts = [
        path.join(root, 'install.sh'),
        path.join(root, 'scripts/installer/setup-unix.sh')
    ];
    const psScripts = [
        path.join(root, 'install.ps1'),
        path.join(root, 'scripts/installer/setup-windows.ps1')
    ];

    it('bash -n on install.sh and setup-unix.sh', () => {
        for (const script of bashScripts) {
            assert.ok(fs.existsSync(script), script);
            const r = spawnSync('bash', ['-n', script], {encoding: 'utf8'});
            assert.equal(r.status, 0, `${script}: ${r.stderr || r.stdout}`);
        }
    });

    it('shellcheck when available', () => {
        const which = spawnSync('sh', ['-c', 'command -v shellcheck'], {encoding: 'utf8'});
        if (which.status !== 0) {
            return;
        }
        for (const script of bashScripts) {
            const r = spawnSync('shellcheck', ['-x', script], {encoding: 'utf8'});
            assert.equal(r.status, 0, `${script}:\n${r.stdout}${r.stderr}`);
        }
    });

    it('PowerShell files non-empty; no bare Invoke-Expression on remote', () => {
        for (const script of psScripts) {
            assert.ok(fs.existsSync(script), script);
            const txt = fs.readFileSync(script, 'utf8');
            assert.ok(txt.trim().length > 20, `${script} empty`);
            // Flag dangerous IEX of remote content unless explicitly commented as reviewed
            const lines = txt.split(/\r?\n/);
            for (const line of lines) {
                const trimmed = line.trim();
                if (trimmed.startsWith('#')) continue;
                if (/Invoke-Expression/i.test(trimmed) || /\bIEX\b/i.test(trimmed)) {
                    assert.ok(
                        /#\s*(safe|reviewed|trusted)/i.test(line),
                        `${script} has Invoke-Expression without safety comment: ${trimmed}`
                    );
                }
            }
        }
    });

    it('installers preserve existing config', () => {
        const unix = fs.readFileSync(path.join(root, 'scripts/installer/setup-unix.sh'), 'utf8');
        const win = fs.readFileSync(path.join(root, 'scripts/installer/setup-windows.ps1'), 'utf8');
        assert.match(unix, /ensure_config_file/);
        assert.match(win, /Ensure-ConfigFile/);
    });
});
