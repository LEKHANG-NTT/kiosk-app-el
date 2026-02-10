const { contextBridge, ipcRenderer } = require('electron');

// 1. Phơi bày các hàm an toàn cho trang web (Bridge)
contextBridge.exposeInMainWorld('electronAPI', {
    // Gửi mã PIN để xác thực thoát App
    sendPasscode: (code) => ipcRenderer.send('verify-passcode', code),
    
    // Ra lệnh in thầm lặng (Silent Print) từ giao diện Web
    printPage: () => ipcRenderer.send('silent-print'),
    
    // Cho phép web thủ công báo cáo hoạt động (nếu cần)
    reportActivity: () => ipcRenderer.send('user-activity'),

    // Yêu cầu clear session (cookies / storage)
    clearSession: () => ipcRenderer.send('clear-session'),

    // Yêu cầu mở QR scanner (mở trang nội bộ cung cấp scanner)
    openQrScanner: () => ipcRenderer.send('open-qr-scanner')
});

// 2. Tự động theo dõi hoạt động (Idle Timeout)
// Mỗi khi người dùng chạm hoặc click, thông báo cho Main Process để reset bộ đếm thời gian
window.addEventListener('mousedown', () => {
    ipcRenderer.send('user-activity');
});

window.addEventListener('touchstart', () => {
    ipcRenderer.send('user-activity');
});

// 3. Tự động gọi Bàn phím ảo (Virtual Keyboard)
window.addEventListener('DOMContentLoaded', () => {
    const handleFocus = (e) => {
        const tag = e.target.tagName.toLowerCase();
        const type = e.target.type ? e.target.type.toLowerCase() : '';
        
        // Các loại input cần bàn phím ảo
        const inputTypes = ['text', 'password', 'email', 'number', 'search', 'tel', 'url'];
        
        if (tag === 'textarea' || (tag === 'input' && inputTypes.includes(type))) {
            ipcRenderer.send('open-virtual-keyboard');
        }
    };

    // Lắng nghe sự kiện focus trên toàn trang (Event Delegation)
    document.addEventListener('focusin', handleFocus);

    // Forward in-window messages (e.g., qr scanner posts) to main
    window.addEventListener('message', (e) => {
        try {
            if (e.data && e.data.type === 'qr') {
                ipcRenderer.send('qr-detected', e.data.data);
            } else if (e.data && e.data.type === 'qr-home') {
                ipcRenderer.send('qr-home');
            }
        } catch (err) { }
    });
});