const express = require('express');
const cors = require('cors');
const cookieSession = require('cookie-session');
const pako = require('pako');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1535568167223562350';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || 'gAFHKRDb9tLvxmeN7mhubHag7LOH1ttN';
const DOMAIN = 'https://sinobfuscator.vercel.app';

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.use(cookieSession({
    name: 'sin_session',
    keys: [process.env.SESSION_SECRET || 'sin_obfuscator_super_secret_key_123'],
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'lax'
}));

function encodePayload(payload) {
    const compressed = pako.deflate(payload);
    return Buffer.from(compressed).toString('base64url');
}

function decodePayload(token) {
    try {
        const buffer = Buffer.from(token, 'base64url');
        return pako.inflate(buffer, { to: 'string' });
    } catch (e) {
        return null;
    }
}

// Injects unique salt so every obfuscation generates a unique loadstring URL
function compileToHardenedLuauVM(sourceCode) {
    const nonce = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const key = Math.floor(Math.random() * 200) + 10;
    
    // Salt source code with a unique comment block
    const saltedSource = `-- [SIN Salt: ${nonce}]\n${sourceCode}`;

    let encoded = '';
    for (let i = 0; i < saltedSource.length; i++) {
        encoded += String.fromCharCode(saltedSource.charCodeAt(i) ^ key);
    }
    const safeString = JSON.stringify(encoded);

    return `--[[ SIN Obfuscator v4.0 | Nonce: ${nonce} ]]--
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

        if (!tokenData.access_token) {
            return res.status(400).send("Authentication failed.");
        }

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

// Obfuscation Endpoint - Always generates a unique loadstring
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
        const token = encodePayload(vmPayload);
        const loaderLink = `loadstring(game:HttpGet("${DOMAIN}/raw/${token}"))()`;

        return res.json({
            success: true,
            id: `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
            loader: loaderLink,
            name: scriptName || `Script_${token.substring(0, 6)}`,
            createdAt: new Date().toLocaleString()
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Raw Endpoint for Roblox Executors
app.get('/raw/:token', (req, res) => {
    const token = req.params.token;
    const userAgent = req.headers['user-agent'] || '';

    const payload = decodePayload(token);

    if (!payload) {
        res.setHeader('Content-Type', 'text/plain');
        return res.status(404).send("-- LOCKED: Invalid or expired script token.");
    }

    const isBrowser = /Mozilla|Chrome|Safari|Edge|Brave|Firefox/i.test(userAgent);
    if (isBrowser) {
        res.setHeader('Content-Type', 'text/plain');
        return res.status(403).send("-- LOCKED: Direct browser access denied.");
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(payload);
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`SIN Obfuscator Server running on port ${PORT}`);
    });
}

module.exports = app;
