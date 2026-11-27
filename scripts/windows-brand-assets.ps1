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
$process = Start-Process -FilePath $setup[0].FullName -ArgumentList '/S', "/D=$folder" -WindowStyle Hidden -Wait -PassThru
if ($process.ExitCode) { throw "Код установщика $($process.ExitCode)." }
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

$shell = New-Object -ComObject WScript.Shell
foreach ($place in 'Programs','DesktopDirectory') {
    $parent = [Environment]::GetFolderPath($place)
    $linkPath = (Get-Item -LiteralPath (Join-Path $parent "$product.lnk")).FullName
    $link = $shell.CreateShortcut($linkPath)
    if ($link.TargetPath -ne $exe -or $link.Arguments) { throw "Неверная команда ярлыка $linkPath — $($link.TargetPath) $($link.Arguments)" }
    $icon = $link.IconLocation
    if ($icon) {
        if ($icon -notmatch '^(.*),\s*0$') { throw "Неверный индекс значка ярлыка $linkPath — $icon" }
        $iconFile = [Environment]::ExpandEnvironmentVariables($Matches[1].Trim().Trim('"'))
        if ($iconFile -and [IO.Path]::GetFullPath($iconFile) -ne $exe) { throw "Неверный источник значка ярлыка $linkPath — $icon" }
    }
    Write-Output "PASS $linkPath → $exe (значок 0)"
}
