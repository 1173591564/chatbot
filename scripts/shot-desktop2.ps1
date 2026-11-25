Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
(New-Object -ComObject Shell.Application).ToggleDesktop()
Start-Sleep -Milliseconds 900
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$bmp.Save("$env:TEMP\desktop2.png", [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Start-Sleep -Milliseconds 300
(New-Object -ComObject Shell.Application).ToggleDesktop()
Write-Output "shot"
