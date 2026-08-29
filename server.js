const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Safely configure static directory
const publicPath = path.join(__dirname, 'public');
if (fs.existsSync(publicPath)) {
    app.use(express.static(publicPath));
}

// In-Memory Databases
const vaultDatabase = new Map();
const apiKeysDatabase = new Map();

// Helper Security Hash Function
function generateHash(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

// ------------------------------------------------------------------
// 1. RAW SCRIPT LINK ENDPOINT (Monochrome Access Restricted)
// ------------------------------------------------------------------
app.get('/raw/:id', (req, res) => {
    const scriptId = req.params.id;
    const userAgent = req.headers['user-agent'] || '';
    const nixSignature = req.headers['x-nix6-signature'];

    const isAuthorizedExecutor = userAgent.includes('Roblox') || userAgent.includes('Luau') || nixSignature;

    if (isAuthorizedExecutor && vaultDatabase.has(scriptId)) {
        const scriptData = vaultDatabase.get(scriptId);
        res.setHeader('Content-Type', 'text/plain');
        return res.status(200).send(scriptData.compiledCode);
    }

    res.setHeader('Content-Type', 'text/html');
    return res.status(403).send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Nix6 // Access Restricted</title>
    <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;700;800&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-base: #000000;
            --bg-card: rgba(12, 12, 12, 0.95);
            --border-subtle: rgba(255, 255, 255, 0.15);
            --border-glow: rgba(255, 255, 255, 0.35);
            --text-primary: #ffffff;
            --text-secondary: #a1a1aa;
            --radius-main: 12px;
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
            font-family: 'JetBrains Mono', monospace;
        }

        body {
            background-color: var(--bg-base);
            color: var(--text-primary);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            position: relative;
            overflow: hidden;
        }

        body::before {
            content: "";
            position: absolute;
            top: 0; left: 0; right: 0; bottom: 0;
            background: 
                linear-gradient(rgba(255, 255, 255, 0.02) 1px, transparent 1px),
                linear-gradient(90deg, rgba(255, 255, 255, 0.02) 1px, transparent 1px);
            background-size: 32px 32px;
            pointer-events: none;
            z-index: 0;
        }

        .restricted-card {
            position: relative;
            z-index: 1;
            background: var(--bg-card);
            border: 1px dashed var(--border-subtle);
            border-radius: var(--radius-main);
            padding: 40px 48px;
            text-align: center;
            max-width: 520px;
            width: 90%;
            box-shadow: 0 0 32px rgba(255, 255, 255, 0.03);
            transition: border-color 0.2s ease, box-shadow 0.2s ease;
        }

        .restricted-card:hover {
            border-color: var(--border-glow);
            box-shadow: 0 0 40px rgba(255, 255, 255, 0.06);
        }

        .restricted-title {
            font-size: 1.1rem;
            font-weight: 800;
            letter-spacing: 3px;
            color: #ffffff;
            margin-bottom: 14px;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 10px;
        }

        .restricted-title::before,
        .restricted-title::after {
            content: "//";
            color: var(--text-secondary);
            font-weight: 500;
        }

        .restricted-subtitle {
            font-size: 0.82rem;
            color: var(--text-secondary);
            letter-spacing: 0.5px;
            line-height: 1.5;
        }
    </style>
</head>
<body>

    <div class="restricted-card">
        <h1 class="restricted-title">ACCESS RESTRICTED</h1>
        <p class="restricted-subtitle">This loadstring source is protected and unlisted.</p>
    </div>

</body>
</html>
    `);
});

// ------------------------------------------------------------------
// 2. API ENDPOINTS
// ------------------------------------------------------------------

app.get('/api/verify-key', (req, res) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey && apiKeysDatabase.has(apiKey)) {
        return res.json({ authenticated: true, username: apiKeysDatabase.get(apiKey).username });
    }
    return res.status(401).json({ authenticated: false, error: 'Invalid Key' });
});

app.post('/api/obfuscate', (req, res) => {
    const { scriptPayload, scriptName, fileType, editId, options } = req.body;

    if (!scriptPayload) {
        return res.status(400).json({ success: false, error: 'Empty script payload' });
    }

    const scriptId = editId || crypto.randomBytes(8).toString('hex');
    const decodedSource = Buffer.from(scriptPayload, 'base64').toString('utf8');

    let processedCode = `-- Nix6 Obfuscated Source [ID: ${scriptId}]\n`;
    if (options && options.antiTamper) {
        processedCode += `if not game or not game:GetService then return end\n`;
    }
    processedCode += decodedSource;

    const hostUrl = `${req.protocol}://${req.get('host')}`;
    const loaderLink = `loadstring(game:HttpGet("${hostUrl}/raw/${scriptId}"))()`;

    vaultDatabase.set(scriptId, {
        id: scriptId,
        name: scriptName || 'Untitled Script',
        fileType: fileType || 'luau',
        rawPayload: scriptPayload,
        compiledCode: processedCode,
        loader: loaderLink,
        updatedAt: new Date().toISOString()
    });

    return res.json({
        success: true,
        scriptId,
        loader: loaderLink
    });
});

app.get('/api/vault', (req, res) => {
    const scripts = Array.from(vaultDatabase.values());
    return res.json({ success: true, scripts });
});

app.post('/api/delete', (req, res) => {
    const { id } = req.body;
    if (vaultDatabase.has(id)) {
        vaultDatabase.delete(id);
        return res.json({ success: true });
    }
    return res.status(404).json({ success: false, error: 'Script not found' });
});

app.post('/api/admin/generate-key', (req, res) => {
    const { username } = req.body;
    const newKey = `nix6_key_${crypto.randomBytes(12).toString('hex')}`;
    
    apiKeysDatabase.set(newKey, { key: newKey, username: username || 'Client_User', createdAt: new Date() });
    return res.json({ success: true, apiKey: newKey });
});

app.get('/api/admin/keys', (req, res) => {
    const keys = Array.from(apiKeysDatabase.values());
    return res.json({ success: true, keys });
});

app.post('/api/admin/revoke-key', (req, res) => {
    const { key } = req.body;
    if (apiKeysDatabase.has(key)) {
        apiKeysDatabase.delete(key);
        return res.json({ success: true });
    }
    return res.status(404).json({ success: false, error: 'Key not found' });
});

// ------------------------------------------------------------------
// 3. ROOT & FALLBACK ROUTE HANDLER
// ------------------------------------------------------------------
app.get('*', (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'index.html');

    if (fs.existsSync(indexPath)) {
        return res.sendFile(indexPath);
    }

    // Fallback response if index.html is missing in the deployment directory
    res.setHeader('Content-Type', 'text/html');
    return res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Nix6 Engine // Online</title>
    <style>
        body { background: #000; color: #fff; font-family: monospace; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        .box { border: 1px dashed #333; padding: 20px 30px; border-radius: 8px; text-align: center; }
        h1 { font-size: 1rem; letter-spacing: 2px; }
    </style>
</head>
<body>
    <div class="box">
        <h1>// NIX6 ENGINE ACTIVE</h1>
        <p style="color:#666; font-size: 0.8rem;">Backend API is running. Add index.html to /public for frontend interface.</p>
    </div>
</body>
</html>
    `);
});

app.listen(PORT, () => {
    console.log(`[NIX6 ENGINE] Server running on port ${PORT}`);
});
