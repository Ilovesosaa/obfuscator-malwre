const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Owner Discord ID (Only this account gets Admin Key Gen access)
const OWNER_DISCORD_ID = "1257596807857569793";

// File path for persistent API key storage
const KEYS_FILE = path.join(__dirname, 'keys.json');

// Helper to load keys from file
function loadKeys() {
    if (!fs.existsSync(KEYS_FILE)) {
        fs.writeFileSync(KEYS_FILE, JSON.stringify([]));
        return [];
    }
    try {
        return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    } catch (e) {
        return [];
    }
}

// Helper to save keys to file
function saveKeys(keys) {
    fs.writeFileSync(KEYS_FILE, JSON.stringify(keys, null, 2));
}

// --- LURAPH-STYLE VM OBFUSCATION ENGINE ---
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

// Discord OAuth2 Configuration
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || 'YOUR_DISCORD_CLIENT_ID';
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || 'YOUR_DISCORD_CLIENT_SECRET';

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(session({
    secret: crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Set to true if using HTTPS in production
}));

// In-memory Database for scripts
let vaultDatabase = [];

// --- MIDDLEWARE ---

// Middleware to protect Owner routes
function requireOwner(req, res, next) {
    if (req.session && req.session.user && req.session.user.id === OWNER_DISCORD_ID) {
        return next();
    }
    return res.status(403).json({ success: false, error: 'Forbidden: Owner access required.' });
}

// Helper middleware to authenticate via Discord Session OR API Key
function getAuthUser(req) {
    if (req.session && req.session.user) {
        return req.session.user;
    }
    
    const apiKey = req.headers['x-api-key'];
    if (apiKey) {
        const keys = loadKeys();
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

app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'index.html');
    const publicIndexPath = path.join(__dirname, 'public', 'index.html');

    if (fs.existsSync(indexPath)) {
        return res.sendFile(indexPath);
    } else if (fs.existsSync(publicIndexPath)) {
        return res.sendFile(publicIndexPath);
    }

    res.setHeader('Content-Type', 'text/html');
    return res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <title>Nix6 Engine // Online</title>
            <style>
                body { background: #000; color: #fff; font-family: monospace; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
                .box { border: 1px dashed #333; padding: 20px 30px; border-radius: 8px; text-align: center; }
                h1 { font-size: 1rem; letter-spacing: 2px; }
            </style>
        </head>
        <body>
            <div class="box">
                <h1>// NIX6 ENGINE ACTIVE</h1>
                <p style="color:#666; font-size: 0.8rem;">Backend API is running properly.</p>
            </div>
        </body>
        </html>
    `);
});

const publicPath = path.join(__dirname, 'public');
if (fs.existsSync(publicPath)) {
    app.use(express.static(publicPath));
}
app.use(express.static(path.join(__dirname)));

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

        res.redirect('/');
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

// 1. Generate new API Key (Owner Only)
app.post('/api/admin/generate-key', requireOwner, (req, res) => {
    const username = req.body.username || "Client_User";
    const keys = loadKeys();
    
    const newApiKey = "nix6_key_" + crypto.randomBytes(16).toString('hex');
    const keyData = { key: newApiKey, username: username, createdAt: new Date().toISOString() };
    
    keys.push(keyData);
    saveKeys(keys);

    res.json({ success: true, apiKey: newApiKey });
});

// 2. Fetch list of all active keys (Owner Only)
app.get('/api/admin/keys', requireOwner, (req, res) => {
    const keys = loadKeys();
    res.json({ success: true, keys });
});

// 3. Revoke/Delete an API Key (Owner Only)
app.post('/api/admin/revoke-key', requireOwner, (req, res) => {
    const { key } = req.body;
    let keys = loadKeys();
    
    keys = keys.filter(k => k.key !== key);
    saveKeys(keys);

    res.json({ success: true, message: 'Key revoked.' });
});

// 4. Verify API Key Login (Public Header Route)
app.get('/api/verify-key', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) return res.json({ authenticated: false });

    const keys = loadKeys();
    const foundKey = keys.find(k => k.key === apiKey);

    if (foundKey) {
        res.json({ authenticated: true, username: foundKey.username });
    } else {
        res.json({ authenticated: false });
    }
});

// --- SCRIPT MANAGEMENT ROUTES ---

app.post('/api/obfuscate', (req, res) => {
    const user = getAuthUser(req);
    if (!user) {
        return res.status(401).json({ success: false, error: 'Unauthorized. Please login with Discord or API Key.' });
    }

    const { scriptPayload, scriptName, fileType, editId } = req.body;
    if (!scriptPayload) {
        return res.status(400).json({ success: false, error: 'Script payload is missing.' });
    }

    try {
        const decodedCode = Buffer.from(scriptPayload, 'base64').toString('utf8');
        
        // Pass code through the Luraph obfuscation engine
        const engine = new LuraphEngine(decodedCode);
        const obfuscatedCode = engine.buildProtectedVM();

        const hostProtocol = req.headers['x-forwarded-proto'] || req.protocol;
        const hostUrl = `${hostProtocol}://${req.get('host')}`;

        let scriptId;
        let loaderString;

        if (editId) {
            const existingScript = vaultDatabase.find(s => s.id === editId && s.ownerId === user.id);
            if (!existingScript) {
                return res.status(403).json({ success: false, error: 'Script not found or unauthorized to edit.' });
            }
            existingScript.name = scriptName || 'Untitled Script';
            existingScript.fileType = fileType || 'luau';
            existingScript.code = obfuscatedCode;
            scriptId = existingScript.id;
            loaderString = existingScript.loader;
        } else {
            scriptId = crypto.randomBytes(6).toString('hex');
            const rawLink = `${hostUrl}/raw/${scriptId}`;
            loaderString = `loadstring(game:HttpGet("${rawLink}"))()`;

            vaultDatabase.push({
                id: scriptId,
                ownerId: user.id,
                ownerName: user.username,
                name: scriptName || 'Untitled Script',
                fileType: fileType || 'luau',
                code: obfuscatedCode,
                loader: loaderString,
                createdAt: new Date().toLocaleDateString()
            });
        }

        res.json({ success: true, loader: loaderString, id: scriptId });
    } catch (err) {
        console.error('Obfuscation Error:', err);
        res.status(500).json({ success: false, error: 'Failed to process script deployment.' });
    }
});

app.get('/api/vault', (req, res) => {
    const user = getAuthUser(req);
    if (!user) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const userScripts = vaultDatabase.filter(s => s.ownerId === user.id);
    res.json({ success: true, scripts: userScripts });
});

app.post('/api/delete', (req, res) => {
    const user = getAuthUser(req);
    if (!user) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { id } = req.body;
    const index = vaultDatabase.findIndex(s => s.id === id && s.ownerId === user.id);
    
    if (index !== -1) {
        vaultDatabase.splice(index, 1);
        res.json({ success: true });
    } else {
        res.status(403).json({ success: false, error: 'Script not found or unauthorized.' });
    }
});

// --- RAW HOSTING ENDPOINT (MONOCHROME WHITE/BLACK) ---

app.get('/raw/:id', (req, res) => {
    const script = vaultDatabase.find(s => s.id === req.params.id);
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
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>Nix6 // Access Restricted</title>
                <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;700;800&display=swap" rel="stylesheet">
                <style>
                    :root {
                        --bg-base: #000000;
                        --bg-card: rgba(12, 12, 12, 0.95);
                        --border-subtle: rgba(255, 255, 255, 0.15);
                        --border-glow: rgba(255, 255, 255, 0.35);
                        --text-primary: #ffffff;
                        --text-secondary: #a1a1aa;
                        --radius-main: 12px;
                    }

                    * {
                        box-sizing: border-box;
                        margin: 0;
                        padding: 0;
                        font-family: 'JetBrains Mono', monospace;
                    }

                    body {
                        background-color: var(--bg-base);
                        color: var(--text-primary);
                        min-height: 100vh;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        position: relative;
                        overflow: hidden;
                    }

                    body::before {
                        content: "";
                        position: absolute;
                        top: 0; left: 0; right: 0; bottom: 0;
                        background: 
                            linear-gradient(rgba(255, 255, 255, 0.02) 1px, transparent 1px),
                            linear-gradient(90deg, rgba(255, 255, 255, 0.02) 1px, transparent 1px);
                        background-size: 32px 32px;
                        pointer-events: none;
                        z-index: 0;
                    }

                    .restricted-card {
                        position: relative;
                        z-index: 1;
                        background: var(--bg-card);
                        border: 1px dashed var(--border-subtle);
                        border-radius: var(--radius-main);
                        padding: 40px 48px;
                        text-align: center;
                        max-width: 520px;
                        width: 90%;
                        box-shadow: 0 0 32px rgba(255, 255, 255, 0.03);
                        transition: border-color 0.2s ease, box-shadow 0.2s ease;
                    }

                    .restricted-card:hover {
                        border-color: var(--border-glow);
                        box-shadow: 0 0 40px rgba(255, 255, 255, 0.06);
                    }

                    .restricted-title {
                        font-size: 1.1rem;
                        font-weight: 800;
                        letter-spacing: 3px;
                        color: #ffffff;
                        margin-bottom: 14px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        gap: 10px;
                    }

                    .restricted-title::before,
                    .restricted-title::after {
                        content: "//";
                        color: var(--text-secondary);
                        font-weight: 500;
                    }

                    .restricted-subtitle {
                        font-size: 0.82rem;
                        color: var(--text-secondary);
                        letter-spacing: 0.5px;
                        line-height: 1.5;
                    }
                </style>
            </head>
            <body>
                <div class="restricted-card">
                    <h1 class="restricted-title">ACCESS RESTRICTED</h1>
                    <p class="restricted-subtitle">This loadstring source is protected and unlisted.</p>
                </div>
            </body>
            </html>
        `);
    }

    res.setHeader('Content-Type', 'text/plain');
    res.send(script.code);
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
