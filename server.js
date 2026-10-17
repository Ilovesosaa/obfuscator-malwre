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

// File path for local persistent storage fallback
const KEYS_FILE = path.join(__dirname, 'keys.json');

// GitHub Gist Environment Variables
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const KEYS_GIST_ID = process.env.KEYS_GIST_ID;
const VAULT_GIST_ID = process.env.VAULT_GIST_ID;

// Helper to load keys (Gist primary for Vercel, fallback to local fs)
async function loadKeys() {
    if (GITHUB_TOKEN && KEYS_GIST_ID) {
        try {
            const res = await fetch(`https://api.github.com/gists/${KEYS_GIST_ID}`, {
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'User-Agent': 'Vercel-Nix6-App'
                }
            });
            const data = await res.json();
            const content = data.files['keys.json']?.content;
            return content ? JSON.parse(content) : [];
        } catch (e) {
            console.error('Error fetching keys from Gist:', e);
            return [];
        }
    }

    if (!fs.existsSync(KEYS_FILE)) {
        try { fs.writeFileSync(KEYS_FILE, JSON.stringify([])); } catch (e) {}
        return [];
    }
    try {
        return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    } catch (e) {
        return [];
    }
}

// Helper to save keys (Gist primary for Vercel, fallback to local fs)
async function saveKeys(keys) {
    if (GITHUB_TOKEN && KEYS_GIST_ID) {
        try {
            await fetch(`https://api.github.com/gists/${KEYS_GIST_ID}`, {
                method: 'PATCH',
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Content-Type': 'application/json',
                    'User-Agent': 'Vercel-Nix6-App'
                },
                body: JSON.stringify({
                    files: {
                        'keys.json': { content: JSON.stringify(keys, null, 2) }
                    }
                })
            });
            return;
        } catch (e) {
            console.error('Error saving keys to Gist:', e);
        }
    }

    try {
        fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));
    } catch (e) {
        console.error('Local FS write error:', e);
    }
}

// Helper to load vault scripts
async function loadVault() {
    if (GITHUB_TOKEN && VAULT_GIST_ID) {
        try {
            const res = await fetch(`https://api.github.com/gists/${VAULT_GIST_ID}`, {
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'User-Agent': 'Vercel-Nix6-App'
                }
            });
            const data = await res.json();
            const content = data.files['vault.json']?.content;
            return content ? JSON.parse(content) : [];
        } catch (e) {
            return [];
        }
    }
    return vaultDatabase;
}

// Helper to save vault scripts
async function saveVault(vault) {
    if (GITHUB_TOKEN && VAULT_GIST_ID) {
        try {
            await fetch(`https://api.github.com/gists/${VAULT_GIST_ID}`, {
                method: 'PATCH',
                headers: {
                    'Authorization': `token ${GITHUB_TOKEN}`,
                    'Content-Type': 'application/json',
                    'User-Agent': 'Vercel-Nix6-App'
                },
                body: JSON.stringify({
                    files: {
                        'vault.json': { content: JSON.stringify(vault, null, 2) }
                    }
                })
            });
            return;
        } catch (e) {
            console.error('Error saving vault to Gist:', e);
        }
    }
    vaultDatabase = vault;
}

/* ============================================================
   Obfuscation options

   The four toggles in the UI used to be decorative and the server
   ignored them. They now drive a real pass over the source before it
   is XOR-wrapped:

     minify         drop comments and squeeze whitespace (never inside a
                    string; `--!` directives are kept)
     rename         rename top-level local identifiers, but only when the
                    name can be proven unambiguous (see renameIdentifiers)
     encryptStrings emit short string literals as byte sequences that are
                    rebuilt at runtime, so they are not readable in the payload
     antiTamper     verify a checksum of the payload before running it

   Everything here is deliberately conservative: a construct that cannot be
   proven safe is skipped, and the counts are reported back to the UI.
   ============================================================ */

/* The four switches arrive from the UI as booleans. Anything missing counts as
   on, which matches the checked boxes the form ships with. */
function normalizeObfuscationOptions(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    return {
        minify: input.minify !== false,
        rename: input.rename !== false,
        encryptStrings: input.encryptStrings !== false,
        antiTamper: input.antiTamper !== false
    };
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
    'spawn', 'wait', 'delay', 'tick', 'self', '_G', '_ENV', 'NIX6_STR'
]);

/* Reads a long bracket ([==[ ... ]==]) starting at `at`. Returns null when the
   bracket is not a long bracket, so the caller can treat it as plain code. */
function readLongBracket(src, at) {
    let k = at + 1;
    let level = 0;
    while (src[k] === '=') { level++; k++; }
    if (src[k] !== '[') return null;
    const closeMark = ']' + '='.repeat(level) + ']';
    const close = src.indexOf(closeMark, k + 1);
    if (close === -1) return null;
    return { end: close + closeMark.length };
}

/* Splits source into code / string / comment runs. This is the only place that
   needs to understand Lua's lexical structure; every transform works on the
   runs, so nothing can ever be edited inside a string or comment by accident. */
function scanLua(src) {
    const segs = [];
    let i = 0;
    let codeStart = 0;
    const n = src.length;
    const pushCode = (end) => {
        if (end > codeStart) segs.push({ type: 'code', text: src.slice(codeStart, end) });
    };

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
            let j = i + 1;
            while (j < n) {
                if (src[j] === '\\') { j += 2; continue; }
                if (src[j] === c) { j++; break; }
                if (src[j] === '\n') break;      // unterminated: stop at the line end
                j++;
            }
            segs.push({ type: 'string', text: src.slice(i, j), quote: c });
            i = j;
            codeStart = i;
            continue;
        }

        if (c === '[') {
            const long = readLongBracket(src, i);
            if (long) {
                pushCode(i);
                segs.push({ type: 'string', text: src.slice(i, long.end), quote: '[' });
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
function minifySource(src) {
    const segs = scanLua(src);
    const out = [];
    let commentsRemoved = 0;

    for (const seg of segs) {
        if (seg.type === 'comment') {
            if (/^--!\w/.test(seg.text)) { out.push(seg); continue; }   // --!strict etc.
            commentsRemoved++;
            continue;
        }
        if (seg.type !== 'code') { out.push(seg); continue; }
        const lines = seg.text
            .replace(/\r\n?/g, '\n')
            .split('\n')
            .map((line) => line.replace(/[ \t]+/g, ' ').replace(/[ \t]+$/, ''));
        /* Blank lines go, but never the empty strings that merely mark where
           this run starts or ends: those carry the newline separating it from
           the string or comment next door, and losing one glues two tokens
           together (`local n = "a"` + `print(n)` became `"a"print(n)`). */
        const kept = lines.filter((line, index) =>
            index === 0 || index === lines.length - 1 || line.trim() !== '');
        out.push({ type: 'code', text: kept.join('\n') });
    }

    return { text: segmentsToText(out).replace(/^\n+/, '').replace(/\n+$/, ''), commentsRemoved };
}

/* --- rename ------------------------------------------------------------- */

/* Block depth: 0 means "top level of the chunk". Only there can we prove a
   single `local` stays in scope for the rest of the file. */
function topLevelLocals(src, mask) {
    const depthAt = new Array(src.length);
    const wordRe = /\b(function|then|do|repeat|end|until)\b/g;
    let depth = 0;
    let last = 0;
    let m;
    while ((m = wordRe.exec(src)) !== null) {
        depthAt.fill(depth, last, m.index);
        const w = m[1];
        if (w === 'end' || w === 'until') depth = Math.max(0, depth - 1);
        else depth++;
        depthAt.fill(mask[m.index] === 1 ? depth : depth, m.index, m.index + w.length);
        last = m.index + w.length;
    }
    depthAt.fill(depth, last, src.length);

    const declarations = new Map();      // name -> [{ index, stmtEnd, depth }]
    const localRe = /\blocal\b/g;
    while ((m = localRe.exec(src)) !== null) {
        if (mask[m.index] !== 1) continue;
        const depth = depthAt[m.index];
        let i = m.index + m[0].length;
        const skipWs = () => { while (i < src.length && (src[i] === ' ' || src[i] === '\t')) i++; };
        const here = [];

        skipWs();
        if (src.startsWith('function', i) && !/[A-Za-z0-9_]/.test(src[i + 8] || '')) {
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
                        if (c === '(' || c === '{') typeDepth++;
                        else if (c === ')' || c === '}') { if (typeDepth === 0) break; typeDepth--; }
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

        for (const decl of here) {
            if (!declarations.has(decl.name)) declarations.set(decl.name, []);
            declarations.get(decl.name).push({
                index: decl.index,
                depth,
                initializer: src.slice(i, stmtEnd)
            });
        }
    }

    return declarations;
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

    const declarations = topLevelLocals(src, mask);
    const newNames = new Map();
    const skipped = [];

    for (const [name, decls] of declarations) {
        if (decls.length !== 1) { skipped.push(name); continue; }             // shadowed/redeclared
        const decl = decls[0];
        if (decl.depth !== 0) { skipped.push(name); continue; }               // scope may end early
        if (LUA_KEYWORDS.has(name) || RESERVED_NAMES.has(name) || /^NIX6_/.test(name)) continue;
        if (name.length < 2) continue;

        const occ = occurrences.get(name) || [];
        if (occ.length < 2) continue;                                          // nothing to gain
        if (occ[0] < decl.index) { skipped.push(name); continue; }              // a global with the same name
        if (new RegExp(`[.:]\\s*${name}\\b`).test(src)) { skipped.push(name); continue; }        // t.name / t:name
        if (new RegExp(`[{,]\\s*${name}\\s*=`).test(src)) { skipped.push(name); continue; }       // { name = ... }
        if (new RegExp(`\\bgoto\\s+${name}\\b|::\\s*${name}\\s*::`).test(src)) { skipped.push(name); continue; }
        if (new RegExp(`\\b${name}\\b`).test(decl.initializer)) { skipped.push(name); continue; } // `local x = x or {}`

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

/* Decodes a quoted Lua string literal into its runtime bytes. Returns null for
   anything unusual (unknown escape, malformed) so the caller can leave the
   literal exactly as it was. */
function decodeQuotedLiteral(literal) {
    const quote = literal[0];
    if (quote !== '"' && quote !== "'") return null;
    const body = literal.slice(1, literal.length - (literal[literal.length - 1] === quote ? 1 : 0));
    const bytes = [];
    for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (c !== '\\') {
            for (const b of Buffer.from(c, 'utf8')) bytes.push(b);
            continue;
        }
        const e = body[++i];
        if (e === undefined) return null;
        const simple = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34, "'": 39, '\n': 10 };
        if (Object.prototype.hasOwnProperty.call(simple, e)) { bytes.push(simple[e]); continue; }
        if (e === 'x') {
            const hex = /^[0-9a-fA-F]{1,2}/.exec(body.slice(i + 1));
            if (!hex) return null;
            bytes.push(parseInt(hex[0], 16));
            i += hex[0].length;
            continue;
        }
        if (e === 'z') { while (/[ \t\r\n\v\f]/.test(body[i + 1] || '')) i++; continue; }
        if (e === 'u') {
            const u = /^\{([0-9a-fA-F]+)\}/.exec(body.slice(i + 1));
            if (!u) return null;
            for (const b of Buffer.from(String.fromCodePoint(parseInt(u[1], 16)), 'utf8')) bytes.push(b);
            i += u[0].length;
            continue;
        }
        if (/[0-9]/.test(e)) {
            const dec = /^[0-9]{1,3}/.exec(body.slice(i));
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

function encodeStrings(src) {
    const segs = scanLua(src);
    const out = [];
    let encoded = 0;
    let skipped = 0;

    for (const seg of segs) {
        if (seg.type !== 'string') { out.push(seg); continue; }
        // long brackets ([==[..]==]) and Luau interpolated (`..{..}..`) strings
        // keep their own decoding rules, so they are left readable.
        if (seg.quote !== '"' && seg.quote !== "'") { skipped++; out.push(seg); continue; }
        const bytes = decodeQuotedLiteral(seg.text);
        if (!bytes || bytes.length === 0) { skipped++; out.push(seg); continue; }
        encoded++;
        /* Keep a space between the rebuilt call and what came before it: after
           minify trimmed a trailing space, `x = 1 or "none"` would otherwise
           come out as `x = 1 orNIX6_STR{...}`, which is one long identifier. */
        const previous = out.length ? out[out.length - 1].text : '';
        const separator = previous !== '' && !/[\s([{,;]$/.test(previous) ? ' ' : '';
        out.push({ type: 'code', text: separator + 'NIX6_STR{' + bytes.join(',') + '}' });
    }

    if (encoded === 0) return { text: src, encoded, skipped };

    const helper = [
        'local NIX6_STR = function(_t)',
        ' local _o = {}',
        ' for _i = 1, #_t do _o[_i] = string.char(_t[_i]) end',
        ' return table.concat(_o)',
        'end',
        ''
    ].join('\n');

    return { text: helper + segmentsToText(out), encoded, skipped };
}

// --- OBFUSCATION ENGINE (reversible XOR wrapper; not a VM, not encryption) ---
class ObfuscatorEngine {
    constructor(sourceCode, options) {
        this.source = sourceCode;
        this.options = normalizeObfuscationOptions(options);
        this.stats = {
            commentsRemoved: 0,
            identifiersRenamed: 0,
            stringsEncoded: 0,
            stringsSkipped: 0,
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
        }
        if (this.options.rename) {
            const result = renameIdentifiers(text);
            text = result.text;
            this.stats.identifiersRenamed = result.renamed.length;
        }
        if (this.options.encryptStrings) {
            const result = encodeStrings(text);
            text = result.text;
            this.stats.stringsEncoded = result.encoded;
            this.stats.stringsSkipped = result.skipped;
        }

        return text;
    }

    appliedOptions() {
        const applied = [];
        if (this.options.minify) applied.push('minify');
        if (this.options.rename) applied.push('rename');
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

    buildProtectedVM() {
        const op = this._generateOpCodes();
        const xorKey = Math.floor(Math.random() * 180) + 35;
        const prepared = this.prepareSource();
        const srcBytes = Buffer.from(prepared, 'utf-8');

        const encBytes = [];
        for (let i = 0; i < srcBytes.length; i++) {
            encBytes.push(srcBytes[i] ^ xorKey);
        }

        /* Anti-tamper: position-weighted sum of the *encoded* bytes, which are
           exactly what the payload carries. Summing those instead of the XOR
           result keeps both sides in integer arithmetic, so the check cannot
           drift on a runtime where bit32 is missing and the pure-Lua XOR
           fallback (which returns floats) is doing the decoding. */
        let integrity = 0;
        for (let i = 0; i < encBytes.length; i++) {
            integrity = (integrity + encBytes[i] * (i + 1)) % INTEGRITY_MODULUS;
        }
        this.stats.integrity = integrity;

        const v_vm = this._randomId();
        const v_bytecode = this._randomId();
        const v_consts = this._randomId();
        const v_k = this._randomId();
        const v_pc = this._randomId();
        const v_reg = this._randomId();
        const v_instr = this._randomId();
        const v_op = this._randomId();
        const v_bxor = this._randomId();
        const v_decode = this._randomId();
        const v_env = this._randomId();

        const formattedBytes = '{' + encBytes.join(',') + '}';

        const tamperGuard = this.options.antiTamper ? `    if debug and debug.getmetatable then
        local _meta = debug.getmetatable(${v_env})
        if _meta then while true do end end
    end

` : '';

        /* The integrity check has to be emitted after the byte table and the
           XOR helper exist, or it would read them as missing globals. */
        const integrityCheck = this.options.antiTamper ? `    local _int = 0
    for _i = 1, #${v_bytecode} do
        _int = (_int + ${v_bytecode}[_i] * _i) % ${INTEGRITY_MODULUS}
    end
    if _int ~= ${integrity} then
        error("Nix6: payload integrity check failed")
    end

` : '';

        return `-- [[ Nix6 obfuscation wrapper: reversible XOR of source bytes. Not encryption, not a security boundary. ]]
local function ${v_vm}(...)
    local ${v_env} = getfenv and getfenv() or _ENV
${tamperGuard}
    local ${v_bxor} = bit32 and bit32.bxor or function(a, b)
        local r, p = 0, 1
        while a > 0 or b > 0 do
            local aa, bb = a % 2, b % 2
            if aa ~= bb then r = r + p end
            a, b, p = (a - aa) / 2, (b - bb) / 2, p * 2
        end
        return r
    end

    local ${v_k} = ${xorKey}
    local ${v_bytecode} = ${formattedBytes}

    local function ${v_decode}(_t, _key)
        local _out = {}
        for _i = 1, #_t do
            table.insert(_out, string.char(${v_bxor}(_t[_i], _key)))
        end
        return table.concat(_out)
    end

${integrityCheck}    local ${v_consts} = {
        [1] = ${v_decode}(${v_bytecode}, ${v_k})
    }

    local ${v_instr} = {
        {${op.OP_EXEC_CHUNK}, 1}
    }

    local ${v_reg} = {}
    local ${v_pc} = 1

    while ${v_pc} <= #${v_instr} do
        local _curr = ${v_instr}[${v_pc}]
        local ${v_op} = _curr[1]

        if ${v_op} == ${op.OP_EXEC_CHUNK} then
            local _code = ${v_consts}[_curr[2]]
            local _loader = loadstring or load
            if _loader then
                local _compiled, _err = _loader(_code)
                if _compiled then
                    return _compiled(...)
                else
                    error(_err or "VM Instruction Fault")
                end
            end
        end

        ${v_pc} = ${v_pc} + 1
    end
end
return ${v_vm}(...)`;
    }
}

// Discord OAuth2 Configuration
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || 'YOUR_DISCORD_CLIENT_ID';
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || 'YOUR_DISCORD_CLIENT_SECRET';

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

let vaultDatabase = [];

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

// --- AUTHENTICATION ROUTES ---

app.get('/auth/discord', (req, res) => {
    const hostProtocol = req.headers['x-forwarded-proto'] || req.protocol;
    const redirectUri = `${hostProtocol}://${req.get('host')}/auth/discord/callback`;
    
    const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify`;
    res.redirect(discordAuthUrl);
});

app.get('/auth/discord/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('No code provided from Discord.');

    const hostProtocol = req.headers['x-forwarded-proto'] || req.protocol;
    const redirectUri = `${hostProtocol}://${req.get('host')}/auth/discord/callback`;

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

        const tokenData = await tokenResponse.json();
        if (!tokenData.access_token) return res.status(400).send('Failed to obtain access token from Discord: ' + JSON.stringify(tokenData));

        const userResponse = await fetch('https://discord.com/api/users/@me', {
            headers: { authorization: `${tokenData.token_type} ${tokenData.access_token}` },
        });

        const userData = await userResponse.json();
        
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
        res.status(500).send('Internal Authentication Error');
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
    await saveKeys(keys);

    res.json({ success: true, apiKey: newApiKey });
});

app.get('/api/admin/keys', requireOwner, async (req, res) => {
    const keys = await loadKeys();
    res.json({ success: true, keys });
});

app.post('/api/admin/revoke-key', requireOwner, async (req, res) => {
    const { key } = req.body;
    let keys = await loadKeys();
    
    keys = keys.filter(k => k.key !== key);
    await saveKeys(keys);

    res.json({ success: true, message: 'Key revoked.' });
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
    if (!scriptPayload) {
        return res.status(400).json({ success: false, error: 'Script payload is missing.' });
    }

    try {
        const decodedCode = Buffer.from(scriptPayload, 'base64').toString('utf8');
        
        const engine = new ObfuscatorEngine(decodedCode, options);
        const obfuscatedCode = engine.buildProtectedVM();

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
            existingScript.fileType = fileType || 'luau';
            existingScript.code = obfuscatedCode;
            existingScript.rawPayload = scriptPayload;
            scriptId = existingScript.id;
            loaderString = existingScript.loader;
        } else {
            scriptId = crypto.randomBytes(6).toString('hex');
            const rawLink = `${hostUrl}/raw/${scriptId}`;
            loaderString = `loadstring(game:HttpGet("${rawLink}"))()`;

            currentVault.push({
                id: scriptId,
                ownerId: user.id,
                ownerName: user.username,
                name: scriptName || 'Untitled Script',
                fileType: fileType || 'luau',
                code: obfuscatedCode,
                rawPayload: scriptPayload,
                loader: loaderString,
                createdAt: new Date().toLocaleDateString()
            });
        }

        await saveVault(currentVault);
        res.json({
            success: true,
            loader: loaderString,
            id: scriptId,
            applied: engine.appliedOptions(),
            stats: engine.stats
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
        await saveVault(currentVault);
        res.json({ success: true });
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

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
}
