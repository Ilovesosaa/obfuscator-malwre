#!/usr/bin/env node
/* Owner-access regression check.

   Uses the real Express app, the real cookie-session middleware, requireOwner
   and /api/me. A signed test session avoids needing Discord OAuth in tests. */

process.env.NODE_ENV = 'production';
process.env.SESSION_SECRET = 'nix6-owner-test-secret-0123456789abcdef';
process.env.NIX6_DATA_DIR = require('os').tmpdir();

const Keygrip = require('keygrip');
const app = require('../server.js');

const OWNER_IDS = ['1257596807857569793', '1561816720845443317'];
const OUTSIDER_ID = '999999999999999999';
const COOKIE_NAME = 'nix6_session';
const sessionKey = process.env.SESSION_SECRET;

let checks = 0;
let failures = 0;

function check(label, condition, detail) {
    checks++;
    if (condition) {
        console.log('  ok ' + label);
        return;
    }
    failures++;
    console.log('  FAIL ' + label + (detail ? ': ' + detail : ''));
}

function sessionCookie(userId) {
    const value = Buffer.from(JSON.stringify({
        user: { id: userId, username: 'owner-test-' + userId }
    })).toString('base64');
    const data = COOKIE_NAME + '=' + value;
    const signature = new Keygrip([sessionKey]).sign(data);
    return data + '; ' + COOKIE_NAME + '.sig=' + signature;
}

async function main() {
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    const port = server.address().port;
    const base = 'http://127.0.0.1:' + port;

    const request = async (path, userId) => {
        const response = await fetch(base + path, {
            headers: { cookie: sessionCookie(userId) }
        });
        let body = null;
        try {
            body = await response.json();
        } catch (err) {
            body = null;
        }
        return { status: response.status, body };
    };

    try {
        for (const id of OWNER_IDS) {
            const me = await request('/api/me', id);
            check('owner ' + id + ' is reported by /api/me',
                me.status === 200 && me.body && me.body.authenticated === true && me.body.isOwner === true,
                JSON.stringify(me));

            const gate = await request('/api/admin/keys', id);
            check('owner ' + id + ' passes the owner-only gate',
                gate.status === 200 && gate.body && gate.body.success === true,
                JSON.stringify(gate));
        }

        const outsiderMe = await request('/api/me', OUTSIDER_ID);
        check('outsider is not reported as owner by /api/me',
            outsiderMe.status === 200 && outsiderMe.body && outsiderMe.body.isOwner === false,
            JSON.stringify(outsiderMe));

        const outsiderGate = await request('/api/admin/keys', OUTSIDER_ID);
        check('outsider is rejected by the owner-only gate',
            outsiderGate.status === 403 && outsiderGate.body && outsiderGate.body.success === false,
            JSON.stringify(outsiderGate));
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }

    console.log((failures ? 'FAIL ' : 'PASS ') + checks + ' checks');
    process.exit(failures ? 1 : 0);
}

main().catch((err) => {
    console.error('owner verification failed:', err);
    process.exit(1);
});
