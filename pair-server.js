const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const archiver = require('archiver');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Boom } = require('@hapi/boom');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const sessions = new Map();

const HTML = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Zero Trace XD – Pair & Get Session</title>
    <style>
        body { background: #0a0f1e; font-family: Arial; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; padding: 20px; }
        .card { background: #1a1f2e; border-radius: 28px; padding: 30px; max-width: 500px; width: 100%; }
        h1 { color: #00ffaa; text-align: center; }
        input, button { width: 100%; padding: 14px; margin: 10px 0; border-radius: 40px; border: none; }
        input { background: #0f1422; color: white; border: 1px solid #2a3455; }
        button { background: #00ffaa; color: #0a0f1e; font-weight: bold; cursor: pointer; }
        .status { margin-top: 20px; text-align: center; color: #88aaff; }
        .footer { margin-top:30px; font-size:12px; color:#667799; text-align:center; }
        .loading { display: inline-block; width: 20px; height: 20px; border: 2px solid white; border-top-color: #00ffaa; border-radius: 50%; animation: spin 0.8s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
    </style>
</head>
<body>
<div class="card">
    <h1>⚡ ZERO TRACE XD</h1>
    <p style="text-align:center">Enter your WhatsApp number</p>
    <input type="tel" id="phone" placeholder="e.g., 254704955033">
    <button id="pairBtn">🔗 Pair Device</button>
    <div id="status" class="status"></div>
    <div class="footer">After linking, the Session ID will be sent to your WhatsApp inbox.</div>
</div>
<script>
    const pairBtn = document.getElementById('pairBtn');
    const phoneInput = document.getElementById('phone');
    const statusDiv = document.getElementById('status');

    pairBtn.addEventListener('click', async () => {
        let phone = phoneInput.value.trim().replace(/\\D/g, '');
        if (!phone || phone.length < 10) return alert('Valid number required');
        pairBtn.disabled = true;
        pairBtn.innerHTML = '<span class="loading"></span> Generating...';
        statusDiv.innerHTML = '⏳ Generating pairing code...';
        try {
            const res = await fetch('/api/pair', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone })
            });
            const data = await res.json();
            if (data.code) {
                statusDiv.innerHTML = \`✅ Code: <strong>\${data.code}</strong><br>Enter this code in WhatsApp → Linked Devices → Link with Phone Number<br>Waiting for connection...\`;
                const interval = setInterval(async () => {
                    const check = await fetch('/api/check-session?phone=' + phone);
                    const result = await check.json();
                    if (result.ready) {
                        clearInterval(interval);
                        statusDiv.innerHTML = '✅ Session ID sent to your WhatsApp inbox! Check your WhatsApp now.';
                        pairBtn.disabled = false;
                        pairBtn.innerHTML = '🔗 Pair Device';
                    } else if (result.error) {
                        clearInterval(interval);
                        statusDiv.innerHTML = '❌ ' + result.error;
                        pairBtn.disabled = false;
                        pairBtn.innerHTML = '🔗 Pair Device';
                    }
                }, 3000);
            } else {
                statusDiv.innerHTML = '❌ Error: ' + (data.error || 'Unknown');
                pairBtn.disabled = false;
                pairBtn.innerHTML = '🔗 Pair Device';
            }
        } catch (err) {
            statusDiv.innerHTML = '❌ Network error';
            pairBtn.disabled = false;
            pairBtn.innerHTML = '🔗 Pair Device';
        }
    });
</script>
</body>
</html>`;

app.get('/', (req, res) => res.send(HTML));

app.post('/api/pair', async (req, res) => {
    const phone = req.body.phone?.replace(/[^0-9]/g, '');
    if (!phone) return res.status(400).json({ error: 'Invalid number' });
    
    const sessionDir = path.join(os.tmpdir(), `zxd_${phone}_${Date.now()}`);
    fs.mkdirSync(sessionDir, { recursive: true });
    
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: ['ZeroTrace XD', 'Safari', '15.0'], // more compatible
            syncFullHistory: false,
            markOnlineOnConnect: false,
            logger: require('pino')({ level: 'silent' }),
            connectTimeoutMs: 30000,
            defaultQueryTimeoutMs: 30000
        });
        
        sock.ev.on('creds.update', saveCreds);
        
        // Wait for connection to be open
        let isOpen = false;
        let code = null;
        
        const connectionPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Connection timeout')), 30000);
            
            sock.ev.on('connection.update', async (update) => {
                console.log('[PAIR] Connection update:', update);
                const { connection, lastDisconnect } = update;
                
                if (connection === 'open' && !isOpen) {
                    isOpen = true;
                    clearTimeout(timeout);
                    try {
                        console.log('[PAIR] Requesting pairing code for', phone);
                        code = await sock.requestPairingCode(phone);
                        console.log('[PAIR] Code received:', code);
                        sessions.set(phone, { sessionDir, status: 'waiting', sock });
                        resolve(code);
                    } catch (err) {
                        reject(err);
                    }
                } else if (connection === 'close') {
                    clearTimeout(timeout);
                    const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                    if (!shouldReconnect) reject(new Error('Connection closed by WhatsApp'));
                    else reject(new Error('Connection closed unexpectedly'));
                }
            });
        });
        
        const pairCode = await connectionPromise;
        res.json({ code: pairCode });
    } catch (err) {
        console.error('[PAIR] Error:', err);
        // Clean up
        if (fs.existsSync(sessionDir)) fs.rmSync(sessionDir, { recursive: true, force: true });
        res.status(500).json({ error: err.message || 'Pairing failed' });
    }
});

app.get('/api/check-session', async (req, res) => {
    const phone = req.query.phone;
    const entry = sessions.get(phone);
    if (!entry) return res.json({ ready: false });
    const { sessionDir, sock } = entry;
    const credsPath = path.join(sessionDir, 'creds.json');
    if (fs.existsSync(credsPath)) {
        try {
            const zipBuffer = await packageSession(sessionDir);
            const sessionId = zipBuffer.toString('base64');
            if (sock && sock.user) {
                const userJid = phone + '@s.whatsapp.net';
                await sock.sendMessage(userJid, { text: `🎉 *Zero Trace XD Session ID*\n\nCopy the text below and save it securely. You will paste it into your bot's environment variable.\n\n\`\`\`\n${sessionId}\n\`\`\`` });
                await sock.logout();
            }
            fs.rmSync(sessionDir, { recursive: true, force: true });
            sessions.delete(phone);
            return res.json({ ready: true });
        } catch (err) {
            console.error('[CHECK] Error packaging session:', err);
            return res.json({ error: err.message });
        }
    }
    res.json({ ready: false });
});

async function packageSession(dir) {
    const chunks = [];
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('data', chunk => chunks.push(chunk));
    archive.directory(dir, false);
    await archive.finalize();
    return Buffer.concat(chunks);
}

app.listen(PORT, () => console.log(`Pairing server running on port ${PORT}`));
