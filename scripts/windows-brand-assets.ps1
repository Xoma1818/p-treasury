# Без параметров проверяет установщик этой сборки на одноразовой машине GitHub.
# -CheckExe только читает ресурсы указанного файла.
param([string]$CheckExe)
$ErrorActionPreference = 'Stop'
if (!$CheckExe -and (!$IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted')) {
    throw 'Установка разрешена только на одноразовой Windows от GitHub.'
}
$repo = Split-Path $PSScriptRoot -Parent
Add-Type -AssemblyName PresentationCore

# Восстанавливаем первую группу значков PE (значок оболочки с индексом 0).
# LoadLibraryEx с LOAD_LIBRARY_AS_DATAFILE только читает ресурсы.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
public static class KaznaIconGroup {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    struct ShellFileInfo {
        public IntPtr icon;
        public int index;
        public uint attributes;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=260)] public string display;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=80)] public string type;
    }
    [DllImport("shell32", CharSet=CharSet.Unicode)] static extern IntPtr SHGetFileInfo(string path, uint attributes, out ShellFileInfo info, uint size, uint flags);
    [DllImport("user32")] public static extern bool DestroyIcon(IntPtr icon);
    public static IntPtr FromShell(string path) {
        ShellFileInfo info;
        if (SHGetFileInfo(path, 0, out info, (uint)Marshal.SizeOf(typeof(ShellFileInfo)), 0x100) == IntPtr.Zero || info.icon == IntPtr.Zero)
            throw new IOException("No shell icon for " + path);
        return info.icon;
    }
    delegate bool EnumName(IntPtr module, IntPtr type, IntPtr name, IntPtr param);
    [DllImport("kernel32", CharSet=CharSet.Unicode)] static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);
    [DllImport("kernel32")] static extern bool FreeLibrary(IntPtr module);
    [DllImport("kernel32", EntryPoint="EnumResourceNamesW")] static extern bool EnumNames(IntPtr module, IntPtr type, EnumName callback, IntPtr param);
    [DllImport("kernel32", EntryPoint="FindResourceW")] static extern IntPtr Find(IntPtr module, IntPtr name, IntPtr type);
    [DllImport("kernel32")] static extern uint SizeofResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32")] static extern IntPtr LoadResource(IntPtr module, IntPtr resource);
    [DllImport("kernel32")] static extern IntPtr LockResource(IntPtr resource);

    static byte[] Read(IntPtr module, IntPtr resource) {
        if (resource == IntPtr.Zero) throw new InvalidDataException("Icon resource missing");
        var bytes = new byte[SizeofResource(module, resource)];
        Marshal.Copy(LockResource(LoadResource(module, resource)), bytes, 0, bytes.Length);
        return bytes;
    }
    public static byte[] FromExe(string path) {
        var module = LoadLibraryEx(path, IntPtr.Zero, 2);
        if (module == IntPtr.Zero) throw new IOException("Cannot read " + path);
        try {
            IntPtr group = IntPtr.Zero;
            EnumNames(module, (IntPtr)14, (h,t,n,p) => { group = Find(h,n,t); return false; }, IntPtr.Zero);
            var dir = Read(module, group);
            int count = BitConverter.ToUInt16(dir, 4);
            using (var output = new MemoryStream())
            using (var writer = new BinaryWriter(output)) {
                writer.Write(dir, 0, 6);
                var frames = new byte[count][];
                int offset = 6 + count * 16;
                for (int i = 0; i < count; i++) {
                    int entry = 6 + i * 14;
                    int id = BitConverter.ToUInt16(dir, entry + 12);
                    frames[i] = Read(module, Find(module, (IntPtr)id, (IntPtr)3));
                    writer.Write(dir, entry, 8);
                    writer.Write(frames[i].Length);
                    writer.Write(offset);
                    offset += frames[i].Length;
                }
                foreach (var frame in frames) writer.Write(frame);
                return output.ToArray();
            }
        } finally { FreeLibrary(module); }
    }
}
'@

function Get-PixelHashes([byte[]]$ico) {
    $stream = [IO.MemoryStream]::new($ico)
    try {
        $decoder = [Windows.Media.Imaging.IconBitmapDecoder]::new($stream, 'PreservePixelFormat', 'OnLoad')
        $hashes = @{}
        foreach ($frame in $decoder.Frames) {
            $size = $frame.PixelWidth
            if ($size -ne $frame.PixelHeight -or $hashes.ContainsKey($size)) { throw "Некорректный кадр значка шириной $size." }
            # Сравнение видимых пикселей допускает иной кодек и выравнивание ресурсов NSIS.
            $bitmap = [Windows.Media.Imaging.FormatConvertedBitmap]::new($frame, [Windows.Media.PixelFormats]::Pbgra32, $null, 0)
            $pixels = [byte[]]::new($size * $size * 4)
            $bitmap.CopyPixels($pixels, $size * 4, 0)
            $hashes[$size] = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($pixels))
        }
        return $hashes
    } finally { $stream.Dispose() }
}

$source = Get-PixelHashes ([IO.File]::ReadAllBytes((Join-Path $repo 'src-tauri/icons/icon.ico')))
$sizes = 16,20,24,32,40,48,64,128,256
function Assert-Icon([string]$path) {
    $actual = Get-PixelHashes ([KaznaIconGroup]::FromExe((Get-Item -LiteralPath $path).FullName))
    foreach ($size in $sizes) {
        if (!$source.ContainsKey($size) -or $actual[$size] -ne $source[$size]) { throw "Кадр ${size}px отсутствует или отличается в $path." }
    }
    Write-Output "PASS $path — $($sizes -join ', ') px"
}
if ($CheckExe) { Assert-Icon $CheckExe; return }

$config = Get-Content (Join-Path $repo 'src-tauri/tauri.conf.json') -Raw | ConvertFrom-Json
$product = $config.productName
$setup = @(Get-ChildItem (Join-Path $repo 'target/release/bundle/nsis') -File -Filter "${product}_$($config.version)_*-setup.exe")
if ($setup.Count -ne 1) { throw "Ожидался один установщик $product $($config.version), найдено $($setup.Count)." }
Assert-Icon $setup[0].FullName
$folder = Join-Path $env:RUNNER_TEMP ('kazna-brand-' + [guid]::NewGuid().ToString('N'))
function Install-BrandBuild([string]$installer, [string[]]$options) {
    $process = Start-Process -FilePath $installer -ArgumentList ($options + "/D=$folder") -WindowStyle Hidden -Wait -PassThru
    if ($process.ExitCode) { throw "Код установщика $($process.ExitCode)." }
}
$shell = New-Object -ComObject WScript.Shell
$explorer = New-Object -ComObject Shell.Application
function Read-AppId([string]$path) {
    return [string]$explorer.NameSpace((Split-Path $path)).ParseName((Split-Path -Leaf $path)).ExtendedProperty('System.AppUserModel.ID')
}
$links = @{}
$evidence = New-Item -ItemType Directory -Path (Join-Path $env:RUNNER_TEMP 'kazna-shell-icons') -Force
foreach ($place in 'Programs','DesktopDirectory') {
    $links[$place] = Join-Path ([Environment]::GetFolderPath($place)) "$product.lnk"
}
# Check the Shell's rendered pixels, including its cache, not just the source file's resources.
function Assert-ShellArtwork([string]$linkPath, [string]$phase) {
    $until = [DateTime]::UtcNow.AddSeconds(10)
    do {
        $icon = [KaznaIconGroup]::FromShell($linkPath)
        try {
            $image = [Windows.Interop.Imaging]::CreateBitmapSourceFromHIcon($icon, [Windows.Int32Rect]::Empty,
                [Windows.Media.Imaging.BitmapSizeOptions]::FromEmptyOptions())
            $bitmap = [Windows.Media.Imaging.FormatConvertedBitmap]::new($image, [Windows.Media.PixelFormats]::Bgra32, $null, 0)
            $stride = 4 * $bitmap.PixelWidth
            $pixels = [byte[]]::new($stride * $bitmap.PixelHeight)
            $bitmap.CopyPixels($pixels, $stride, 0)
            $matchesColor = 0
            for ($i = 0; $i -lt $pixels.Length; $i += 4) {
                $b, $g, $r, $a = $pixels[$i..($i+3)]
                if ($a -ge 245 -and (($phase -eq 'before' -and $g -gt 200 -and $r -lt 205 -and $b -lt 140) -or
                    ($phase -eq 'after' -and $r -gt 230 -and $g -ge 125 -and $g -lt 185 -and $b -le 150))) { $matchesColor++ }
            }
        } finally { [void][KaznaIconGroup]::DestroyIcon($icon) }
        if ($matchesColor -gt $bitmap.PixelWidth * $bitmap.PixelHeight / 5) {
            $place = if ($linkPath -eq $links.DesktopDirectory) { 'desktop' } else { 'start' }
            $encoder = [Windows.Media.Imaging.PngBitmapEncoder]::new()
            $encoder.Frames.Add([Windows.Media.Imaging.BitmapFrame]::Create($bitmap))
            $stream = [IO.File]::Create((Join-Path $evidence.FullName "$phase-$place.png"))
            try { $encoder.Save($stream) } finally { $stream.Dispose() }
            Write-Output "PASS Shell $phase $linkPath — $matchesColor пикселей марки"
            return
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $until)
    throw "Оболочка не показала ожидаемый значок $phase у $linkPath"
}

# Reproduce the old lime default icon, read it through the Shell, then use the
# same NSIS update flags as Kazna's updater. Do not invoke the new app during QA.
$old = Join-Path $env:RUNNER_TEMP 'Kazna_0.43.0_x64-setup.exe'
Invoke-WebRequest -Uri 'https://github.com/Xoma1818/p-treasury-releases/releases/download/v0.43.0/Kazna_0.43.0_x64-setup.exe' -OutFile $old
if ((Get-FileHash $old).Hash -ne '600BF54566D3288B55D248935D8EEE58F4B0D3DAE5B05B3AB94314240EE9ADCA') { throw 'Изменился контрольный установщик 0.43.0' }
Install-BrandBuild $old @('/S')
foreach ($path in $links.Values) { Assert-ShellArtwork $path 'before' }
$link = $shell.CreateShortcut($links.DesktopDirectory)
$link.Arguments = '--test-type=webdriver'
$link.Description = 'Kazna link test'
$link.Save()
$oldIds = @{}
foreach ($place in $links.Keys) { $oldIds[$place] = Read-AppId $links[$place] }
if ($oldIds.Programs -ne $config.identifier) { throw 'В исходном ярлыке Пуска отсутствует AppUserModelID Kazna.' }
Install-BrandBuild $setup[0].FullName @('/P','/UPDATE')
$exe = (Get-Item -LiteralPath (Join-Path $folder "$($config.mainBinaryName).exe")).FullName
$portableExe = Join-Path $repo "portable/$product.exe"
# Tauri помечает EXE внутри установщика типом NSIS. Сверяем версию и изображения обеих сборок.
foreach ($binary in $exe, $portableExe) {
    $version = (Get-Item -LiteralPath $binary).VersionInfo
    if ($version.ProductName -ne $product -or $version.ProductVersion -ne $config.version) {
        throw "Неверное имя или версия в $binary — $($version.ProductName) $($version.ProductVersion)."
    }
    Assert-Icon $binary
}
Assert-Icon (Join-Path $folder 'uninstall.exe')

$iconFile = Join-Path $folder 'kazna-fold.ico'
if ((Get-FileHash $iconFile).Hash -ne (Get-FileHash (Join-Path $repo 'src-tauri/icons/icon.ico')).Hash) {
    throw 'Установленный ICO отличается от исходного Сгиба.'
}
foreach ($place in 'Programs','DesktopDirectory') {
    $linkPath = (Get-Item -LiteralPath $links[$place]).FullName
    $link = $shell.CreateShortcut($linkPath)
    if ((Read-AppId $linkPath) -ne $oldIds[$place]) { throw "Изменился AppUserModelID ярлыка $place." }
    if ($link.TargetPath -ne $exe -or $link.IconLocation -ne "$iconFile,0") { throw "Неверный ярлык $linkPath — $($link.IconLocation)" }
    if ($place -eq 'DesktopDirectory') {
        if ($link.Arguments -ne '--test-type=webdriver' -or $link.Description -ne 'Kazna link test') { throw 'Утрачены свойства ярлыка.' }
    } elseif ($link.Arguments) {
        throw 'Изменилась команда ярлыка Пуск.'
    }
    Assert-ShellArtwork $linkPath 'after'
}

# A repeated in-app update respects a renamed desktop shortcut and a custom icon.
$renamed = Join-Path (Split-Path $links.DesktopDirectory) 'Personal Kazna.lnk'
Rename-Item -LiteralPath $links.DesktopDirectory -NewName (Split-Path -Leaf $renamed)
$custom = "$env:SystemRoot\System32\shell32.dll,4"
$link = $shell.CreateShortcut($links.Programs)
$link.IconLocation = $custom
$link.Save()
$custom = $shell.CreateShortcut($links.Programs).IconLocation
Install-BrandBuild $setup[0].FullName @('/P','/UPDATE')
if ((Test-Path -LiteralPath $links.DesktopDirectory) -or !(Test-Path -LiteralPath $renamed) -or
    $shell.CreateShortcut($links.Programs).IconLocation -ne $custom) { throw 'Утрачены личные настройки ярлыков.' }
Write-Output 'PASS повторное обновление сохраняет переименование и личный значок'

# Retain coverage of the fresh silent installation path, too.
Rename-Item -LiteralPath $renamed -NewName (Split-Path -Leaf $links.DesktopDirectory)
$process = Start-Process (Join-Path $folder 'uninstall.exe') -ArgumentList '/S', "_?=$folder" -WindowStyle Hidden -Wait -PassThru
if ($process.ExitCode -or (Test-Path -LiteralPath $exe) -or (Test-Path -LiteralPath $iconFile)) { throw 'Не удалось удалить тестовую установку.' }
Install-BrandBuild $setup[0].FullName @('/S')
foreach ($path in $links.Values) {
    $link = $shell.CreateShortcut($path)
    if ($link.TargetPath -ne $exe -or $link.Arguments -or $link.IconLocation -ne "$iconFile,0") {
        throw "Неверные свойства нового ярлыка $path"
    }
    Assert-ShellArtwork $path 'fresh'
}
