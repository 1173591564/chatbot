Add-Type -AssemblyName System.Drawing
try {
  $i = [System.Drawing.Icon]::new('C:\Users\11735\Desktop\Projects\chatbot\scripts\pelican.ico')
  Write-Output "loaded: $($i.Width)x$($i.Height)"
  $bmp = $i.ToBitmap()
  Write-Output "bitmap: $($bmp.Width)x$($bmp.Height) px:$($bmp.GetPixel(128,128).ToArgb())"
} catch {
  Write-Output "FAILED: $($_.Exception.Message)"
}
