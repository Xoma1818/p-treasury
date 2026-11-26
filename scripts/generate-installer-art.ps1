# Produce the two NSIS illustrations from the application's desktop icon.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$desktop = Join-Path $PSScriptRoot '../src-tauri'
$icon = [Drawing.Image]::FromFile((Join-Path $desktop 'icons/icon.png'))

function Write-Panel($Name, $Width, $Height, $Background, $Text, $IconBox, $FontSize, $WordBox) {
    $bitmap = [Drawing.Bitmap]::new($Width, $Height, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $font = [Drawing.Font]::new('Segoe UI Semibold', $FontSize, [Drawing.GraphicsUnit]::Pixel)
    $brush = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml($Text))
    $format = [Drawing.StringFormat]::new()
    try {
        $graphics.Clear([Drawing.ColorTranslator]::FromHtml($Background))
        $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::Half
        $graphics.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
        $graphics.DrawImage($icon, [Drawing.Rectangle]::new($IconBox[0], $IconBox[1], $IconBox[2], $IconBox[2]))
        $format.Alignment = 'Center'
        $format.LineAlignment = 'Center'
        $bounds = [Drawing.RectangleF]::new($WordBox[0], $WordBox[1], $WordBox[2], $WordBox[3])
        $graphics.DrawString('Kazna', $font, $brush, $bounds, $format)
        $bitmap.Save((Join-Path $desktop "windows/$Name.bmp"), [Drawing.Imaging.ImageFormat]::Bmp)
    } finally {
        $format.Dispose()
        $brush.Dispose()
        $font.Dispose()
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

try {
    Write-Panel 'header' 150 57 '#ffffff' '#14210a' @(17, 11, 35) 22 @(56, 0, 79, 57)
    Write-Panel 'sidebar' 164 314 '#141810' '#f3f5ed' @(50, 104, 64) 27 @(0, 171, 164, 44)
} finally {
    $icon.Dispose()
}
