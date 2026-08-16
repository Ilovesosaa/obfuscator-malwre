const express = require('express');
const session = require('express-session');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for Railway / HTTPS environments
app.set('trust proxy', 1);

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const DOMAIN = process.env.DOMAIN || 'https://error404obfuscator.up.railway.app';
const REDIRECT_URI = `${DOMAIN}/auth/discord/callback`;

if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("CRITICAL: DISCORD_CLIENT_ID or DISCORD_CLIENT_SECRET environment variables are missing!");
}

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(session({
    secret: process.env.SESSION_SECRET || 'error404_super_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: true, 
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000 
    }
}));

app.use(express.static(path.join(__dirname, 'public')));

let scriptVault = {};

// Auth Routes
app.get('/auth/discord', (req, res) => {
    const discordAuthUrl = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify`;
    res.redirect(discordAuthUrl);
});

app.get('/auth/discord/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('No code provided from Discord.');

    try {
        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: REDIRECT_URI,
            }),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });

        const tokenData = await tokenResponse.json();
        if (!tokenData.access_token) return res.status(400).send('Failed to acquire Discord access token.');

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

        req.session.save((err) => {
            if (err) console.error('Session save error:', err);
            res.redirect('/');
        });
    } catch (error) {
        console.error('OAuth Error:', error);
        res.status(500).send('Authentication failed.');
    }
});

app.get('/auth/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

app.get('/api/me', (req, res) => {
    if (req.session && req.session.user) {
        res.json({ authenticated: true, user: req.session.user });
    } else {
        res.json({ authenticated: false });
    }
});

// Obfuscate / Deploy API
app.post('/api/obfuscate', (req, res) => {
    if (!req.session || !req.session.user) {
        return res.json({ success: false, error: 'Unauthorized. Please login with Discord.' });
    }

    const { scriptPayload, scriptName, fileType, editId } = req.body;
    if (!scriptPayload) {
        return res.json({ success: false, error: 'Empty script payload.' });
    }

    try {
        const decodedCode = Buffer.from(scriptPayload, 'base64').toString('utf8');
        
        const obfuscatedCode = `-- [ Error404 Obfuscator Protected ]\n-- Type: ${fileType || 'luau'}\n\nreturn (function(...) local _={...};return _[1];end)("${Buffer.from(decodedCode).toString('base64')}")`;

        const scriptId = editId || Math.random().toString(36).substring(2, 9);
        
        if (!scriptVault[req.session.user.id]) {
            scriptVault[req.session.user.id] = {};
        }

        scriptVault[req.session.user.id][scriptId] = {
            id: scriptId,
            name: scriptName || 'Untitled Script',
            fileType: fileType || 'luau',
            code: obfuscatedCode,
            createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };

        const loader = `loadstring(game:HttpGet("${DOMAIN}/raw/${scriptId}"))()`;

        res.json({ success: true, loader, scriptId });
    } catch (err) {
        console.error(err);
        res.json({ success: false, error: 'Obfuscation processing failed.' });
    }
});

// Vault API
app.get('/api/vault', (req, res) => {
    if (!req.session || !req.session.user) return res.json({ success: false, scripts: [] });
    const userScripts = scriptVault[req.session.user.id] ? Object.values(scriptVault[req.session.user.id]) : [];
    res.json({ success: true, scripts: userScripts });
});

app.post('/api/delete', (req, res) => {
    if (!req.session || !req.session.user) return res.json({ success: false });
    const { id } = req.body;
    if (scriptVault[req.session.user.id] && scriptVault[req.session.user.id][id]) {
        delete scriptVault[req.session.user.id][id];
    }
    res.json({ success: true });
});

// Raw Loader Endpoint for Roblox `game:HttpGet`
app.get('/raw/:id', (req, res) => {
    const scriptId = req.params.id;
    let foundScript = null;

    for (let userId in scriptVault) {
        if (scriptVault[userId][scriptId]) {
            foundScript = scriptVault[userId][scriptId];
            break;
        }
    }

    if (foundScript) {
        res.setHeader('Content-Type', 'text/plain');
        res.send(foundScript.code);
    } else {
        res.status(404).send('-- Error404: Script not found or removed.');
    }
});

app.listen(PORT, () => {
    console.log(`Error404 Obfuscator running on port ${PORT}`);
});
