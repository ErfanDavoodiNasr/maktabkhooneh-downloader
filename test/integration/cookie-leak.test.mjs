import {describe, it} from 'node:test';
import assert from 'node:assert/strict';
import {createMockServer, makeMediaBytes} from '../helpers/mock-server.mjs';
import {buildAuthAwareHeaders, probeRemoteSize} from '../../lib/download-engine.mjs';
import {shouldAttachAuth} from '../../lib/http-util.mjs';

describe('cookie-leak', () => {
    it('Cookie header must not leak across redirect to second origin', async () => {
        const mediaBytes = makeMediaBytes(1024);
        const media = await createMockServer({mediaBytes});
        const auth = await createMockServer({mediaBytes});

        // Auth origin redirects cross-origin to media
        auth.setHandler((req, res) => {
            if ((req.url || '').startsWith('/redirect/cross')) {
                res.writeHead(302, {location: `${media.baseUrl}/media/full`});
                res.end();
                return;
            }
            res.writeHead(404);
            res.end();
        });

        const cookie = 'sessionid=LEAK_TEST_COOKIE_VALUE';
        const trustedOrigin = auth.baseUrl;

        // Manual follow like a careful client: first hop with cookie, second without if foreign
        const headers1 = buildAuthAwareHeaders({cookie, url: `${auth.baseUrl}/redirect/cross`, trustedOrigin});
        assert.equal(headers1.cookie, cookie);

        const res1 = await fetch(`${auth.baseUrl}/redirect/cross`, {
            method: 'GET',
            headers: headers1,
            redirect: 'manual'
        });
        assert.ok(res1.status >= 300 && res1.status < 400);
        const loc = res1.headers.get('location');
        assert.ok(loc.startsWith(media.baseUrl));
        assert.equal(shouldAttachAuth(loc, trustedOrigin), false);

        const headers2 = buildAuthAwareHeaders({cookie, url: loc, trustedOrigin});
        assert.equal(headers2.cookie, undefined);

        await fetch(loc, {method: 'GET', headers: headers2, redirect: 'manual'});

        const leaked = media.requests.some(
            (r) => (r.cookie && r.cookie.includes('LEAK_TEST_COOKIE_VALUE')) ||
                (r.headers.cookie && String(r.headers.cookie).includes('LEAK_TEST_COOKIE_VALUE'))
        );
        assert.equal(leaked, false);

        // probeRemoteSize also strips cookie on cross-origin hop
        await probeRemoteSize(`${auth.baseUrl}/redirect/cross`, {
            cookie,
            trustedOrigin,
            allowPrivateMedia: true,
            fetchFn: (url, init) => fetch(url, init)
        });
        const leakedAfterProbe = media.requests.some(
            (r) => r.cookie && r.cookie.includes('LEAK_TEST_COOKIE_VALUE')
        );
        assert.equal(leakedAfterProbe, false);

        await media.close();
        await auth.close();
    });
});
