const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

// 1. Phơi bày các hàm an toàn cho trang web (Bridge)
contextBridge.exposeInMainWorld('electronAPI', {
    sendPasscode: (code) => ipcRenderer.send('verify-passcode', code),
    printPage: () => ipcRenderer.send('silent-print'),
    reportActivity: () => ipcRenderer.send('user-activity'),
    clearSession: () => ipcRenderer.send('clear-session'),
    openQrScanner: () => ipcRenderer.send('open-qr-scanner')
});

// --- PHẦN QUẢN LÝ BÀN PHÍM ẢO ---

function injectKeyboard() {
    try {
        // Đọc file CSS và JS từ máy cục bộ để chạy offline
        const cssContent = fs.readFileSync(path.join(__dirname, 'simple-keyboard.css'), 'utf8');
        const jsContent = fs.readFileSync(path.join(__dirname, 'simple-keyboard.min.js'), 'utf8');

        // 1. Nhúng CSS
        if (!document.getElementById('kiosk-keyboard-css')) {
            const style = document.createElement('style');
            style.id = 'kiosk-keyboard-css';
            style.innerHTML = cssContent + `
                /* Tùy chỉnh thêm để bàn phím đẹp hơn trên Kiosk */
                #kiosk-keyboard-wrapper {
                    position: fixed; bottom: 0; left: 0; width: 100%; 
                    z-index: 2147483647; display: none; background: #f0f0f0; 
                    padding: 10px; box-shadow: 0 -5px 25px rgba(0,0,0,0.3);
                    user-select: none; -webkit-user-select: none;
                }
                .simple-keyboard { max-width: 1000px; margin: 0 auto; font-family: sans-serif; }
                .hg-button { height: 50px !important; font-size: 18px !important; }
            `;
            document.head.appendChild(style);
        }

        // 2. Tạo Container HTML
        if (!document.getElementById('kiosk-keyboard-wrapper')) {
            const wrapper = document.createElement('div');
            wrapper.id = 'kiosk-keyboard-wrapper';
            wrapper.innerHTML = '<div class="simple-keyboard"></div>';
            document.body.appendChild(wrapper);

            // 3. Thực thi JS Simple-keyboard
            const script = document.createElement('script');
            script.innerHTML = jsContent + `
                window.kioskKeyboard = new SimpleKeyboard.default({
                    onChange: input => {
                        const target = window.activeInput;
                        if (target) {
                            target.value = input;
                            target.dispatchEvent(new Event('input', { bubbles: true }));
                            target.dispatchEvent(new Event('change', { bubbles: true }));
                        }
                    },
                    onKeyPress: button => {
                        if (button === "{shift}" || button === "{lock}") {
                            const current = window.kioskKeyboard.options.layoutName;
                            window.kioskKeyboard.setOptions({ layoutName: current === "default" ? "shift" : "default" });
                        }
                        if (button === "{ent}") {
                            document.getElementById('kiosk-keyboard-wrapper').style.display = 'none';
                        }
                    },
                    layout: {
                        default: ["q w e r t y u i o p", "a s d f g h j k l", "{shift} z x c v b n m {backspace}", "{numbers} {space} {ent}"],
                        shift: ["Q W E R T Y U I O P", "A S D F G H J K L", "{shift} Z X C V B N M {backspace}", "{numbers} {space} {ent}"],
                        numbers: ["1 2 3", "4 5 6", "7 8 9", "{abc} 0 {backspace}"]
                    },
                    display: { "{ent}": "Xác nhận", "{backspace}": "⌫ Xóa", "{shift}": "⇧", "{space}": "Khoảng cách", "{numbers}": "123", "{abc}": "ABC" }
                });
            `;
            document.head.appendChild(script);
        }
    } catch (err) {
        console.error("Lỗi khi nhúng bàn phím ảo:", err);
    }
}

// --- QUẢN LÝ SỰ KIỆN ---

window.addEventListener('mousedown', () => ipcRenderer.send('user-activity'));
window.addEventListener('touchstart', () => ipcRenderer.send('user-activity'));

window.addEventListener('DOMContentLoaded', () => {
    // Chỉ nhúng bàn phím nếu đây không phải là trang QR scanner
    if (!window.location.href.includes('qr-scanner.html')) {
        injectKeyboard();
    }

    const handleFocus = (e) => {
        const tag = e.target.tagName.toLowerCase();
        const type = e.target.type ? e.target.type.toLowerCase() : 'text';
        const inputTypes = ['text', 'password', 'email', 'number', 'search', 'tel', 'url'];

        if (tag === 'textarea' || (tag === 'input' && inputTypes.includes(type))) {
            window.activeInput = e.target;
            
            // Cập nhật giá trị hiện tại vào bàn phím ảo
            if (window.kioskKeyboard) {
                window.kioskKeyboard.setInput(e.target.value);
            }

            // Hiện bàn phím
            const wrapper = document.getElementById('kiosk-keyboard-wrapper');
            if (wrapper) wrapper.style.display = 'block';

            // Cuộn ô input vào giữa tầm mắt để không bị bàn phím che
            setTimeout(() => {
                e.target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            }, 300);
        }
    };

    // Lắng nghe sự kiện focus
    document.addEventListener('focusin', handleFocus);

    // Click ra ngoài để đóng bàn phím
    document.addEventListener('click', (e) => {
        const wrapper = document.getElementById('kiosk-keyboard-wrapper');
        if (wrapper && !wrapper.contains(e.target) && 
            e.target.tagName !== 'INPUT' && 
            e.target.tagName !== 'TEXTAREA') {
            wrapper.style.display = 'none';
        }
    });

    // Xử lý messages (QR, v.v.)
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