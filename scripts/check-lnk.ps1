$sh = New-Object -ComObject WScript.Shell
$lnk = $sh.CreateShortcut("$env:USERPROFILE\Desktop\DeepSeek Chat.lnk")
Write-Output "target: $($lnk.TargetPath)"
Write-Output "iconloc: $($lnk.IconLocation)"
$icoPath = ($lnk.IconLocation -replace ',.*$','')
Write-Output "ico exists: $(Test-Path $icoPath)"
Write-Output "explorer: $((Get-Process explorer -ErrorAction SilentlyContinue).Id)"
Get-ChildItem "$env:LOCALAPPDATA\IconCache.db","$env:LOCALAPPDATA\Microsoft\Windows\Explorer\iconcache*" -ErrorAction SilentlyContinue | Select-Object Name,Length | Format-Table -AutoSize
