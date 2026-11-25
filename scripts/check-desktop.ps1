$real = [Environment]::GetFolderPath('Desktop')
Write-Output "real desktop: $real"
Write-Output "userprofile:  $env:USERPROFILE\Desktop"
Get-ChildItem $real -Filter "DeepSeek*" -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Output "on real desktop: $($_.FullName) ($($_.Length) bytes, $($_.LastWriteTime))"
}
Get-ChildItem "$env:USERPROFILE\Desktop" -Filter "DeepSeek*" -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Output "on profile desktop: $($_.FullName) ($($_.Length) bytes, $($_.LastWriteTime))"
}
$sh = New-Object -ComObject WScript.Shell
foreach ($p in @("$real\DeepSeek Chat.lnk", "$env:USERPROFILE\Desktop\DeepSeek Chat.lnk")) {
  if (Test-Path $p) {
    $l = $sh.CreateShortcut($p)
    Write-Output "$p`n  icon=$($l.IconLocation)"
  }
}
