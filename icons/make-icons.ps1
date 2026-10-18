# Regenerates the PNG icons. Run: powershell -ExecutionPolicy Bypass -File icons\make-icons.ps1
Add-Type -AssemblyName System.Drawing
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
foreach ($size in 16, 32, 48, 128) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = 'AntiAlias'
    $g.TextRenderingHint = 'AntiAliasGridFit'
    $g.Clear([System.Drawing.Color]::Transparent)

    # Rounded red square
    $r = [single]($size * 0.22)
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $w = [single]($size - 1)
    $path.AddArc(0, 0, $r * 2, $r * 2, 180, 90)
    $path.AddArc($w - $r * 2, 0, $r * 2, $r * 2, 270, 90)
    $path.AddArc($w - $r * 2, $w - $r * 2, $r * 2, $r * 2, 0, 90)
    $path.AddArc(0, $w - $r * 2, $r * 2, $r * 2, 90, 90)
    $path.CloseFigure()
    $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 217, 48, 37))), $path)

    # Up and down triangles
    $white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
    $cx = [single]($size / 2)
    $tw = [single]($size * 0.30)
    $th = [single]($size * 0.24)
    $gap = [single]($size * 0.07)
    $up = [System.Drawing.PointF[]]@(
        (New-Object System.Drawing.PointF ($cx - $tw), ($cx - $gap)),
        (New-Object System.Drawing.PointF ($cx + $tw), ($cx - $gap)),
        (New-Object System.Drawing.PointF $cx, ($cx - $gap - $th))
    )
    $down = [System.Drawing.PointF[]]@(
        (New-Object System.Drawing.PointF ($cx - $tw), ($cx + $gap)),
        (New-Object System.Drawing.PointF ($cx + $tw), ($cx + $gap)),
        (New-Object System.Drawing.PointF $cx, ($cx + $gap + $th))
    )
    $g.FillPolygon($white, $up)
    $g.FillPolygon($white, $down)

    $g.Dispose()
    $bmp.Save((Join-Path $dir "icon$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
}
