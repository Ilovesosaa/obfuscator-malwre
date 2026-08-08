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
 * LIGHTWEIGHT CRASH-PROOF VM ENGINE
 */
function compileToHardenedLuauVM(sourceCode, options = {}) {
    const key = Math.floor(Math.random() * 200) + 10;
    
    // Fast XOR encoding into a single string stream
    let encoded = '';
    for (let i = 0; i < sourceCode.length; i++) {
        encoded += String.fromCharCode(sourceCode.charCodeAt(i) ^ key);
    }

    // Escape special characters so string literal doesn't break
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
    
    if _f then
        return _f(...)
    else
        error("[SIN Runtime Error]: " .. tostring(_e), 0)
    end
end)(...);`;
}

app.post('/api/obfuscate', (req, res) => {
    try {
        const { script } = req.body;

        if (!script || typeof script !== 'string' || script.trim() === '') {
            return res.status(400).json({ success: false, error: "No Luau source code provided." });
        }

        const loaderId = crypto.randomBytes(6).toString('hex');
        const vmPayload = compileToHardenedLuauVM(script);

        scriptStore.set(loaderId, { payload: vmPayload });

        const protocol = req.protocol || 'http';
        const host = req.get('host') || `localhost:${PORT}`;
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

    // Browser lockout
    const isBrowser = /Mozilla|Chrome|Safari|Edge|Brave|Firefox/i.test(userAgent);
    if (isBrowser) {
        res.setHeader('Content-Type', 'text/plain');
        return res.status(403).send("LOCKED: Source code access denied.");
    }

    // Explicitly send text/plain so HttpGet doesn't get messed up
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send(entry.payload);
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`SIN Obfuscator Server running on port ${PORT}`);
});
