const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Discord OAuth2 Configuration (Replace with your actual Discord Bot/App credentials or environment variables)
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || 'YOUR_DISCORD_CLIENT_ID';
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || 'YOUR_DISCORD_CLIENT_SECRET';
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI || 'http://localhost:3000/auth/discord/callback';

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(session({
    secret: crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Set to true if using HTTPS in production
}));

// In-memory Database for scripts
// Structure: { id, ownerId, ownerName, name, fileType, code, loader, createdAt }
let vaultDatabase = [];

// Serve static frontend files
app.use(express.static(path.join(__dirname)));

// --- AUTHENTICATION ROUTES ---

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
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: REDIRECT_URI,
            }),
        });

        const tokenData = await tokenResponse.json();
        if (!tokenData.access_token) return res.status(400).send('Failed to obtain access token from Discord.');

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

// --- API & SCRIPT MANAGEMENT ROUTES ---

app.post('/api/obfuscate', (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ success: false, error: 'Unauthorized. Please login with Discord.' });
    }

    const { scriptPayload, scriptName, fileType, editId } = req.body;
    if (!scriptPayload) {
        return res.status(400).json({ success: false, error: 'Script payload is missing.' });
    }

    try {
        // Decode base64 payload safely
        const decodedCode = Buffer.from(scriptPayload, 'base64').toString('utf8');
        const hostProtocol = req.headers['x-forwarded-proto'] || req.protocol;
        const hostUrl = `${hostProtocol}://${req.get('host')}`;

        let scriptId;
        let loaderString;

        if (editId) {
            // Edit existing script if owned by user
            const existingScript = vaultDatabase.find(s => s.id === editId && s.ownerId === req.session.user.id);
            if (!existingScript) {
                return res.status(403).json({ success: false, error: 'Script not found or unauthorized to edit.' });
            }
            existingScript.name = scriptName || 'Untitled Script';
            existingScript.fileType = fileType || 'luau';
            existingScript.code = decodedCode;
            scriptId = existingScript.id;
            loaderString = existingScript.loader;
        } else {
            // Create new script entry
            scriptId = crypto.randomBytes(6).toString('hex');
            const rawLink = `${hostUrl}/raw/${scriptId}`;
            loaderString = `loadstring(game:HttpGet("${rawLink}"))()`;

            vaultDatabase.push({
                id: scriptId,
                ownerId: req.session.user.id,
                ownerName: req.session.user.username,
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
    if (!req.session.user) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    // Return only scripts owned by the logged-in user
    const userScripts = vaultDatabase.filter(s => s.ownerId === req.session.user.id);
    res.json({ success: true, scripts: userScripts });
});

app.post('/api/delete', (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { id } = req.body;
    const index = vaultDatabase.findIndex(s => s.id === id && s.ownerId === req.session.user.id);
    
    if (index !== -1) {
        vaultDatabase.splice(index, 1);
        res.json({ success: true });
    } else {
        res.status(403).json({ success: false, error: 'Script not found or unauthorized.' });
    }
});

// --- SECURE RAW HOSTING ENDPOINT ---

app.get('/raw/:id', (req, res) => {
    const script = vaultDatabase.find(s => s.id === req.params.id);
    if (!script) return res.status(404).send('Script not found.');

    const userAgent = req.headers['user-agent'] || '';
    
    // Check if the request is from a standard web browser vs a Roblox exploit executor client
    const isBrowser = userAgent.includes('Mozilla') || userAgent.includes('Chrome') || userAgent.includes('Safari') || userAgent.includes('Edge');

    if (isBrowser) {
        // Return a secure black screen / access restricted panel for web visitors
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

    // Serve clean raw code for Roblox executors
    res.setHeader('Content-Type', 'text/plain');
    res.send(script.code);
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
