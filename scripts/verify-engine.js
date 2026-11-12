#!/usr/bin/env node
/* Offline check for the obfuscation engine.

   Two layers:

   1. Byte level (always run): builds an artifact the same way the API does,
      decodes the payload back out of it exactly as the Lua wrapper would, and
      asserts the bytes are identical. No Lua runtime is needed.

   2. Runtime level (when a Luau binary is available): runs the original script
      and the obfuscated artifact through the real interpreter and compares
      their output. Put the binary at .tools/luau or point LUAU_BIN at it; the
      section is skipped, and said to be skipped, when neither exists.

   Usage: node scripts/verify-engine.js   (or: npm test) */

process.env.NODE_ENV = 'production';   // stop server.js from binding a port

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { ObfuscatorEngine } = require('../server.js');

const ALL = { minify: true, rename: true, encodeNumbers: true, encryptStrings: true, antiTamper: true, cff: true };
const PLAIN = { minify: true, rename: true, encodeNumbers: false, encryptStrings: false, antiTamper: true, cff: false };

/* Mirrors the emitted wrapper: recover the per-build Base85 alphabet, collect
   the independently keyed payload chunks, decode five characters into four
   bytes, then decrypt the chunk with its RC4 stream. */
function seedKey(seed) {
    const key = Buffer.alloc(8);
    let state = Number(seed) & 0xFFFF;
    for (let i = 0; i < key.length; i++) {
        state = (state * 25173 + 13849) % 65536;
        key[i] = Math.floor(state / 256) % 256;
    }
    return key;
}

function rc4(bytes, key) {
    const s = new Uint8Array(256);
    for (let i = 0; i < 256; i++) s[i] = i;
    let j = 0;
    for (let i = 0; i < 256; i++) {
        j = (j + s[i] + key[i % key.length]) & 0xFF;
        const t = s[i];
        s[i] = s[j];
        s[j] = t;
    }
    const out = Buffer.alloc(bytes.length);
    let i = 0;
    j = 0;
    for (let n = 0; n < bytes.length; n++) {
        i = (i + 1) & 0xFF;
        j = (j + s[i]) & 0xFF;
        const t = s[i];
        s[i] = s[j];
        s[j] = t;
        out[n] = bytes[n] ^ s[(s[i] + s[j]) & 0xFF];
    }
    return out;
}

function decodeArtifact(artifact) {
    const alphaMatch = /local\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*"([^"]{85})"/.exec(artifact);
    if (!alphaMatch) throw new Error('alphabet not found in artifact');
    const alphabet = alphaMatch[1];
    const map = new Map();
    for (let i = 0; i < alphabet.length; i++) map.set(alphabet[i], i);

    const chunkRe = /\{(\d+),(\d+),(\d+),"([^"]*)"\}/g;
    const chunks = [];
    let m;
    while ((m = chunkRe.exec(artifact)) !== null) {
        chunks.push({ index: Number(m[1]), length: Number(m[2]), seed: Number(m[3]), data: m[4] });
    }
    if (chunks.length === 0) throw new Error('payload not found in artifact');
    chunks.sort((a, b) => a.index - b.index);

    const output = [];
    for (const chunk of chunks) {
        const decoded = [];
        for (let i = 0; i < chunk.data.length; i += 5) {
            let value = 0;
            for (let j = 0; j < 5; j++) {
                const digit = map.get(chunk.data[i + j]);
                if (digit === undefined) throw new Error('bad Base85 digit at ' + i);
                value = value * 85 + digit;
            }
            decoded.push(
                Math.floor(value / 16777216) % 256,
                Math.floor(value / 65536) % 256,
                Math.floor(value / 256) % 256,
                value % 256
            );
        }
        const encrypted = Buffer.from(decoded).subarray(0, chunk.length);
        output.push(rc4(encrypted, seedKey(chunk.seed)));
    }
    return Buffer.concat(output);
}

function build(code, options) {
    const engine = new ObfuscatorEngine(code, { virtualize: false, ...(options || {}) });
    const artifact = engine.buildProtectedVM();
    return { engine, artifact, decoded: decodeArtifact(artifact) };
}

/* The VM artifact deliberately has no {index,length,seed,data} chunks, so it
   is verified by running it rather than by the source-level decoder above. */
function buildVM(code, options) {
    const engine = new ObfuscatorEngine(code, { ...(options || {}), virtualize: true });
    const artifact = engine.buildProtectedVM();
    return { engine, artifact };
}

/* Lexical coverage. `fragments` must survive byte for byte when only the
   non-string passes run; they are the "nothing got corrupted" proof. */
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
        name: 'luau nested interpolation: braces, strings, tables',
        code: 'local t = { value = 2 }\nlocal s = `a {t["value"] + (function() return 3 end)()} b`\nreturn s',
        fragments: ['value', 'function() return']
    },
    {
        name: 'static backtick literal (encodable) and escaped braces',
        code: 'local s = `plain 🎃 \\{not an expression\\}`\nreturn s',
        fragments: ['plain 🎃', 'not an expression']
    },
    {
        name: 'shebang first line',
        code: '#!/usr/bin/env lua\n-- a comment\nlocal x = 1\nreturn x',
        fragments: ['#!/usr/bin/env lua']
    },
    {
        name: 'backslash-newline continuation (LF and CRLF)',
        code: 'local a = "one \\\ntwo"\nlocal b = "three \\\r\nfour"\nreturn a .. b',
        fragments: ['one ', 'three ']
    },
    {
        name: 'long comments, deep brackets and directives',
        code: '--!nocheck\n--[==[ block ]] comment ]==]\nlocal v = [===[deep]===]\nreturn v',
        fragments: ['deep']
    },
    {
        name: 'numeric literal zoo (hex, binary, floats, exponents)',
        code: 'local a = 0xFF\nlocal b = 0b1010\nlocal c = 1.5e3\nlocal d = 0x1p4\nlocal e = 1 .. 2\nreturn a, b, c, d, e',
        fragments: ['0xFF', '0b1010', '1.5e3', '0x1p4']
    },
    {
        name: 'goto labels and compound assignment',
        code: 'local x = 1\nx += 2\nx ..= "s"\n::top::\nif false then goto top end\nreturn x',
        fragments: ['::top::', 'goto top']
    },
    {
        name: 'string-call sugar (f"str" must survive encoding)',
        code: 'local function f(s) return s end\nlocal tick = `tick`\nreturn f"plain" .. f[[long]] .. tick',
        fragments: ['plain', 'long', 'tick']
    },
    {
        name: 'plain bracket comment must not swallow code',
        code: '-- [note] this is a line comment, not a long comment ]]\n_G.alive = "still here"\nreturn _G.alive',
        fragments: ['still here', 'return _G.alive']
    },
    {
        name: 'luau integer suffixes and digit separators',
        code: 'local a = 123i\nlocal b = 1_000\nlocal c = 0xABABi\nlocal d = 0b1000_1000i\nreturn a, b, c, d',
        fragments: ['123i', '1_000', '0xABABi', '0b1000_1000i']
    },
    {
        name: 'exponent literals must not be split',
        code: 'local a = 1e-2\nlocal b = 1E2\nlocal c = .5e+3\nreturn a, b, c',
        fragments: ['1e-2', '1E2', '.5e+3']
    },
    {
        name: 'lone surrogate escapes stay byte-exact',
        code: 'local a = "\\u{D800}"\nlocal b = "\\u{DFFF}"\nreturn #a, #b',
        fragments: []
    },
    {
        name: 'identifier ending in a digit followed by a dot',
        code: 'local t2 = { lower = function(s) return s end }\nreturn t2.lower("x")',
        fragments: ['.lower(']
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
    const encoded = build(sample.code, ALL);
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

    check('dual integrity guard emitted',
        encoded.engine.stats.integrityChecks === 2
        && encoded.artifact.includes('% 1000000007')
        && encoded.artifact.includes('% 1000000009'));
    check('length guard emitted', encoded.artifact.includes('~=') && encoded.artifact.includes('string.sub'));
    check('legacy NIX6 marker removed', !encoded.artifact.includes('NIX6_'));

    if (sample.name === 'shebang first line') {
        check('shebang stays on line one of the payload',
            encoded.decoded.toString('utf8').startsWith('#!/usr/bin/env lua'));
    }

    if (sample.code.length > 200) {
        const ratio = Buffer.byteLength(encoded.artifact, 'utf8') / Buffer.byteLength(sample.code, 'utf8');
        console.log('  ok  ' + Buffer.byteLength(encoded.artifact, 'utf8') + ' bytes (' + ratio.toFixed(2) + 'x source)');
    }
}

/* 3. Splitting the payload must not lose or reorder a byte, at any size. */
for (const size of [0, 1, 2, 3, 191, 192, 193, 5000]) {
    const code = 'x'.repeat(size) + 'local tail = "🎃"';
    const { engine, decoded } = build(code, ALL);
    check('payload split at ' + size + ' bytes survives',
        Buffer.compare(decoded, Buffer.from(engine.lastPrepared, 'utf8')) === 0);
}

/* 4. Each option must work on its own. */
const toggleSource = 'local function demo(a)\n    for i = 1, 2 do\n        a = a .. "x 🎃"\n    end\n    return a\nend\nreturn demo("y")';
const OPTION_NAMES = ['minify', 'rename', 'encodeNumbers', 'encryptStrings', 'antiTamper', 'cff'];
for (const option of OPTION_NAMES) {
    const options = { minify: false, rename: false, encodeNumbers: false, encryptStrings: false, antiTamper: false };
    options[option] = true;
    const { engine, decoded } = build(toggleSource, options);
    check(option + ' alone yields a decodable artifact',
        Buffer.compare(decoded, Buffer.from(engine.lastPrepared, 'utf8')) === 0);
}

/* 5. Every combination must decode. */
for (let mask = 0; mask < (1 << OPTION_NAMES.length); mask++) {
    const options = {};
    OPTION_NAMES.forEach((name, bit) => { options[name] = Boolean(mask & (1 << bit)); });
    const { engine, decoded } = build(toggleSource, options);
    check('combination ' + mask + ' decodes',
        Buffer.compare(decoded, Buffer.from(engine.lastPrepared, 'utf8')) === 0);
}

/* 6. Numbers pass: integers are rewritten, floats and non-integers are not. */
{
    const source = 'local a = 12345\nlocal b = 1.5\nlocal c = 1e5\nlocal d = 0xFF\nlocal e = 2^10\n';
    const { decoded } = build(source, { minify: false, rename: false, encodeNumbers: true, encryptStrings: false, antiTamper: false });
    const text = decoded.toString('utf8');
    check('large integer constant is rewritten', !text.includes('12345'), text);
    check('hex integer constant is rewritten', !/\b0xFF\b/.test(text), text);
    check('float literal survives', text.includes('1.5'), text);
    check('exponent literal survives', text.includes('1e5'), text);
}

/* 7. End-to-end: the artifact must behave exactly like the original script. */
const runtimeSamples = [
    {
        name: 'empty chunk',
        code: ''
    },
    {
        name: 'functions, params, loops, interpolation, emoji',
        code: [
            'local function greet(name: string, times: number): string',
            '    local parts = {}',
            '    for i = 1, times do',
            '        parts[#parts + 1] = `hi {name} #{i} 🎃`',
            '    end',
            '    return table.concat(parts, "|")',
            'end',
            'print(greet("nix", 3))'
        ].join('\n')
    },
    {
        name: 'control flow, continue, coroutines, metatables',
        code: [
            'local acc = 0',
            'for i = 1, 20 do',
            '    if i % 2 == 0 then continue end',
            '    acc += i',
            'end',
            'local co = coroutine.wrap(function()',
            '    for i = 1, 3 do coroutine.yield(i) end',
            'end)',
            'local got = {}',
            'for i = 1, 3 do got[i] = co() end',
            'print(acc, table.concat(got, ","))',
            'local t = setmetatable({}, { __index = function(_, k) return k * 2 end })',
            'print(t[21])',
            'local mt = { __add = function(a, b) return a.v + b.v end }',
            'local A, B = setmetatable({ v = 5 }, mt), setmetatable({ v = 7 }, mt)',
            'print(A + B)'
        ].join('\n')
    },
    {
        name: 'string escapes, unicode, long brackets, methods',
        code: [
            'print("tab\\there", "quote\\"inside", \'single\\\'s\')',
            'print("\\u{1F600}", #"日本語", string.upper("abc"))',
            'print([==[long ]] string]==], [==[nested ]=] ok]==])',
            'print(("x"):rep(3), ("%d"):format(42))',
            'local s = "a" .. "b" .. tostring(3)',
            'print(s, #s, string.byte("A"), string.char(66))'
        ].join('\n')
    },
    {
        name: 'numeric literals, integer arithmetic, bit32',
        code: [
            'print(0xFF, 0b1010, 1e3, 1.5, -0x10, 2^10, 7 // 2, 7 % 2)',
            'print(math.floor(3.7), math.max(1, 9, 3))',
            'print(100000000, 999999999999, 1e15)',
            'local i = 0; i += 1; i *= 3; i -= 2; print(i)',
            'print(bit32.bxor(255, 85), #tostring(12345))'
        ].join('\n')
    },
    {
        name: 'closures, upvalues, varargs, shadowing',
        code: [
            'local function pack(...) return select("#", ...), ... end',
            'print(pack(1, nil, 3))',
            'local function counter()',
            '    local n = 0',
            '    return function() n += 1 return n end',
            'end',
            'local c = counter()',
            'print(c(), c(), c())',
            'local function shadow(x: number)',
            '    local y = x * 2',
            '    do',
            '        local x = y + 1',
            '        y = y + x',
            '    end',
            '    return y',
            'end',
            'print(shadow(3))'
        ].join('\n')
    },
    {
        name: 'generic for, table.sort, string.gsub',
        code: [
            'local sum = 0',
            'for _, v in ipairs({ 4, 5, 6 }) do sum += v end',
            'print(sum)',
            'local t = { "b", "c", "a" }',
            'table.sort(t)',
            'print(table.concat(t))',
            'print((("a1b2c3"):gsub("%d", "#")))',
            'for k, v in pairs({ only = 1 }) do print(k, v) end'
        ].join('\n')
    },
    {
        name: 'string-call sugar, bracket comments, digit-ending identifiers',
        code: [
            'local function f(s) return s .. "!" end',
            'local tick = `tick`',
            'print(f"call sugar", f[[long]], tick)',
            '-- [note] a plain comment with ]] in it',
            'local t2 = { lower = function(s) return s end }',
            'print(t2.lower("ABC"), "still here")'
        ].join('\n')
    },
    {
        name: 'luau integer suffixes, separators and exponent literals',
        code: [
            'print(123i, 1_000, 0b1010, 0xFF)',
            'print(0xABABi, 0b1000_1000i)',
            'print(1e-2, 1E2, .5e+3)'
        ].join('\n')
    },
    {
        name: 'sandboxed environment (metatable on the globals) still runs',
        code: [
            'local out = print',
            'setmetatable(getfenv(), {})',
            'out("sandboxed", 1 + 1, "ok")'
        ].join('\n')
    },
    {
        name: 'lone surrogate escapes stay raw bytes',
        code: [
            'local a = "\\u{D800}"',
            'print(#a, string.byte(a, 1, 3), pcall(utf8.codepoint, a) == false)'
        ].join('\n')
    }
];

/* 8. Runtime targets: every loader must point at the right primitive for its
      runtime, and must be quoted safely no matter what the host header held. */
{
    const api = require('../server.js').__engine;
    const URL = 'https://nix6.example/raw/abc123';
    const loaders = {};
    for (const target of Object.keys(api.RUN_TARGETS)) {
        const loader = api.buildLoader(target, URL);
        loaders[target] = loader;
        check(target + ' loader is non-empty', typeof loader === 'string' && loader.length > 40);
        check(target + ' loader embeds the payload URL', loader.includes(URL));
        check(target + ' loader resolves a compile function',
            /loadstring or load|_g\.loadstring/.test(loader));
    }

    /* The executor loader is the one users paste, so it has to stay a single
       line that reads as a loadstring -- not a probe chain. */
    check('executor loader is one line', loaders.auto.split('\n').length === 1, loaders.auto);
    check('executor loader is a loadstring',
        loaders.auto.startsWith('(loadstring or load)(game:HttpGet(') && loaders.auto.endsWith('))()'));
    check('executor loader stays short (< 120 chars)', loaders.auto.length < 120, loaders.auto);
    check('executor loader fetches with game:HttpGet', loaders.auto.includes('game:HttpGet'));

    check('studio target uses HttpService:GetAsync', loaders.studio.includes('HttpService'));
    check('studio loader is one line', loaders.studio.split('\n').length === 1, loaders.studio);
    for (const target of ['lua51', 'lua54']) {
        check(target + ' target uses luasocket', loaders[target].includes('socket.http'));
        check(target + ' target falls back to curl', loaders[target].includes('curl'));
        check(target + ' target is at most three lines',
            loaders[target].split('\n').length <= 3, loaders[target]);
    }

    /* A quote in the URL would end the Lua string and turn the loader into a
       syntax error; it must be escaped before it is embedded. */
    const hostile = api.buildLoader('auto', 'https://nix6.example/raw/a"b\\c\nd');
    check('quotes in the URL are escaped', !hostile.includes('a"b') && hostile.includes('%22'));
    check('newlines in the URL are stripped', !hostile.includes('\nd'));

    check('legacy luau maps to the executor target', api.normalizeTarget('luau') === 'auto');
    check('legacy executor maps to the executor target', api.normalizeTarget('executor') === 'auto');
    check('legacy lua maps to lua54', api.normalizeTarget('lua') === 'lua54');
    check('unknown target falls back to the executor target', api.normalizeTarget('nonsense') === 'auto');
}

/* 9. Dialect warnings: Luau-only syntax must be flagged for Lua targets, and
      strings/comments must not trigger them. */
{
    const api = require('../server.js').__engine;
    const luauOnly = 'local x: number = 1\nfor i = 1, 3 do if i == 2 then continue end end\nlocal s = `n={x}`';
    const luaWarnings = api.compatibilityWarnings(luauOnly, 'lua51');
    check('type annotations warn on Lua targets', luaWarnings.some((w) => w.includes('type annotations')));
    check('continue warns on Lua targets', luaWarnings.some((w) => w.includes('continue')));
    check('interpolated strings warn on Lua targets', luaWarnings.some((w) => w.includes('interpolated')));
    check('Luau target does not warn about Luau syntax',
        api.compatibilityWarnings(luauOnly, 'auto').length === 0);

    /* The same tokens inside a string or comment are data, not syntax. */
    const quoted = 'local a = "x += 1 // continue"\n-- local b: number = 2';
    check('compound assignment in a string is not flagged',
        !api.compatibilityWarnings(quoted, 'lua51').some((w) => w.includes('compound')));
    check('comments do not trigger Luau warnings',
        !api.compatibilityWarnings(quoted, 'lua51').some((w) => w.includes('type annotations')));

    const luaOnly = 'setfenv(1, {})\nlocal t = unpack({1, 2})';
    const luauWarnings = api.compatibilityWarnings(luaOnly, 'auto');
    check('setfenv warns on Luau targets', luauWarnings.some((w) => w.includes('setfenv')));
    check('global unpack warns on Luau targets', luauWarnings.some((w) => w.includes('unpack')));
    check('Lua target does not warn about Lua syntax',
        api.compatibilityWarnings(luaOnly, 'lua54').length === 0);
}

/* 10. The emitted wrapper must stay portable: no bit32-only path, a loader
       lookup that survives a missing loadstring, and a shebang strip (load()
       on a string rejects a chunk that starts with '#'). */
{
    const { artifact } = build('print("portable")', ALL);
    const secondArtifact = build('print("portable")', ALL).artifact;
    check('artifact is randomized per build', secondArtifact !== artifact);
    check('bit32 is optional', artifact.includes('type(bit32) == "table"'));
    check('LuaJIT bit library is used when present', artifact.includes('type(bit) == "table"'));
    check('pure-Lua xor fallback remains', artifact.includes('math.floor((_a - _x) / 2)'));
    check('loader falls back to getgenv', artifact.includes('_g.loadstring or _g.load'));
    check('missing loader reports a clear error', artifact.includes('debug.loadstring') && artifact.includes('error('));
    check('shebang is stripped before compiling', artifact.includes('string.char(10)'));
    check('compile failures are pcall-guarded', artifact.includes('pcall('));
    const alphaMatch = /local\s+[A-Za-z_][A-Za-z0-9_]*\s*=\s*"([^"]{85})"/.exec(artifact);
    check('Base85 alphabet is unique', Boolean(alphaMatch) && new Set(alphaMatch[1]).size === 85);
    check('old Base64 alphabet removed',
        !artifact.includes('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'));
    check('payload uses per-chunk RC4 metadata', /\{\d+,\d+,\d+,"[^"]*"\}/.test(artifact));
}

/* 11. Loader-link gate: game clients get the artifact, browsers get the block
      page, and known HTTP downloaders get a harmless decoy. */
{
    const api = require('../server.js').__engine;
    const classify = api.classifyRawClient;

    check('link allows executor Roblox clients', classify('Roblox/WinInet', {}, 'auto') === 'runtime');
    check('link allows Studio clients', classify('RobloxStudio/WinInet', {}, 'studio') === 'runtime');
    check('link blocks browsers',
        classify('Mozilla/5.0 (Windows NT 10.0) Chrome/120.0', { accept: 'text/html' }, 'auto') === 'browser');
    check('link blocks browser-only fetch headers',
        classify('', { 'sec-fetch-mode': 'navigate' }, 'auto') === 'browser');
    check('link decoys Python downloaders',
        classify('python-requests/2.31.0', { accept: '*/*' }, 'auto') === 'tool');
    check('link decoys curl for executor links', classify('curl/8.4.0', {}, 'auto') === 'tool');
    check('link allows desktop curl', classify('curl/8.4.0', {}, 'lua51') === 'runtime');
    check('link allows renamed executor agents', classify('SomeExecutor/1.0', {}, 'auto') === 'runtime');
    check('link decoy is harmless Lua',
        api.RAW_DECOY.includes('return _app') && !api.RAW_DECOY.includes('script.code'));
}

/* 12. Support reports: Discord URLs are validated, the embed contains the
       server timestamp and message, and the payload cannot ping a channel. */
{
    const api = require('../server.js').__engine;
    const webhook = 'https://discord.com/api/webhooks/123456789012345678/' + 'a'.repeat(68);

    check('support cooldown is one day', api.SUPPORT_REPORT_COOLDOWN_MS === 24 * 60 * 60 * 1000);
    check('support accepts a Discord webhook', api.isValidSupportWebhook(webhook));
    check('support rejects non-Discord hosts',
        !api.isValidSupportWebhook('https://example.com/api/webhooks/123456789012345678/' + 'a'.repeat(68)));
    check('support rejects insecure webhooks',
        !api.isValidSupportWebhook(webhook.replace('https://', 'http://')));

    const payload = api.buildSupportPayload({
        category: 'bug',
        message: 'The compiler broke on line 2',
        user: { id: '42', username: 'tester' },
        page: '/vault'
    });
    const embed = payload.embeds[0];
    check('support embed labels the report type', embed.title.includes('Bug report'));
    check('support embed carries the message', embed.description === 'The compiler broke on line 2');
    check('support embed includes the submitter',
        embed.fields.some((field) => field.value.includes('tester') && field.value.includes('42')));
    check('support embed includes a Discord timestamp',
        embed.fields.some((field) => field.name === 'Sent' && field.value.includes('<t:')));
    check('support embed includes an ISO timestamp', /^\d{4}-\d{2}-\d{2}T/.test(embed.timestamp));
    check('support disables mentions', payload.allowed_mentions.parse.length === 0);

    const anonymous = api.buildSupportPayload({ category: 'feature', message: 'Add dark mode' });
    check('support accepts anonymous reports',
        anonymous.embeds[0].fields.some((field) => field.value === 'Anonymous'));
    check('support maps unknown types to something else',
        api.buildSupportPayload({ category: 'nonsense', message: 'x' }).embeds[0].title.includes('Something else'));
}

function findLuau() {
    const local = path.join(__dirname, '..', '.tools', 'luau');
    if (fs.existsSync(local)) return local;
    if (process.env.LUAU_BIN && fs.existsSync(process.env.LUAU_BIN)) return process.env.LUAU_BIN;
    return null;
}

function runLuau(binary, code) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nix6-'));
    const file = path.join(dir, 'chunk.luau');
    fs.writeFileSync(file, code);
    try {
        const stdout = execFileSync(binary, [file], {
            encoding: 'utf8',
            timeout: 20000,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        return { ok: true, stdout, stderr: '' };
    } catch (err) {
        return {
            ok: false,
            stdout: err.stdout || '',
            stderr: err.stderr || String(err),
            status: err.status
        };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const luau = findLuau();
if (!luau) {
    console.log('\nruntime checks: SKIPPED (no .tools/luau and no LUAU_BIN)');
} else {
    console.log('\nruntime checks with ' + luau);
    for (const sample of runtimeSamples) {
        console.log('  ' + sample.name);
        const original = runLuau(luau, sample.code);
        check('original runs: ' + sample.name, original.ok, original.stderr);

        const { artifact } = build(sample.code, ALL);
        const obfuscated = runLuau(luau, artifact);
        check('obfuscated runs: ' + sample.name, obfuscated.ok, obfuscated.stderr);
        check('output identical: ' + sample.name,
            original.stdout === obfuscated.stdout,
            'original=' + JSON.stringify(original.stdout) + ' obfuscated=' + JSON.stringify(obfuscated.stdout));
    }

    {
        const { artifact } = build('print("tamper-check")', ALL);
        const tampered = artifact.replace(/(\{\d+,\d+,\d+,")([^"])/, (_, head, ch) =>
            head + (ch === 'A' ? 'B' : 'A'));
        check('tampered payload is rejected',
            tampered !== artifact && !runLuau(luau, tampered).ok);
    }

    {
        const source = [
            'local function fib(n: number): number',
            '    if n < 2 then return n end',
            '    return fib(n - 1) + fib(n - 2)',
            'end',
            'local parts = {}',
            'for i = 1, 8 do parts[i] = tostring(fib(i)) end',
            'print("bytecode-vm", table.concat(parts, ","))'
        ].join('\n');
        const original = runLuau(luau, source);
        const vm = buildVM(source, ALL);
        check('bytecode VM is selected', vm.engine.stats.virtualized === true,
            'compiler unavailable or compile failed');
        if (vm.engine.stats.virtualized) {
            check('bytecode VM emits bytecode size', vm.engine.stats.bytecodeBytes > 0);
            check('bytecode VM does not embed prepared source', !vm.artifact.includes('fib(n - 1)'));
            check('bytecode VM embeds the Fiu interpreter', vm.artifact.includes('luau_load'));
            check('bytecode VM integrity guards are armed',
                vm.engine.stats.integrityChecks === 2
                && vm.artifact.includes('% 1000000007')
                && vm.artifact.includes('% 1000000009'));
            check('bytecode VM has no source loadstring', !vm.artifact.includes('loadstring(prepared'));
            const obfuscated = runLuau(luau, vm.artifact);
            check('bytecode VM runs', obfuscated.ok, obfuscated.stderr);
            check('bytecode VM output identical',
                original.stdout === obfuscated.stdout,
                'original=' + JSON.stringify(original.stdout) + ' vm=' + JSON.stringify(obfuscated.stdout));
        }
    }

    /* 9. Control-flow flattening: a function body becomes a randomized
          dispatcher, locals are hoisted only when safe, and the VM carries the
          same flattened CFG into bytecode. */
    {
        const source = [
            'local function outer(base: number)',
            '    local total = 0',
            '    local function add(x: number)',
            '        local bump = x + 1',
            '        return bump + base',
            '    end',
            '    for i = 1, 3 do',
            '        total = total + add(i)',
            '    end',
            '    return total',
            'end',
            'print(outer(10))'
        ].join('\n');
        const original = runLuau(luau, source);
        const bare = { minify: false, rename: false, encodeNumbers: false, encryptStrings: false, antiTamper: false, cff: true };
        const first = build(source, bare);
        const second = build(source, bare);
        check('CFF flattens top-level and nested functions', first.engine.stats.cffFunctions >= 3 && first.engine.stats.cffBlocks >= 4);
        check('CFF emits a dispatcher', first.engine.lastPrepared.includes('while true do'));
        check('CFF shuffles and randomizes per build', first.engine.lastPrepared !== second.engine.lastPrepared);
        check('CFF output has multiple states', (first.engine.lastPrepared.match(/\belseif\b/g) || []).length >= 2);
        check('CFF can be switched off',
            !build(source, { ...bare, cff: false }).engine.lastPrepared.includes('while true do'));
        const flattened = runLuau(luau, first.artifact);
        check('CFF artifact runs', flattened.ok, flattened.stderr);
        check('CFF output identical', original.stdout === flattened.stdout,
            'original=' + JSON.stringify(original.stdout) + ' cff=' + JSON.stringify(flattened.stdout));

        const vm = buildVM(source, ALL);
        if (vm.engine.stats.virtualized) {
            check('CFF is compiled into the VM path', vm.engine.stats.cffFunctions > 0);
            const vmOut = runLuau(luau, vm.artifact);
            check('CFF VM output identical', vmOut.ok && vmOut.stdout === original.stdout, vmOut.stderr);
        }

        /* One direct statement is still a basic block: a single loop must be
           wrapped without moving its break/return targets out of the loop. */
        const oneLoopSource = [
            'local function emit(n: number)',
            '    for i = 1, n do',
            '        if i == 2 then break end',
            '        print("one-loop", i)',
            '    end',
            'end',
            'emit(5)'
        ].join('\n');
        const oneLoopOriginal = runLuau(luau, oneLoopSource);
        const oneLoop = build(oneLoopSource, bare);
        check('CFF flattens a one-loop function',
            oneLoop.engine.stats.cffFunctions >= 2
            && oneLoop.engine.lastPrepared.includes('while true do'));
        const oneLoopOut = runLuau(luau, oneLoop.artifact);
        check('CFF preserves break inside a one-loop function',
            oneLoopOut.ok && oneLoopOut.stdout === oneLoopOriginal.stdout,
            'original=' + JSON.stringify(oneLoopOriginal.stdout) + ' cff=' + JSON.stringify(oneLoopOut.stdout) + ' ' + oneLoopOut.stderr);

        const earlyReturnSource = [
            'local function firstSmall(n: number)',
            '    for i = 1, n do',
            '        if i == 3 then return i end',
            '    end',
            'end',
            'print(firstSmall(5))'
        ].join('\n');
        const earlyReturnOriginal = runLuau(luau, earlyReturnSource);
        const earlyReturn = build(earlyReturnSource, bare);
        const earlyReturnOut = runLuau(luau, earlyReturn.artifact);
        check('CFF preserves return inside a one-loop function',
            earlyReturnOut.ok && earlyReturnOut.stdout === earlyReturnOriginal.stdout,
            'original=' + JSON.stringify(earlyReturnOriginal.stdout) + ' cff=' + JSON.stringify(earlyReturnOut.stdout) + ' ' + earlyReturnOut.stderr);

        const oneReturnSource = [
            'local function oneValue()',
            '    return "one"',
            'end',
            'print(oneValue())'
        ].join('\n');
        const oneReturnOriginal = runLuau(luau, oneReturnSource);
        const oneReturn = build(oneReturnSource, bare);
        const oneReturnOut = runLuau(luau, oneReturn.artifact);
        check('CFF preserves a direct return',
            oneReturnOut.ok && oneReturnOut.stdout === oneReturnOriginal.stdout,
            'original=' + JSON.stringify(oneReturnOriginal.stdout) + ' cff=' + JSON.stringify(oneReturnOut.stdout) + ' ' + oneReturnOut.stderr);

        const oneTopSource = 'for i = 1, 3 do print("top-loop", i) end';
        const oneTopOriginal = runLuau(luau, oneTopSource);
        const oneTop = build(oneTopSource, bare);
        check('CFF flattens a single top-level loop',
            oneTop.engine.stats.cffBlocks >= 1 && oneTop.engine.lastPrepared.includes('while true do'));
        const oneTopOut = runLuau(luau, oneTop.artifact);
        check('CFF single top-level loop output identical',
            oneTopOut.ok && oneTopOut.stdout === oneTopOriginal.stdout,
            'original=' + JSON.stringify(oneTopOriginal.stdout) + ' cff=' + JSON.stringify(oneTopOut.stdout) + ' ' + oneTopOut.stderr);

        const oneScopeSource = [
            'local function keep(n: number)',
            '    local value = n',
            'end',
            'keep(3)'
        ].join('\n');
        const oneScope = build(oneScopeSource, bare);
        const oneScopeOut = runLuau(luau, oneScope.artifact);
        check('CFF preserves a one-statement local scope',
            oneScopeOut.ok && oneScope.engine.stats.cffBlocks >= 1, oneScopeOut.stderr);
    }

    /* 10. Env loggers replace getfenv/loadstring with Lua closures and then
           trace what the artifact does. The anti-tamper guard must reject that
           runtime before either the source wrapper or VM reaches a loader. */
    {
        const loggerHarness = (artifact) => `local realGetfenv = getfenv
local realLoadstring = loadstring
local leaked = false
local loadCalls = 0
getfenv = function(level)
    return realGetfenv(level)
end
loadstring = function(code, ...)
    loadCalls = loadCalls + 1
    if type(code) == "string" and code:find("ENV_LOG_CANARY", 1, true) then leaked = true end
    return realLoadstring(code, ...)
end
local ok, err = pcall(function(...)
${artifact}
end)
print("ok=" .. tostring(ok) .. " load_calls=" .. tostring(loadCalls) .. " leaked=" .. tostring(leaked))
`;
        const sourceLogged = runLuau(luau, loggerHarness(build('print("ENV_LOG_CANARY")', ALL).artifact));
        check('env logger guard rejects a wrapped source runtime',
            sourceLogged.ok && sourceLogged.stdout.includes('ok=false'), sourceLogged.stderr);
        check('env logger guard blocks source decoding',
            sourceLogged.stdout.includes('load_calls=0'), sourceLogged.stdout);
        check('env logger guard leaves no source marker',
            !sourceLogged.stdout.includes('leaked=true'), sourceLogged.stdout);

        const loggedVm = buildVM('print("ENV_LOG_CANARY")', ALL);
        if (loggedVm.engine.stats.virtualized) {
            const vmLogged = runLuau(luau, loggerHarness(loggedVm.artifact));
            check('env logger guard rejects an instrumented VM',
                vmLogged.ok && vmLogged.stdout.includes('ok=false'), vmLogged.stderr);
            check('env logger guard blocks VM payload loading',
                vmLogged.stdout.includes('load_calls=0'), vmLogged.stdout);
        }
    }
}

console.log('\n' + (failures === 0
    ? 'PASS ' + checked + ' checks'
    : 'FAIL ' + failures + ' of ' + checked + ' checks'));
process.exit(failures === 0 ? 0 : 1);
