import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {redactSecrets, redactUrl} from '../../lib/http-util.mjs';

describe('redact-logging', () => {
    const password = 'SuperSecretPass99';
    const session = 'sess_ABCDEFGHijkl';
    const csrf = 'csrf_TOKEN_VALUE_99';
    const signed = 'https://cdn.example.com/file.mp4?token=tok_LIVE_SECRET&signature=sig_LIVE_SECRET&expires=999';

    it('password never appears after redactSecrets', () => {
        const log = `auth failed password=${password} email=a@b.c`;
        const out = redactSecrets(log, [password]);
        assert.ok(!out.includes(password));
        assert.match(out, /REDACTED/);
    });

    it('sessionid / csrftoken never appear', () => {
        const log = `Cookie: sessionid=${session}; csrftoken=${csrf}`;
        const out = redactSecrets(log);
        assert.ok(!out.includes(session));
        assert.ok(!out.includes(csrf));
    });

    it('signed URL query secrets never appear', () => {
        const outUrl = redactUrl(signed);
        assert.ok(!outUrl.includes('tok_LIVE_SECRET'));
        assert.ok(!outUrl.includes('sig_LIVE_SECRET'));
        const outText = redactSecrets(`fetching ${signed}`);
        assert.ok(!outText.includes('tok_LIVE_SECRET'));
    });
});
