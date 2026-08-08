const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// DISCORD OAUTH2 CONFIGURATION
// ==========================================
const DISCORD_CLIENT_ID = '1535568167223562350';
const DISCORD_CLIENT_SECRET = 'cYNdYMrZNIxz6QCoGAVLD5gCnq5jlBo-';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

app.use(session({
    secret: 'sin_obfuscator_super_secret_key_123',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 Hours
}));

// Databases (In-Memory)
const scriptStore = new Map();     // Global loader payloads
const userScriptsStore = new Map(); // User Discord ID -> Array of saved scripts

/**
 * LIGHTWEIGHT VM COMPILER
 */
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

// ==========================================
// DISCORD AUTH ENDPOINTS
// ==========================================

// Login Redirect
app.get('/auth/discord', (req, res) => {
    const protocol = req.protocol || 'http';
    const host = req.get('host') || `localhost:${PORT}`;
    const redirectUri = encodeURIComponent(`${protocol}://${host}/auth/discord/callback`);
    const discordUrl = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${redirectUri}&response_type=code&scope=identify`;
    res.redirect(discordUrl);
});

// OAuth2 Callback
app.get('/auth/discord/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.redirect('/');

    const protocol = req.protocol || 'http';
    const host = req.get('host') || `localhost:${PORT}`;
    const redirectUri = `${protocol}://${host}/auth/discord/callback`;

    try {
        // Exchange code for access token
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
            return res.status(400).send("Authentication failed.");
        }

        // Fetch User Info
        const userResponse = await fetch('https://discord.com/api/users/@me', {
            headers: { authorization: `${tokenData.token_type} ${tokenData.access_token}` },
        });

        const userData = await userResponse.json();

        // Store User in Session
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

// Get Current Auth Session
app.get('/api/me', (req, res) => {
    if (req.session && req.session.user) {
        return res.json({ authenticated: true, user: req.session.user });
    }
    return res.json({ authenticated: false });
});

// Logout
app.get('/auth/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// ==========================================
// OBFUSCATION & HISTORY ENDPOINTS
// ==========================================

app.post('/api/obfuscate', (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ success: false, error: "You must be logged in with Discord!" });
    }

    try {
        const { script, scriptName } = req.body;

        if (!script || typeof script !== 'string' || script.trim() === '') {
            return res.status(400).json({ success: false, error: "No Luau source code provided." });
        }

        const loaderId = crypto.randomBytes(6).toString('hex');
        const vmPayload = compileToHardenedLuauVM(script);

        scriptStore.set(loaderId, { payload: vmPayload });

        const protocol = req.protocol || 'http';
        const host = req.get('host') || `localhost:${PORT}`;
        const loaderScript = `loadstring(game:HttpGet("${protocol}://${host}/v3/loader/${loaderId}"))()`;

        // Save to user's saved scripts list
        const userId = req.session.user.id;
        if (!userScriptsStore.has(userId)) {
            userScriptsStore.set(userId, []);
        }

        const userHistory = userScriptsStore.get(userId);
        userHistory.unshift({
            id: loaderId,
            name: scriptName || `Script_${loaderId}`,
            loader: loaderScript,
            createdAt: new Date().toLocaleString()
        });

        return res.json({
            success: true,
            loaderId: loaderId,
            loader: loaderScript
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Fetch User's Obfuscated Scripts
app.get('/api/my-scripts', (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ success: false, error: "Unauthorized" });
    }

    const userId = req.session.user.id;
    const history = userScriptsStore.get(userId) || [];
    return res.json({ success: true, scripts: history });
});

app.get('/v3/loader/:id', (req, res) => {
    const loaderId = req.params.id;
    const userAgent = req.headers['user-agent'] || '';

    const entry = scriptStore.get(loaderId);

    if (!entry) {
        res.setHeader('Content-Type', 'text/plain');
        return res.status(404).send("LOCKED: Invalid or expired script key.");
    }

    const isBrowser = /Mozilla|Chrome|Safari|Edge|Brave|Firefox/i.test(userAgent);
    if (isBrowser) {
        res.setHeader('Content-Type', 'text/plain');
        return res.status(403).send("LOCKED: Source code access denied.");
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(entry.payload);
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`SIN Obfuscator running on port ${PORT}`);
});
