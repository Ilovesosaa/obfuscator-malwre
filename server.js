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
const scriptVault = new Map(); // Stores obfuscated script code
const userVaults = new Map();  // Maps userId -> array of script meta

// EXPRESS CONFIG
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
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

// Helper to decode base64 safely supporting all UTF-8 characters
function decodeBase64Script(base64Str) {
    try {
        const binString = Buffer.from(base64Str, 'base64').toString('binary');
        const bytes = Uint8Array.from(binString, (m) => m.codePointAt(0));
        return new TextDecoder().decode(bytes);
    } catch (e) {
        return Buffer.from(base64Str, 'base64').toString('utf8');
    }
}

// ADVANCED OBFUSCATION PIPELINE (Transforms raw Luau script into protected bytecode wrapper)
function obfuscateLuauScript(rawCode) {
    // 1. Sanitize input code endings
    const cleanCode = rawCode.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

    // 2. Generate randomized obfuscation tokens & variable names
    const randKey = Math.floor(Math.random() * 899999) + 100000;
    const varEnv = '_' + crypto.randomBytes(4).toString('hex');
    const varBytes = '_' + crypto.randomBytes(4).toString('hex');
    const varDecode = '_' + crypto.randomBytes(4).toString('hex');
    const varFunc = '_' + crypto.randomBytes(4).toString('hex');

    // 3. Convert script characters into encrypted byte/number arrays
    const buffer = Buffer.from(cleanCode, 'utf-8');
    const obfuscatedBytes = [];
    for (let i = 0; i < buffer.length; i++) {
        // XOR obfuscation cipher using dynamic key
        obfuscatedBytes.push((buffer[i] ^ (randKey % 255)));
    }

    // Chunk bytes into string representation to prevent payload detection
    const chunkedBytes = obfuscatedBytes.join(',');

    // 4. Construct heavy runtime VM de-obfuscation wrapper runnable in Luau executors
    const wrapper = `-- [SIN V2 SECURE ENGINE PROTECTED]
local ${varEnv} = {${chunkedBytes}};
local function ${varDecode}()
    local ${varBytes} = {};
    for ${varFunc} = 1, #${varEnv} do
        ${varBytes}[${varFunc}] = string.char(bit32.bxor(${varEnv}[${varFunc}], ${randKey % 255}));
    end;
    return table.concat(${varBytes});
end;
local success, result = pcall(function()
    return loadstring(${varDecode}())();
end);
if not success then
    warn("[SIN] Execution Fault: " .. tostring(result));
end;`;

    return wrapper;
}

// SCRIPT VAULT DEPLOYMENT & OBFUSCATION API (Requires Authentication)
app.post('/api/obfuscate', (req, res) => {
    try {
        if (!req.isAuthenticated()) {
            return res.status(401).json({ success: false, error: 'You must be signed in with Discord to deploy scripts.' });
        }

        const { scriptPayload, scriptName, fileType, editId } = req.body;

        if (!scriptPayload || typeof scriptPayload !== 'string') {
            return res.status(400).json({ success: false, error: 'No script payload provided.' });
        }

        const rawScript = decodeBase64Script(scriptPayload);

        if (!rawScript || !rawScript.trim()) {
            return res.status(400).json({ success: false, error: 'Decoded script is empty.' });
        }

        // Apply real backend obfuscation
        const finalProtectedScript = obfuscateLuauScript(rawScript);

        const type = (fileType === 'luau') ? 'luau' : 'lua';
        const name = (scriptName && scriptName.trim()) ? scriptName.trim() : `Script_${Date.now().toString().slice(-4)}`;
        const domain = process.env.DOMAIN || `${req.protocol}://${req.get('host')}`;

        let scriptId = editId;

        if (scriptId && scriptVault.has(scriptId)) {
            const existingItem = scriptVault.get(scriptId);
            if (existingItem.owner !== req.user.id) {
                return res.status(403).json({ success: false, error: 'Unauthorized to edit this script.' });
            }

            existingItem.code = finalProtectedScript;
            scriptVault.set(scriptId, existingItem);

            const loader = `loadstring(game:HttpGet("${domain}/raw/${scriptId}"))()`;

            const userId = req.user.id;
            const userList = userVaults.get(userId) || [];
            const meta = userList.find(s => s.id === scriptId);
            if (meta) {
                meta.name = name;
                meta.loader = loader;
                meta.code = finalProtectedScript;
            }
            userVaults.set(userId, userList);

            return res.json({ success: true, loader, scriptId });
        }

        scriptId = crypto.randomBytes(8).toString('hex');
        const loader = `loadstring(game:HttpGet("${domain}/raw/${scriptId}"))()`;

        scriptVault.set(scriptId, {
            code: finalProtectedScript,
            owner: req.user.id,
            createdAt: new Date()
        });

        const userId = req.user.id;
        if (!userVaults.has(userId)) userVaults.set(userId, []);
        userVaults.get(userId).push({
            id: scriptId,
            name: name,
            fileType: type,
            loader: loader,
            code: finalProtectedScript,
            createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });

        return res.json({ success: true, loader, scriptId });

    } catch (err) {
        console.error("Vault storage error:", err);
        return res.status(500).json({ success: false, error: 'Server error: ' + err.message });
    }
});

// RAW SCRIPT EXECUTION ENDPOINT (Universal Executor Support & Browser Black Screen)
app.get('/raw/:id', (req, res) => {
    const item = scriptVault.get(req.params.id);
    if (!item) {
        return res.status(404).send('-- Script expired or invalid loader ID.');
    }

    const userAgent = (req.headers['user-agent'] || '').toLowerCase();
    const isStandardBrowser = 
        (userAgent.includes('mozilla') || userAgent.includes('chrome') || userAgent.includes('safari') || userAgent.includes('edge')) &&
        !userAgent.includes('roblox') && 
        !userAgent.includes('executor') &&
        !userAgent.includes('dalvik') && 
        !userAgent.includes('mobile');

    if (isStandardBrowser) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(`<!DOCTYPE html><html><head><title></title><style>body{background:#000;margin:0;height:100vh;}</style></head><body></body></html>`);
    }

    let sanitizedCode = item.code
        .replace(/^\uFEFF/, '')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(sanitizedCode);
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
    console.log(`[SIN] Loader Host & Obfuscation Engine operational on port ${PORT}`);
});
