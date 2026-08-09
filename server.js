require('dotenv').config();
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// IN-MEMORY STORAGE (RAM VAULT)
const scriptVault = new Map(); // Stores raw/obfuscated script code
const userVaults = new Map();  // Maps userId -> array of script meta

// EXPRESS CONFIG
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// TRUST PROXY
app.set('trust proxy', 1);

// SESSION CONFIG
app.use(session({
    secret: process.env.SESSION_SECRET || 'sin_obfuscator_default_secret_key',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000
    }
}));

// PASSPORT DISCORD AUTH SETUP
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

passport.use(new DiscordStrategy({
    clientID: process.env.DISCORD_CLIENT_ID,
    clientSecret: process.env.DISCORD_CLIENT_SECRET,
    callbackURL: `${process.env.DOMAIN || 'http://localhost:3000'}/auth/discord/callback`,
    scope: ['identify']
}, (accessToken, refreshToken, profile, done) => {
    return done(null, profile);
}));

app.use(passport.initialize());
app.use(passport.session());

// AUTH ROUTES
app.get('/auth/discord', passport.authenticate('discord'));

app.get('/auth/discord/callback', passport.authenticate('discord', {
    failureRedirect: '/'
}), (req, res) => {
    res.redirect('/');
});

app.get('/auth/logout', (req, res) => {
    req.logout(() => {
        res.redirect('/');
    });
});

app.get('/api/me', (req, res) => {
    if (req.isAuthenticated()) {
        const avatar = req.user.avatar 
            ? `https://cdn.discordapp.com/avatars/${req.user.id}/${req.user.avatar}.png`
            : `https://cdn.discordapp.com/embed/avatars/${(req.user.discriminator || '0') % 5}.png`;
        return res.json({
            authenticated: true,
            user: {
                id: req.user.id,
                username: req.user.username,
                avatar: avatar
            }
        });
    }
    res.json({ authenticated: false });
});

// SCRIPT VAULT DEPLOYMENT & CREATION API
app.post('/api/obfuscate', (req, res) => {
    try {
        const { script, scriptName, fileType, editId } = req.body;

        if (!script || typeof script !== 'string' || !script.trim()) {
            return res.status(400).json({ success: false, error: 'No script code provided.' });
        }

        const type = (fileType === 'luau') ? 'luau' : 'lua';
        const name = (scriptName && scriptName.trim()) ? scriptName.trim() : `Script_${Date.now().toString().slice(-4)}`;
        const domain = process.env.DOMAIN || `${req.protocol}://${req.get('host')}`;

        let scriptId = editId;

        // If editing an existing script, update it instead of creating a new entry
        if (scriptId && scriptVault.has(scriptId)) {
            const existingItem = scriptVault.get(scriptId);
            if (req.isAuthenticated() && existingItem.owner !== req.user.id) {
                return res.status(403).json({ success: false, error: 'Unauthorized to edit this script.' });
            }

            existingItem.code = script;
            scriptVault.set(scriptId, existingItem);

            const loader = `loadstring(game:HttpGet("${domain}/raw/${scriptId}"))()`;

            if (req.isAuthenticated()) {
                const userId = req.user.id;
                const userList = userVaults.get(userId) || [];
                const meta = userList.find(s => s.id === scriptId);
                if (meta) {
                    meta.name = name;
                    meta.loader = loader;
                }
                userVaults.set(userId, userList);
            }

            return res.json({ success: true, loader, scriptId });
        }

        // Otherwise, create a new script entry
        scriptId = crypto.randomBytes(8).toString('hex');
        const loader = `loadstring(game:HttpGet("${domain}/raw/${scriptId}"))()`;

        scriptVault.set(scriptId, {
            code: script,
            owner: req.isAuthenticated() ? req.user.id : null,
            createdAt: new Date()
        });

        if (req.isAuthenticated()) {
            const userId = req.user.id;
            if (!userVaults.has(userId)) userVaults.set(userId, []);
            userVaults.get(userId).push({
                id: scriptId,
                name: name,
                fileType: type,
                loader: loader,
                code: script,
                createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
        }

        return res.json({ success: true, loader, scriptId });

    } catch (err) {
        console.error("Vault storage error:", err);
        return res.status(500).json({ success: false, error: 'Server error: ' + err.message });
    }
});

// RAW SCRIPT EXECUTION ENDPOINT (Roblox game:HttpGet target)
app.get('/raw/:id', (req, res) => {
    const item = scriptVault.get(req.params.id);
    if (!item) {
        return res.status(404).send('-- Script expired or invalid loader ID.');
    }
    res.setHeader('Content-Type', 'text/plain');
    res.send(item.code);
});

// USER VAULT API
app.get('/api/vault', (req, res) => {
    if (!req.isAuthenticated()) {
        return res.json({ success: false, error: 'Unauthenticated' });
    }
    const scripts = userVaults.get(req.user.id) || [];
    res.json({ success: true, scripts: scripts });
});

// DELETE SCRIPT API
app.post('/api/delete', (req, res) => {
    if (!req.isAuthenticated()) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { id } = req.body;
    scriptVault.delete(id);

    const userList = userVaults.get(req.user.id) || [];
    const updated = userList.filter(s => s.id !== id);
    userVaults.set(req.user.id, updated);

    res.json({ success: true });
});

app.use('/api/*', (req, res) => {
    res.status(404).json({ success: false, error: 'API endpoint not found.' });
});

app.use((err, req, res, next) => {
    console.error("Server Error:", err);
    res.status(500).json({ success: false, error: err.message || 'Internal server error.' });
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`[SIN] Loader Host Engine operational on port ${PORT}`);
});
