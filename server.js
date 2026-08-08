const express = require('express');
const cors = require('cors');
const cookieSession = require('cookie-session');
const crypto = require('crypto');
const path = require('path');

const fetch = globalThis.fetch || require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1535568167223562350';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || 'eUPsy6H-IXsQBZUDppPEIincubwPB5m5';

// Helper function: Ensures DOMAIN has no trailing slash to prevent double slashes (//)
const getCleanDomain = () => {
    const rawDomain = process.env.DOMAIN || `http://localhost:${PORT}`;
    return rawDomain.trim().replace(/\/+$/, '');
};

// ==================== IN-MEMORY VAULT ====================
// Runs 24/7 in RAM on Railway/Render
const scriptVault = new Map();

// ==================== MIDDLEWARE ====================
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname)));

app.use(cookieSession({
    name: 'sin_session',
    keys: [process.env.SESSION_SECRET || 'sin_obfuscator_super_secret_key_999'],
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 Days
    sameSite: 'lax',
    secure: false // Set to true if running strictly on HTTPS
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

// ==================== DISCORD AUTH ROUTES ====================

// Step 1: Initiate Login
app.get('/auth/discord', (req, res) => {
    try {
        const DOMAIN = getCleanDomain();
        const redirectUri = `${DOMAIN}/auth/discord/callback`;
        const discordUrl = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify`;
        return res.redirect(discordUrl);
    } catch (err) {
        return res.status(500).send("Failed to initiate Discord login: " + err.message);
    }
});

// Step 2: Callback Handler
app.get('/auth/discord/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.redirect('/');

    const DOMAIN = getCleanDomain();
    const redirectUri = `${DOMAIN}/auth/discord/callback`;

    try {
        // Token Exchange
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
        if (!tokenData.access_token) {
            console.error("[AUTH ERROR] Token exchange failed:", tokenData);
            return res.status(400).send(`Authentication failed: ${tokenData.error_description || 'Invalid Client Secret or Redirect URI'}`);
        }

        // Fetch User Info
        const userResponse = await fetch('https://discord.com/api/users/@me', {
            headers: { authorization: `${tokenData.token_type} ${tokenData.access_token}` },
        });

        const userData = await userResponse.json();

        // Store User in Cookie Session
        req.session.user = {
            id: userData.id,
            username: userData.username,
            avatar: userData.avatar 
                ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png`
                : `https://cdn.discordapp.com/embed/avatars/0.png`
        };

        res.redirect('/');
    } catch (err) {
        console.error("[AUTH ERROR] Callback Exception:", err);
        res.status(500).send("Login error: " + err.message);
    }
});

// Fetch Current Logged-in User
app.get('/api/me', (req, res) => {
    if (req.session && req.session.user) {
        return res.json({ authenticated: true, user: req.session.user });
    }
    return res.json({ authenticated: false });
});

// Logout
app.get('/auth/logout', (req, res) => {
    req.session = null;
    res.redirect('/');
});

// ==================== OBFUSCATE & VAULT API ====================

// Obfuscate Script (Requires Auth)
app.post('/api/obfuscate', (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ success: false, error: "You must be logged in with Discord to obfuscate scripts!" });
    }

    try {
        const { script, scriptName } = req.body;
        if (!script || typeof script !== 'string' || script.trim() === '') {
            return res.status(400).json({ success: false, error: "No Luau source code provided." });
        }

        const DOMAIN = getCleanDomain();
        const vmPayload = compileToHardenedLuauVM(script);
        const scriptId = generateShortId();

        const newEntry = {
            id: scriptId,
            ownerId: req.session.user.id,
            name: (scriptName || '').trim() || `Script_${scriptId}`,
            payload: vmPayload,
            createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })
        };

        // Save to RAM Vault
        scriptVault.set(scriptId, newEntry);

        const loaderLink = `loadstring(game:HttpGet("${DOMAIN}/raw/${scriptId}"))()`;

        return res.json({
            success: true,
            id: scriptId,
            loader: loaderLink,
            name: newEntry.name,
            createdAt: newEntry.createdAt
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Get User's Personal Vault
app.get('/api/vault', (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ success: false, error: "Unauthorized access." });
    }

    const userId = req.session.user.id;
    const DOMAIN = getCleanDomain();

    const userScripts = [];
    for (const [id, item] of scriptVault.entries()) {
        if (item.ownerId === userId) {
            userScripts.push({
                id: item.id,
                name: item.name,
                loader: `loadstring(game:HttpGet("${DOMAIN}/raw/${item.id}"))()`,
                createdAt: item.createdAt
            });
        }
    }

    return res.json({ success: true, scripts: userScripts });
});

// Delete Script from Vault
app.post('/api/delete', (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ success: false, error: "Unauthorized access." });
    }

    const { id } = req.body;
    const entry = scriptVault.get(id);

    if (!entry) {
        return res.status(404).json({ success: false, error: "Script not found." });
    }

    if (entry.ownerId !== req.session.user.id) {
        return res.status(403).json({ success: false, error: "You do not own this script." });
    }

    scriptVault.delete(id);
    return res.json({ success: true, message: `Script ${id} deleted.` });
});

// ==================== RAW ENDPOINT ====================
app.get('/raw/:id', (req, res) => {
    const id = req.params.id;
    const acceptHeader = (req.headers['accept'] || '').toLowerCase();
    const DOMAIN = getCleanDomain();

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

// Serve Main Site
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Start Express Listener
app.listen(PORT, () => console.log(`[SIN HUB] Server active on port ${PORT}`));
