const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(__dirname));

const scriptStore = new Map();

/**
 * SAFE LUAU VM COMPILER (NO INFINITE LOOPS)
 */
function compileToHardenedLuauVM(sourceCode, options = {}) {
    const seedKey = Math.floor(Math.random() * 220) + 20;
    
    const bytes = [];
    for (let i = 0; i < sourceCode.length; i++) {
        bytes.push(sourceCode.charCodeAt(i) ^ seedKey);
    }

    const { antiHttpSpy = true } = options;

    return `--[[ Luarmor Cloud Protection Engine ]]--
return (function(...)
    local _bxor = bit32 and bit32.bxor or function(a, b) return a end
    local _char = string.char
    local _concat = table.concat
    local _key = ${seedKey}

    ${antiHttpSpy ? `
    -- Anti-Hooking Check (Safe Error instead of Game Freeze)
    if hookfunction and (getgenv().httpspy or getgenv().HttpSpy) then
        error("[Luarmor]: Execution blocked by security policy.", 0)
    end
    ` : ''}

    local _stream = { ${bytes.join(',')} }
    local _buffer = {}

    for i = 1, #_stream do
        _buffer[i] = _char(_bxor(_stream[i], _key))
    end

    local _rawScript = _concat(_buffer)
    local _load = loadstring or (vExecutionEnvironment and vExecutionEnvironment.loadstring)

    if not _load then
        error("[Luarmor Error]: 'loadstring' is not enabled or supported in this environment.", 0)
    end

    local _exec, _err = _load(_rawScript)
    if _exec then
        return _exec(...)
    else
        error("[Luarmor Runtime Error]: " .. tostring(_err), 0)
    end
end)(...);`;
}

app.post('/api/obfuscate', (req, res) => {
    try {
        const { script, antiHttpSpy } = req.body;

        if (!script || typeof script !== 'string' || script.trim() === '') {
            return res.status(400).json({ success: false, error: "No Luau source code provided." });
        }

        const loaderId = crypto.randomBytes(6).toString('hex');
        const vmPayload = compileToHardenedLuauVM(script, { antiHttpSpy });

        scriptStore.set(loaderId, { payload: vmPayload });

        const protocol = req.protocol || 'http';
        const host = req.get('host') || `localhost:${PORT}`;
        
        // 1-Line Loader Output
        const loaderScript = `loadstring(game:HttpGet("${protocol}://${host}/v3/loader/${loaderId}"))()`;

        return res.json({
            success: true,
            loaderId: loaderId,
            loader: loaderScript
        });
    } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/v3/loader/:id', (req, res) => {
    const loaderId = req.params.id;
    const userAgent = req.headers['user-agent'] || '';

    const entry = scriptStore.get(loaderId);

    if (!entry) {
        res.setHeader('Content-Type', 'text/plain');
        return res.status(404).send("LOCKED: Invalid or expired script key.");
    }

    // Browser lockout check
    const isBrowser = /Mozilla|Chrome|Safari|Edge|Brave|Firefox/i.test(userAgent);
    if (isBrowser) {
        res.setHeader('Content-Type', 'text/plain');
        return res.status(403).send("LOCKED: Source code access denied.");
    }

    res.setHeader('Content-Type', 'text/plain');
    res.send(entry.payload);
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running safely on http://localhost:${PORT}`);
});