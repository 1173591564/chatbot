$lnkPath = "$env:USERPROFILE\Desktop\DeepSeek Chat.lnk"
if (Test-Path $lnkPath) { Remove-Item $lnkPath -Force }
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = 'C:\Users\11735\Desktop\Projects\chatbot\scripts\launcher.exe'
$lnk.WorkingDirectory = 'C:\Users\11735\Desktop\Projects\chatbot'
$lnk.Description = 'Start DeepSeek chat server and open in browser'
$lnk.Save()
Write-Output "created: $lnkPath"
