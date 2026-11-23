#requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Source)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
    $env:RUNNER_OS -ne 'Windows') { throw 'W08 requires a disposable GitHub-hosted Windows runner.' }
$os = Get-CimInstance Win32_OperatingSystem
if ($os.ProductType -ne 1 -or [int]$os.BuildNumber -lt 22000) { throw 'Windows 11 client is required.' }
if (!(Test-Path -LiteralPath $env:GITHUB_WORKSPACE -PathType Container)) { throw 'Missing checkout workspace.' }
$checkout = (Get-Item -LiteralPath $Source).FullName
$relative = [IO.Path]::GetRelativePath((Get-Item -LiteralPath $env:GITHUB_WORKSPACE).FullName, $checkout)
if ([IO.Path]::IsPathRooted($relative) -or $relative -match '^\.\.(\\|/|$)' -or
    !(Test-Path -LiteralPath (Join-Path $checkout 'crates/core/tests/vault_edges.rs') -PathType Leaf)) {
    throw 'Expected a Kazna checkout in this job workspace.'
}

function Assert-PlainDirectoryTree([IO.DirectoryInfo]$Directory) {
    for ($d = $Directory; $null -ne $d; $d = $d.Parent) {
        if ($d.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing reparse point: $($d.FullName)" }
    }
}
function Get-OwnerSid([string]$Path) {
    (Get-Acl -LiteralPath $Path).GetOwner([Security.Principal.SecurityIdentifier]).Value
}
function Assert-ImageOwner {
    $file = Get-Item -LiteralPath $image
    if ($file.PSIsContainer -or $file.Attributes -band [IO.FileAttributes]::ReparsePoint -or
        $file.Directory.FullName -ne $jobDir -or (Get-OwnerSid $image) -ne $owner -or
        $file.Length -ne $diskSize + 512) { throw 'Unverified VHD path, owner, type or size.' }
}

# The formatter writes offsets only in this new, detached fixed-size VHD file.
# No physical device handles, disk-number selection or Windows volume formatting.
function Write-FatFixture([string]$Path, [uint32]$Signature, [string]$Label) {
    $stream = [IO.File]::Open($Path, 'Open', 'ReadWrite', 'None')
    try {
        $footer = [byte[]]::new(512)
        $stream.Position = $diskSize
        $stream.ReadExactly($footer,0,$footer.Length)
        if ([Text.Encoding]::ASCII.GetString($footer,0,8) -cne 'conectix' -or
            [Convert]::ToHexString($footer,60,4) -cne '00000002' -or
            [Convert]::ToHexString($footer,48,8) -cne '0000000002000000') { throw 'Expected a new fixed 32 MiB VHD.' }
        $mbr = [byte[]]::new(512)
        [BitConverter]::GetBytes($Signature).CopyTo($mbr,440)
        # LBA FAT16, first partition at 1 MiB, exactly 32768 sectors.
        ([byte[]](254,255,255,14,254,255,255)).CopyTo($mbr,447)
        [BitConverter]::GetBytes([uint32]2048).CopyTo($mbr,454)
        [BitConverter]::GetBytes([uint32]32768).CopyTo($mbr,458)
        $mbr[510] = 0x55; $mbr[511] = 0xaa
        $stream.Position = 0
        $stream.Write($mbr,0,$mbr.Length)
        $boot = [byte[]]::new(512)
        ([byte[]](0xeb,0x3c,0x90)).CopyTo($boot,0)
        [Text.Encoding]::ASCII.GetBytes('MSDOS5.0').CopyTo($boot,3)
        # 512 bytes/sector, 4 sectors/cluster, 1 reserved sector, 2 FATs,
        # 512 root entries, 32768 total sectors, 32 sectors in each FAT.
        ([byte[]](0,2,4,1,0,2,0,2,0,128,248,32,0,63,0,255,0)).CopyTo($boot,11)
        [BitConverter]::GetBytes([uint32]2048).CopyTo($boot,28)
        $boot[36] = 0x80; $boot[38] = 0x29
        [BitConverter]::GetBytes($Signature).CopyTo($boot,39)
        [Text.Encoding]::ASCII.GetBytes($Label).CopyTo($boot,43)
        [Text.Encoding]::ASCII.GetBytes('FAT16   ').CopyTo($boot,54)
        $boot[510] = 0x55; $boot[511] = 0xaa
        $stream.Position = 1MB
        $stream.Write($boot,0,$boot.Length)
        foreach ($sector in 1,33) {
            $stream.Position = 1MB + $sector * 512
            $stream.Write([byte[]](248,255,255,255),0,4)
        }
        $stream.Position = 1MB + 65 * 512
        $stream.Write([Text.Encoding]::ASCII.GetBytes($Label),0,11)
        $stream.WriteByte(8) # a root directory volume label
        $stream.Flush($true)
    } finally { $stream.Dispose() }
}

$temp = Get-Item -LiteralPath $env:RUNNER_TEMP
if ($temp.FullName -notmatch '^[A-Za-z]:\\' -or $temp.FullName -match '[\r\n"]') { throw 'Invalid runner temp path.' }
Assert-PlainDirectoryTree $temp
$jobDir = Join-Path $temp.FullName ('kazna-w08-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $jobDir
Assert-PlainDirectoryTree (Get-Item -LiteralPath $jobDir)
$owner = Get-OwnerSid $jobDir
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if ($owner -notin @($userSid,'S-1-5-32-544')) { throw 'Unexpected owner of the new runner directory.' }
$diskSize = 32MB
$image = Join-Path $jobDir 'w08.vhd'
$script = Join-Path $jobDir 'create.txt'
if (Test-Path -LiteralPath $image) { throw 'Expected a new VHD file.' }
[IO.File]::WriteAllLines($script, @("create vdisk file=`"$image`" maximum=32 type=fixed",'exit'), [Text.Encoding]::ASCII)
& (Join-Path $env:SystemRoot 'System32/diskpart.exe') /s $script
if ($LASTEXITCODE -ne 0) { throw 'Could not create the new fixed-size VHD.' }
Assert-ImageOwner
$signature = [uint32][Security.Cryptography.RandomNumberGenerator]::GetInt32(1,2147483647)
$label = 'W08' + $signature.ToString('X8')
Write-FatFixture $image $signature $label
$attemptedMount = $false
try {
    Assert-ImageOwner
    $attemptedMount = $true
    $null = Mount-DiskImage -ImagePath $image -StorageType VHD -Access ReadWrite -NoDriveLetter -PassThru
    $attached = Get-DiskImage -ImagePath $image
    $disks = @($attached | Get-Disk)
    if (!$attached.Attached -or $attached.ImagePath -ne $image -or $disks.Count -ne 1) { throw 'Could not identify the new VHD.' }
    $disk = $disks[0]
    if ($attached.DevicePath -ne ("\\.\PhysicalDrive" + $disk.Number) -or $disk.Size -ne $diskSize -or
        $disk.Signature -ne $signature -or $disk.PartitionStyle -ne 'MBR' -or $disk.IsBoot -or $disk.IsSystem) {
        throw 'Virtual disk failed its path, signature, size or system-disk check.'
    }
    $parts = @($disk | Get-Partition)
    if ($parts.Count -ne 1 -or $parts[0].DiskNumber -ne $disk.Number -or $parts[0].Offset -ne 1MB -or
        $parts[0].Size -ne 16MB) { throw 'Expected the one 16 MiB fixture partition.' }
    $part = $parts[0]
    $volumes = @($part | Get-Volume)
    if ($volumes.Count -ne 1 -or $volumes[0].FileSystem -notin @('FAT','FAT16') -or
        $volumes[0].FileSystemLabel -ne $label -or $volumes[0].Size -lt 15MB -or
        $volumes[0].Size -gt 16MB) { throw 'Expected the unique FAT16 volume created inside the VHD.' }
    $null = Add-PartitionAccessPath -InputObject $part -AssignDriveLetter
    $volume = Get-Volume -UniqueId $volumes[0].UniqueId
    if ("$($volume.DriveLetter)" -notmatch '^[D-Z]$' -or $volume.FileSystemLabel -ne $label) { throw 'Could not verify the assigned letter.' }
    $byLetter = Get-Partition -DriveLetter $volume.DriveLetter
    if ($byLetter.DiskNumber -ne $part.DiskNumber -or $byLetter.PartitionNumber -ne $part.PartitionNumber -or
        $byLetter.Size -ne 16MB -or $byLetter.Offset -ne 1MB) { throw 'Assigned letter resolved to another partition.' }
    $root = "$($volume.DriveLetter):\"
    # Separate OS probe: records the exact Win32 error on this identified FAT16 volume.
    $probe = Join-Path $root 'w08-probe.bin'
    $out = [IO.File]::Open($probe,'CreateNew','Write','None')
    $win32 = 0
    try {
        $block = [byte[]]::new(1MB)
        for ($i = 0; $i -lt 17; $i++) { $out.Write($block,0,$block.Length); $out.Flush($true) }
    } catch [IO.IOException] {
        $win32 = $_.Exception.GetBaseException().HResult -band 0xffff
    } finally { $out.Dispose() }
    if ($win32 -notin @(39,112)) { throw "Expected ERROR_DISK_FULL on the fixture, received $win32." }
    [IO.File]::Delete($probe)
    [IO.File]::WriteAllText((Join-Path $root '.kazna-test-volume-16mib'), $label)
    Write-Host "W08 platform=$($os.Caption) build=$($os.BuildNumber) volume=$label bytes=$($part.Size) win32_probe=$win32"
    $previous = $env:KAZNA_FULL_DIR
    Push-Location -LiteralPath $checkout
    try {
        $env:KAZNA_FULL_DIR = $root
        $test = 'full_disk_keeps_last_good_copy_and_leaves_no_parts'
        $log = Join-Path $jobDir 'w08-rust.log'
        & cargo test --color never -p budget-core --locked --test vault_edges -- --ignored --exact $test --nocapture 2>&1 | Tee-Object -FilePath $log
        if ($LASTEXITCODE -ne 0 -or !(Select-String -LiteralPath $log -Pattern "^test $test \.\.\. ok$" -Quiet) -or
            !(Select-String -LiteralPath $log -SimpleMatch '1 passed; 0 failed; 0 ignored' -Quiet)) {
            throw 'The expected backup failure/recovery test did not pass exactly once.'
        }
        Write-Host 'W08 Rust assertions passed: old backup byte-identical and restored, live balance preserved, new backup restored after free space, no .part files.'
    } finally { $env:KAZNA_FULL_DIR = $previous; Pop-Location }
} finally {
    if ($attemptedMount) {
        Assert-ImageOwner
        $current = Get-DiskImage -ImagePath $image
        if ($current.Attached -and $current.ImagePath -eq $image) { Dismount-DiskImage -ImagePath $image }
    }
    # The runner disposes of this unique directory with its temporary VM.
}
