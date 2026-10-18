#!/usr/bin/env node
/* Offline check for the obfuscation engine.

   Builds an artifact the same way the API does, decodes the payload back out of
   it exactly as the Lua wrapper would, and asserts the bytes are identical. No
   Lua runtime is needed, so this runs anywhere Node does.

   Usage: node scripts/verify-engine.js   (or: npm test) */

process.env.NODE_ENV = 'production';   // stop server.js from binding a port

const { ObfuscatorEngine } = require('../server.js');

const ENCODED = { minify: true, rename: true, encryptStrings: true, antiTamper: true };
const PLAIN = { minify: true, rename: true, encryptStrings: false, antiTamper: true };

/* Mirrors what the emitted wrapper does: build the byte->value map from the
   shuffled alphabet, then decode four characters into three bytes. */
function decodeArtifact(artifact) {
    const alphaMatch = /local [A-Za-z_0-9]+ = "([A-Za-z0-9+/]{64})"/.exec(artifact);
    if (!alphaMatch) throw new Error('alphabet not found in artifact');
    const alphabet = alphaMatch[1];

    const afterAlphabet = artifact.slice(alphaMatch.index + alphaMatch[0].length);
    const payloadMatch = /\[==\[\r?\n?([A-Za-z0-9+/=]*)\r?\n?\]==\]/.exec(afterAlphabet);
    if (!payloadMatch) throw new Error('payload not found in artifact');
    const payload = payloadMatch[1];

    const keyMatch = /local [A-Za-z_0-9]+ = (\d+)\r?\n/.exec(afterAlphabet);
    if (!keyMatch) throw new Error('xor key not found in artifact');
    const key = Number(keyMatch[1]);

    const map = new Map();
    for (let i = 0; i < alphabet.length; i++) map.set(alphabet[i], i);

    const bytes = [];
    for (let i = 0; i < payload.length; i += 4) {
        const v1 = map.get(payload[i]);
        const v2 = map.get(payload[i + 1]);
        const v3 = payload[i + 2] === '=' ? undefined : map.get(payload[i + 2]);
        const v4 = payload[i + 3] === '=' ? undefined : map.get(payload[i + 3]);
        if (v1 === undefined || v2 === undefined) throw new Error('bad base64 group at ' + i);
        bytes.push(v1 * 4 + Math.floor(v2 / 16));
        if (v3 !== undefined) {
            bytes.push((v2 % 16) * 16 + Math.floor(v3 / 4));
            if (v4 !== undefined) bytes.push((v3 % 4) * 64 + v4);
        }
    }
    return Buffer.from(bytes.map((b) => b ^ key));
}

function build(code, options) {
    const engine = new ObfuscatorEngine(code, options);
    const artifact = engine.buildProtectedVM();
    return { engine, artifact, decoded: decodeArtifact(artifact) };
}

const samples = [
    {
        name: 'emoji, flags, ZWJ families, skin tones',
        code: [
            'local a = "hi 👋 there"',
            'local b = "🇺🇸🇬🇧 👨‍👩‍👧‍👦 👍🏿"',
            'print(a, b)',
            'return a'
        ].join('\n'),
        fragments: ['hi 👋 there', '🇺🇸🇬🇧 👨‍👩‍👧‍👦 👍🏿']
    },
    {
        name: 'CJK, RTL, combining marks, astral plane',
        code: 'local s = "日本語 العربية e\\204\\129 𝕹𝕀𝕏"\nreturn s',
        fragments: ['日本語 العربية', '𝕹𝕀𝕏']
    },
    {
        name: 'unicode escapes and NUL bytes',
        code: 'local a = "\\u{1F600}"\nlocal b = "nul\\0end"\nreturn a .. b',
        fragments: ['nul', 'end']
    },
    {
        name: 'long bracket strings',
        code: 'local a = [[line 🎃 one\nline two]]\nlocal b = [==[with ]] inside]==]\nreturn a .. b',
        fragments: ['line 🎃 one', 'with ]] inside']
    },
    {
        name: 'escapes, quotes and backslashes',
        code: 'local a = "he said \\"hi\\" \\\\ done"\nlocal b = \'it\\\'s\'\nreturn a .. b',
        fragments: ['he said']
    },
    {
        name: 'byte order mark and CRLF',
        code: '\uFEFF--!strict\r\nlocal s = "🎃"\r\nreturn s',
        fragments: ['🎃', '--!strict']
    },
    {
        name: 'luau type annotations and interpolated strings',
        code: 'local x: number = 5\nlocal name = "nix"\nlocal msg = `hello {name} 🎃`\nreturn msg',
        fragments: ['`hello {name} 🎃`', 'number']
    },
    {
        name: 'empty script',
        code: '',
        fragments: []
    }
];

let failures = 0;
let checked = 0;

function check(label, condition, detail) {
    checked++;
    if (!condition) {
        failures++;
        console.error('  FAIL ' + label + (detail ? '\n       ' + detail : ''));
    }
}

for (const sample of samples) {
    console.log('\n' + sample.name);

    /* 1. With string encoding off, every fragment must still be in the source
          the runtime will receive - that is the "nothing is corrupted" proof. */
    const plain = build(sample.code, PLAIN);
    check('payload round-trips byte for byte',
        Buffer.compare(plain.decoded, Buffer.from(plain.engine.lastPrepared, 'utf8')) === 0);
    for (const fragment of sample.fragments) {
        check('unchanged: ' + JSON.stringify(fragment),
            plain.decoded.toString('utf8').includes(fragment),
            plain.decoded.toString('utf8').slice(0, 240));
    }

    /* 2. With every option on, the artifact must not leak readable literals. */
    const encoded = build(sample.code, ENCODED);
    check('encoded payload round-trips byte for byte',
        Buffer.compare(encoded.decoded, Buffer.from(encoded.engine.lastPrepared, 'utf8')) === 0);
    check('reported source length matches',
        encoded.engine.stats.sourceBytes === Buffer.from(encoded.engine.lastPrepared, 'utf8').length);

    const literals = (sample.code.match(/"[^"]{2,}"|'[^']{2,}'/g) || [])
        .map((lit) => lit.slice(1, -1))
        .filter((lit) => lit.length >= 2 && !lit.includes('\\') && !lit.includes('{'));
    for (const literal of literals) {
        check('not readable in artifact: ' + JSON.stringify(literal.slice(0, 24)),
            !encoded.artifact.includes(literal));
    }

    check('integrity guard emitted',
        encoded.artifact.includes('payload integrity check failed'));
    check('length guard emitted',
        encoded.artifact.includes('payload length mismatch'));

    if (sample.code.length > 200) {
        const ratio = Buffer.byteLength(encoded.artifact, 'utf8') / Buffer.byteLength(sample.code, 'utf8');
        console.log('  ok  ' + Buffer.byteLength(encoded.artifact, 'utf8') + ' bytes (' + ratio.toFixed(2) + 'x source)');
    }
}

/* 3. Each option must work on its own. */
const toggleSource = 'local function demo(a)\n    return "x 🎃" .. a\nend\nreturn demo("y")';
for (const option of ['minify', 'rename', 'encryptStrings', 'antiTamper']) {
    const options = { minify: false, rename: false, encryptStrings: false, antiTamper: false };
    options[option] = true;
    const { engine, decoded } = build(toggleSource, options);
    check(option + ' alone yields a decodable artifact',
        Buffer.compare(decoded, Buffer.from(engine.lastPrepared, 'utf8')) === 0);
}

/* 4. Every combination must decode. */
for (let mask = 0; mask < 16; mask++) {
    const options = {
        minify: Boolean(mask & 1),
        rename: Boolean(mask & 2),
        encryptStrings: Boolean(mask & 4),
        antiTamper: Boolean(mask & 8)
    };
    const { engine, decoded } = build(toggleSource, options);
    check('combination ' + mask + ' decodes',
        Buffer.compare(decoded, Buffer.from(engine.lastPrepared, 'utf8')) === 0);
}

console.log('\n' + (failures === 0
    ? 'PASS ' + checked + ' checks'
    : 'FAIL ' + failures + ' of ' + checked + ' checks'));
process.exit(failures === 0 ? 0 : 1);
