Add-Type -AssemblyName System.Drawing
$bytes = [IO.File]::ReadAllBytes("$PSScriptRoot\pelican.ico")
$count = [BitConverter]::ToUInt16($bytes, 4)
for ($i = 0; $i -lt $count; $i++) {
  $off = 6 + $i * 16
  $w = $bytes[$off]; if ($w -eq 0) { $w = 256 }
  $h = $bytes[$off + 1]; if ($h -eq 0) { $h = 256 }
  $size = [BitConverter]::ToUInt32($bytes, $off + 8)
  $pos = [BitConverter]::ToUInt32($bytes, $off + 12)
  $dib = New-Object byte[] $size
  [Array]::Copy($bytes, $pos, $dib, 0, $size)
  # 手工重建位图验证：读 BITMAPINFOHEADER + BGRA
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  for ($y = 0; $y -lt $h; $y++) {
    for ($x = 0; $x -lt $w; $x++) {
      $p = 40 + (($h - 1 - $y) * $w + $x) * 4
      $bmp.SetPixel($x, $y, [System.Drawing.Color]::FromArgb($dib[$p+3], $dib[$p+2], $dib[$p+1], $dib[$p]))
    }
  }
  $bmp.Save("$env:TEMP\ico-$w.png", [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output "entry $w x $h, $size bytes"
}
