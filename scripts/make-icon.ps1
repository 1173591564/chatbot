Add-Type -AssemblyName System.Drawing
$S = 256
$k = $S / 108.0
$b = New-Object System.Drawing.Bitmap $S, $S
$g = [System.Drawing.Graphics]::FromImage($b)
$g.SmoothingMode = 'AntiAlias'

$paper = [System.Drawing.Color]::FromArgb(247,245,240)
$terra = [System.Drawing.Color]::FromArgb(158,83,48)
$r = [int]($S * 0.22)
$gp = New-Object System.Drawing.Drawing2D.GraphicsPath
$d = $r * 2
$gp.AddArc(0, 0, $d, $d, 180, 90)
$gp.AddArc($S - $d, 0, $d, $d, 270, 90)
$gp.AddArc($S - $d, $S - $d, $d, $d, 0, 90)
$gp.AddArc(0, $S - $d, $d, $d, 90, 90)
$gp.CloseFigure()
$g.FillPath([System.Drawing.SolidBrush]::new($terra), $gp)

function Cubic($x1,$y1,$x2,$y2,$x3,$y3,$x4,$y4,$w,$a) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $sc = $k
  $p.AddBezier($x1*$sc,$y1*$sc,$x2*$sc,$y2*$sc,$x3*$sc,$y3*$sc,$x4*$sc,$y4*$sc)
  $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb($a,247,245,240)), ($w*$sc)
  $pen.StartCap = 'Round'; $pen.EndCap = 'Round'
  $g.DrawPath($pen, $p)
  $pen.Dispose(); $p.Dispose()
}
Cubic 34 72 24 66 22 54 30 46 3.4 255
Cubic 30 46 36 40 46 38 54 41 3.4 255
Cubic 54 41 58 32 66 26 74 26 3.4 255
Cubic 40 58 46 54 54 54 60 58 2.6 140
$beak = @(
  [System.Drawing.PointF]::new(74*$k, 26*$k),
  [System.Drawing.PointF]::new(88*$k, 31*$k),
  [System.Drawing.PointF]::new(76*$k, 38*$k)
)
$g.FillPolygon([System.Drawing.SolidBrush]::new($paper), $beak)
$er = 1.3*$k
$g.FillEllipse([System.Drawing.SolidBrush]::new($terra), (75.5*$k-$er), (27.5*$k-$er), $er*2, $er*2)
$g.Dispose()

# ---- 经典 DIB 格式 ICO：16/32/48/64 四档 ----
$sizes = 16, 32, 48, 64
$ms = New-Object IO.MemoryStream
$bw = New-Object IO.BinaryWriter $ms
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
$dibs = @()
foreach ($n in $sizes) {
  $thumb = New-Object System.Drawing.Bitmap $n, $n
  $tg = [System.Drawing.Graphics]::FromImage($thumb)
  $tg.InterpolationMode = 'HighQualityBicubic'
  $tg.DrawImage($b, 0, 0, $n, $n)
  $tg.Dispose()
  $maskRow = [math]::Floor(($n + 31) / 32) * 4
  $dib = New-Object IO.MemoryStream
  $dw = New-Object IO.BinaryWriter $dib
  $dw.Write([uint32]40); $dw.Write([int32]$n); $dw.Write([int32]($n*2))
  $dw.Write([uint16]1); $dw.Write([uint16]32); $dw.Write([uint32]0)
  $dw.Write([uint32]($n*$n*4 + $maskRow*$n)); $dw.Write([uint32]0); $dw.Write([uint32]0); $dw.Write([uint32]0); $dw.Write([uint32]0)
  for ($y = $n-1; $y -ge 0; $y--) {
    for ($x = 0; $x -lt $n; $x++) {
      $c = $thumb.GetPixel($x, $y)
      $dw.Write([byte]$c.B); $dw.Write([byte]$c.G); $dw.Write([byte]$c.R); $dw.Write([byte]$c.A)
    }
  }
  $dw.Write((New-Object byte[] ($maskRow*$n)), 0, $maskRow*$n)
  $dibs += ,$dib.ToArray()
  $dw.Dispose(); $dib.Dispose(); $thumb.Dispose()
}
foreach ($i in 0..($sizes.Count-1)) {
  $n = $sizes[$i]
  $bw.Write([byte]$n); $bw.Write([byte]$n); $bw.Write([byte]0); $bw.Write([byte]0)
  $bw.Write([uint16]1); $bw.Write([uint16]32)
  $bw.Write([uint32]$dibs[$i].Length); $bw.Write([uint32]$offset)
  $offset += $dibs[$i].Length
}
foreach ($dib in $dibs) { $bw.Write($dib) }
[IO.File]::WriteAllBytes("$PSScriptRoot\pelican.ico", $ms.ToArray())
$bw.Dispose(); $ms.Dispose(); $b.Dispose()
Write-Output "ico written"
