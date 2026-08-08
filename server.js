const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Bulletproof path resolution for Vercel serverless environments
const publicPath = fs.existsSync(path.join(__dirname, 'public'))
    ? path.join(__dirname, 'public')
    : path.join(process.cwd(), 'public');

app.use(express.static(publicPath));

app.use(session({
    secret: process.env.SESSION_SECRET || 'fallback-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 7 * 24 * 60 * 60 * 1000
    }
}));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.get('/', (req, res) => {
    const indexPath = path.join(publicPath, 'index.html');
    if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
    } else {
        res.status(404).send("Error: index.html not found in deployment bundle.");
    }
});

// Discord Authentication Routes
app.get('/auth/discord', (req, res) => {
    const redirectUri = encodeURIComponent(`https://sinobfuscator.vercel.app/auth/discord/callback`);
    const discordUrl = `https://discord.com/api/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&redirect_uri=${redirectUri}&response_type=code&scope=identify`;
    res.redirect(discordUrl);
});

app.get('/auth/discord/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.redirect('/');

    const redirectUri = `https://sinobfuscator.vercel.app/auth/discord/callback`;

    try {
        const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            body: new URLSearchParams({
                client_id: process.env.DISCORD_CLIENT_ID,
                client_secret: process.env.DISCORD_CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: redirectUri,
            }),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });

        const tokenData = await tokenResponse.json();

        if (!tokenData.access_token) {
            console.error("Discord Token Error Response:", tokenData);
            return res.status(400).send("Authentication failed: " + JSON.stringify(tokenData));
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
    req.session.destroy(() => {
        res.redirect('/');
    });
});

// Script Vault API Routes
app.post('/api/save-script', async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: "You must be logged in with Discord to save scripts." });
    }

    const { scriptName, scriptContent } = req.body;
    const discordId = req.session.user.id;

    if (!scriptName || !scriptContent) {
        return res.status(400).json({ error: "Script name and content are required." });
    }

    try {
        const query = `INSERT INTO saved_scripts (discord_id, script_name, script_content) VALUES ($1, $2, $3) RETURNING *`;
        const values = [discordId, scriptName, scriptContent];
        const result = await pool.query(query, values);
        
        res.json({ success: true, saved: result.rows[0] });
    } catch (err) {
        console.error("Database Save Error:", err);
        res.status(500).json({ error: "Failed to save script to vault." });
    }
});

app.get('/api/my-scripts', async (req, res) => {
    if (!req.session || !req.session.user) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    try {
        const query = `SELECT id, script_name, script_content, created_at FROM saved_scripts WHERE discord_id = $1 ORDER BY created_at DESC`;
        const result = await pool.query(query, [req.session.user.id]);
        
        res.json({ scripts: result.rows });
    } catch (err) {
        console.error("Database Fetch Error:", err);
        res.status(500).json({ error: "Failed to load scripts." });
    }
});

// Roblox Loadstring Loader Route
app.get('/v3/loader/:id', async (req, res) => {
    const scriptId = req.params.id;

    try {
        const query = `SELECT script_content FROM saved_scripts WHERE id = $1`;
        const result = await pool.query(query, [scriptId]);

        if (result.rows.length === 0) {
            return res.status(404).send("-- Error: Script not found in vault.");
        }

        res.setHeader('Content-Type', 'text/plain');
        res.send(result.rows[0].script_content);
    } catch (err) {
        console.error("Loader Error:", err);
        res.status(500).send("-- Error: Failed to load script.");
    }
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
}

module.exports = app;
