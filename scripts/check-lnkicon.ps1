Add-Type -AssemblyName System.Drawing
$lnk = "$env:USERPROFILE\Desktop\DeepSeek Chat.lnk"
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($lnk)
$bmp = $icon.ToBitmap()
$out = "$env:TEMP\lnk-icon.png"
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "resolved: $($icon.Width)x$($icon.Height) -> $out"
