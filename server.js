const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS Handler
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-API-Key, X-Nix6-Signature');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: 'nix6_secure_engine_session_secret_2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

const activeKeys = new Map();
const scriptVault = new Map();
const OWNER_DISCORD_ID = "1257596807857569793";

function safeBase64Decode(str) {
    return Buffer.from(str, 'base64').toString('utf-8');
}

// Luraph-Style Enterprise Obfuscation Engine
class LuraphEngine {
    constructor(sourceCode) {
        this.source = sourceCode;
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
        const srcBytes = Buffer.from(this.source, 'utf-8');
        const encBytes = [];

        for (let i = 0; i < srcBytes.length; i++) {
            encBytes.push(srcBytes[i] ^ xorKey);
        }

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

        return `-- [[ Nix6 Security Engine v4.0 - Luraph Grade Protection ]]
local function ${v_vm}(...)
    local ${v_env} = getfenv and getfenv() or _ENV
    if debug and debug.getmetatable then
        local _meta = debug.getmetatable(${v_env})
        if _meta then while true do end end
    end

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

    local ${v_consts} = {
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

// Auth Middleware
function requireAuth(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    if (apiKey && activeKeys.has(apiKey)) {
        req.user = { username: activeKeys.get(apiKey).username, type: 'key' };
        return next();
    }
    if (req.session && req.session.user) {
        req.user = req.session.user;
        return next();
    }
    return res.status(401).json({ success: false, error: 'Unauthorized.' });
}

function requireOwner(req, res, next) {
    if (req.session && req.session.user && req.session.user.id === OWNER_DISCORD_ID) {
        return next();
    }
    return res.status(403).json({ success: false, error: 'Owner required.' });
}

// API Routes
app.get('/api/verify-key', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey && activeKeys.has(apiKey)) {
        return res.json({ authenticated: true, username: activeKeys.get(apiKey).username });
    }
    res.json({ authenticated: false });
});

app.get('/api/me', (req, res) => {
    if (req.session && req.session.user) {
        return res.json({ authenticated: true, user: req.session.user });
    }
    res.json({ authenticated: false });
});

app.post('/api/obfuscate', requireAuth, (req, res) => {
    try {
        const { scriptPayload, scriptName, fileType, editId } = req.body;
        if (!scriptPayload) return res.status(400).json({ success: false, error: 'Empty payload.' });

        const rawScript = safeBase64Decode(scriptPayload);
        const engine = new LuraphEngine(rawScript);
        const obfuscatedCode = engine.buildProtectedVM();

        const scriptId = editId || 'nix6_' + crypto.randomBytes(8).toString('hex');
        const loader = `loadstring(game:HttpGet("https://${req.get('host')}/raw/${scriptId}"))()`;

        scriptVault.set(scriptId, {
            id: scriptId,
            name: scriptName || 'Untitled Script',
            fileType: fileType || 'luau',
            code: obfuscatedCode,
            rawPayload: scriptPayload,
            owner: req.user.username,
            createdAt: new Date().toISOString(),
            loader: loader
        });

        res.json({ success: true, scriptId, loader, code: obfuscatedCode });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Compilation error: ' + err.message });
    }
});

app.get('/api/vault', requireAuth, (req, res) => {
    const userScripts = Array.from(scriptVault.values()).filter(s => s.owner === req.user.username);
    res.json({ success: true, scripts: userScripts });
});

app.post('/api/delete', requireAuth, (req, res) => {
    const { id } = req.body;
    if (scriptVault.has(id) && scriptVault.get(id).owner === req.user.username) {
        scriptVault.delete(id);
        return res.json({ success: true });
    }
    res.status(400).json({ success: false, error: 'Invalid ID.' });
});

// Raw Endpoint
app.get('/raw/:id', (req, res) => {
    const script = scriptVault.get(req.params.id);
    const userAgent = req.headers['user-agent'] || '';
    const isRoblox = userAgent.includes('Roblox') || req.headers['x-nix6-signature'];

    if (script) {
        if (isRoblox) {
            res.setHeader('Content-Type', 'text/plain');
            return res.send(script.code);
        }
    }

    res.setHeader('Content-Type', 'text/html');
    res.status(200).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <title>Access Restricted</title>
            <style>
                body {
                    margin: 0;
                    background-color: #050505;
                    color: #00ff66;
                    font-family: monospace;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    height: 100vh;
                }
                .card {
                    border: 1px dashed #00ff66;
                    padding: 30px;
                    border-radius: 8px;
                    text-align: center;
                    box-shadow: 0 0 15px rgba(0, 255, 102, 0.2);
                }
                h2 { margin: 0 0 10px 0; }
                p { color: #a0a0a0; margin: 0; }
            </style>
        </head>
        <body>
            <div class="card">
                <h2>// ACCESS RESTRICTED //</h2>
                <p>This loadstring source is protected and unlisted.</p>
            </div>
        </body>
        </html>
    `);
});

app.post('/api/admin/generate-key', requireOwner, (req, res) => {
    const newKey = 'nix6_key_' + crypto.randomBytes(12).toString('hex');
    activeKeys.set(newKey, { username: req.body.username || 'Client', createdAt: new Date() });
    res.json({ success: true, apiKey: newKey });
});

app.get('/api/admin/keys', requireOwner, (req, res) => {
    const keysArray = Array.from(activeKeys.entries()).map(([key, data]) => ({ key, username: data.username, createdAt: data.createdAt }));
    res.json({ success: true, keys: keysArray });
});

app.post('/api/admin/revoke-key', requireOwner, (req, res) => {
    if (activeKeys.has(req.body.key)) {
        activeKeys.delete(req.body.key);
        return res.json({ success: true });
    }
    res.status(400).json({ success: false, error: 'Key not found.' });
});

app.get('/auth/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

// SPA Router Fallback
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`[NIX6 ENGINE] Operational on port ${PORT}`);
});
