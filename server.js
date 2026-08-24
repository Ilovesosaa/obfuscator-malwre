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
    res.sendFile(path.join(__dirname, 'index.html'));
});

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
    
    const newApiKey = "err404_key_" + crypto.randomBytes(16).toString('hex');
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
            existingScript.code = decodedCode;
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
                code: decodedCode,
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

// --- RAW HOSTING ENDPOINT ---

app.get('/raw/:id', (req, res) => {
    const script = vaultDatabase.find(s => s.id === req.params.id);
    if (!script) return res.status(404).send('Script not found.');

    const userAgent = req.headers['user-agent'] || '';
    const isBrowser = userAgent.includes('Mozilla') || userAgent.includes('Chrome') || userAgent.includes('Safari') || userAgent.includes('Edge');

    if (isBrowser) {
        res.setHeader('Content-Type', 'text/html');
        return res.send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <title>Error404 | Secured Loadstring</title>
                <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
                <style>
                    body {
                        background-color: #050805;
                        color: #00ff66;
                        font-family: 'JetBrains Mono', monospace;
                        height: 100vh;
                        display: flex;
                        justify-content: center;
                        align-items: center;
                        margin: 0;
                        overflow: hidden;
                    }
                    .vault-box {
                        border: 1px dashed #00ff6655;
                        padding: 30px;
                        border-radius: 8px;
                        background: #0a120a;
                        text-align: center;
                        box-shadow: 0 0 30px rgba(0, 255, 102, 0.1);
                    }
                    h1 { font-size: 1.1rem; margin-bottom: 10px; letter-spacing: 2px; }
                    p { font-size: 0.8rem; color: #609060; }
                </style>
            </head>
            <body>
                <div class="vault-box">
                    <h1>// ACCESS RESTRICTED //</h1>
                    <p>This loadstring source is protected and unlisted.</p>
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
