window.electronAPI.onUIState((state) => {
    const statusText = document.getElementById('status');
    const orbBox = document.getElementById('orb-box');
    const hud = document.getElementById('hud');
    const body = document.body;

    body.className = state;

    if (state === 'loading') {
        statusText.innerText = "ĐANG KHỞI TẠO...";
        statusText.style.letterSpacing = "15px";
    } 
    else if (state === 'active') {
        statusText.innerText = "KẾT QUẢ PHÂN TÍCH";
        hud.classList.add('visible');
    } 
    else if (state === 'closing') {
        statusText.innerText = "ĐANG ĐÓNG...";
        hud.classList.remove('visible');
    }
    else {
        statusText.innerText = "HỆ THỐNG SẴN SÀNG";
        statusText.style.letterSpacing = "10px";
        hud.classList.remove('visible');
    }
});