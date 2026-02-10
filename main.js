const { app, BrowserWindow, BrowserView, screen, ipcMain, session } = require('electron');
const path = require('path');
const { exec, execSync } = require('child_process');
const { io } = require("socket.io-client");
const { machineIdSync } = require('node-machine-id');
const Store = require('electron-store');
const si = require('systeminformation');
const schedule = require('node-schedule');
const screenshot = require('screenshot-desktop');
 const { desktopCapturer } = require('electron');

// Capture screenshot and send to server
async function handleScreenshot() {
    try {
        if (!view) return;
        // Prefer using Electron desktopCapturer for high fidelity within app
        const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 1280, height: 720 } });
        const primary = sources[0];
        const dataUrl = primary.thumbnail.toDataURL();
        if (socket && socket.connected) socket.emit('kiosk-screenshot-report', { image: dataUrl });
        // also save last screenshot to store for persistence
        const cfg = store.get('kiosk_config') || {};
        cfg.lastScreenshot = dataUrl;
        store.set('kiosk_config', cfg);
    } catch (err) {
        console.error('handleScreenshot error', err);
        try {
            const img = await screenshot({ format: 'png' });
            const b64 = Buffer.from(img).toString('base64');
            const dataUrl = `data:image/png;base64,${b64}`;
            if (socket && socket.connected) socket.emit('kiosk-screenshot-report', { image: dataUrl });
        } catch (e) { console.error('screenshot-desktop fallback failed', e); }
    }
}

const store = new Store();
let win, view, configWin, touchWin, navWin, promptWin, socket, shutdownJob, qrBtnWin, homeBtnWin;
let lastPageUrl = null;
let qrLocalMode = false;
let idleTimer;
const fs = require('fs');
const logFile = fs.createWriteStream('kiosk-debug.log', { flags: 'a' });
process.stdout.write = process.stderr.write = logFile.write.bind(logFile);
console.log('--- App Started at ' + new Date() + ' ---');
// ID duy nhất cho máy Kiosk
const MY_ID = machineIdSync().substring(0, 8).toUpperCase();

// Kiểm tra quyền Administrator
function isAdmin() {
    try { execSync('net session', { stdio: 'ignore' }); return true; } catch (e) { return false; }
}

/* ==========================================================
   1. QUẢN LÝ HỆ THỐNG & KIOSK HARDENING
   ========================================================== */
function setShutdownSchedule(timeStr) {
    if (!timeStr || timeStr === "N/A" || timeStr === "") return;
    if (shutdownJob) shutdownJob.cancel();

    const [hour, minute] = timeStr.split(':');
    shutdownJob = schedule.scheduleJob(`${minute} ${hour} * * *`, () => {
        restoreWindowsSystem();
        exec('shutdown /s /t 60'); 
    });
}

function enableKioskHardening() {
    const appPath = app.getPath('exe'); 
    try {
        execSync(`reg add "HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon" /v "Shell" /t REG_SZ /d "${appPath}" /f`);
        execSync('reg add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer" /v "NoWinKeys" /t REG_DWORD /d 1 /f');
        exec('taskkill /f /im explorer.exe');
    } catch (e) { console.error("Lỗi Hardening:", e); }
}

function restoreWindowsSystem() {
    try {
        execSync('reg delete "HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon" /v "Shell" /f');
        execSync('reg add "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer" /v "NoWinKeys" /t REG_DWORD /d 0 /f');
    } catch (e) {}
    exec('start explorer.exe');
}

/* ==========================================================
   2. TỰ ĐỘNG DỌN DẸP & GIÁM SÁT (IDLE TIMEOUT)
   ========================================================== */
async function clearAllSession() {
    if (!view) return;
    try {
        console.log('Clearing all session storage and cache...');
        await view.webContents.session.clearStorageData({ storages: ['cookies','localstorage','indexdb','serviceworkers'] });
        await view.webContents.session.clearCache();
    } catch (e) { console.error('clearAllSession failed', e); }
}

function resetIdleTimer(timeoutMs = 120000) {
    clearTimeout(idleTimer);
    const config = store.get('kiosk_config');
    if (!config) return;

    // Sau timeout (default 2 phút) không tương tác: xóa session (cookie/cache) và quay về trang chủ
    idleTimer = setTimeout(async () => {
        if (view) {
            console.log("Hệ thống: Hết thời gian chờ, đang xóa dữ liệu riêng tư...");
            await clearAllSession();
            view.webContents.loadURL(config.url);
        }
    }, timeoutMs);
}

/* ==========================================================
   3. BÁO CÁO CẤU HÌNH & SOCKET.IO (MCP COMMANDS)
   ========================================================== */
async function reportDeviceInfo() {
    try {
        const config = store.get('kiosk_config');
        const cpu = await si.cpu();
        const mem = await si.mem();
        const printers = await win.webContents.getPrintersAsync();
        const network = await si.networkInterfaces();

        const deviceInfo = {
            kioskId: MY_ID,
            cpu: `${cpu.manufacturer} ${cpu.brand}`,
            ram: (mem.total / (1024 ** 3)).toFixed(2) + " GB",
            freeRam: (mem.free / (1024 ** 3)).toFixed(2) + " GB", // Thêm báo cáo RAM trống
            ip: network.find(n => !n.internal && n.ip4)?.ip4 || "127.0.0.1",
            shutdownTime: config ? config.shutdownTime : "N/A",
            printers: printers.map(p => p.name),
            // Thêm thông tin cấu hình để lưu vào `specs` trên server
            url: config?.url || null,
            mode: config?.mode || null,
            socketServerUrl: config?.socketServerUrl || null
        };
        if (socket && socket.connected) socket.emit('kiosk-report-config', deviceInfo);
    } catch (err) { console.error(err); }
}

function setupSocket(serverUrl) {
    const config = store.get('kiosk_config');
    // Giả sử serverUrl là http://localhost:3001
    // Namespace lấy từ config (ví dụ: 'cn-q1')
    const namespace = config.socketNamespace || 'default';
    const token = config.socketToken || null;

    // include token in auth for server-side JWT validation
    socket = io(`${serverUrl}/${namespace}`, {
        auth: { token },
        query: {
            kioskId: MY_ID,
            type: 'kiosk' // Khai báo rõ loại client là kiosk
        }
    });

    socket.on("connect", () => {
        console.log(`✅ Connected to Namespace: ${namespace}`);
        reportDeviceInfo();
    });

    socket.on('connect_error', (err) => console.error('Socket connect_error', err && err.message));
    socket.on('error', (err) => console.error('Socket error', err));

    // Lắng nghe lệnh từ MCP Dashboard
    socket.on("mcp-command", async (data) => {
        try {
            console.log('mcp-command raw:', data);
            const cmd = data.cmd;
            const payload = data.payload || {};
         const target = (data.target || 'ALL').toString().toUpperCase();

            if (target !== MY_ID && target !== 'ALL') {
                console.log(`mcp-command ignored for target=${target}`);
                return;
            }

            console.log(`📩 Thực thi lệnh: ${cmd} payload=${JSON.stringify(payload)}`);

            // Các lệnh cơ bản
            if (cmd === 'take-screenshot' || cmd === 'screenshot') {
                await handleScreenshot();
                socket.emit('mcp-command-response', { commandId: data.commandId, result: 'screenshot_sent' });
            } else if (cmd === 'reboot') {
                socket.emit('mcp-command-response', { commandId: data.commandId, result: 'rebooting' });
                restoreWindowsSystem();
                exec('shutdown /r /t 0');
            } else if (cmd === 'shutdown' || cmd === 'poweroff') {
                socket.emit('mcp-command-response', { commandId: data.commandId, result: 'shutting-down' });
                restoreWindowsSystem();
                exec('shutdown /s /t 0');
            } else if (cmd === 'exit-app') {
                socket.emit('mcp-command-response', { commandId: data.commandId, result: 'exiting' });
                restoreWindowsSystem();
                setTimeout(() => app.exit(0), 500);
            } else if (cmd === 'reset') {
                socket.emit('mcp-command-response', { commandId: data.commandId, result: 'resetting' });
                try {
                    restoreWindowsSystem();
                    store.delete('kiosk_config');
                    app.relaunch();
                    app.exit(0);
                } catch (e) { console.error('Reset failed', e); }
            } else if (cmd === 'set-url' && payload.url) {
                try {
                    const cfg = store.get('kiosk_config') || {};
                    cfg.url = payload.url;
                    store.set('kiosk_config', cfg);
                    if (view && view.webContents) view.webContents.loadURL(payload.url);
                    socket.emit('mcp-command-response', { commandId: data.commandId, result: 'url-updated' });
                } catch (e) { console.error('set-url failed', e); socket.emit('mcp-command-response', { commandId: data.commandId, result: 'error', error: e.message }); }
            } else {
                console.log('Unknown mcp command:', cmd);
                socket.emit('mcp-command-response', { commandId: data.commandId, result: 'unknown-command' });
            }
        } catch (err) {
            console.error('Error handling mcp-command', err);
            try { socket.emit('mcp-command-response', { commandId: data.commandId, result: 'error', error: err.message }); } catch (e) {}
        }
    });
}

/* ==========================================================
   4. KHỞI TẠO CỬA SỔ CHÍNH & NAV BAR
   ========================================================== */
function createMainWindow() {
    const config = store.get('kiosk_config');
    if (!config || config.showConfigModal) {
        configWin = new BrowserWindow({ width: 500, height: 550, frame: false, alwaysOnTop: true, center: true, webPreferences: { nodeIntegration: true, contextIsolation: false } });
        configWin.loadFile('config.html');
        
        // Gửi dữ liệu config hiện tại cho form nếu có (không phụ thuộc vào config.url)
        configWin.webContents.on('dom-ready', () => {
            if (config) {
                configWin.webContents.send('load-config', config);
            }
        });
        return;
    }

    enableKioskHardening();
    setShutdownSchedule(config.shutdownTime);
    
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const navHeight = 45;

    win = new BrowserWindow({
        width, height, fullscreen: true, kiosk: true, alwaysOnTop: true, frame: false,
        backgroundColor: '#000', skipTaskbar: true
    });

    view = new BrowserView({
        webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
    });

    win.setBrowserView(view);
    
    // Watchdog: Tự động tải lại trang nếu bị treo hoặc crash
    // Keep local state for reconnect/backoff
    view._reconnectAttempts = 0;
    view._reconnectTimer = null;
    view._highMemCount = 0;

    view.webContents.on('render-process-gone', (ev, details) => {
        console.log("Cảnh báo: Render process bị lỗi, đang tự động nạp lại...", details);
        socket?.emit && socket.emit('kiosk-warning', { type: 'render-gone', details });
        try { view.webContents.reload(); } catch (e) { console.error('reload failed', e); }
    });

    // Handle unresponsive
    view.webContents.on('unresponsive', () => {
        console.warn('Render unresponsive - attempting reload');
        socket?.emit && socket.emit('kiosk-warning', { type: 'unresponsive' });
        try { view.webContents.reload(); } catch (e) { console.error('reload on unresponsive failed', e); }
    });

    // Did-fail-load -> show offline static page and start reconnect attempts
    view.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        console.warn('did-fail-load', { errorCode, errorDescription, validatedURL, isMainFrame });
        if (!isMainFrame) return;
        // load offline page
        try {
            view.webContents.loadFile(path.join(__dirname, 'offline.html'));
            scheduleReconnect();
        } catch (e) { console.error('load offline failed', e); }
    });

    // When page successfully loads -> reset reconnect attempts
    view.webContents.on('did-finish-load', () => {
        view._reconnectAttempts = 0;
        if (view._reconnectTimer) { clearTimeout(view._reconnectTimer); view._reconnectTimer = null; }
        // if previously offline, emit recovered
        socket?.emit && socket.emit('kiosk-recovered', { time: new Date() });
    });

    // Intercept navigations from offline page (app://reload, app://open-admin)
    view.webContents.on('will-navigate', (e, url) => {
        if (url === 'app://reload') {
            e.preventDefault();
            const cfg = store.get('kiosk_config') || {};
            if (cfg.url) view.webContents.loadURL(cfg.url);
        }
        if (url === 'app://open-admin') {
            e.preventDefault();
            try {
                if (config && config.showConfigModal) { /* noop */ }
                // Open config window
                if (!configWin) {
                    configWin = new BrowserWindow({ width: 500, height: 550, frame: false, alwaysOnTop: true, center: true, webPreferences: { nodeIntegration: true, contextIsolation: false } });
                    configWin.loadFile('config.html');
                    configWin.webContents.on('dom-ready', () => { if (config) configWin.webContents.send('load-config', config); });
                }
            } catch (e) { console.error('open-admin failed', e); }
        }
    });

    // Memory monitor interval for this view
    const memCheckInterval = setInterval(async () => {
        try {
            if (!view || view.isDestroyed()) { clearInterval(memCheckInterval); return; }
            const memInfo = await view.webContents.getProcessMemoryInfo();
            // memInfo.private is in KB on some platforms
            const privateMB = (memInfo.private || memInfo.privateMemory || 0) / 1024;
            // If > 800MB consider high
            if (privateMB > 800) {
                view._highMemCount = (view._highMemCount || 0) + 1;
                console.warn('High memory detected', privateMB, 'MB, count=', view._highMemCount);
                socket?.emit && socket.emit('kiosk-warning', { type: 'high-memory', mb: privateMB });
                if (view._highMemCount >= 6) { // sustained high mem over time -> restart
                    console.error('Memory threshold exceeded, restarting app');
                    try { app.relaunch(); app.exit(0); } catch (e) { console.error(e); }
                }
            } else {
                view._highMemCount = 0;
            }
        } catch (e) { console.error('mem check failed', e); }
    }, 5 * 60 * 1000); // every 5 minutes

    function scheduleReconnect() {
        if (view._reconnectTimer) return;
        const cfg = store.get('kiosk_config') || {};
        const tryPing = async () => {
            view._reconnectAttempts = (view._reconnectAttempts || 0) + 1;
            const attempt = view._reconnectAttempts;
            console.log('Reconnect attempt', attempt);
            try {
                // ping server debug endpoint
                const fetch = require('node-fetch');
                const base = cfg.socketServerUrl || cfg.url || 'http://localhost:3001';
                const pingUrl = base.replace(/\/$/, '') + '/api/debug/sockets';
                const r = await fetch(pingUrl, { timeout: 4000 });
                if (r.ok) {
                    console.log('Reconnect succeeded, loading URL');
                    view._reconnectAttempts = 0;
                    view.webContents.loadURL(cfg.url);
                    if (view._reconnectTimer) { clearTimeout(view._reconnectTimer); view._reconnectTimer = null; }
                    return;
                }
            } catch (e) { /* ignore */ }

            // exponential backoff
            const nextMs = Math.min(30000, 2000 * Math.pow(1.4, attempt));
            view._reconnectTimer = setTimeout(tryPing, nextMs);

            // escalate if many attempts
            if (attempt >= 20) {
                // after many attempts, restart app to recover
                socket?.emit && socket.emit('kiosk-warning', { type: 'reconnect-failed', attempts: attempt });
                try { app.relaunch(); app.exit(0); } catch (e) { console.error(e); }
            }
        };
        tryPing();
    }

    if (config.mode === 'AI') {
        win.loadFile('index.html');
        view.setBounds({ x: 0, y: Math.floor(height * 0.15) + navHeight, width, height: Math.floor(height * 0.85) - navHeight });
    } else {
        view.webContents.loadURL(config.url);
        view.setBounds({ x: 0, y: navHeight, width, height: height - navHeight });
    }

    // Use socketServerUrl if provided (allows separate socket management server)
    const socketServer = config.socketServerUrl || config.url;
    setupSocket(socketServer);
    // createNavBar(width, navHeight);
    createTouchZone(height);
    // Small quick-action buttons: QR (bottom-left) and Home (bottom-right)
    createQuickButtons(height);
}

// function createNavBar(width, height) {
//     navWin = new BrowserWindow({
//         width: 220, height, x: 0, y: 0, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
//         focusable: false, resizable: false, hasShadow: false,
//         webPreferences: { nodeIntegration: true, contextIsolation: false }
//     });

//     navWin.setAlwaysOnTop(true, 'screen-saver', 15);

//     // Ép Nav Bar luôn nổi
//     setInterval(() => {
//         if (navWin && !navWin.isDestroyed()) {
//             navWin.setAlwaysOnTop(true, 'screen-saver', 15);
//             navWin.moveTop();
//         }
//     }, 800);

//     const navHtml = `
//     <body style="margin:0; background:rgba(0,0,0,0.85); display:flex; align-items:center; padding:0 10px; border-bottom-right-radius:12px; border:1px solid #333; overflow:hidden;">
//         <div style="display:flex; gap:8px;">
//             <button onclick="nav('back')" id="btn-back" style="background:#222; color:white; border:1px solid #444; width:35px; height:32px; border-radius:4px; cursor:pointer;">◀</button>
//             <button onclick="nav('forward')" id="btn-forward" style="background:#222; color:white; border:1px solid #444; width:35px; height:32px; border-radius:4px; cursor:pointer;">▶</button>
//             <button onclick="nav('reload')" style="background:#00f2fe; color:black; border:none; padding:0 12px; height:32px; border-radius:4px; cursor:pointer; font-weight:bold; font-size:11px;">RELOAD</button>
//         </div>
//         <script>
//             const { ipcRenderer } = require('electron');
//             function nav(c){ ipcRenderer.send('nav-action', c); }
//         </script>
//     </body>`;
//     navWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(navHtml)}`);
// }

function createTouchZone(screenHeight) {
    // Lấy kích thước toàn màn hình (bao gồm cả width để tính góc bên phải)
    const { width: screenWidth } = screen.getPrimaryDisplay().workAreaSize;

    const winWidth = 100;
    const winHeight = 100;

    touchWin = new BrowserWindow({
        width: winWidth,
        height: winHeight,
        x: screenWidth - winWidth, 
        y: 0, 
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        focusable: false,
        resizable: false,
        hasShadow: false,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    // Mức level screen-saver để đè lên mọi ứng dụng khác
    touchWin.setAlwaysOnTop(true, 'screen-saver', 100);

    const html = `
    <body style="margin:0; overflow:hidden; background:transparent; display:flex; justify-content: flex-end; align-items: flex-start; -webkit-app-region: no-drag;">
        <div id="btn"
            style="
                width:60px;
                height:60px;
                background: rgba(255, 255, 255, 0.1); 
                border-radius: 0 0 0 100%; /* Bo cong phía dưới bên trái để tạo hình cung góc trên phải */
                display:flex;
                align-items:center;
                justify-content:center;
                font-family: sans-serif;
                font-size: 10px;
                font-weight: bold;
                user-select:none;
                cursor: pointer;
                padding-left: 10px; /* Đẩy chữ ra giữa cung tròn */
                padding-bottom: 10px;
            ">   
        </div>

        <script>
            const { ipcRenderer } = require('electron');
            let lastTap = 0;

            document.getElementById('btn').addEventListener('click', () => {
                const now = Date.now();
                if (now - lastTap < 500) {
                    ipcRenderer.send('request-passcode-dialog');
                }
                lastTap = now;
            });
        </script>
    </body>
    `;

    touchWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

    // Duy trì vị trí trên cùng
    setInterval(() => {
        if (touchWin && !touchWin.isDestroyed()) {
            touchWin.moveTop();
        }
    }, 1000);
}

function createQuickButtons(screenHeight) {
    const { width: screenWidth, height: screenHeight2 } = screen.getPrimaryDisplay().workAreaSize;
    const btnSize = 72;

    // QR button bottom-left
    qrBtnWin = new BrowserWindow({
        width: btnSize, height: btnSize, x: 20, y: screenHeight2 - btnSize - 20, frame: false, transparent: true,
        alwaysOnTop: true, skipTaskbar: true, focusable: true, resizable: false, webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    qrBtnWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
        <body style="margin:0;background:transparent;display:flex;align-items:flex-end;justify-content:flex-start;">
            <div id="qr" style="width:60px;height:60px;border-radius:30px;background:rgba(0,0,0,0.6);color:white;display:flex;align-items:center;justify-content:center;font-weight:bold;cursor:pointer;font-family:Segoe UI;">QR</div>
            <script>const {ipcRenderer}=require('electron'); document.getElementById('qr').addEventListener('click',()=>ipcRenderer.send('open-qr-in-view'))</script>
        </body>` )}`);

    // Home button bottom-right
    homeBtnWin = new BrowserWindow({
        width: btnSize, height: btnSize, x: screenWidth - btnSize - 20, y: screenHeight2 - btnSize - 20, frame: false, transparent: true,
        alwaysOnTop: true, skipTaskbar: true, focusable: true, resizable: false, webPreferences: { nodeIntegration: true, contextIsolation: false }
    });
    homeBtnWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
        <body style="margin:0;background:transparent;display:flex;align-items:flex-end;justify-content:flex-end;">
            <div id="home" style="width:60px;height:60px;border-radius:30px;background:rgba(0,0,0,0.6);color:white;display:flex;align-items:center;justify-content:center;font-weight:bold;cursor:pointer;font-family:Segoe UI;">HOME</div>
            <script>const {ipcRenderer}=require('electron'); document.getElementById('home').addEventListener('click',()=>ipcRenderer.send('qr-home'))</script>
        </body>` )}`);

    // Keep them on top
    setInterval(() => {
        if (qrBtnWin && !qrBtnWin.isDestroyed()) qrBtnWin.moveTop();
        if (homeBtnWin && !homeBtnWin.isDestroyed()) homeBtnWin.moveTop();
    }, 1000);
}

/* ==========================================================
   5. XỬ LÝ IPC
   ========================================================== */
ipcMain.on('user-activity', () => resetIdleTimer());

ipcMain.on('open-virtual-keyboard', () => exec('osk.exe'));

ipcMain.on('clear-session', async () => {
    try { await clearAllSession(); console.log('Session cleared via IPC'); } catch (e) { console.error(e); }
});

// Open QR scanner inside main view (local-only)
ipcMain.on('open-qr-in-view', () => {
    try {
        if (!view) return;
        lastPageUrl = view.webContents.getURL();
        qrLocalMode = true;
        view.webContents.loadFile(path.join(__dirname, 'qr-scanner.html'));
    } catch (e) { console.error('open-qr-in-view error', e); }
});

// Home action from QR scanner (or overlay)
ipcMain.on('qr-home', () => {
    try {
        qrLocalMode = false;
        if (view) {
            if (lastPageUrl) view.webContents.loadURL(lastPageUrl);
            else {
                const cfg = store.get('kiosk_config') || {};
                if (cfg.url) view.webContents.loadURL(cfg.url);
            }
        }
    } catch (e) { console.error('qr-home failed', e); }
});

ipcMain.on('open-qr-scanner', () => {
    // Open a modal window with scanner (legacy)
    try {
        const scannerWin = new BrowserWindow({ width: 800, height: 600, modal: true, parent: win, webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true } });
        scannerWin.loadFile('qr-scanner.html');
    } catch (e) { console.error('open-qr-scanner error', e); }
});

ipcMain.on('qr-detected', (event, data) => {
    console.log('QR detected', data);
    if (qrLocalMode) {
        // show in current view (scanner page already updates #out, but ensure big display)
        try {
            if (view && view.webContents) {
                view.webContents.executeJavaScript(`(function(){ const el=document.getElementById('out'); if(el) el.textContent='Detected: '+${JSON.stringify(data)}; const big=document.getElementById('bigout'); if(!big){ const b=document.createElement('div'); b.id='bigout'; b.style= 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);background:rgba(0,0,0,0.85);color:#fff;padding:20px;border-radius:8px;font-size:22px;z-index:100000;'; b.textContent=${JSON.stringify(data)}; document.body.appendChild(b);} else big.textContent=${JSON.stringify(data)}; })()`).catch(()=>{});
            }
        } catch (e) {}
        return;
    }
    if (socket && socket.connected) socket.emit('kiosk-qr', { kioskId: MY_ID, data });
});

ipcMain.on('nav-action', (e, cmd) => {
    resetIdleTimer();
    if (!view) return;
    if (cmd === 'back' && view.webContents.canGoBack()) view.webContents.goBack();
    if (cmd === 'forward' && view.webContents.canGoForward()) view.webContents.goForward();
    if (cmd === 'reload') view.webContents.reload();
});

ipcMain.on('request-passcode-dialog', () => {
    if (promptWin) promptWin.close();
    promptWin = new BrowserWindow({ width: 300, height: 200, frame: false, alwaysOnTop: true, center: true, webPreferences: { nodeIntegration: true, contextIsolation: false } });
    const html = `<body style="background:#222; color:white; text-align:center; padding:20px; border:2px solid #00f2fe; font-family:sans-serif;">
        <h3 style="margin:0">MÃ QUẢN TRỊ</h3>
        <input type="password" id="p" autofocus style="width:80%; padding:10px; margin:15px 0; background:#444; border:none; color:white; text-align:center;">
        <br><button onclick="s()" style="background:#00f2fe; border:none; padding:10px 20px; font-weight:bold; cursor:pointer;">OK</button>
        <button onclick="window.close()" style="background:#555; color:white; border:none; padding:10px 20px; cursor:pointer;">HỦY</button>
        <script>const {ipcRenderer}=require('electron'); function s(){ipcRenderer.send('verify-passcode', document.getElementById('p').value)}</script>
    </body>`;
    promptWin.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
});

ipcMain.on('verify-passcode', (event, code) => {
    if (code === "123456") { restoreWindowsSystem(); app.exit(0); }
    else if (code === "654321") { 
        restoreWindowsSystem();
        // Set flag để hiện thị config modal với dữ liệu cũ
        const cfg = store.get('kiosk_config') || {};
        cfg.showConfigModal = true;
        store.set('kiosk_config', cfg);
        app.relaunch(); 
        app.exit(0); 
    }
    else { if(promptWin) promptWin.webContents.executeJavaScript('alert("Sai mật mã!")'); }
});

ipcMain.on('silent-print', () => {
    if (view) view.webContents.print({ silent: true, printBackground: true, pageSize: { width: 72000, height: 100000 } });
});

ipcMain.on('save-config', async (e, data) => { 
    // Xóa flag showConfigModal khi lưu config mới
    data.showConfigModal = false;
    store.set('kiosk_config', data); 

    // Nếu đã có kết nối socket, gửi ngay reportDeviceInfo để Dashboard cập nhật cấu hình (url/mode/socket)
    try {
        if (socket && socket.connected) {
            await reportDeviceInfo();
            console.log('✅ reportDeviceInfo đã gửi sau khi lưu config');
        }
    } catch (err) { console.error('Gửi reportDeviceInfo thất bại:', err); }

    // Relaunch app để áp dụng cấu hình mới
    app.relaunch(); 
    app.exit(0); 
});
app.disableHardwareAcceleration();
app.whenReady().then(() => {
    // Allow camera/media permission prompts automatically for kiosk origins
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
        if (permission === 'media') return callback(true);
        // allow notifications for convenience
        if (permission === 'notifications') return callback(true);
        callback(false);
    });

    if (isAdmin()) createMainWindow(); else app.quit();
});
app.on('will-quit', () => restoreWindowsSystem());