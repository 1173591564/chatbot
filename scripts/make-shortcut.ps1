# 重建「DeepSeek Chat」桌面快捷方式。
# 注意：图标必须放在 %USERPROFILE% 之外——WScript.Shell 会把用户目录下的路径
# 压缩成 %USERPROFILE%\... 存进 .lnk，而 Explorer 解析图标时不展开这个变量 → 空白图标。
# %ALLUSERSPROFILE%（C:\ProgramData）是能被正常展开的，所以图标部署到那里。
$icoDst = 'C:\ProgramData\DeepSeekChat'
New-Item -ItemType Directory -Path $icoDst -Force | Out-Null
Copy-Item "$PSScriptRoot\pelican.ico" "$icoDst\deepseek.ico" -Force

$lnkPath = "$env:USERPROFILE\Desktop\DeepSeek Chat.lnk"
if (Test-Path $lnkPath) { Remove-Item $lnkPath -Force }
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($lnkPath)
$lnk.TargetPath = "$env:WINDIR\System32\wscript.exe"
$lnk.Arguments = '"C:\Users\11735\Desktop\Projects\chatbot\scripts\launch.vbs"'
$lnk.WorkingDirectory = 'C:\Users\11735\Desktop\Projects\chatbot'
$lnk.IconLocation = 'C:\ProgramData\DeepSeekChat\deepseek.ico,0'
$lnk.Description = 'Start DeepSeek chat server and open in browser'
$lnk.Save()
Write-Output "created: $lnkPath"
