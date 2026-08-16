document.addEventListener('DOMContentLoaded', () => {
    checkAuth();
    loadVault();

    document.getElementById('obfuscateBtn').addEventListener('click', handleObfuscate);
    document.getElementById('copyBtn').addEventListener('click', handleCopy);
    document.getElementById('clearBtn').addEventListener('click', () => {
        document.getElementById('scriptInput').value = '';
        showToast('Editor cleared', 'success');
    });
    document.getElementById('sampleBtn').addEventListener('click', () => {
        document.getElementById('scriptInput').value = `-- Sample Luau Script\nprint("Hello from Error404 Obfuscator!")\n\nlocal part = Instance.new("Part")\npart.Position = Vector3.new(0, 50, 0)\npart.Parent = workspace`;
        document.getElementById('scriptName').value = 'TestScript.lua';
        showToast('Sample loaded', 'success');
    });
});

async function checkAuth() {
    try {
        const res = await fetch('/api/me');
        const data = await res.json();
        const authSection = document.getElementById('authSection');

        if (data.authenticated) {
            authSection.innerHTML = `
                <div class="user-pill">
                    <img src="${data.user.avatar}" alt="Avatar" class="user-avatar">
                    <span class="user-name">${data.user.username}</span>
                    <a href="/auth/logout" class="logout-btn" title="Logout"><i class="fa-solid fa-power-off"></i></a>
                </div>
            `;
        } else {
            authSection.innerHTML = `
                <a href="/auth/discord" class="btn-discord">
                    <i class="fa-brands fa-discord"></i> Login with Discord
                </a>
            `;
        }
    } catch (e) {
        console.error('Auth check failed', e);
    }
}

async function handleObfuscate() {
    const rawCode = document.getElementById('scriptInput').value.trim();
    const scriptName = document.getElementById('scriptName').value.trim() || 'Untitled Script';
    
    if (!rawCode) {
        showToast('Please enter a script to obfuscate!', 'error');
        return;
    }

    const payload = b56Encode(rawCode); // Or standard btoa

    try {
        const btn = document.getElementById('obfuscateBtn');
        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Protecting...`;

        const res = await fetch('/api/obfuscate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ scriptPayload: btoa(rawCode), scriptName, fileType: 'luau' })
        });
        
        const data = await res.json();
        btn.innerHTML = `<i class="fa-solid fa-shield-halved"></i> Protect Script`;

        if (data.success) {
            document.getElementById('outputLoader').value = data.loader;
            document.getElementById('charCount').innerText = `${rawCode.split('\n').length} lines`;
            showToast('Script successfully protected & deployed!', 'success');
            loadVault();
        } else {
            showToast(data.error || 'Obfuscation failed.', 'error');
        }
    } catch (err) {
        console.error(err);
        document.getElementById('obfuscateBtn').innerHTML = `<i class="fa-solid fa-shield-halved"></i> Protect Script`;
        showToast('Server connection error.', 'error');
    }
}

async function loadVault() {
    try {
        const res = await fetch('/api/vault');
        const data = await res.json();
        const vaultGrid = document.getElementById('vaultGrid');

        if (!data.success || !data.scripts.length) {
            vaultGrid.innerHTML = `
                <div class="vault-empty">
                    <i class="fa-solid fa-box-open"></i>
                    <span>No protected scripts in your vault yet. Protect one above!</span>
                </div>
            `;
            return;
        }

        vaultGrid.innerHTML = data.scripts.map(script => `
            <div class="vault-card">
                <div class="vault-card-top">
                    <div>
                        <div class="vault-title"><i class="fa-regular fa-file-code"></i> ${escapeHtml(script.name)}</div>
                        <div class="vault-time">Created at ${script.createdAt}</div>
                    </div>
                </div>
                <div class="vault-loader-box" title="loadstring(game:HttpGet(...))()">loadstring(game:HttpGet("${window.location.origin}/raw/${script.id}"))()</div>
                <div class="vault-actions">
                    <button class="btn-sm" onclick="navigator.clipboard.writeText('loadstring(game:HttpGet(\\\\"${window.location.origin}/raw/${script.id}\\\"))()'); showToast('Loader copied!', 'success');">
                        <i class="fa-regular fa-copy"></i> Copy
                    </button>
                    <button class="btn-sm btn-danger" onclick="deleteScript('${script.id}')">
                        <i class="fa-regular fa-trash-can"></i>
                    </button>
                </div>
            </div>
        `).join('');
    } catch (e) {
        console.error('Failed to load vault', e);
    }
}

async function deleteScript(id) {
    try {
        const res = await fetch('/api/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
        });
        const data = await res.json();
        if (data.success) {
            showToast('Script deleted from vault', 'success');
            loadVault();
        }
    } catch (e) {
        showToast('Failed to delete script', 'error');
    }
}

function handleCopy() {
    const output = document.getElementById('outputLoader');
    if (!output.value) {
        showToast('Nothing to copy!', 'error');
        return;
    }
    output.select();
    navigator.clipboard.writeText(output.value);
    showToast('Loader copied to clipboard!', 'success');
}

function showToast(message, type = 'success') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<i class="fa-solid ${type === 'success' ? 'fa-circle-check' : 'fa-circle-exclamation'}"></i> ${message}`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}