$lnkPath = "$env:USERPROFILE\Desktop\DeepSeek Chat.lnk"
if (Test-Path $lnkPath) { Remove-Item $lnkPath -Force }
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = "$env:WINDIR\System32\wscript.exe"
$lnk.Arguments = '"C:\Users\11735\Desktop\Projects\chatbot\scripts\launch.vbs"'
$lnk.WorkingDirectory = 'C:\Users\11735\Desktop\Projects\chatbot'
$lnk.IconLocation = 'C:\Users\11735\Desktop\Projects\chatbot\scripts\pelican.ico,0'
$lnk.Description = 'Start DeepSeek chat server and open in browser'
$lnk.Save()
Write-Output "created: $lnkPath"
