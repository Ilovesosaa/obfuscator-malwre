const express = require('express');
const cors = require('cors');
const cookieSession = require('cookie-session');
const crypto = require('crypto');
const path = require('path');

const fetch = globalThis.fetch || require('node-fetch');

const app = express();
// Render assigns a dynamic PORT via environment variable
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1535568167223562350';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || 'QSTxgNTgXXsJeVvMY3frq0ZLVnT_LZVf';
// Update process.env.DOMAIN in Render dashboard to your .onrender.com URL
const DOMAIN = process.env.DOMAIN || 'http://localhost:3000';

// ==================== IN-MEMORY SCRIPT VAULT ====================
// Runs 24/7 in Render server RAM
const scriptVault = new Map();

// ==================== MIDDLEWARE ====================
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

app.use(cookieSession({
    name: 'sin_session',
    keys: [process.env.SESSION_SECRET || 'sin_obfuscator_super_secret_key_999'],
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'lax'
}));

function generateShortId() {
    return crypto.randomBytes(4).toString('hex');
}

// ==================== OBFUSCATOR ENGINE ====================
function compileToHardenedLuauVM(sourceCode) {
    const genVar = () => '_0x' + Math.random().toString(16).substring(2, 8);

    const v_char = genVar();
    const v_concat = genVar();
    const v_bxor = genVar();
    const v_load = genVar();
    const v_key = genVar();
    const v_bytes = genVar();
    const v_result = genVar();
    const v_idx = genVar();
    const v_val = genVar();
    const v_func = genVar();
    const v_err = genVar();
    const v_realByte = genVar();

    const baseKey = Math.floor(Math.random() * 180) + 40;
    const shiftStep = Math.floor(Math.random() * 13) + 3;

    // Convert UTF-8 source string safely to byte buffer
    const sourceBuffer = Buffer.from(sourceCode, 'utf-8');
    const encryptedBytes = [];

    for (let i = 0; i < sourceBuffer.length; i++) {
        let byteVal = sourceBuffer[i];
        let dynamicKey = (baseKey + (i * shiftStep)) % 256;
        encryptedBytes.push(byteVal ^ dynamicKey);
    }

    const bytesArrayString = `{${encryptedBytes.join(',')}}`;

    return `--[[ SIN Luau Hardened Shield v5.0 ]]--
return (function(...)
    local ${v_char} = string.char
    local ${v_concat} = table.concat
    local ${v_bxor} = (bit32 and bit32.bxor) or function(a, b) return a ~ b end
    local ${v_load} = loadstring or load

    local ${v_key} = ${baseKey}
    local ${v_bytes} = ${bytesArrayString}
    local ${v_result} = {}

    for ${v_idx} = 1, #${v_bytes} do
        local ${v_val} = ${v_bytes}[${v_idx}]
        local ${v_realByte} = ${v_bxor}(${v_val}, (${v_key} + ((${v_idx} - 1) * ${shiftStep})) % 256)
        ${v_result}[${v_idx}] = ${v_char}(${v_realByte})
    end

    local _rawCode = ${v_concat}(${v_result})
    ${v_bytes} = nil
    ${v_result} = nil

    local ${v_func}, ${v_err} = ${v_load}(_rawCode)
    _rawCode = nil

    if ${v_func} then
        return ${v_func}(...)
    else
        error("[SIN Security Runtime Error]: " .. tostring(${v_err}), 0)
    end
end)(...);`;
}

// ==================== ROUTES ====================

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Discord Auth Routes
app.get('/auth/discord', (req, res) => {
    try {
        const redirectUri = encodeURIComponent(`${DOMAIN}/auth/discord/callback`);
        const discordUrl = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${redirectUri}&response_type=code&scope=identify`;
        return res.redirect(discordUrl);
    } catch (err) {
        return res.status(500).send("Failed to initiate Discord login: " + err.message);
    }
});

app.get('/auth/discord/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.redirect('/');

    const redirectUri = `${DOMAIN}/auth/discord/callback`;

    try {
        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            body: new URLSearchParams({
                client_id: DISCORD_CLIENT_ID,
                client_secret: DISCORD_CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: redirectUri,
            }),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });

        const tokenData = await tokenResponse.json();
        if (!tokenData.access_token) return res.status(400).send("Authentication failed.");

        const userResponse = await fetch('https://discord.com/api/users/@me', {
            headers: { authorization: `${tokenData.token_type} ${tokenData.access_token}` },
        });

        const userData = await userResponse.json();

        req.session.user = {
            id: userData.id,
            username: userData.username,
            avatar: userData.avatar 
                ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png`
                : `https://cdn.discordapp.com/embed/avatars/0.png`
        };

        res.redirect('/');
    } catch (err) {
        res.status(500).send("Login error: " + err.message);
    }
});

app.get('/api/me', (req, res) => {
    if (req.session && req.session.user) {
        return res.json({ authenticated: true, user: req.session.user });
    }
    return res.json({ authenticated: false });
});

app.get('/auth/logout', (req, res) => {
    req.session = null;
    res.redirect('/');
});

// API Obfuscate Endpoint
app.post('/api/obfuscate', (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ success: false, error: "You must be logged in with Discord!" });
    }

    try {
        const { script, scriptName } = req.body;
        if (!script || typeof script !== 'string' || script.trim() === '') {
            return res.status(400).json({ success: false, error: "No Luau source code provided." });
        }

        const vmPayload = compileToHardenedLuauVM(script);
        const scriptId = generateShortId();

        // Stored continuously in RAM
        scriptVault.set(scriptId, {
            ownerId: req.session.user.id,
            payload: vmPayload,
            createdAt: new Date().toLocaleString()
        });

        const loaderLink = `loadstring(game:HttpGet("${DOMAIN}/raw/${scriptId}"))()`;

        return res.json({
            success: true,
            id: scriptId,
            loader: loaderLink,
            name: scriptName.trim() || `Script_${scriptId}`,
            createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ==================== RAW ENDPOINT ====================
app.get('/raw/:id', (req, res) => {
    const id = req.params.id;
    const acceptHeader = (req.headers['accept'] || '').toLowerCase();

    const entry = scriptVault.get(id);

    if (!entry) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        return res.status(404).send(`error("[SIN SECURITY]: Script ID '${id}' not found or expired.", 0)`);
    }

    // Direct web browser access check
    const isBrowserRequest = acceptHeader.includes('text/html');

    if (isBrowserRequest) {
        res.setHeader('Content-Type', 'text/html');
        return res.status(403).send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Access Denied | SIN Obfuscator</title>
    <style>
        body { background: #060609; color: #f1f5f9; font-family: system-ui; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .lock-card { background: #0d0d14; border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 12px; padding: 2.5rem; max-width: 420px; text-align: center; }
        h1 { color: #ef4444; font-size: 1.4rem; }
        .cmd-box { background: #040406; border: 1px solid #1e293b; color: #38bdf8; padding: 0.8rem; border-radius: 8px; font-family: monospace; font-size: 0.78rem; word-break: break-all; }
    </style>
</head>
<body>
    <div class="lock-card">
        <div style="font-size:3rem;">🔒</div>
        <h1>RAW ACCESS BLOCKED</h1>
        <p style="color:#94a3b8; font-size: 0.88rem;">Direct browser viewing is disabled. Execute in Roblox:</p>
        <div class="cmd-box">loadstring(game:HttpGet("${DOMAIN}/raw/${id}"))()</div>
    </div>
</body>
</html>
        `);
    }

    // Serve raw script directly to Roblox executor
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(entry.payload);
});

// Start Express Listener
app.listen(PORT, () => console.log(`[SIN HUB] Server active on port ${PORT}`));
