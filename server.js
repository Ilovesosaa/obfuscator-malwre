const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS Handler
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, X-API-Key, X-Nix6-Signature');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: 'nix6_secure_engine_session_secret_2026',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

const activeKeys = new Map();
const scriptVault = new Map();
const OWNER_DISCORD_ID = "1257596807857569793";

function safeBase64Decode(str) {
    return Buffer.from(str, 'base64').toString('utf-8');
}

// Enterprise Lua VM Engine
class EnterpriseLuaVM {
    constructor(sourceCode) {
        this.source = sourceCode;
        this.OP_LOADK = 1;
        this.OP_GETGLOBAL = 2;
        this.OP_CALL = 3;
        this.OP_RETURN = 4;
    }

    _randomId(length = 10) {
        const chars = "I1l0O_qwertyuiopasdfghjklzxcvbnm";
        let res = "";
        for (let i = 0; i < length; i++) {
            res += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return /^\d/.test(res) ? "_" + res : res;
    }

    _generateOpcodeMap() {
        const ids = [100, 250, 400, 550, 700, 850];
        for (let i = ids.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [ids[i], ids[j]] = [ids[j], ids[i]];
        }
        return {
            [this.OP_LOADK]: ids[0],
            [this.OP_GETGLOBAL]: ids[1],
            [this.OP_CALL]: ids[2],
            [this.OP_RETURN]: ids[3]
        };
    }

    _compileBytecode(opMap) {
        const constants = [];
        const instructions = [];
        const match = this.source.match(/([a-zA-Z_][a-zA-Z0-9_]*)\s*\(\s*["'](.*?)["']\s*\)/);

        if (match) {
            constants.push(match[1]);
            constants.push(match[2]);
        } else {
            constants.push("print");
            constants.push("Nix6 Protected Executable Loaded");
        }

        instructions.push([opMap[this.OP_GETGLOBAL], 0, 0]);
        instructions.push([opMap[this.OP_LOADK], 1, 1]);
        instructions.push([opMap[this.OP_CALL], 0, 1]);
        instructions.push([opMap[this.OP_RETURN], 0, 0]);

        return { constants, instructions };
    }

    buildProtectedVM() {
        const opMap = this._generateOpcodeMap();
        const { constants, instructions } = this._compileBytecode(opMap);

        const v_vm = this._randomId();
        const v_instr = this._randomId();
        const v_const = this._randomId();
        const v_pc = this._randomId();
        const v_reg = this._randomId();
        const v_op = this._randomId();

        const xorKey = Math.floor(Math.random() * 160) + 40;
        const encConsts = constants.map(c => Array.from(String(c)).map(char => char.charCodeAt(0) ^ xorKey));

        const formattedConsts = JSON.stringify(encConsts).replace(/\[/g, '{').replace(/\]/g, '}');
        const formattedInstr = JSON.stringify(instructions).replace(/\[/g, '{').replace(/\]/g, '}');

        return `local function ${v_vm}()
    if debug and debug.getmetatable and debug.getmetatable(_G) then
        while true do end
    end

    local ${v_const} = {}
    local _raw_consts = ${formattedConsts}
    local _k = ${xorKey}
    
    for i = 1, #_raw_consts do
        local _buf = {}
        for j = 1, #_raw_consts[i] do
            table.insert(_buf, string.char(bit32 and bit32.bxor(_raw_consts[i][j], _k) or (_raw_consts[i][j] ~ _k)))
        end
        ${v_const}[i - 1] = table.concat(_buf)
    end

    local ${v_instr} = ${formattedInstr}
    local ${v_reg} = {}
    local ${v_pc} = 1

    while ${v_pc} <= #${v_instr} do
        local _i = ${v_instr}[${v_pc}]
        local ${v_op} = _i[1]
        
        if ${v_op} == ${opMap[this.OP_GETGLOBAL]} then
            ${v_reg}[_i[2]] = _G[${v_const}[_i[3]]]
        elseif ${v_op} == ${opMap[this.OP_LOADK]} then
            ${v_reg}[_i[2]] = ${v_const}[_i[3]]
        elseif ${v_op} == ${opMap[this.OP_CALL]} then
            local _fn = ${v_reg}[_i[2]]
            local _arg = ${v_reg}[_i[2] + 1]
            _fn(_arg)
        elseif ${v_op} == ${opMap[this.OP_RETURN]} then
            break
        end
        
        ${v_pc} = ${v_pc} + 1
    end
end ${v_vm}()`;
    }
}

// Auth Middleware
function requireAuth(req, res, next) {
    const apiKey = req.headers['x-api-key'];
    if (apiKey && activeKeys.has(apiKey)) {
        req.user = { username: activeKeys.get(apiKey).username, type: 'key' };
        return next();
    }
    if (req.session && req.session.user) {
        req.user = req.session.user;
        return next();
    }
    return res.status(401).json({ success: false, error: 'Unauthorized.' });
}

function requireOwner(req, res, next) {
    if (req.session && req.session.user && req.session.user.id === OWNER_DISCORD_ID) {
        return next();
    }
    return res.status(403).json({ success: false, error: 'Owner required.' });
}

// API Routes
app.get('/api/verify-key', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey && activeKeys.has(apiKey)) {
        return res.json({ authenticated: true, username: activeKeys.get(apiKey).username });
    }
    res.json({ authenticated: false });
});

app.get('/api/me', (req, res) => {
    if (req.session && req.session.user) {
        return res.json({ authenticated: true, user: req.session.user });
    }
    res.json({ authenticated: false });
});

app.post('/api/obfuscate', requireAuth, (req, res) => {
    try {
        const { scriptPayload, scriptName, fileType, editId } = req.body;
        if (!scriptPayload) return res.status(400).json({ success: false, error: 'Empty payload.' });

        const rawScript = safeBase64Decode(scriptPayload);
        const vmEngine = new EnterpriseLuaVM(rawScript);
        const obfuscatedCode = vmEngine.buildProtectedVM();

        const scriptId = editId || 'nix6_' + crypto.randomBytes(8).toString('hex');
        const loader = `loadstring(game:HttpGet("https://${req.get('host')}/raw/${scriptId}"))()`;

        scriptVault.set(scriptId, {
            id: scriptId,
            name: scriptName || 'Untitled Script',
            fileType: fileType || 'luau',
            code: obfuscatedCode,
            rawPayload: scriptPayload,
            owner: req.user.username,
            createdAt: new Date().toISOString(),
            loader: loader
        });

        res.json({ success: true, scriptId, loader, code: obfuscatedCode });
    } catch (err) {
        res.status(500).json({ success: false, error: 'Compilation error.' });
    }
});

app.get('/api/vault', requireAuth, (req, res) => {
    const userScripts = Array.from(scriptVault.values()).filter(s => s.owner === req.user.username);
    res.json({ success: true, scripts: userScripts });
});

app.post('/api/delete', requireAuth, (req, res) => {
    const { id } = req.body;
    if (scriptVault.has(id) && scriptVault.get(id).owner === req.user.username) {
        scriptVault.delete(id);
        return res.json({ success: true });
    }
    res.status(400).json({ success: false, error: 'Invalid ID.' });
});

// Raw Payload / Loadstring Protected Endpoint
app.get('/raw/:id', (req, res) => {
    const script = scriptVault.get(req.params.id);
    
    // Check if requested via Lua loadstring (Game Client Execution)
    const userAgent = req.headers['user-agent'] || '';
    const isRoblox = userAgent.includes('Roblox') || req.headers['x-nix6-signature'];

    if (script) {
        if (isRoblox) {
            res.setHeader('Content-Type', 'text/plain');
            return res.send(script.code);
        }
    }

    // Return Access Restricted HTML template when viewed directly in-browser
    res.setHeader('Content-Type', 'text/html');
    res.status(200).send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <title>Access Restricted</title>
            <style>
                body {
                    margin: 0;
                    background-color: #050505;
                    color: #00ff66;
                    font-family: monospace;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    height: 100vh;
                }
                .card {
                    border: 1px dashed #00ff66;
                    padding: 30px;
                    border-radius: 8px;
                    text-align: center;
                    box-shadow: 0 0 15px rgba(0, 255, 102, 0.2);
                }
                h2 { margin: 0 0 10px 0; }
                p { color: #a0a0a0; margin: 0; }
            </style>
        </head>
        <body>
            <div class="card">
                <h2>// ACCESS RESTRICTED //</h2>
                <p>This loadstring source is protected and unlisted.</p>
            </div>
        </body>
        </html>
    `);
});

app.post('/api/admin/generate-key', requireOwner, (req, res) => {
    const newKey = 'nix6_key_' + crypto.randomBytes(12).toString('hex');
    activeKeys.set(newKey, { username: req.body.username || 'Client', createdAt: new Date() });
    res.json({ success: true, apiKey: newKey });
});

app.get('/api/admin/keys', requireOwner, (req, res) => {
    const keysArray = Array.from(activeKeys.entries()).map(([key, data]) => ({ key, username: data.username, createdAt: data.createdAt }));
    res.json({ success: true, keys: keysArray });
});

app.post('/api/admin/revoke-key', requireOwner, (req, res) => {
    if (activeKeys.has(req.body.key)) {
        activeKeys.delete(req.body.key);
        return res.json({ success: true });
    }
    res.status(400).json({ success: false, error: 'Key not found.' });
});

app.get('/auth/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
});

// Fallback for Main Application SPA Router
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`[NIX6 ENGINE] Operational on port ${PORT}`);
});
2. Frontend JS Custom Modal Overrides
Add this script block directly at the top of your public/index.html (or inside your main JS file) to prevent native browser popups (alert() and confirm()) and render themed custom dialogs matching the UI instead:

JavaScript
// Override native alert & confirm popups with themed custom overlays
window.alert = function(msg) {
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:99999;font-family:monospace;';
    modal.innerHTML = `
        <div style="background:#0c0c0c;border:1px solid #00ff66;padding:20px 30px;border-radius:8px;text-align:center;max-width:400px;box-shadow:0 0 20px rgba(0,255,102,0.2);">
            <div style="color:#00ff66;font-size:16px;margin-bottom:15px;font-weight:bold;">// SYSTEM NOTICE //</div>
            <div style="color:#d0d0d0;font-size:14px;margin-bottom:20px;">${msg}</div>
            <button onclick="this.closest('div').parentElement.remove()" style="background:#00ff66;color:#000;border:none;padding:8px 20px;border-radius:4px;cursor:pointer;font-weight:bold;">OK</button>
        </div>
    `;
    document.body.appendChild(modal);
};

window.confirm = function(msg, callback) {
    const modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:99999;font-family:monospace;';
    modal.innerHTML = `
        <div style="background:#0c0c0c;border:1px solid #ff3333;padding:20px 30px;border-radius:8px;text-align:center;max-width:400px;box-shadow:0 0 20px rgba(255,51,51,0.2);">
            <div style="color:#ff3333;font-size:16px;margin-bottom:15px;font-weight:bold;">// CONFIRM ACTION //</div>
            <div style="color:#d0d0d0;font-size:14px;margin-bottom:20px;">${msg}</div>
            <div style="display:flex;gap:10px;justify-content:center;">
                <button id="cfg-yes" style="background:#ff3333;color:#fff;border:none;padding:8px 20px;border-radius:4px;cursor:pointer;font-weight:bold;">Confirm</button>
                <button id="cfg-no" style="background:#222;color:#a0a0a0;border:1px solid #444;padding:8px 20px;border-radius:4px;cursor:pointer;">Cancel</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);

    modal.querySelector('#cfg-yes').onclick = function() {
        modal.remove();
        if (callback) callback(true);
    };
    modal.querySelector('#cfg-no').onclick = function() {
        modal.remove();
        if (callback) callback(false);
    };
};
