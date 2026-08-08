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
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || 'gAFHKRDb9tLvxmeN7mhubHag7LOH1ttN';
const DOMAIN = 'https://sinobfuscator.vercel.app';

// In-memory script storage
const scriptVault = new Map();

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

function compileToHardenedLuauVM(sourceCode) {
    const key = Math.floor(Math.random() * 200) + 10;
    let encoded = '';
    for (let i = 0; i < sourceCode.length; i++) {
        encoded += String.fromCharCode(sourceCode.charCodeAt(i) ^ key);
    }
    const safeString = JSON.stringify(encoded);

    return `--[[ SIN Obfuscator v4.0 ]]--
return (function(...)
    local _k = ${key}
    local _str = ${safeString}
    local _char = string.char
    if type(_str) ~= "string" then return end

    local _buf = {}
    local _sub = string.sub
    local _byte = string.byte
    local _len = #_str

    for i = 1, _len do
        _buf[i] = _char(bit32 and bit32.bxor(_byte(_sub(_str, i, i)), _k) or (_byte(_sub(_str, i, i)) ~ _k))
    end

    local _code = table.concat(_buf)
    local _f, _e = loadstring(_code)
    if _f then return _f(...) else error("[SIN Runtime Error]: " .. tostring(_e), 0) end
end)(...);`;
}

// ==================== ROUTES ====================

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Auth Routes
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

// Create Obfuscated Script (Supports Optional Password)
app.post('/api/obfuscate', (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ success: false, error: "You must be logged in with Discord!" });
    }

    try {
        const { script, scriptName, password } = req.body;
        if (!script || typeof script !== 'string' || script.trim() === '') {
            return res.status(400).json({ success: false, error: "No Luau source code provided." });
        }

        const vmPayload = compileToHardenedLuauVM(script);
        const scriptId = generateShortId();

        scriptVault.set(scriptId, {
            ownerId: req.session.user.id,
            payload: vmPayload,
            password: password ? password.trim() : null,
            createdAt: new Date().toLocaleString()
        });

        // If password is set, append ?key= to loader link for Roblox
        const passQuery = password ? `?key=${encodeURIComponent(password.trim())}` : '';
        const loaderLink = `loadstring(game:HttpGet("${DOMAIN}/raw/${scriptId}${passQuery}"))()`;

        return res.json({
            success: true,
            id: scriptId,
            loader: loaderLink,
            name: scriptName.trim() || `Script_${scriptId}`,
            hasPassword: !!password,
            createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/delete', (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ success: false, error: "Unauthorized access." });
    }

    const { id } = req.body;
    if (!id) return res.status(400).json({ success: false, error: "Missing script ID." });

    if (scriptVault.has(id)) {
        scriptVault.delete(id);
    }

    return res.json({ success: true, message: `Script ${id} deleted successfully.` });
});

// ==================== RAW ENDPOINT WITH PASSWORD GATEWAY ====================

function renderPasswordPage(scriptId, errorMsg = '') {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Protected Script | SIN Obfuscator</title>
    <style>
        body {
            background: #060608;
            color: #f8fafc;
            font-family: system-ui, -apple-system, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
        }
        .box {
            background: rgba(15, 15, 21, 0.9);
            border: 1px solid rgba(239, 68, 68, 0.3);
            border-radius: 14px;
            padding: 2.5rem;
            width: 100%;
            max-width: 380px;
            text-align: center;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.8);
        }
        h2 { margin-bottom: 0.5rem; font-size: 1.4rem; color: #ef4444; }
        p { color: #94a3b8; font-size: 0.88rem; margin-bottom: 1.5rem; }
        input {
            width: 100%;
            padding: 0.8rem;
            background: #0a0a0f;
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 8px;
            color: #fff;
            margin-bottom: 1rem;
            box-sizing: border-box;
            outline: none;
        }
        input:focus { border-color: #ef4444; }
        button {
            width: 100%;
            padding: 0.8rem;
            background: #ef4444;
            color: #fff;
            border: none;
            border-radius: 8px;
            font-weight: bold;
            cursor: pointer;
            transition: background 0.2s;
        }
        button:hover { background: #dc2626; }
        .error { color: #f87171; font-size: 0.8rem; margin-bottom: 1rem; }
    </style>
</head>
<body>
    <div class="box">
        <h2>🔒 Protected Script</h2>
        <p>This obfuscated script requires a password to view.</p>
        ${errorMsg ? `<div class="error">${errorMsg}</div>` : ''}
        <form method="POST" action="/raw/${scriptId}">
            <input type="password" name="password" placeholder="Enter Script Password" required autofocus />
            <button type="submit">Unlock Script</button>
        </form>
    </div>
</body>
</html>`;
}

// GET Route (Handles Browser & Roblox HttpGet)
app.get('/raw/:id', (req, res) => {
    const id = req.params.id;
    const providedKey = req.query.key || req.query.password;
    const userAgent = req.headers['user-agent'] || '';

    const entry = scriptVault.get(id);

    if (!entry) {
        res.setHeader('Content-Type', 'text/plain');
        return res.status(404).send("-- LOCKED: Script ID not found, expired, or deleted.");
    }

    const isBrowser = /Mozilla|Chrome|Safari|Edge|Brave|Firefox/i.test(userAgent);

    // If password exists for script
    if (entry.password) {
        if (providedKey !== entry.password) {
            if (isBrowser) {
                // Show password input page for browser users
                return res.status(401).send(renderPasswordPage(id, providedKey ? "Incorrect Password" : ""));
            } else {
                // Deny Roblox if key query param is missing/incorrect
                res.setHeader('Content-Type', 'text/plain');
                return res.status(401).send("-- ERROR: Invalid or missing script password key.");
            }
        }
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(entry.payload);
});

// POST Route (Handles HTML Password Form submission from browser)
app.post('/raw/:id', (req, res) => {
    const id = req.params.id;
    const submittedPassword = req.body.password;

    const entry = scriptVault.get(id);

    if (!entry) {
        return res.status(404).send(renderPasswordPage(id, "Script not found."));
    }

    if (entry.password && submittedPassword !== entry.password) {
        return res.status(401).send(renderPasswordPage(id, "Incorrect Password!"));
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(entry.payload);
});

if (require.main === module) {
    app.listen(PORT, () => console.log(`[SIN HUB] Server active on port ${PORT}`));
}

module.exports = app;
