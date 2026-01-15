# ===============================
# UNLOCK TOUCHSCREEN
# ===============================

Write-Host "🔓 Enabling Touchscreen..."

Get-PnpDevice |
Where-Object {
    $_.Class -eq "HIDClass" -and
    $_.FriendlyName -match "Touch"
} |
ForEach-Object {
    Write-Host "✅ Enable: $($_.FriendlyName)"
    Enable-PnpDevice -InstanceId $_.InstanceId -Confirm:$false
}

Write-Host "✅ Touchscreen Enabled"
