const express = require('express');
const cors = require('cors');
const path = require('path');
const cookieSession = require('cookie-session');
const rateLimit = require('express-rate-limit');
const pako = require('pako');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

// Rate Limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: "Too many requests from this IP, please try again later." }
});
app.use(limiter);

const obfuscateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 15,
    message: { success: false, error: "Rate limit reached. Please wait a minute before obfuscating again." }
});

const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1535568167223562350';
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || 'gAFHKRDb9tLvxmeN7mhubHag7LOH1ttN';

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

// Lightweight cookie session
app.use(cookieSession({
    name: 'sin_session',
    keys: [process.env.SESSION_SECRET || 'sin_obfuscator_super_secret_key_123'],
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'lax'
}));

// Compress and encode script payload into a compact token
function encodePayload(payload) {
    const compressed = pako.deflate(payload);
    return Buffer.from(compressed).toString('base64url');
}

// Decode and decompress payload
function decodePayload(token) {
    try {
        const buffer = Buffer.from(token, 'base64url');
        const decompressed = pako.inflate(buffer, { to: 'string' });
        return decompressed;
    } catch (e) {
        return null;
    }
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

function getBaseUrl(req) {
    const host = req.headers['x-forwarded-host'] || req.get('host') || `localhost:${PORT}`;
    const proto = req.headers['x-forwarded-proto'] || (host.includes('localhost') ? 'http' : 'https');
    return `${proto}://${host}`;
}

// Discord Auth Routes
app.get('/auth/discord', (req, res) => {
    const baseUrl = getBaseUrl(req);
    const redirectUri = encodeURIComponent(`${baseUrl}/auth/discord/callback`);
    const discordUrl = `https://discord.com/api/oauth2/authorize?client_id=${DISCORD_CLIENT_ID}&redirect_uri=${redirectUri}&response_type=code&scope=identify`;
    
    res.redirect(discordUrl);
});

app.get('/auth/discord/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.redirect('/');

    const baseUrl = getBaseUrl(req);
    const redirectUri = `${baseUrl}/auth/discord/callback`;

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
            console.error("Discord Token Error:", tokenData);
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

// Obfuscation Endpoint - Returns ONLY the loader link
app.post('/api/obfuscate', obfuscateLimiter, (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ success: false, error: "You must be logged in with Discord!" });
    }

    try {
        const { script, scriptName } = req.body;

        if (!script || typeof script !== 'string' || script.trim() === '') {
            return res.status(400).json({ success: false, error: "No Luau source code provided." });
        }

        const vmPayload = compileToHardenedLuauVM(script);
        const loaderToken = encodePayload(vmPayload);

        const baseUrl = getBaseUrl(req);
        const loaderLink = `loadstring(game:HttpGet("${baseUrl}/v3/loader/${loaderToken}"))()`;

        return res.json({
            success: true,
            loader: loaderLink,
            name: scriptName || `Script_${loaderToken.substring(0, 6)}`,
            createdAt: new Date().toLocaleString()
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

// Loader Endpoint - Serves raw obfuscated bytecode to executors
app.get('/v3/loader/:token', (req, res) => {
    const token = req.params.token;
    const userAgent = req.headers['user-agent'] || '';

    const payload = decodePayload(token);

    if (!payload) {
        res.setHeader('Content-Type', 'text/plain');
        return res.status(404).send("LOCKED: Invalid or expired script token.");
    }

    const isBrowser = /Mozilla|Chrome|Safari|Edge|Brave|Firefox/i.test(userAgent);
    if (isBrowser) {
        res.setHeader('Content-Type', 'text/plain');
        return res.status(403).send("LOCKED: Direct browser access denied.");
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(payload);
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`SIN Obfuscator Server running on port ${PORT}`);
    });
}

module.exports = app;
