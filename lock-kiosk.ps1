# Kiểm tra quyền Admin
if (-NOT ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole] "Administrator")) {
    exit 1
}

# 1. Khóa cử chỉ 3 và 4 ngón (Vuốt lên/xuống/trái/phải)
$path = "HKCU:\Software\Microsoft\Windows\CurrentVersion\PrecisionTouchPad"
if (-not (Test-Path $path)) { New-Item -Path $path -Force }
Set-ItemProperty -Path $path -Name "ThreeFingerSlideEnabled" -Value 0
Set-ItemProperty -Path $path -Name "FourFingerSlideEnabled" -Value 0
Set-ItemProperty -Path $path -Name "ThreeFingerTapEnabled" -Value 0
Set-ItemProperty -Path $path -Name "FourFingerTapEnabled" -Value 0

# 2. Khóa thu phóng (Pinch Zoom) 2 ngón
Set-ItemProperty -Path $path -Name "PinchEnabled" -Value 0

# 3. Khóa vuốt mép màn hình (Edge Swipe - Vuốt từ ngoài vào)
$edgePath = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\EdgeUI"
if (-not (Test-Path $edgePath)) { New-Item -Path $edgePath -Force }
Set-ItemProperty -Path $edgePath -Name "AllowEdgeSwipe" -Value 0

# 4. Khởi động lại Explorer để áp dụng thay đổi ngay lập tức
Stop-Process -Name explorer -Force