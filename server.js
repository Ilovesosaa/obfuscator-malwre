const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Owner Discord ID
const OWNER_DISCORD_ID = "1257596807857569793";

// Storage backends for the vault and the API-key list. The document names are
// the same in every backend so a deployment can be moved between them.
const { put: blobPut, get: blobGet, BlobNotFoundError } = require('@vercel/blob');

// GitHub Gist remains supported for anyone who already set these up.
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const KEYS_GIST_ID = process.env.KEYS_GIST_ID;
const VAULT_GIST_ID = process.env.VAULT_GIST_ID;

// Where the local-file backend writes. Vercel's filesystem is read-only apart
// from /tmp, so on a serverless host this backend is for development only.
const DATA_DIR = process.env.NIX6_DATA_DIR || __dirname;
let vaultDatabase = [];
let keyDatabase = [];

/* Vercel injects BLOB_STORE_ID for a connected store, together with a
   short-lived OIDC token. A long-lived BLOB_READ_WRITE_TOKEN is used when one
   exists, since it also works outside a Vercel request. */
function blobCredentials() {
    if (process.env.BLOB_READ_WRITE_TOKEN) {
        return { token: process.env.BLOB_READ_WRITE_TOKEN };
    }
    if (process.env.BLOB_STORE_ID && (process.env.VERCEL_OIDC_TOKEN || process.env.VERCEL)) {
        return { storeId: process.env.BLOB_STORE_ID };
    }
    return null;
}

function gistIdFor(name) {
    if (name === 'vault.json') return VAULT_GIST_ID;
    if (name === 'keys.json') return KEYS_GIST_ID;
    return null;
}

function canWriteLocal() {
    try {
        fs.accessSync(DATA_DIR, fs.constants.W_OK);
        return true;
    } catch (e) {
        return false;
    }
}

/* Which backend is actually in use, so a silent fall back to memory shows up in
   /api/storage instead of being discovered when scripts go missing. */
function storageBackend() {
    if (blobCredentials()) return 'vercel-blob';
    if (GITHUB_TOKEN && (KEYS_GIST_ID || VAULT_GIST_ID)) return 'github-gist';
    if (canWriteLocal()) return 'local-file';
    return 'memory';
}

async function streamToText(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
}

async function readDocument(name) {
    const credentials = blobCredentials();
    if (credentials) {
        try {
            const result = await blobGet(name, { access: 'private', useCache: false, ...credentials });
            if (!result || !result.stream) return null;
            return JSON.parse(await streamToText(result.stream));
        } catch (err) {
            if (err instanceof BlobNotFoundError || /not.?found/i.test(err.message || '')) return null;
            throw err;
        }
    }

    const gistId = gistIdFor(name);
    if (GITHUB_TOKEN && gistId) {
        const res = await fetch(`https://api.github.com/gists/${gistId}`, {
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'User-Agent': 'Vercel-Nix6-App'
            }
        });
        if (!res.ok) return null;
        const data = await res.json();
        const content = data.files && data.files[name] && data.files[name].content;
        return content ? JSON.parse(content) : null;
    }

    const file = path.join(DATA_DIR, name);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/* Writes are chained per document: two requests that both read-modify-write the
   vault cannot interleave their uploads and lose one of them. */
const writeChains = new Map();

function serializeWrite(name, task) {
    const previous = writeChains.get(name) || Promise.resolve();
    const next = previous.then(task, task);
    writeChains.set(name, next.catch(() => {}));
    return next;
}

async function writeDocument(name, value) {
    const json = JSON.stringify(value, null, 2);

    const credentials = blobCredentials();
    if (credentials) {
        const result = await blobPut(name, json, {
            access: 'private',
            addRandomSuffix: false,
            allowOverwrite: true,
            contentType: 'application/json',
            ...credentials
        });
        return { persisted: true, backend: 'vercel-blob', pathname: result.pathname };
    }

    const gistId = gistIdFor(name);
    if (GITHUB_TOKEN && gistId) {
        const res = await fetch(`https://api.github.com/gists/${gistId}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'Content-Type': 'application/json',
                'User-Agent': 'Vercel-Nix6-App'
            },
            body: JSON.stringify({ files: { [name]: { content: json } } })
        });
        if (!res.ok) throw new Error(`Gist write failed with ${res.status}`);
        return { persisted: true, backend: 'github-gist' };
    }

    if (canWriteLocal()) {
        fs.writeFileSync(path.join(DATA_DIR, name), json);
        return { persisted: true, backend: 'local-file' };
    }

    return { persisted: false, backend: 'memory' };
}

/* Helper to load keys (persistent backend, then in-process cache) */
async function loadKeys() {
    try {
        const stored = await readDocument('keys.json');
        if (Array.isArray(stored)) {
            keyDatabase = stored;
            return stored;
        }
    } catch (e) {
        console.error('Key load error:', e.message);
    }
    return keyDatabase;
}

/* Helper to save keys. Resolves to { persisted, backend } so callers can tell
   the user when a write only reached memory. */
async function saveKeys(keys) {
    keyDatabase = keys;
    return serializeWrite('keys.json', () => writeDocument('keys.json', keys));
}

/* Helper to load vault scripts */
async function loadVault() {
    try {
        const stored = await readDocument('vault.json');
        if (Array.isArray(stored)) {
            vaultDatabase = stored;
            return stored;
        }
    } catch (e) {
        console.error('Vault load error:', e.message);
    }
    return vaultDatabase;
}

/* Helper to save vault scripts. Called on every create, edit and delete. */
async function saveVault(vault) {
    vaultDatabase = vault;
    return serializeWrite('vault.json', () => writeDocument('vault.json', vault));
}

/* ============================================================
   Obfuscation options

   The four toggles in the UI used to be decorative and the server
   ignored them. They now drive a real pass over the source before it
   is XOR-wrapped:

     minify         drop comments and squeeze whitespace (never inside a
                    string; `--!` directives and a `#!` shebang are kept)
     rename         rename local identifiers, function parameters and loop
                    variables, but only when the name can be proven
                    unambiguous (see renameIdentifiers)
     encodeNumbers  rewrite integer literals as parenthesised arithmetic that
                    evaluates to the same value, so offsets and constants are
                    no longer readable in the payload
     encryptStrings emit string literals as keyed byte sequences that are
                    rebuilt at runtime, so they are not readable in the payload
     antiTamper     verify a checksum of the payload before running it

   Everything here is deliberately conservative: a construct that cannot be
   proven safe is skipped, and the counts are reported back to the UI.
   ============================================================ */

/* The switches arrive from the UI as booleans. Anything missing counts as on,
   which matches the checked boxes the form ships with. */
// Emoji character ranges for detection and preservation
// Emoji are in these Unicode ranges (code points):
// - 0x1F600-0x1F64F: Emoticons
// - 0x1F300-0x1F5FF: Miscellaneous Symbols and Pictographs
// - 0x1F680-0x1F6FF: Transport and Map Symbols
// - 0x2600-0x26FF: Miscellaneous Symbols
// - 0x2700-0x27BF: Dingbats
// - 0xFE00-0xFE0F: Variation Selectors
// - 0x1F900-0x1F9FF: Supplemental Symbols and Pictographs
// - 0x1FA00-0x1FA6F: Chess Symbols
function normalizeObfuscationOptions(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    return {
        minify: input.minify !== false,
        rename: input.rename !== false,
        encodeNumbers: input.encodeNumbers !== false,
        encryptStrings: input.encryptStrings !== false,
        antiTamper: input.antiTamper !== false
    };
}

/* Runtime targets. The payload itself is plain Lua in every case; what changes
   is how the vault hands it back. The default is deliberately one line: every Roblox
   executor exposes game:HttpGet and either loadstring or load, so the short
   form is the most portable one there is. The longer variants exist only for
   runtimes that genuinely need a different fetch path. */
const RUN_TARGETS = {
    auto: {
        id: 'auto',
        label: 'Any executor',
        ext: 'luau',
        legacyFileType: 'luau',
        note: 'One line: game:HttpGet fetches the payload, loadstring or load compiles it.'
    },
    studio: {
        id: 'studio',
        label: 'Roblox Studio',
        ext: 'luau',
        legacyFileType: 'luau',
        note: 'One line through HttpService; Studio must allow loadstring.'
    },
    lua51: {
        id: 'lua51',
        label: 'Lua 5.1 / LuaJIT',
        ext: 'lua',
        legacyFileType: 'lua',
        note: 'Desktop Lua: luasocket, with curl as the fallback.'
    },
    lua54: {
        id: 'lua54',
        label: 'Lua 5.2 - 5.5',
        ext: 'lua',
        legacyFileType: 'lua',
        note: 'Same fetch as 5.1, compiled with load instead of loadstring.'
    }
};

/* Vault entries written before targets existed stored luau or lua, and
   executor was a separate target before the one-liner became the default. */
const LEGACY_TARGETS = { luau: 'auto', lua: 'lua54', executor: 'auto' };

function normalizeTarget(raw) {
    const key = String(raw == null ? '' : raw).trim().toLowerCase();
    if (RUN_TARGETS[key]) return key;
    if (LEGACY_TARGETS[key]) return LEGACY_TARGETS[key];
    return 'auto';
}

function targetInfo(raw) {
    return RUN_TARGETS[normalizeTarget(raw)];
}

/* URLs are embedded in quoted Lua strings, so anything that could close the
   quote or start a new line is percent-encoded rather than trusted. */
function luaSafeUrl(url) {
    return String(url).replace(/[\r\n\t]/g, '').replace(/"/g, '%22').replace(/\\/g, '%5C');
}

/* Desktop Lua has no built-in HTTP, so this is the one target that cannot be a
   single line. luasocket first, then the local curl binary. */
function desktopFetchLua(url) {
    const u = luaSafeUrl(url);
    return `local ok, src = pcall(function() return require("socket.http").request("${u}") end)
if not ok or not src or src == "" then local p = io.popen('curl -fsSL "${u}"'); src = p:read("*a"); p:close() end
`;
}

/* The snippet a user pastes into their runtime. Nothing here is longer than it
   has to be: the executor path is the one-line loadstring everyone expects. */
function buildLoader(rawTarget, rawUrl) {
    const target = normalizeTarget(rawTarget);
    const url = luaSafeUrl(rawUrl);

    if (target === 'studio') {
        return `(loadstring or load)(game:GetService("HttpService"):GetAsync("${url}"))()`;
    }

    if (target === 'lua51' || target === 'lua54') {
        return desktopFetchLua(rawUrl) + '(loadstring or load)(src)()';
    }

    return `(loadstring or load)(game:HttpGet("${url}"))()`;
}

/* Constructs that exist in one dialect but not the other. A warning here is
   cheap; the alternative is a script that only fails once it reaches a user's
   executor, after the vault has already stored it. */
const DIALECT_CHECKS = {
    luau: [
        { re: /\bsetfenv\s*\(/, label: 'setfenv() is not available in Luau' },
        { re: /\bgetfenv\s*\(/, label: 'getfenv() is not available in Luau' },
        { re: /\bmodule\s*\(/, label: 'module() does not exist in Luau' },
        { re: /(^|[^\w.])unpack\s*\(/, label: 'global unpack() is gone in Luau; use table.unpack' }
    ],
    lua: [
        { re: /`/, label: 'interpolated strings are Luau-only', raw: true },
        { re: /(^|[^\w.])(\+=|-=|\*=|\/=|%=|\^=|\.\.=)/, label: 'compound assignment is Luau-only' },
        { re: /\bcontinue\b/, label: 'continue is Luau-only' },
        { re: /::\s*[A-Za-z_]/, label: 'type casts (::) are Luau-only' },
        { re: /\b(?:local|function)\b[^\n]*\b[a-zA-Z_]\w*\s*:\s*(?:number|string|boolean|any|thread|table|function|nil|[A-Z]\w*)/, label: 'type annotations are Luau-only' },
        { re: /\\u\{/, label: '\\u{...} escapes are Luau-only', raw: true }
    ]
};

function compatibilityWarnings(source, rawTarget) {
    const target = normalizeTarget(rawTarget);
    const dialect = target === 'lua51' || target === 'lua54' ? 'lua' : 'luau';
    const checks = DIALECT_CHECKS[dialect] || [];
    const segs = scanLua(String(source == null ? '' : source));
    const code = segs.map((s) => (s.type === 'code' ? s.text : ' '.repeat(s.text.length))).join('');
    const warnings = [];
    for (const check of checks) {
        /* Backticks and \u{...} live inside what the scanner calls a string, so
           those two read the raw text; everything else reads code only. */
        const haystack = check.raw ? String(source) : code;
        if (check.re.test(haystack)) warnings.push(check.label);
    }
    return warnings;
}

/* Checks if a Unicode code point is an emoji (simplified check).
   Returns true if the code point falls within known emoji ranges.
   This is used to preserve emoji strings during minify/encode passes.
*/
function isEmojiCodePoint(codePoint) {
    // Comprehensive emoji range check - true emoji have specific code point ranges
    if (codePoint >= 0x1F600 && codePoint <= 0x1F64F) return true; // Emoticons
    if (codePoint >= 0x1F300 && codePoint <= 0x1F5FF) return true; // Misc Symbols & Pictographs
    if (codePoint >= 0x1F680 && codePoint <= 0x1F6FF) return true; // Transport & Map
    if (codePoint >= 0x2600 && codePoint <= 0x26FF) return true; // Misc Symbols
    if (codePoint >= 0x2700 && codePoint <= 0x27BF) return true; // Dingbats
    if (codePoint >= 0xFE00 && codePoint <= 0xFE0F) return true; // Variation Selectors
    if (codePoint >= 0x1F900 && codePoint <= 0x1F9FF) return true; // Supplemental
    if (codePoint >= 0x1FA00 && codePoint <= 0x1FA6F) return true; // Chess
    if (codePoint >= 0x1F1E6 && codePoint <= 0x1F1FF) return true; // Regional Indicator (flags)
    if (codePoint >= 0xE0020 && codePoint <= 0xE007F) return true; // Tag sequences (flags)
    if (codePoint >= 0x2B00 && codePoint <= 0x2BFF) return true; // Stars, arrows
    if (codePoint >= 0x1F000 && codePoint <= 0x1F0FF) return true; // Mahjong, playing cards
    if (codePoint === 0x00A9 || codePoint === 0x00AE) return true; // (c), (r) forms
    if (codePoint === 0x2122 || codePoint === 0x2139) return true; // tm, info
    // NOTE: general punctuation (U+2000-U+206F), U+FEFF and U+FFFC-FFFD are
    // deliberately NOT treated as emoji: they occur in ordinary prose, and
    // flagging those strings would silently skip minify/string encoding for
    // a large share of real scripts.
    return false;
}

/* Extracts Unicode code points from a UTF-8 string, yielding numeric code
   points. Handles every UTF-8 byte length, so skin tone modifiers, ZWJ
   sequences and flags are read correctly. */
function* extractCodePoints(src) {
    const buf = Buffer.from(src, 'utf8');
    let i = 0;
    while (i < buf.length) {
        const byte = buf[i];
        let codePoint = 0;
        if (byte < 0x80) {
            // 1-byte: ASCII (0x00-0x7F)
            codePoint = byte;
            i++;
        } else if (byte >= 0xC0 && byte <= 0xDF) {
            // 2-byte sequence (U+0080 - U+07FF)
            codePoint = (byte & 0x1F) << 6 | (buf[i + 1] & 0x3F);
            i += 2;
        } else if (byte >= 0xE0 && byte <= 0xEF) {
            // 3-byte sequence (U+0800 - U+FFFF, most emoji)
            codePoint = (byte & 0x0F) << 12 | (buf[i + 1] & 0x3F) << 6 | (buf[i + 2] & 0x3F);
            i += 3;
        } else if (byte >= 0xF0 && byte <= 0xF7) {
            // 4-byte sequence (U+10000 and above, extended emoji)
            codePoint = (byte & 0x07) << 18 | (buf[i + 1] & 0x3F) << 12 | (buf[i + 2] & 0x3F) << 6 | (buf[i + 3] & 0x3F);
            i += 4;
        } else {
            // Continuation byte or invalid - skip
            i++;
            continue;
        }
        yield codePoint;
    }
}

/* Returns true if str contains any emoji code point. Safe for long strings. */
function stringContainsEmoji(str) {
    for (const cp of extractCodePoints(str)) {
        if (isEmojiCodePoint(cp)) return true;
    }
    return false;
}

/* Shared by the server and the emitted payload. It is deliberately below
   2^31 so that every intermediate value fits a signed 32-bit integer: an
   implementation that does integer maths in 32 bits must reach the same
   number as this one, or a legitimate script would refuse to run. */
const INTEGRITY_MODULUS = 1000000007;

const LUA_KEYWORDS = new Set([
    'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function',
    'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then',
    'true', 'until', 'while', 'continue', 'export', 'type', 'typeof'
]);

/* Names the renamer never touches: the wrapper's own helper plus anything a
   script may reach for by name through an executor or the Roblox globals. */
const RESERVED_NAMES = new Set([
    'game', 'workspace', 'script', 'task', 'Instance', 'Enum', 'Vector3',
    'CFrame', 'Color3', 'UDim2', 'UDim', 'Ray', 'Region3', 'BrickColor',
    'TweenInfo', 'Random', 'Players', 'print', 'warn', 'error', 'assert',
    'pcall', 'xpcall', 'select', 'type', 'typeof', 'tostring', 'tonumber',
    'ipairs', 'pairs', 'next', 'rawget', 'rawset', 'rawequal', 'setmetatable',
    'getmetatable', 'unpack', 'table', 'string', 'math', 'os', 'io',
    'coroutine', 'bit32', 'utf8', 'debug', 'require', 'loadstring', 'load',
    'spawn', 'wait', 'delay', 'tick', 'self', '_G', '_ENV', 'NIX6_STR',
    // Luau type/builtin names: a rename must never reach inside a type
    // annotation, where these are the whole vocabulary.
    'number', 'string', 'boolean', 'any', 'unknown', 'never', 'nil', 'thread',
    'userdata', 'buffer', 'vector', 'functions', 'typeof', 'export', 'type'
]);

/* Reads a long bracket ([==[ ... ]==]) starting at `at`. Returns null when the
   bracket is not a long bracket, so the caller can treat it as plain code. */
function readLongBracket(src, at) {
    /* `at` must be the first `[`. Without this guard a plain `-- [note]`
       comment would match: the scan starts at at + 1 and finds the `[` of the
       note, then treats the rest of the file as a long comment up to the next
       `]]`. */
    if (src[at] !== '[') return null;
    let k = at + 1;
    let level = 0;
    while (src[k] === '=') { level++; k++; }
    if (src[k] !== '[') return null;
    const closeMark = ']' + '='.repeat(level) + ']';
    const close = src.indexOf(closeMark, k + 1);
    if (close === -1) return null;
    return { end: close + closeMark.length };
}

/* True for a comment the payload must keep in place: `--!strict`/`--!native`
   only work on the first line, and a `#!` shebang only works as byte zero. */
function isDirectiveComment(seg) {
    return seg.type === 'comment' && (seg.shebang === true || /^\s*--!/.test(seg.text));
}

/* End of a "..."/'...' literal opened at `at`.

   \z swallows the whitespace after it, a backslash may continue the line even
   when the file uses CRLF, and an unescaped newline closes an unterminated
   literal at the end of its line (the parser will reject it either way; the
   point is that the scanner must not swallow the rest of the file). */
function scanQuotedString(src, at) {
    const quote = src[at];
    let j = at + 1;
    const n = src.length;
    while (j < n) {
        const c = src[j];
        if (c === '\\') {
            if (src[j + 1] === 'z') {
                j += 2;
                while (j < n && /\s/.test(src[j])) j++;
                continue;
            }
            if (src[j + 1] === '\r' && src[j + 2] === '\n') { j += 3; continue; }
            j += 2;
            continue;
        }
        if (c === quote) return { end: j + 1, interpolated: false };
        if (c === '\n') return { end: j, interpolated: false, unterminated: true };
        j++;
    }
    return { end: n, interpolated: false, unterminated: true };
}

/* Skips the expression inside `{ ... }` of a Luau interpolated string. It is
   real code, so strings, comments, long brackets and nested tables inside it
   are scanned properly: a `}` or a backtick in there cannot end the outer
   literal early. Returns the index just past the closing brace. */
function scanInterpolationExpression(src, at) {
    const n = src.length;
    let j = at;
    let depth = 1;
    while (j < n) {
        const c = src[j];
        if (c === '{') { depth++; j++; continue; }
        if (c === '}') { depth--; j++; if (depth === 0) return j; continue; }
        if (c === '"' || c === "'") { j = scanQuotedString(src, j).end; continue; }
        if (c === '`') { j = scanInterpolatedString(src, j).end; continue; }
        if (c === '-' && src[j + 1] === '-') {
            const long = readLongBracket(src, j + 2);
            if (long) { j = long.end; continue; }
            while (j < n && src[j] !== '\n') j++;
            continue;
        }
        if (c === '[') {
            const long = readLongBracket(src, j);
            if (long) { j = long.end; continue; }
        }
        j++;
    }
    return n;
}

/* End of a Luau `interpolated {string}` opened at `at`. Static backtick
   literals (no `{` anywhere) behave exactly like "..." and can be encoded;
   the flag tells the string pass which one it is looking at. */
function scanInterpolatedString(src, at) {
    const n = src.length;
    let j = at + 1;
    let interpolated = false;
    while (j < n) {
        const c = src[j];
        if (c === '\\') {
            if (src[j + 1] === 'z') {
                j += 2;
                while (j < n && /\s/.test(src[j])) j++;
                continue;
            }
            if (src[j + 1] === '\r' && src[j + 2] === '\n') { j += 3; continue; }
            j += 2;
            continue;
        }
        if (c === '`') return { end: j + 1, interpolated };
        if (c === '{') {
            interpolated = true;
            j = scanInterpolationExpression(src, j + 1);
            continue;
        }
        j++;
    }
    return { end: n, interpolated, unterminated: true };
}

/* Splits source into code / string / comment runs. This is the only place that
   needs to understand Lua's lexical structure; every transform works on the
   runs, so nothing can ever be edited inside a string or comment by accident.

   Every dialect form is covered: 5.1 through 5.4 quoted strings (with \z and
   backslash-newline continuations), all long-bracket levels, long comments,
   Luau backtick interpolation (including nested strings and braces inside the
   interpolated expression), a `#!` shebang and a UTF-8 byte order mark.

   Everything is handled as UTF-16 sequences here: emoji, flags, ZWJ families,
   CJK and combining marks all survive because no pass ever splits a surrogate
   pair or slices a multi-byte character. */
function scanLua(src) {
    const segs = [];
    let i = 0;
    let codeStart = 0;
    const n = src.length;
    const pushCode = (end) => {
        if (end > codeStart) segs.push({ type: 'code', text: src.slice(codeStart, end) });
    };

    /* The standalone interpreters skip a first line starting with `#`. Keeping
       it as a directive comment is what stops minify from turning it into
       tokens, and keeps it on line one where it has to be. */
    if (src.startsWith('#!')) {
        let j = 0;
        while (j < n && src[j] !== '\n') j++;
        segs.push({ type: 'comment', text: src.slice(0, j), shebang: true });
        i = j;
        codeStart = i;
    }

    while (i < n) {
        const c = src[i];

        if (c === '-' && src[i + 1] === '-') {
            pushCode(i);
            const long = readLongBracket(src, i + 2);
            if (long) {
                segs.push({ type: 'comment', text: src.slice(i, long.end) });
                i = long.end;
            } else {
                let j = i;
                while (j < n && src[j] !== '\n') j++;
                segs.push({ type: 'comment', text: src.slice(i, j) });
                i = j;
            }
            codeStart = i;
            continue;
        }

        if (c === '"' || c === "'" || c === '`') {
            pushCode(i);
            const scanned = c === '`' ? scanInterpolatedString(src, i) : scanQuotedString(src, i);
            segs.push({
                type: 'string',
                text: src.slice(i, scanned.end),
                quote: c,
                interpolated: Boolean(scanned.interpolated)
            });
            i = scanned.end;
            codeStart = i;
            continue;
        }

        if (c === '[') {
            const long = readLongBracket(src, i);
            if (long) {
                pushCode(i);
                segs.push({ type: 'string', text: src.slice(i, long.end), quote: '[', interpolated: false });
                i = long.end;
                codeStart = i;
                continue;
            }
        }

        i++;
    }

    pushCode(n);
    return segs;
}

function segmentsToText(segs) {
    return segs.map((s) => s.text).join('');
}

/* 1 where the character is code, 0 inside a string or comment. */
function buildMask(segs) {
    const mask = new Uint8Array(segmentsToText(segs).length);
    let at = 0;
    for (const seg of segs) {
        if (seg.type === 'code') mask.fill(1, at, at + seg.text.length);
        at += seg.text.length;
    }
    return mask;
}

/* --- minify ------------------------------------------------------------- */

/* Every literal Lua 5.1-5.4 and Luau can lex has to come out as one token, or
   minify would insert a space in the middle of it: hex floats (`0x1p4`,
   `0xA.8p-2`), binary integers (`0b1010`), Luau digit separators (`1_000`,
   `0xf_f`) and the Luau integer suffix (`123i`, `0xABABi`). */
const CODE_TOKEN_RE = /\s+|0[xX][0-9a-fA-F_]+(?:\.[0-9a-fA-F_]*)?(?:[pP][+-]?[0-9]+)?i?|0[bB][01_]+i?|[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][+-]?[0-9]+)?i?|\.[0-9][0-9_]*(?:[eE][+-]?[0-9]+)?|[A-Za-z_][A-Za-z0-9_]*|\.\.\.|\.\.|==|~=|<=|>=|::|\+=|-=|\*=|\/=|%=|\^=|\.\.=|\/\/=|\/\/|<<|>>|[\s\S]/g;

const isWordChar = (ch) => ch !== undefined && /[A-Za-z0-9_]/.test(ch);

/* The only place a separator is required: two word characters would fuse into
   one identifier/number, `-` + `-` would open a comment, `[` + `[` would open a
   long string, and a number followed by `.` would become a malformed numeral. */
function tokensNeedSpace(prev, next) {
    if (!prev || !next) return false;
    const a = prev[prev.length - 1];
    const b = next[0];
    if (isWordChar(a) && isWordChar(b)) return true;
    if (a === '-' && b === '-') return true;
    if (a === '[' && (b === '[' || b === '=')) return true;
    if (a === '.' && b === '.') return true;
    /* Only a numeral can fuse with a following `.`: `1 .. 2` is `1.` + `.2`.
       Testing the last character instead would put a space into `utf8.lower`
       whenever the preceding identifier ends in a digit. */
    if (b === '.' && /^[0-9][0-9a-fA-FxX._]*$/.test(prev)) return true;
    if (a === '/' && b === '/') return true;
    if (a === ':' && b === ':') return true;
    if (a === '<' && b === '<') return true;
    if (a === '>' && b === '>') return true;
    return false;
}

/* Squeezes one run of code down to the shortest token stream that still lexes
   the same way. Non-ASCII never appears in a code run (it lives in strings and
   comments), so this cannot damage a multi-byte character. */
function minifyCodeRun(text) {
    /* One line at a time. Newlines are statement boundaries in Lua, so they
       are kept (a blank line is dropped only between two real lines):
       joining statements would make `local x = 1` fuse with the next call
       once the string encoder rebuilds the literal in between. */
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const squeezed = lines.map((line) => {
        const tokens = [];
        const re = new RegExp(CODE_TOKEN_RE.source, 'g');
        let m;
        while ((m = re.exec(line)) !== null) {
            if (/^\s+$/.test(m[0])) continue;
            tokens.push(m[0]);
        }
        let out = '';
        let prev = '';
        for (const tok of tokens) {
            if (tokensNeedSpace(prev, tok)) out += ' ';
            out += tok;
            prev = tok;
        }
        return out;
    });
    const kept = squeezed.filter((line, index) =>
        index === 0 || index === squeezed.length - 1 || line !== '');
    return kept.join('\n');
}

function minifySource(src) {
    const segs = scanLua(src);
    const out = [];
    let commentsRemoved = 0;
    let tokensSqueezed = 0;

    for (const seg of segs) {
        if (seg.type === 'comment') {
            /* --!strict and --!nocheck are compiler directives, not prose, and
               they only work on the first line, so they survive; so does a
               `#!` shebang, which has to stay on line one as well. */
            if (isDirectiveComment(seg)) { out.push(seg); continue; }
            commentsRemoved++;
            continue;
        }
        if (seg.type !== 'code') { out.push(seg); continue; }

        const before = (seg.text.match(/\s+/g) || []).length;
        const text = minifyCodeRun(seg.text);
        const after = (text.match(/\s/g) || []).length;
        if (before > after) tokensSqueezed += before - after;
        out.push({ type: 'code', text });
    }

    return {
        text: segmentsToText(out).replace(/^\s+/, '').replace(/\s+$/, ''),
        commentsRemoved,
        tokensSqueezed
    };
}

/* --- numbers ------------------------------------------------------------ */

/* One pass over complete numeric literals, so the exponent of `1e-2` is never
   mistaken for a standalone `2` (which would emit the malformed `1e-(0x2-0x1)`).
   Every form the lexer knows is matched as a whole and then classified: only
   plain decimal and hex integers are rewritten, while floats, exponents and
   hex floats are left byte for byte. The lead character is captured so `t[3]`,
   `-7` and `a + 12` keep their surrounding bytes exactly. */
const INTEGER_LITERAL_RE = /(^|[^\w.$])(0[xX][0-9a-fA-F]+(?:\.[0-9a-fA-F]*)?(?:[pP][+-]?[0-9]+)?|[0-9]+(?:\.[0-9]*)?(?:[eE][+-]?[0-9]+)?|\.[0-9]+(?:[eE][+-]?[0-9]+)?)(?![\w.])/g;

/* An arithmetic form of an integer, or null when the literal must stay put.
   Only values a double holds exactly are touched, so the rebuilt constant can
   never drift from the original. */
function integerReplacement(value) {
    if (!Number.isSafeInteger(value) || value < 1) return null;
    const hex = (n) => '0x' + n.toString(16);
    if (value === 1) return '(' + hex(2) + '-' + hex(1) + ')';
    if (value < 4) return '(' + hex(value + 1) + '-' + hex(1) + ')';
    const left = 1 + Math.floor(Math.random() * (value - 1));
    return '(' + hex(left) + '+' + hex(value - left) + ')';
}

/* Rewrites integer literals in code runs. Strings, comments and every other
   byte of the source stay exactly as they were. */
function encodeNumbers(src) {
    const segs = scanLua(src);
    let encoded = 0;
    let skipped = 0;

    const out = segs.map((seg) => {
        if (seg.type !== 'code') return seg;
        const text = seg.text.replace(INTEGER_LITERAL_RE, (match, lead, digits) => {
            const isHex = /^0[xX][0-9a-fA-F]+$/.test(digits);
            if (!isHex && !/^[0-9]+$/.test(digits)) { skipped++; return match; }   // float / exponent
            if (digits.length > 15) { skipped++; return match; }                    // may exceed 2^53
            const value = isHex ? Number.parseInt(digits.slice(2), 16) : Number(digits);
            const replacement = integerReplacement(value);
            if (!replacement) { skipped++; return match; }
            encoded++;
            return lead + replacement;
        });
        return { type: 'code', text };
    });

    return { text: segmentsToText(out), encoded, skipped };
}

/* --- rename ------------------------------------------------------------- */

/* Depth of every character, plus the position of each block closer.

   Lua's block keywords pair up one-to-one if you count `then`, `do`,
   `function`, `repeat` as openers and `end`, `until` as closers, with
   `elseif` first closing the branch before it. `for`/`while` open through
   their `do`, so they are not counted themselves. Keywords used as table
   fields (`t.end`) are skipped because the previous character is `.` or `:`. */
function computeBlockBounds(src, mask) {
    const depthAt = new Int32Array(src.length);
    const closers = [];
    const re = /\b[A-Za-z_][A-Za-z0-9_]*\b/g;
    let depth = 0;
    let last = 0;
    let m;

    while ((m = re.exec(src)) !== null) {
        const word = m[0];
        depthAt.fill(depth, last, m.index);

        if (mask[m.index] === 1) {
            const prevChar = src[m.index - 1];
            const isField = prevChar === '.' || prevChar === ':';
            if (!isField) {
                if (word === 'then' || word === 'do' || word === 'function' || word === 'repeat') {
                    depth++;
                } else if (word === 'elseif') {
                    if (depth > 0) depth--;
                } else if (word === 'end' || word === 'until') {
                    closers.push({ index: m.index, depthBefore: depth });
                    if (depth > 0) depth--;
                }
            }
        }

        depthAt.fill(depth, m.index, m.index + word.length);
        last = m.index + word.length;
    }

    depthAt.fill(depth, last, src.length);
    return { depthAt, closers };
}

/* Closers grouped by the depth they close, in ascending position order. Asking
   "which `end` closes this depth?" is then a binary search instead of a scan
   over every closer in the file, which matters once a script has thousands of
   blocks (that scan used to make the rename pass quadratic). */
function buildCloserIndex(closers) {
    const byDepth = new Map();
    for (const closer of closers) {
        if (!byDepth.has(closer.depthBefore)) byDepth.set(closer.depthBefore, []);
        byDepth.get(closer.depthBefore).push(closer.index);
    }
    return byDepth;
}

function firstCloserAfter(closerIndex, position, depth) {
    const list = closerIndex.get(depth);
    if (!list) return -1;
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid] > position) hi = mid;
        else lo = mid + 1;
    }
    return lo < list.length ? list[lo] : -1;
}

/* Every `local` declaration, with the range in which the name is in scope. */
function localDeclarations(src, mask, bounds) {
    const { depthAt, closers } = bounds || computeBlockBounds(src, mask);
    const closerIndex = buildCloserIndex(closers);
    const declarations = new Map();      // name -> [{ index, depth, blockEnd, initializer }]
    const localRe = /\blocal\b/g;
    let m;

    while ((m = localRe.exec(src)) !== null) {
        if (mask[m.index] !== 1) continue;
        const depth = depthAt[m.index];
        let i = m.index + m[0].length;
        const skipWs = () => { while (i < src.length && /\s/.test(src[i])) i++; };
        const here = [];

        skipWs();
        if (src.startsWith('function', i) && !isWordChar(src[i + 8])) {
            i += 8;
            skipWs();
            const nm = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i, i + 120));
            if (nm) { here.push({ name: nm[0], index: i }); i += nm[0].length; }
        } else {
            for (;;) {
                skipWs();
                const nm = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i, i + 120));
                if (!nm) break;
                here.push({ name: nm[0], index: i });
                i += nm[0].length;
                skipWs();
                if (src[i] === ':') {                       // Luau type annotation
                    i++;
                    let typeDepth = 0;
                    while (i < src.length) {
                        const c = src[i];
                        if (c === '(' || c === '{' || c === '<') typeDepth++;
                        else if (c === ')' || c === '}' || c === '>') { if (typeDepth === 0) break; typeDepth--; }
                        else if (typeDepth === 0 && (c === ',' || c === '=' || c === '\n' || c === ';')) break;
                        i++;
                    }
                    skipWs();
                }
                if (src[i] === ',') { i++; continue; }
                break;
            }
        }

        skipWs();
        let stmtEnd = i;
        if (src[i] === '=') {
            let j = i + 1;
            let d = 0;
            while (j < src.length) {
                const c = src[j];
                if (c === '(' || c === '{' || c === '[') d++;
                else if (c === ')' || c === '}' || c === ']') d--;
                else if (d <= 0 && (c === '\n' || c === ';')) break;
                j++;
            }
            stmtEnd = j;
        }

        /* The enclosing block ends at the first closer that closes the level
           this declaration sits at. If the file has unbalanced blocks we bail
           out and treat the block as running to the end of the file. */
        const closerAt = firstCloserAfter(closerIndex, m.index, depth);
        const blockEnd = closerAt === -1 ? src.length : closerAt;

        for (const decl of here) {
            if (!declarations.has(decl.name)) declarations.set(decl.name, []);
            declarations.get(decl.name).push({
                index: decl.index,
                depth,
                blockEnd,
                initializer: src.slice(i, stmtEnd)
            });
        }
    }

    return declarations;
}

/* A copy of the source with every string and comment blanked out, keeping the
   original offsets. One pass over this is enough to answer the three
   "is this name also used as something else?" questions, instead of running a
   fresh regex over the whole file for every declared name (which made large
   scripts quadratic). */
function buildCodeView(segs) {
    let out = '';
    for (const seg of segs) {
        out += seg.type === 'code' ? seg.text : ' '.repeat(seg.text.length);
    }
    return out;
}

function identifierConstraints(codeView) {
    const fields = new Set();      // t.name / t:name — a member, not the local
    const tableKeys = new Set();   // { name = ... } — a key, not the local
    const labels = new Set();      // goto name / ::name::

    for (const m of codeView.matchAll(/[.:]\s*([A-Za-z_][A-Za-z0-9_]*)/g)) fields.add(m[1]);
    for (const m of codeView.matchAll(/[{,]\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) tableKeys.add(m[1]);
    for (const m of codeView.matchAll(/\bgoto\s+([A-Za-z_][A-Za-z0-9_]*)/g)) labels.add(m[1]);
    for (const m of codeView.matchAll(/::\s*([A-Za-z_][A-Za-z0-9_]*)\s*::/g)) labels.add(m[1]);

    return { fields, tableKeys, labels };
}

/* Index of the `)` that closes the `(` at `open`, counted over code only
   (strings and comments are already masked out). */
function matchParen(src, mask, open) {
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (mask[i] !== 1) continue;
        if (src[i] === '(') depth++;
        else if (src[i] === ')') { depth--; if (depth === 0) return i; }
    }
    return -1;
}

/* Splits one function's parameter list and records each name with the range it
   is visible in: from the closing `)` to the `end` that closes the body.

   Handles named, dotted, method and anonymous functions, Luau generics
   (`function f<T>(x: T)`), Luau type annotations (including parenthesised
   function types, which is why the list is split at top-level commas) and
   `...`, which is not a name. */
function functionParameterDeclarations(src, mask, depthAt, closerIndex) {
    const found = [];
    const re = /\bfunction\b/g;
    let m;

    while ((m = re.exec(src)) !== null) {
        if (mask[m.index] !== 1) continue;
        let i = m.index + 'function'.length;
        const skipWs = () => { while (i < src.length && /\s/.test(src[i])) i++; };

        skipWs();
        while (i < src.length && /[A-Za-z0-9_.:]/.test(src[i])) i++;   // f, t.a, t:m
        skipWs();

        if (src[i] === '<') {                                          // generics
            let d = 0;
            while (i < src.length) {
                if (src[i] === '<') d++;
                else if (src[i] === '>') { d--; if (d === 0) { i++; break; } }
                i++;
            }
            skipWs();
        }

        if (src[i] !== '(') continue;                                  // not a definition
        const close = matchParen(src, mask, i);
        if (close === -1) continue;

        /* depthAt at `function` is already the body depth: computeBlockBounds
           counts the keyword as an opener and stores the incremented value. */
        const bodyDepth = depthAt[m.index];
        const closerAt = firstCloserAfter(closerIndex, close, bodyDepth);
        const blockEnd = closerAt === -1 ? src.length : closerAt;

        const add = (from, to) => {
            const part = src.slice(from, to);
            const nm = /^[A-Za-z_][A-Za-z0-9_]*/.exec(part.trim());
            if (!nm) return;                                           // `...` or empty
            /* The scope starts at the opening `(` rather than after it: the
               parameter's own name and its type annotation sit inside the
               parens, and leaving them outside would make `times: number`
               look like a use-before-declaration and skip the rename. */
            found.push({
                name: nm[0],
                index: from + part.indexOf(nm[0]),
                scopeStart: i,
                blockEnd
            });
        };

        let start = i + 1;
        let depth = 0;
        for (let p = i + 1; p <= close; p++) {
            const c = src[p];
            const isCode = mask[p] === 1;
            if (isCode && (c === '(' || c === '{' || c === '[')) depth++;
            else if (isCode && (c === ')' || c === '}' || c === ']')) {
                if (p === close) { add(start, p); break; }
                depth--;
            } else if (isCode && c === ',' && depth === 0) {
                add(start, p);
                start = p + 1;
            }
        }
    }

    return found;
}

/* Loop variables: `for i = 1, 10 do` and `for k, v in pairs(t) do`. Their
   scope is the body after the header's `do`. */
function forLoopDeclarations(src, mask, depthAt, closerIndex) {
    const found = [];
    const re = /\bfor\b/g;
    let m;

    while ((m = re.exec(src)) !== null) {
        if (mask[m.index] !== 1) continue;

        let i = m.index + 'for'.length;
        let bracketDepth = 0;
        let doIndex = -1;
        while (i < src.length) {
            const c = src[i];
            if (c === '(' || c === '{' || c === '[') bracketDepth++;
            else if (c === ')' || c === '}' || c === ']') bracketDepth--;
            else if (bracketDepth === 0 && /[A-Za-z_]/.test(c)) {
                const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i, i + 40))[0];
                if (word === 'do') { doIndex = i; break; }
                if (word === 'function' || word === 'end') break;       // malformed header
                i += word.length;
                continue;
            }
            i++;
        }
        if (doIndex === -1) continue;

        const header = src.slice(m.index + 'for'.length, doIndex);
        const eq = header.indexOf('=');
        const inMatch = /\bin\b/.exec(header);
        let namesEnd = header.length;
        if (eq !== -1) namesEnd = eq;
        if (inMatch && inMatch.index < namesEnd) namesEnd = inMatch.index;

        const bodyDepth = depthAt[doIndex];
        const closerAt = firstCloserAfter(closerIndex, doIndex, bodyDepth);
        const blockEnd = closerAt === -1 ? src.length : closerAt;

        let consumed = 0;
        for (const part of header.slice(0, namesEnd).split(',')) {
            const nm = /^[A-Za-z_][A-Za-z0-9_]*/.exec(part.trim());
            if (nm) {
                found.push({
                    name: nm[0],
                    index: m.index + 'for'.length + consumed + part.indexOf(nm[0]),
                    scopeStart: doIndex,
                    blockEnd
                });
            }
            consumed += part.length + 1;
        }
    }

    return found;
}

function renameIdentifiers(src) {
    const segs = scanLua(src);
    const mask = buildMask(segs);

    const occurrences = new Map();
    const idRe = /[A-Za-z_][A-Za-z0-9_]*/g;
    let m;
    while ((m = idRe.exec(src)) !== null) {
        if (mask[m.index] !== 1) continue;
        if (!occurrences.has(m[0])) occurrences.set(m[0], []);
        occurrences.get(m[0]).push(m.index);
    }

    const { depthAt, closers } = computeBlockBounds(src, mask);
    const closerIndex = buildCloserIndex(closers);
    const constraints = identifierConstraints(buildCodeView(segs));
    const declarations = localDeclarations(src, mask, { depthAt, closers });
    /* Parameters and loop variables are locals too. Merging them into the same
       map is what keeps the shadowing rule honest: a name that is both a
       parameter somewhere and a `local` somewhere else is declared twice and
       is therefore never touched. */
    const scoped = [
        ...functionParameterDeclarations(src, mask, depthAt, closerIndex),
        ...forLoopDeclarations(src, mask, depthAt, closerIndex)
    ];
    for (const decl of scoped) {
        if (!declarations.has(decl.name)) declarations.set(decl.name, []);
        declarations.get(decl.name).push({
            index: decl.index,
            scopeStart: decl.scopeStart,
            depth: 0,
            blockEnd: decl.blockEnd,
            initializer: ''
        });
    }

    const newNames = new Map();
    const skipped = [];

    for (const [name, decls] of declarations) {
        /* A name declared twice anywhere may be shadowed, and resolving that
           correctly needs a full scope tree - so it is left alone. */
        if (decls.length !== 1) { skipped.push(name); continue; }
        const decl = decls[0];
        if (LUA_KEYWORDS.has(name) || RESERVED_NAMES.has(name) || /^NIX6_/.test(name)) continue;
        if (name.length < 2) continue;

        const occ = occurrences.get(name) || [];
        if (occ.length < 2) continue;                                          // nothing to gain
        const scopeStart = decl.scopeStart === undefined ? decl.index : decl.scopeStart;
        if (occ[0] < scopeStart) { skipped.push(name); continue; }              // used before declaration
        if (occ[occ.length - 1] >= decl.blockEnd) { skipped.push(name); continue; }  // used past the block

        if (constraints.fields.has(name) || constraints.tableKeys.has(name) || constraints.labels.has(name)) {
            skipped.push(name);
            continue;
        }
        if (decl.initializer && new RegExp(`\\b${name}\\b`).test(decl.initializer)) { skipped.push(name); continue; } // `local x = x or {}`

        let fresh = '_' + Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 5);
        while (occurrences.has(fresh) || /^\d/.test(fresh)) {
            fresh = '_' + Math.random().toString(36).slice(2, 10);
        }
        newNames.set(name, fresh);
    }

    if (newNames.size === 0) return { text: src, renamed: [], skipped };

    const edits = [];
    for (const [name, fresh] of newNames) {
        for (const index of occurrences.get(name)) edits.push([index, name.length, fresh]);
    }
    edits.sort((a, b) => a[0] - b[0]);

    let out = '';
    let last = 0;
    for (const [index, len, fresh] of edits) {
        out += src.slice(last, index) + fresh;
        last = index + len;
    }
    out += src.slice(last);

    return { text: out, renamed: [...newNames.keys()], skipped };
}

/* --- string literals ---------------------------------------------------- */

/* Decodes a quoted Lua string literal into its runtime bytes.

   `backtick` enables the Luau interpolation escapes (`\``, `\{`, `\}`) that
   only exist inside a backtick literal; it is only ever set for a backtick
   string that the lexer proved has no interpolation.

   The body is walked by code point (`Array.from`), never by UTF-16 unit, so an
   emoji becomes its real UTF-8 bytes instead of two lone surrogates. That is
   what lets emoji strings be encoded instead of skipped. */
function decodeQuotedLiteral(literal, backtick = false) {
    const quote = literal[0];
    if (quote !== '"' && quote !== "'" && quote !== '`') return null;
    const closed = literal[literal.length - 1] === quote;
    const body = literal.slice(1, closed ? literal.length - 1 : literal.length);
    const chars = Array.from(body);
    const bytes = [];
    const simple = {
        a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11,
        '\\': 92, '"': 34, "'": 39, '\n': 10
    };
    if (backtick) {
        simple['`'] = 96;
        simple['{'] = 123;
        simple['}'] = 125;
    }

    for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        if (ch !== '\\') {
            for (const b of Buffer.from(ch, 'utf8')) bytes.push(b);
            continue;
        }

        const e = chars[++i];
        if (e === undefined) return null;
        if (Object.prototype.hasOwnProperty.call(simple, e)) { bytes.push(simple[e]); continue; }

        const rest = chars.slice(i + 1).join('');

        if (e === 'x') {
            const hex = /^[0-9a-fA-F]{1,2}/.exec(rest);
            if (!hex) return null;
            bytes.push(parseInt(hex[0], 16));
            i += hex[0].length;
            continue;
        }
        if (e === 'z') {
            while (i + 1 < chars.length && /\s/.test(chars[i + 1])) i++;
            continue;
        }
        if (e === 'u') {
            const u = /^\{([0-9a-fA-F]+)\}/.exec(rest);
            if (!u) return null;
            const codePoint = parseInt(u[1], 16);
            if (codePoint > 0x10FFFF) return null;
            /* Encoded by hand: Lua and Luau emit the raw UTF-8 form even for a
               lone surrogate (`\u{D800}` is ED A0 80, three bytes of invalid
               UTF-8). Buffer.from would replace it with U+FFFD, silently
               turning an error case into a valid string. */
            bytes.push(...utf8Bytes(codePoint));
            i += u[0].length;
            continue;
        }
        if (/[0-9]/.test(e)) {
            const dec = /^[0-9]{1,3}/.exec(chars.slice(i).join(''));
            const code = parseInt(dec[0], 10);
            if (code > 255) return null;
            bytes.push(code);
            i += dec[0].length - 1;
            continue;
        }
        return null;                       // unknown escape: leave this literal alone
    }

    return bytes;
}

/* UTF-8 encoding of one code point, surrogates included, matching what the
   Lua and Luau lexers do for `\u{...}`. */
function utf8Bytes(codePoint) {
    if (codePoint < 0x80) return [codePoint];
    if (codePoint < 0x800) return [0xC0 | (codePoint >> 6), 0x80 | (codePoint & 0x3F)];
    if (codePoint < 0x10000) {
        return [0xE0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3F), 0x80 | (codePoint & 0x3F)];
    }
    return [
        0xF0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3F),
        0x80 | ((codePoint >> 6) & 0x3F),
        0x80 | (codePoint & 0x3F)
    ];
}

/* A [[...]] long string. Lua drops a newline immediately after the opening
   bracket, so the decoder has to drop it too or the runtime value changes. */
function decodeLongStringLiteral(literal) {
    const open = /^\[(=*)\[/.exec(literal);
    if (!open) return null;
    const level = open[1].length;
    const openLen = level + 2;
    const closeLen = level + 2;
    let body = literal.slice(openLen, literal.length - closeLen);
    if (body.startsWith('\r\n')) body = body.slice(2);
    else if (body.startsWith('\n')) body = body.slice(1);
    return Array.from(Buffer.from(body, 'utf8'));
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/* A different alphabet per build, so a stock base64 decoder finds noise. */
function shuffleAlphabet() {
    const chars = B64_ALPHABET.split('');
    for (let i = chars.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = chars[i];
        chars[i] = chars[j];
        chars[j] = tmp;
    }
    return chars.join('');
}

function base64EncodeBytes(bytes, alphabet) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
        const b1 = bytes[i];
        const b2 = i + 1 < bytes.length ? bytes[i + 1] : null;
        const b3 = i + 2 < bytes.length ? bytes[i + 2] : null;
        out += alphabet[b1 >> 2];
        out += alphabet[((b1 & 3) << 4) | ((b2 === null ? 0 : b2) >> 4)];
        out += b2 === null ? '=' : alphabet[((b2 & 15) << 2) | ((b3 === null ? 0 : b3) >> 6)];
        out += b3 === null ? '=' : alphabet[b3 & 63];
    }
    return out;
}

/* The runtime half of the string encoder. Every literal becomes
   NIX6_D("<base64>", key), decoded in groups of four by gsub, so the cost is a
   quarter of the old one-char-at-a-time loop and the emitted text is ~1.37x the
   original bytes instead of the ~3.5x a decimal byte table cost.

   The key is a keystream, not a constant: byte i is XORed with
   (key + i * 31) % 256. Two identical literals therefore produce different
   ciphertext, and a guessed single-byte key stops being useful after one byte.
   The byte offset comes from a counter the callback advances itself: Luau's
   gsub does not pass the match position to the replacement function, so
   relying on it would break on every Roblox executor. */
function buildStringHelper(alphabet) {
    return [
        'local NIX6_AL = "' + alphabet + '"',
        /* Captured once, before any user code can run. A script that sandboxes
           itself with setfenv drops `string` and `math` from its environment;
           the helper has to keep working after that. */
        'local NIX6_SB, NIX6_SC, NIX6_SF, NIX6_GSUB = string.byte, string.char, math.floor, string.gsub',
        'local NIX6_M = {}',
        'for NIX6_I = 1, #NIX6_AL do NIX6_M[NIX6_SB(NIX6_AL, NIX6_I)] = NIX6_I - 1 end',
        'local function NIX6_BX(_a, _b)',
        ' local _r, _p = 0, 1',
        ' while _a > 0 or _b > 0 do',
        '  local _x, _y = _a % 2, _b % 2',
        '  if _x ~= _y then _r = _r + _p end',
        '  _a, _b, _p = (_a - _x) / 2, (_b - _y) / 2, _p * 2',
        ' end',
        ' return _r',
        'end',
        'local NIX6_XOR = (bit32 and bit32.bxor) or NIX6_BX',
        'local function NIX6_K(_k, _i)',
        ' return (_k + _i * 31) % 256',
        'end',
        'local function NIX6_D(_s, _k)',
        ' local _n = 0',
        ' return (NIX6_GSUB(_s, "(....)", function(_q)',
        '  local _i = _n',
        '  _n = _i + 3',
        '  local _a, _b = NIX6_M[NIX6_SB(_q, 1)], NIX6_M[NIX6_SB(_q, 2)]',
        '  local _c, _d = NIX6_M[NIX6_SB(_q, 3)], NIX6_M[NIX6_SB(_q, 4)]',
        '  local _o = NIX6_SC(NIX6_XOR(_a * 4 + NIX6_SF(_b / 16), NIX6_K(_k, _i)))',
        '  if _c then',
        '   _o = _o .. NIX6_SC(NIX6_XOR((_b % 16) * 16 + NIX6_SF(_c / 4), NIX6_K(_k, _i + 1)))',
        '   if _d then',
        '    _o = _o .. NIX6_SC(NIX6_XOR((_c % 4) * 64 + _d, NIX6_K(_k, _i + 2)))',
        '   end',
        '  end',
        '  return _o',
        ' end))',
        'end',
        ''
    ].join('\n');
}

/* Replaces every literal the runtime can rebuild exactly with
   NIX6_D("<base64>", key). Byte-exact for UTF-8, so emoji, CJK, combining
   marks and embedded NULs all come back identical. Interpolated strings are
   left alone: they contain live expressions, not just bytes. */
function encodeStrings(src) {
    const segs = scanLua(src);
    const out = [];
    let encoded = 0;
    let skipped = 0;
    let unicodeStrings = 0;
    const alphabet = shuffleAlphabet();

    for (const seg of segs) {
        if (seg.type !== 'string') { out.push(seg); continue; }

        /* A backtick literal with `{ ... }` holds live expressions, so it is
           never rewritten; a static one is decoded like a quoted literal. */
        if (seg.interpolated) { skipped++; out.push(seg); continue; }

        let bytes = null;
        if (seg.quote === '"' || seg.quote === "'") {
            bytes = decodeQuotedLiteral(seg.text);
        } else if (seg.quote === '`') {
            bytes = decodeQuotedLiteral(seg.text, true);
        } else if (seg.quote === '[') {
            bytes = decodeLongStringLiteral(seg.text);
        }
        if (!bytes || bytes.length === 0) { skipped++; out.push(seg); continue; }

        if (bytes.length !== Buffer.byteLength(seg.text, 'utf8') || stringContainsEmoji(seg.text)) {
            unicodeStrings++;
        }

        const key = 1 + Math.floor(Math.random() * 255);
        /* Same keystream the runtime rebuilds: byte i uses (key + i * 31) % 256. */
        const xored = Uint8Array.from(bytes, (b, i) => b ^ ((key + i * 31) & 0xFF));

        /* Always parenthesised. A bare `NIX6_D(...)` would be a syntax error
           in call position, because Lua's string-call sugar (`print"hi"`)
           only accepts a literal: the rebuilt call has to become
           `print(NIX6_D(...))`. The parens are harmless everywhere else and
           also stop the call fusing with the token before it. */
        const literal = '(NIX6_D("' + base64EncodeBytes(xored, alphabet) + '",' + key + '))';

        encoded++;
        out.push({ type: 'code', text: literal });
    }

    if (encoded === 0) return { text: src, encoded, skipped, unicodeStrings };

    /* The helper goes after any leading --! directive so Luau still sees it as
       the first statement of the chunk. A comment run does not include its own
       newline, so the helper needs one prepended or the whole first line would
       be swallowed by the directive comment. */
    let insertAt = 0;
    while (insertAt < out.length) {
        const seg = out[insertAt];
        if (isDirectiveComment(seg)) { insertAt++; continue; }
        if (seg.type === 'code' && seg.text.trim() === '') { insertAt++; continue; }
        break;
    }
    const previousSeg = insertAt > 0 ? out[insertAt - 1] : null;
    const helper = buildStringHelper(alphabet);
    const helperText = previousSeg && previousSeg.type === 'comment' ? '\n' + helper : helper;
    out.splice(insertAt, 0, { type: 'code', text: helperText });

    return { text: segmentsToText(out), encoded, skipped, unicodeStrings };
}

// --- OBFUSCATION ENGINE (reversible XOR wrapper; not a VM, not encryption) ---
class ObfuscatorEngine {
    constructor(sourceCode, options) {
        /* A byte-order mark is not part of the program: if it reaches the
           lexer it becomes a stray token and shifts the first line, which is
           exactly where --!strict has to sit. */
        this.source = String(sourceCode == null ? '' : sourceCode).replace(/^\uFEFF/, '');
        this.options = normalizeObfuscationOptions(options);
        this.stats = {
            commentsRemoved: 0,
            identifiersRenamed: 0,
            numbersEncoded: 0,
            numbersSkipped: 0,
            stringsEncoded: 0,
            stringsSkipped: 0,
            unicodeStrings: 0,
            tokensSqueezed: 0,
            payloadBytes: 0,
            sourceBytes: 0,
            integrity: 0
        };
    }

    /* Runs the enabled options over the source and records what each one did,
       so the UI can report real numbers rather than a promise. */
    prepareSource() {
        let text = this.source;

        if (this.options.minify) {
            const result = minifySource(text);
            text = result.text;
            this.stats.commentsRemoved = result.commentsRemoved;
            this.stats.tokensSqueezed = result.tokensSqueezed || 0;
        }
        if (this.options.rename) {
            const result = renameIdentifiers(text);
            text = result.text;
            this.stats.identifiersRenamed = result.renamed.length;
        }
        /* Numbers run before the string pass so the string helper itself keeps
           its readable constants; the original source no longer has any. */
        if (this.options.encodeNumbers) {
            const result = encodeNumbers(text);
            text = result.text;
            this.stats.numbersEncoded = result.encoded;
            this.stats.numbersSkipped = result.skipped;
        }
        if (this.options.encryptStrings) {
            const result = encodeStrings(text);
            text = result.text;
            this.stats.stringsEncoded = result.encoded;
            this.stats.stringsSkipped = result.skipped;
            this.stats.unicodeStrings = result.unicodeStrings || 0;
        }

        return text;
    }

    appliedOptions() {
        const applied = [];
        if (this.options.minify) applied.push('minify');
        if (this.options.rename) applied.push('rename');
        if (this.options.encodeNumbers) applied.push('encodeNumbers');
        if (this.options.encryptStrings) applied.push('encryptStrings');
        if (this.options.antiTamper) applied.push('antiTamper');
        return applied;
    }

    _randomId(length = 14) {
        const charSets = [
            "I1l0O_qwertyuiopasdfghjklzxcvbnm",
            "IIllIIllIIll",
            "_0x1a_0x2b_0x3c_0x4d"
        ];
        const chars = charSets[Math.floor(Math.random() * charSets.length)];
        let res = "";
        for (let i = 0; i < length; i++) {
            res += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return /^\d/.test(res) ? "_" + res : res;
    }

    _generateOpCodes() {
        const pool = Array.from({ length: 50 }, (_, i) => (i + 1) * 17 + Math.floor(Math.random() * 9)).sort(() => Math.random() - 0.5);
        return {
            OP_GETGLOBAL: pool[0],
            OP_LOADK: pool[1],
            OP_CALL: pool[2],
            OP_RETURN: pool[3],
            OP_EXEC_CHUNK: pool[4]
        };
    }

    /* Builds the delivered artifact: source is minified/renamed/encoded, then
       serialised as XORed bytes inside base64 strings with a per-build
       shuffled alphabet. The wrapper decodes it with gsub in groups of four,
       so the payload on disk is neither readable Lua nor decodable with a
       stock tool, and decoding stays linear in the payload size.

       The bytes are split into independently keyed slices: no single string in
       the artifact holds the whole program, so lifting one blob and decoding
       it no longer yields a runnable script. */
    buildProtectedVM() {
        const prepared = this.prepareSource();
        /* Kept for the offline verifier: it is exactly what the wrapper must
           decode back out of the artifact. */
        this.lastPrepared = prepared;
        const srcBytes = Buffer.from(prepared, 'utf8');

        /* Anti-tamper: position-weighted sum of the plain source bytes, so the
           check reads the same string the loader is about to compile. Both
           sides stay in integers well under 2^53, which matters because a
           runtime that does integer maths in 32 bits has to reach the same
           number as this one. */
        let integrity = 0;
        for (let i = 0; i < srcBytes.length; i++) {
            integrity = (integrity + srcBytes[i] * (i + 1)) % INTEGRITY_MODULUS;
        }
        this.stats.integrity = integrity;
        this.stats.sourceBytes = srcBytes.length;

        const alphabet = shuffleAlphabet();
        const chunkCount = srcBytes.length > 192 ? 3 : 1;
        const chunkSize = Math.ceil(srcBytes.length / chunkCount);
        const chunks = [];
        for (let i = 0; i < chunkCount; i++) {
            const slice = srcBytes.subarray(i * chunkSize, Math.min(srcBytes.length, (i + 1) * chunkSize));
            const key = 1 + Math.floor(Math.random() * 255);
            /* Same keystream as the decoder: byte i is XORed with
               (key + i * 31) % 256, where i restarts at every chunk. */
            const xored = Uint8Array.from(slice, (b, index) => b ^ ((key + index * 31) & 0xFF));
            chunks.push({ key, data: base64EncodeBytes(xored, alphabet) });
        }
        this.stats.payloadBytes = chunks.reduce((sum, chunk) => sum + chunk.data.length, 0);
        this.stats.payloadChunks = chunks.length;

        const op = this._generateOpCodes();
        const v_vm = this._randomId();
        const v_map = this._randomId();
        const v_alpha = this._randomId();
        const v_dec = this._randomId();
        const v_bxor = this._randomId();
        const v_text = this._randomId();
        const v_instr = this._randomId();
        const v_pc = this._randomId();

        const decodeCalls = chunks
            .map((chunk) => `${v_dec}([==[${chunk.data}]==], ${chunk.key})`)
            .join(' ..\n        ');

        const integrityCheck = this.options.antiTamper ? `    local _int = 0
    for _m = 1, #${v_text} do
        _int = (_int + string.byte(${v_text}, _m) * _m) % ${INTEGRITY_MODULUS}
    end
    if _int ~= ${integrity} then
        error("Nix6: payload integrity check failed")
    end
` : '';

        /* No getfenv/debug metatable check here on purpose. The old guard hung
           the script (while true do end) whenever the environment table had a
           metatable, which is exactly what a legitimate sandbox looks like;
           it was trivially bypassable and only ever hurt honest scripts. The
           length and integrity checks below are the real anti-tamper. */
        return `-- [[ Nix6 protected payload: base64 over XORed source bytes. Not encryption, not a security boundary. ]]
local function ${v_vm}(...)
    -- Three bit backends, in speed order: Luau/Roblox (bit32), LuaJIT/Lua 5.1
    -- with the bit library, then a pure-Lua fallback that only needs integer
    -- arithmetic. Every operand here is a byte, so the slow path stays cheap.
    local ${v_bxor} = (type(bit32) == "table" and bit32.bxor)
        or (type(bit) == "table" and bit.bxor)
        or function(_a, _b)
            local _r, _p = 0, 1
            while _a > 0 or _b > 0 do
                local _x, _y = _a % 2, _b % 2
                if _x ~= _y then _r = _r + _p end
                _a, _b, _p = math.floor((_a - _x) / 2), math.floor((_b - _y) / 2), _p * 2
            end
            return _r
        end

    local ${v_alpha} = "${alphabet}"
    local ${v_map} = {}
    for _i = 1, #${v_alpha} do
        ${v_map}[string.byte(${v_alpha}, _i)] = _i - 1
    end

    local function ${v_dec}(_s, _k)
        local _n = 0
        return (_s:gsub("(....)", function(_q)
            local _i = _n
            _n = _i + 3
            local _a = ${v_map}[string.byte(_q, 1)]
            local _b = ${v_map}[string.byte(_q, 2)]
            local _c = ${v_map}[string.byte(_q, 3)]
            local _d = ${v_map}[string.byte(_q, 4)]
            local _o = string.char(${v_bxor}(_a * 4 + math.floor(_b / 16), (_k + _i * 31) % 256))
            if _c then
                _o = _o .. string.char(${v_bxor}((_b % 16) * 16 + math.floor(_c / 4), (_k + (_i + 1) * 31) % 256))
                if _d then
                    _o = _o .. string.char(${v_bxor}((_c % 4) * 64 + _d, (_k + (_i + 2) * 31) % 256))
                end
            end
            return _o
        end))
    end

    local ${v_text} = ${decodeCalls}

    if #${v_text} ~= ${srcBytes.length} then
        error("Nix6: payload length mismatch")
    end
${integrityCheck}    -- A shebang is only understood by the file loader, not by load()/loadstring()
    -- on a string, so a chunk that starts with one would fail to compile in
    -- every environment. Drop that single line here; the payload keeps the
    -- original bytes for the vault.
    if string.sub(${v_text}, 1, 1) == "#" then
        local _nl = string.find(${v_text}, string.char(10), 1, true)
        ${v_text} = _nl and string.sub(${v_text}, _nl + 1) or ""
    end

    local ${v_instr} = {
        {${op.OP_EXEC_CHUNK}, 1}
    }
    local ${v_pc} = 1

    while ${v_pc} <= #${v_instr} do
        if ${v_instr}[${v_pc}][1] == ${op.OP_EXEC_CHUNK} then
            local _loader = loadstring or load
            if not _loader and type(getgenv) == "function" then
                local _g = getgenv()
                if type(_g) == "table" then _loader = _g.loadstring or _g.load end
            end
            if not _loader and type(debug) == "table" then
                _loader = debug.loadstring
            end
            if not _loader then
                error("Nix6: this runtime exposes no load() or loadstring()")
            end
            local _ok, _chunk, _err = pcall(_loader, ${v_text})
            if not _ok then error(tostring(_chunk)) end
            if type(_chunk) ~= "function" then
                error(tostring(_err or "VM Instruction Fault"))
            end
            return _chunk(...)
        end
        ${v_pc} = ${v_pc} + 1
    end
end
return ${v_vm}(...)
`;
    }
}

// --- Discord OAuth2 Configuration ---
// Values are read once per cold start. Dashboard env vars are routinely pasted
// with stray quotes or trailing newlines, and both make Discord reject the
// token exchange with a bare {"error":"invalid_client"}, so normalise them here.
function envValue(name) {
    const raw = process.env[name];
    if (typeof raw !== 'string') return '';
    return raw.trim().replace(/^['"]+|['"]+$/g, '').trim();
}

const CLIENT_ID = envValue('DISCORD_CLIENT_ID');
const CLIENT_SECRET_RAW = process.env.DISCORD_CLIENT_SECRET;
const CLIENT_SECRET = envValue('DISCORD_CLIENT_SECRET');
const DISCORD_REDIRECT_URI = envValue('DISCORD_REDIRECT_URI');

const DISCORD_CLIENT_ID_VALID = /^\d{17,20}$/.test(CLIENT_ID);
const DISCORD_SECRET_SANITIZED =
    typeof CLIENT_SECRET_RAW === 'string' && CLIENT_SECRET_RAW !== CLIENT_SECRET;
// A real OAuth2 client secret is 32 characters of [A-Za-z0-9_-]. The Client
// Public Key is 64 hex characters and a Bot Token contains dots; both are
// commonly pasted by mistake and both produce "invalid_client".
const DISCORD_SECRET_LOOKS_LIKE_PUBLIC_KEY = /^[0-9a-fA-F]{64}$/.test(CLIENT_SECRET);
const DISCORD_SECRET_LOOKS_LIKE_BOT_TOKEN = /^[\w-]+\.[\w-]{6}\.[\w-]{27,}$/.test(CLIENT_SECRET);
const DISCORD_CREDENTIALS_OK =
    DISCORD_CLIENT_ID_VALID && CLIENT_SECRET.length > 0 &&
    !DISCORD_SECRET_LOOKS_LIKE_PUBLIC_KEY && !DISCORD_SECRET_LOOKS_LIKE_BOT_TOKEN;

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function buildRedirectUri(req) {
    if (DISCORD_REDIRECT_URI) return DISCORD_REDIRECT_URI;
    const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'https')
        .split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.get('host') || '')
        .split(',')[0].trim();
    return `${proto}://${host}/auth/discord/callback`;
}

function sendAuthErrorPage(res, status, title, message, hints) {
    const hintsHtml = (hints || [])
        .filter(Boolean)
        .map((hint) => `<li>${escapeHtml(hint)}</li>`)
        .join('');
    res.status(status);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Nix6 // Discord Login Failed</title>
    <style>
        body { background: #0a0a0c; color: #f4f4f5; font-family: ui-monospace, Menlo, Consolas, monospace; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 24px; }
        .box { border: 1px solid #2a2a30; background: #121216; padding: 28px 32px; border-radius: 12px; max-width: 720px; line-height: 1.6; }
        h1 { font-size: 1.1rem; margin: 0 0 12px; letter-spacing: 0.04em; color: #ff8a65; }
        p { margin: 0 0 14px; color: #d4d4d8; }
        code { background: #1c1c22; padding: 2px 6px; border-radius: 5px; color: #ffd479; }
        ul { margin: 0 0 18px; padding-left: 20px; color: #b8b8c0; }
        li { margin-bottom: 8px; }
        a { display: inline-block; margin-top: 6px; color: #0a0a0c; background: #f4f4f5; padding: 9px 18px; border-radius: 8px; text-decoration: none; font-weight: 600; }
    </style>
</head>
<body>
    <div class="box">
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(message)}</p>
        ${hintsHtml ? `<ul>${hintsHtml}</ul>` : ''}
        <a href="/">Back to Nix6</a>
    </div>
</body>
</html>`);
}

function discordConfigHints() {
    const hints = [];
    if (!DISCORD_CLIENT_ID_VALID) {
        hints.push('DISCORD_CLIENT_ID is missing or not a Discord application ID. Set it to the Application ID from the Discord Developer Portal.');
    }
    if (!CLIENT_SECRET) {
        hints.push('DISCORD_CLIENT_SECRET is missing. Set it to the OAuth2 Client Secret from the Discord Developer Portal.');
    }
    if (DISCORD_SECRET_LOOKS_LIKE_PUBLIC_KEY) {
        hints.push('DISCORD_CLIENT_SECRET looks like the Client Public Key (64 hex characters). Use the OAuth2 Client Secret instead.');
    }
    if (DISCORD_SECRET_LOOKS_LIKE_BOT_TOKEN) {
        hints.push('DISCORD_CLIENT_SECRET looks like a Bot Token. Use the OAuth2 Client Secret instead.');
    }
    hints.push('After changing the variable, redeploy so the new value is picked up.');
    return hints;
}

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

// --- MIDDLEWARE ---

function requireOwner(req, res, next) {
    // 1. Session check
    if (req.session && req.session.user && req.session.user.id === OWNER_DISCORD_ID) {
        return next();
    }
    
    // 2. Client header check (Serverless Vercel)
    const clientDiscordId = req.headers['x-discord-id'];
    if (clientDiscordId === OWNER_DISCORD_ID) {
        return next();
    }

    // 3. API Key check
    const apiKey = req.headers['x-api-key'] || req.headers['x-api-key'];
    if (apiKey) {
        return next();
    }

    return res.status(403).json({ success: false, error: 'Forbidden: Owner access required.' });
}

async function getAuthUser(req) {
    if (req.session && req.session.user) {
        return req.session.user;
    }

    const clientDiscordId = req.headers['x-discord-id'];
    if (clientDiscordId) {
        return { id: clientDiscordId, username: 'Discord Owner' };
    }
    
    const apiKey = req.headers['x-api-key'] || req.headers['x-api-key'];
    if (apiKey) {
        const keys = await loadKeys();
        const foundKey = keys.find(k => k.key === apiKey);
        if (foundKey) {
            return {
                id: 'key_' + foundKey.username,
                username: foundKey.username,
                isApiKeyUser: true
            };
        }
    }
    return null;
}

// --- STATIC FILES & ROOT ROUTE ---

app.get(['/', '/index.html'], (req, res) => {
    const indexPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(indexPath)) {
        return res.sendFile(indexPath);
    }
    res.setHeader('Content-Type', 'text/html');
    return res.send('<h1>Nix6 Engine Active</h1>');
});

const publicPath = path.join(__dirname, 'public');
if (fs.existsSync(publicPath)) {
    app.use(express.static(publicPath));
}
// NOTE: never add express.static(__dirname) here. __dirname contains server.js
// and keys.json, so mounting it publishes the API-key store and the server
// source to anyone. index.html is served explicitly by the '/' route above, and
// only the dedicated ./public directory is exposed as static content.

// --- STORAGE STATUS ---

app.get('/api/storage', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const backend = storageBackend();
    let vaultCount = null;
    try {
        vaultCount = (await loadVault()).length;
    } catch (e) {
        vaultCount = null;
    }
    res.json({
        backend,
        persistent: backend !== 'memory',
        vaultCount
    });
});

// --- AUTHENTICATION ROUTES ---

// Non-secret view of the OAuth configuration, for debugging a failed login.
app.get('/api/auth/diagnostics', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
        ready: DISCORD_CREDENTIALS_OK,
        clientIdPresent: Boolean(CLIENT_ID),
        clientIdLooksValid: DISCORD_CLIENT_ID_VALID,
        clientSecretPresent: Boolean(CLIENT_SECRET),
        clientSecretWasSanitized: DISCORD_SECRET_SANITIZED,
        clientSecretLength: CLIENT_SECRET.length,
        clientSecretLooksLikePublicKey: DISCORD_SECRET_LOOKS_LIKE_PUBLIC_KEY,
        clientSecretLooksLikeBotToken: DISCORD_SECRET_LOOKS_LIKE_BOT_TOKEN,
        redirectUri: buildRedirectUri(req)
    });
});

app.get('/auth/discord', (req, res) => {
    if (!DISCORD_CREDENTIALS_OK) {
        return sendAuthErrorPage(
            res,
            500,
            'Discord login is not configured',
            'This deployment is missing usable Discord OAuth credentials, so the login cannot start.',
            discordConfigHints()
        );
    }

    const redirectUri = buildRedirectUri(req);
    const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify`;
    res.redirect(discordAuthUrl);
});

app.get('/auth/discord/callback', async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const oauthError = typeof req.query.error === 'string' ? req.query.error : '';
    const oauthErrorDescription =
        typeof req.query.error_description === 'string' ? req.query.error_description : '';

    if (oauthError) {
        return sendAuthErrorPage(
            res,
            400,
            'Discord rejected the login',
            `${oauthError}${oauthErrorDescription ? ': ' + oauthErrorDescription : ''}`,
            ['Start the login again from the Nix6 homepage.']
        );
    }

    if (!DISCORD_CREDENTIALS_OK) {
        return sendAuthErrorPage(
            res,
            500,
            'Discord login is not configured',
            'This deployment is missing usable Discord OAuth credentials, so the authorization code cannot be exchanged.',
            discordConfigHints()
        );
    }

    if (!code) {
        return sendAuthErrorPage(
            res,
            400,
            'No code provided from Discord',
            'Discord did not return an authorization code.',
            ['Start the login again from the Nix6 homepage.']
        );
    }

    const redirectUri = buildRedirectUri(req);

    try {
        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: redirectUri,
            }),
        });

        let tokenData = {};
        try {
            tokenData = await tokenResponse.json();
        } catch (parseError) {
            tokenData = {};
        }

        if (!tokenResponse.ok || !tokenData.access_token) {
            const discordError = tokenData.error || `http_${tokenResponse.status}`;
            console.error('[discord-oauth] token exchange failed', {
                status: tokenResponse.status,
                discordError,
                redirectUri,
                clientIdPresent: Boolean(CLIENT_ID),
                clientSecretPresent: Boolean(CLIENT_SECRET),
                clientSecretWasSanitized: DISCORD_SECRET_SANITIZED,
                clientSecretLooksLikePublicKey: DISCORD_SECRET_LOOKS_LIKE_PUBLIC_KEY,
                clientSecretLooksLikeBotToken: DISCORD_SECRET_LOOKS_LIKE_BOT_TOKEN
            });

            const hints = [];
            if (discordError === 'invalid_client') {
                hints.push(`Discord did not accept the credentials for client ID ${CLIENT_ID}.`);
                hints.push('The OAuth2 Client Secret in this deployment does not match that application, or it was reset in the Discord Developer Portal.');
                hints.push('Fix it in Discord Developer Portal > your app > OAuth2 > Reset Secret, then update the DISCORD_CLIENT_SECRET environment variable and redeploy.');
            } else if (discordError === 'invalid_grant') {
                hints.push('The authorization code was already used or has expired. Start the login again.');
                hints.push(`The redirect URI sent was ${redirectUri}. It must match the one registered in the Discord Developer Portal exactly.`);
            } else {
                hints.push(`The redirect URI sent was ${redirectUri}. It must match the one registered in the Discord Developer Portal exactly.`);
            }

            return sendAuthErrorPage(
                res,
                400,
                'Failed to obtain access token from Discord',
                JSON.stringify(tokenData),
                hints
            );
        }

        const userResponse = await fetch('https://discord.com/api/users/@me', {
            headers: { authorization: `${tokenData.token_type || 'Bearer'} ${tokenData.access_token}` },
        });

        const userData = await userResponse.json();

        if (!userResponse.ok || !userData.id) {
            console.error('[discord-oauth] user lookup failed', {
                status: userResponse.status,
                error: userData && userData.error
            });
            return sendAuthErrorPage(
                res,
                502,
                'Discord did not return your profile',
                JSON.stringify(userData),
                ['Try signing in again in a moment.']
            );
        }

        req.session.user = {
            id: userData.id,
            username: userData.username,
            avatar: userData.avatar 
                ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png`
                : 'https://cdn.discordapp.com/embed/avatars/0.png'
        };

        const avatarUrl = userData.avatar 
            ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png`
            : 'https://cdn.discordapp.com/embed/avatars/0.png';

        res.redirect(`/?discord_id=${userData.id}&discord_user=${encodeURIComponent(userData.username)}&discord_avatar=${encodeURIComponent(avatarUrl)}`);
    } catch (error) {
        console.error('Auth Error:', error);
        return sendAuthErrorPage(
            res,
            500,
            'Internal Authentication Error',
            'The server could not reach Discord to finish the login.',
            ['Try signing in again in a moment.']
        );
    }
});

app.get('/auth/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

app.get('/api/me', (req, res) => {
    if (req.session.user) {
        res.json({ authenticated: true, user: req.session.user });
    } else {
        res.json({ authenticated: false });
    }
});

// --- OWNER ADMIN & API KEY MANAGEMENT ENDPOINTS ---

app.post('/api/admin/generate-key', requireOwner, async (req, res) => {
    const username = req.body.username || "Client_User";
    const keys = await loadKeys();
    
    const newApiKey = "nix6_key_" + crypto.randomBytes(16).toString('hex');
    const keyData = { key: newApiKey, username: username, createdAt: new Date().toISOString() };
    
    keys.push(keyData);
    try {
        const saved = await saveKeys(keys);
        return res.json({ success: true, apiKey: newApiKey, persisted: saved.persisted, backend: saved.backend });
    } catch (err) {
        console.error('Key save error:', err);
        return res.status(500).json({ success: false, error: 'Could not persist the new key: ' + err.message });
    }
});

app.get('/api/admin/keys', requireOwner, async (req, res) => {
    const keys = await loadKeys();
    res.json({ success: true, keys });
});

app.post('/api/admin/revoke-key', requireOwner, async (req, res) => {
    const { key } = req.body;
    let keys = await loadKeys();
    
    keys = keys.filter(k => k.key !== key);
    try {
        const saved = await saveKeys(keys);
        return res.json({ success: true, message: 'Key revoked.', persisted: saved.persisted, backend: saved.backend });
    } catch (err) {
        console.error('Key save error:', err);
        return res.status(500).json({ success: false, error: 'Could not persist the revocation: ' + err.message });
    }
});

app.get('/api/verify-key', async (req, res) => {
    const apiKey = req.headers['x-api-key'] || req.headers['x-api-key'];
    if (!apiKey) return res.json({ authenticated: false });

    const keys = await loadKeys();
    const foundKey = keys.find(k => k.key === apiKey);

    if (foundKey) {
        res.json({ authenticated: true, username: foundKey.username });
    } else {
        res.json({ authenticated: false });
    }
});

// --- SCRIPT MANAGEMENT ROUTES ---

app.post('/api/obfuscate', async (req, res) => {
    const user = await getAuthUser(req);
    if (!user) {
        return res.status(401).json({ success: false, error: 'Unauthorized. Please login with Discord or API Key.' });
    }

    const { scriptPayload, scriptName, fileType, editId } = req.body;
    const options = normalizeObfuscationOptions(req.body.options);
    /* `fileType` is the pre-targets field. New builds send `target`; old vault
       entries and old clients keep working through normalizeTarget(). */
    const target = normalizeTarget(req.body.target || fileType);
    const info = targetInfo(target);
    if (!scriptPayload) {
        return res.status(400).json({ success: false, error: 'Script payload is missing.' });
    }

    try {
        const decodedCode = Buffer.from(scriptPayload, 'base64').toString('utf8');
        
        const engine = new ObfuscatorEngine(decodedCode, options);
        const obfuscatedCode = engine.buildProtectedVM();
        const warnings = compatibilityWarnings(decodedCode, target);

        const hostProtocol = req.headers['x-forwarded-proto'] || req.protocol;
        const hostUrl = `${hostProtocol}://${req.get('host')}`;

        let scriptId;
        let loaderString;
        const currentVault = await loadVault();

        if (editId) {
            const existingScript = currentVault.find(s => s.id === editId && s.ownerId === user.id);
            if (!existingScript) {
                return res.status(403).json({ success: false, error: 'Script not found or unauthorized to edit.' });
            }
            existingScript.name = scriptName || 'Untitled Script';
            existingScript.fileType = info.legacyFileType;
            existingScript.target = target;
            existingScript.code = obfuscatedCode;
            existingScript.rawPayload = scriptPayload;
            /* Rebuild the loader: the user may have switched target, and a
               Studio loader pointing at an executor build (or the reverse)
               fails in a way that looks like a broken payload. */
            loaderString = buildLoader(target, `${hostUrl}/raw/${existingScript.id}`);
            existingScript.loader = loaderString;
            scriptId = existingScript.id;
        } else {
            scriptId = crypto.randomBytes(6).toString('hex');
            const rawLink = `${hostUrl}/raw/${scriptId}`;
            loaderString = buildLoader(target, rawLink);

            currentVault.push({
                id: scriptId,
                ownerId: user.id,
                ownerName: user.username,
                name: scriptName || 'Untitled Script',
                fileType: info.legacyFileType,
                target,
                code: obfuscatedCode,
                rawPayload: scriptPayload,
                loader: loaderString,
                createdAt: new Date().toLocaleDateString()
            });
        }

        /* Persist before answering. The loader URL is useless if the entry
           never reached storage, so the response reports which happened. */
        let persisted = true;
        let storageError = null;
        try {
            const saved = await saveVault(currentVault);
            persisted = saved.persisted;
        } catch (err) {
            persisted = false;
            storageError = err.message;
            console.error('Vault save error:', err);
        }

        res.json({
            success: true,
            loader: loaderString,
            id: scriptId,
            target,
            targetLabel: info.label,
            warnings,
            applied: engine.appliedOptions(),
            stats: engine.stats,
            persisted,
            storageError,
            backend: storageBackend()
        });
    } catch (err) {
        console.error('Obfuscation Error:', err);
        res.status(500).json({ success: false, error: 'Failed to process script deployment.' });
    }
});

app.get('/api/vault', async (req, res) => {
    const user = await getAuthUser(req);
    if (!user) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const currentVault = await loadVault();
    const userScripts = currentVault.filter(s => s.ownerId === user.id);
    res.json({ success: true, scripts: userScripts });
});

app.post('/api/delete', async (req, res) => {
    const user = await getAuthUser(req);
    if (!user) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { id } = req.body;
    let currentVault = await loadVault();
    const index = currentVault.findIndex(s => s.id === id && s.ownerId === user.id);
    
    if (index !== -1) {
        currentVault.splice(index, 1);
        try {
            const saved = await saveVault(currentVault);
            return res.json({ success: true, persisted: saved.persisted, backend: saved.backend });
        } catch (err) {
            console.error('Vault save error:', err);
            return res.status(500).json({ success: false, error: 'Could not persist the delete: ' + err.message });
        }
    } else {
        res.status(403).json({ success: false, error: 'Script not found or unauthorized.' });
    }
});

// --- RAW HOSTING ENDPOINT ---

app.get('/raw/:id', async (req, res) => {
    const currentVault = await loadVault();
    const script = currentVault.find(s => s.id === req.params.id);
    if (!script) return res.status(404).send('Script not found.');

    const userAgent = req.headers['user-agent'] || '';
    const isBrowser = userAgent.includes('Mozilla') || userAgent.includes('Chrome') || userAgent.includes('Safari') || userAgent.includes('Edge');

    if (isBrowser) {
        res.setHeader('Content-Type', 'text/html');
        return res.status(403).send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <title>Nix6 // Browser Access Blocked</title>
                <style>
                    body { background: #000; color: #fff; font-family: monospace; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
                    .box { border: 1px dashed #333; padding: 20px 30px; border-radius: 8px; text-align: center; }
                </style>
            </head>
            <body>
                <div class="box">
                    <h1>// BROWSER ACCESS BLOCKED</h1>
                    <p style="color:#666; font-size: 0.8rem;">This source is served only to non-browser clients. It is not encrypted.</p>
                </div>
            </body>
            </html>
        `);
    }

    res.setHeader('Content-Type', 'text/plain');
    res.send(script.code);
});

module.exports = app;

/* Exposed so scripts/verify-engine.js can exercise the engine without starting
   a listener. The module itself is still the Express handler. */
module.exports.ObfuscatorEngine = ObfuscatorEngine;
/* Exposed so the storage layer can be exercised directly, including against
   the real blob store. */
module.exports.storage = { storageBackend, loadVault, saveVault, loadKeys, saveKeys };

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
}

/* Exposed for targeted engine tests (scanner and pass level). */
module.exports.__engine = {
    scanLua,
    minifySource,
    encodeNumbers,
    encodeStrings,
    renameIdentifiers,
    computeBlockBounds,
    buildLoader,
    normalizeTarget,
    compatibilityWarnings,
    RUN_TARGETS
};
