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

const ALL = { minify: true, rename: true, encodeNumbers: true, encryptStrings: true, antiTamper: true };
const PLAIN = { minify: true, rename: true, encodeNumbers: false, encryptStrings: false, antiTamper: true };

/* Mirrors the emitted wrapper: rebuild the byte -> value map from the shuffled
   alphabet, collect every independently keyed payload chunk, and decode four
   characters into three bytes with the (key + i * 31) % 256 keystream. */
function decodeArtifact(artifact) {
    const alphaMatch = /local [A-Za-z_0-9]+ = "([A-Za-z0-9+/]{64})"/.exec(artifact);
    if (!alphaMatch) throw new Error('alphabet not found in artifact');
    const alphabet = alphaMatch[1];

    const map = new Map();
    for (let i = 0; i < alphabet.length; i++) map.set(alphabet[i], i);

    const chunkRe = /\[==\[([A-Za-z0-9+/=]*)\]==\],\s*(\d+)\)/g;
    const bytes = [];
    let chunks = 0;
    let m;

    while ((m = chunkRe.exec(artifact)) !== null) {
        chunks++;
        const payload = m[1];
        const key = Number(m[2]);
        let offset = 0;

        for (let i = 0; i < payload.length; i += 4) {
            const v1 = map.get(payload[i]);
            const v2 = map.get(payload[i + 1]);
            const v3 = payload[i + 2] === '=' ? undefined : map.get(payload[i + 2]);
            const v4 = payload[i + 3] === '=' ? undefined : map.get(payload[i + 3]);
            if (v1 === undefined || v2 === undefined) throw new Error('bad base64 group at ' + i);

            bytes.push((v1 * 4 + Math.floor(v2 / 16)) ^ ((key + offset * 31) & 0xFF));
            offset++;
            if (v3 !== undefined) {
                bytes.push(((v2 % 16) * 16 + Math.floor(v3 / 4)) ^ ((key + offset * 31) & 0xFF));
                offset++;
                if (v4 !== undefined) {
                    bytes.push(((v3 % 4) * 64 + v4) ^ ((key + offset * 31) & 0xFF));
                    offset++;
                }
            }
        }
    }

    if (chunks === 0) throw new Error('payload not found in artifact');
    return Buffer.from(bytes);
}

function build(code, options) {
    const engine = new ObfuscatorEngine(code, options);
    const artifact = engine.buildProtectedVM();
    return { engine, artifact, decoded: decodeArtifact(artifact) };
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

    check('integrity guard emitted',
        encoded.artifact.includes('payload integrity check failed'));
    check('length guard emitted',
        encoded.artifact.includes('payload length mismatch'));

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
const OPTION_NAMES = ['minify', 'rename', 'encodeNumbers', 'encryptStrings', 'antiTamper'];
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

    check('executor target fetches with game:HttpGet', loaders.executor.includes('game:HttpGet'));
    check('studio target uses HttpService:GetAsync', loaders.studio.includes('HttpService'));
    for (const target of ['lua51', 'lua54']) {
        check(target + ' target uses luasocket', loaders[target].includes('socket.http'));
        check(target + ' target falls back to a CLI fetcher',
            loaders[target].includes('curl') && loaders[target].includes('wget'));
    }
    check('universal target probes executors', loaders.auto.includes('game:HttpGet'));
    check('universal target probes request shims', loaders.auto.includes('http_request'));
    check('universal target probes desktop HTTP', loaders.auto.includes('socket.http'));
    check('universal target probes a CLI fetcher', loaders.auto.includes('io.popen'));

    /* A quote in the URL would end the Lua string and turn the loader into a
       syntax error; it must be escaped before it is embedded. */
    const hostile = api.buildLoader('executor', 'https://nix6.example/raw/a"b\\c\nd');
    check('quotes in the URL are escaped', !hostile.includes('a"b') && hostile.includes('%22'));
    check('newlines in the URL are stripped', !hostile.includes('\nd'));

    check('legacy luau maps to the universal target', api.normalizeTarget('luau') === 'auto');
    check('legacy lua maps to lua54', api.normalizeTarget('lua') === 'lua54');
    check('unknown target falls back to universal', api.normalizeTarget('nonsense') === 'auto');
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
    check('bit32 is optional', artifact.includes('type(bit32) == "table"'));
    check('LuaJIT bit library is used when present', artifact.includes('type(bit) == "table"'));
    check('pure-Lua xor fallback remains', artifact.includes('math.floor((_a - _x) / 2)'));
    check('loader falls back to getgenv', artifact.includes('_g.loadstring or _g.load'));
    check('missing loader reports a clear error', artifact.includes('exposes no load() or loadstring()'));
    check('shebang is stripped before compiling', artifact.includes('string.char(10)'));
    check('compile failures are pcall-guarded', artifact.includes('pcall(_loader'));
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
}

console.log('\n' + (failures === 0
    ? 'PASS ' + checked + ' checks'
    : 'FAIL ' + failures + ' of ' + checked + ' checks'));
process.exit(failures === 0 ? 0 : 1);
