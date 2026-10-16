const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Owner Discord ID
const OWNER_DISCORD_ID = "1257596807857569793";

// GitHub Gist Configuration (Set in Vercel Environment Variables)
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const KEYS_GIST_ID = process.env.KEYS_GIST_ID;
const VAULT_GIST_ID = process.env.VAULT_GIST_ID;

// Helper to fetch data from GitHub Gist
async function getGistData(gistId, fileName) {
    if (!GITHUB_TOKEN || !gistId) return [];
    try {
        const res = await fetch(`https://api.github.com/gists/${gistId}`, {
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'User-Agent': 'Vercel-Nix6-App'
            }
        });
        const data = await res.json();
        const content = data.files[fileName]?.content;
        return content ? JSON.parse(content) : [];
    } catch (e) {
        console.error(`Error reading ${fileName} from Gist:`, e);
        return [];
    }
}

// Helper to update data in GitHub Gist
async function updateGistData(gistId, fileName, data) {
    if (!GITHUB_TOKEN || !gistId) return;
    try {
        await fetch(`https://api.github.com/gists/${gistId}`, {
            method: 'PATCH',
            headers: {
                'Authorization': `token ${GITHUB_TOKEN}`,
                'Content-Type': 'application/json',
                'User-Agent': 'Vercel-Nix6-App'
            },
            body: JSON.stringify({
                files: {
                    [fileName]: {
                        content: JSON.stringify(data, null, 2)
                    }
                }
            })
        });
    } catch (e) {
        console.error(`Error writing ${fileName} to Gist:`, e);
    }
}

// --- LURAPH-STYLE VM OBFUSCATION ENGINE ---
class LuraphEngine {
    constructor(sourceCode) {
        this.source = sourceCode;
    }

    _randomId(length = 14) {
        const charSets = [
            "I1l0O_qwertyuiopasdfghjklzxcvbnm",
            "IIllIIllIIll",
            "_0x1a_0x2b_0x3c_0x4d"
        ];
        const chars = charSets[Math.floor(Math.random() * charSets.length)];
        let res = "";
        for (let i = 0; i < length; i++) {
            res += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return /^\d/.test(res) ? "_" + res : res;
    }

    _generateOpCodes() {
        const pool = Array.from({ length: 50 }, (_, i) => (i + 1) * 17 + Math.floor(Math.random() * 9)).sort(() => Math.random() - 0.5);
        return {
            OP_GETGLOBAL: pool[0],
            OP_LOADK: pool[1],
            OP_CALL: pool[2],
            OP_RETURN: pool[3],
            OP_EXEC_CHUNK: pool[4]
        };
    }

    buildProtectedVM() {
        const op = this._generateOpCodes();
        const xorKey = Math.floor(Math.random() * 180) + 35;
        const srcBytes = Buffer.from(this.source, 'utf-8');
        const encBytes = [];

        for (let i = 0; i < srcBytes.length; i++) {
            encBytes.push(srcBytes[i] ^ xorKey);
        }

        const v_vm = this._randomId();
        const v_bytecode = this._randomId();
        const v_consts = this._randomId();
        const v_k = this._randomId();
        const v_pc = this._randomId();
        const v_reg = this._randomId();
        const v_instr = this._randomId();
        const v_op = this._randomId();
        const v_bxor = this._randomId();
        const v_decode = this._randomId();
        const v_env = this._randomId();

        const formattedBytes = '{' + encBytes.join(',') + '}';

        return `-- [[ Nix6 Security Engine v4.0 - Luraph Grade Protection ]]
local function ${v_vm}(...)
    local ${v_env} = getfenv and getfenv() or _ENV
    if debug and debug.getmetatable then
        local _meta = debug.getmetatable(${v_env})
        if _meta then while true do end end
    end

    local ${v_bxor} = bit32 and bit32.bxor or function(a, b)
        local r, p = 0, 1
        while a > 0 or b > 0 do
            local aa, bb = a % 2, b % 2
            if aa ~= bb then r = r + p end
            a, b, p = (a - aa) / 2, (b - bb) / 2, p * 2
        end
        return r
    end

    local ${v_k} = ${xorKey}
    local ${v_bytecode} = ${formattedBytes}

    local function ${v_decode}(_t, _key)
        local _out = {}
        for _i = 1, #_t do
            table.insert(_out, string.char(${v_bxor}(_t[_i], _key)))
        end
        return table.concat(_out)
    end

    local ${v_consts} = {
        [1] = ${v_decode}(${v_bytecode}, ${v_k})
    }

    local ${v_instr} = {
        {${op.OP_EXEC_CHUNK}, 1}
    }

    local ${v_reg} = {}
    local ${v_pc} = 1

    while ${v_pc} <= #${v_instr} do
        local _curr = ${v_instr}[${v_pc}]
        local ${v_op} = _curr[1]

        if ${v_op} == ${op.OP_EXEC_CHUNK} then
            local _code = ${v_consts}[_curr[2]]
            local _loader = loadstring or load
            if _loader then
                local _compiled, _err = _loader(_code)
                if _compiled then
                    return _compiled(...)
                else
                    error(_err or "VM Instruction Fault")
                end
            end
        end

        ${v_pc} = ${v_pc} + 1
    end
end
return ${v_vm}(...)`;
    }
}

// Discord OAuth2 Configuration
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || 'YOUR_DISCORD_CLIENT_ID';
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || 'YOUR_DISCORD_CLIENT_SECRET';

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(session({
    secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
    resave: false,
    saveUninitialized: false,
    cookie: { secure: process.env.NODE_ENV === 'production' }
}));

// --- MIDDLEWARE ---

function requireOwner(req, res, next) {
    if (req.session && req.session.user && req.session.user.id === OWNER_DISCORD_ID) {
        return next();
    }
    return res.status(403).json({ success: false, error: 'Forbidden: Owner access required.' });
}

async function getAuthUser(req) {
    if (req.session && req.session.user) {
        return req.session.user;
    }
    
    const apiKey = req.headers['x-api-key'] || req.headers['x-api-key'];
    if (apiKey) {
        const keys = await getGistData(KEYS_GIST_ID, 'keys.json');
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

// --- STATIC ROUTE ---

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const publicPath = path.join(__dirname, 'public');
app.use(express.static(publicPath));
app.use(express.static(__dirname));

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
        res.json({ 
            authenticated: true, 
            user: req.session.user
        });
    } else {
        res.json({ authenticated: false });
    }
});

// --- OWNER ADMIN & API KEY MANAGEMENT ENDPOINTS ---

app.post('/api/admin/generate-key', requireOwner, async (req, res) => {
    const username = req.body.username || "Client_User";
    const keys = await getGistData(KEYS_GIST_ID, 'keys.json');
    
    const newApiKey = "nix6_key_" + crypto.randomBytes(16).toString('hex');
    const keyData = { key: newApiKey, username: username, createdAt: new Date().toISOString() };
    
    keys.push(keyData);
    await updateGistData(KEYS_GIST_ID, 'keys.json', keys);

    res.json({ success: true, apiKey: newApiKey });
});

app.get('/api/admin/keys', requireOwner, async (req, res) => {
    const keys = await getGistData(KEYS_GIST_ID, 'keys.json');
    res.json({ success: true, keys });
});

app.post('/api/admin/revoke-key', requireOwner, async (req, res) => {
    const { key } = req.body;
    let keys = await getGistData(KEYS_GIST_ID, 'keys.json');
    
    keys = keys.filter(k => k.key !== key);
    await updateGistData(KEYS_GIST_ID, 'keys.json', keys);

    res.json({ success: true, message: 'Key revoked.' });
});

app.get('/api/verify-key', async (req, res) => {
    const apiKey = req.headers['x-api-key'] || req.headers['x-api-key'];
    if (!apiKey) return res.json({ authenticated: false });

    const keys = await getGistData(KEYS_GIST_ID, 'keys.json');
    const foundKey = keys.find(k => k.key === apiKey);

    if (foundKey) {
        res.json({ authenticated: true, username: foundKey.username });
    } else {
        res.json({ authenticated: false });
    }
});

// --- SCRIPT MANAGEMENT ROUTES ---

app.post('/api/obfuscate', async (req, res) => {
    const user = await getAuthUser(req);
    if (!user) {
        return res.status(401).json({ success: false, error: 'Unauthorized. Please login with Discord or API Key.' });
    }

    const { scriptPayload, scriptName, fileType, editId } = req.body;
    if (!scriptPayload) {
        return res.status(400).json({ success: false, error: 'Script payload is missing.' });
    }

    try {
        const decodedCode = Buffer.from(scriptPayload, 'base64').toString('utf8');
        
        const engine = new LuraphEngine(decodedCode);
        const obfuscatedCode = engine.buildProtectedVM();

        const hostProtocol = req.headers['x-forwarded-proto'] || req.protocol;
        const hostUrl = `${hostProtocol}://${req.get('host')}`;

        let scriptId;
        let loaderString;
        const vaultDatabase = await getGistData(VAULT_GIST_ID, 'vault.json');

        if (editId) {
            const existingScript = vaultDatabase.find(s => s.id === editId && s.ownerId === user.id);
            if (!existingScript) {
                return res.status(403).json({ success: false, error: 'Script not found or unauthorized to edit.' });
            }
            existingScript.name = scriptName || 'Untitled Script';
            existingScript.fileType = fileType || 'luau';
            existingScript.code = obfuscatedCode;
            existingScript.rawPayload = scriptPayload;
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
                code: obfuscatedCode,
                rawPayload: scriptPayload,
                loader: loaderString,
                createdAt: new Date().toLocaleDateString()
            });
        }

        await updateGistData(VAULT_GIST_ID, 'vault.json', vaultDatabase);
        res.json({ success: true, loader: loaderString, id: scriptId });
    } catch (err) {
        console.error('Obfuscation Error:', err);
        res.status(500).json({ success: false, error: 'Failed to process script deployment.' });
    }
});

app.get('/api/vault', async (req, res) => {
    const user = await getAuthUser(req);
    if (!user) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const vaultDatabase = await getGistData(VAULT_GIST_ID, 'vault.json');
    const userScripts = vaultDatabase.filter(s => s.ownerId === user.id);
    res.json({ success: true, scripts: userScripts });
});

app.post('/api/delete', async (req, res) => {
    const user = await getAuthUser(req);
    if (!user) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const { id } = req.body;
    let vaultDatabase = await getGistData(VAULT_GIST_ID, 'vault.json');
    const index = vaultDatabase.findIndex(s => s.id === id && s.ownerId === user.id);
    
    if (index !== -1) {
        vaultDatabase.splice(index, 1);
        await updateGistData(VAULT_GIST_ID, 'vault.json', vaultDatabase);
        res.json({ success: true });
    } else {
        res.status(403).json({ success: false, error: 'Script not found or unauthorized.' });
    }
});

// --- RAW HOSTING ENDPOINT ---

app.get('/raw/:id', async (req, res) => {
    const vaultDatabase = await getGistData(VAULT_GIST_ID, 'vault.json');
    const script = vaultDatabase.find(s => s.id === req.params.id);
    if (!script) return res.status(404).send('Script not found.');

    const userAgent = req.headers['user-agent'] || '';
    const isBrowser = userAgent.includes('Mozilla') || userAgent.includes('Chrome') || userAgent.includes('Safari') || userAgent.includes('Edge');

    if (isBrowser) {
        res.setHeader('Content-Type', 'text/html');
        return res.status(403).send(`
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <title>Nix6 // Access Restricted</title>
                <style>
                    body { background: #000; color: #fff; font-family: monospace; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
                    .box { border: 1px dashed #333; padding: 20px 30px; border-radius: 8px; text-align: center; }
                </style>
            </head>
            <body>
                <div class="box">
                    <h1>// ACCESS RESTRICTED</h1>
                    <p style="color:#666; font-size: 0.8rem;">This loadstring source is protected and unlisted.</p>
                </div>
            </body>
            </html>
        `);
    }

    res.setHeader('Content-Type', 'text/plain');
    res.send(script.code);
});

module.exports = app;

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`Server running locally on http://localhost:${PORT}`);
    });
}
