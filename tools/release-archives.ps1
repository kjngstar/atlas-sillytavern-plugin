param([string]$BackupDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$atlasRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$atlasRelease = Join-Path $atlasRoot 'release'
$atlasVersion = (Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $atlasRoot 'package.json') | ConvertFrom-Json).version
if ($atlasVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid package version' }

function Write-AtlasZip([string]$Name, [object[]]$Files) {
    $target = Join-Path $atlasRelease "$Name-$atlasVersion.zip"
    if ($BackupDirectory -and (Test-Path -LiteralPath $target)) {
        New-Item -ItemType Directory -Force -Path $BackupDirectory | Out-Null
        Copy-Item -LiteralPath $target -Destination (Join-Path $BackupDirectory ([IO.Path]::GetFileName($target)))
    }
    $temporary = "$target.new-$PID"
    $zip = [IO.Compression.ZipFile]::Open($temporary, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in $Files) {
            [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.Source, $file.Entry, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    } finally { $zip.Dispose() }
    # Validate every archive entry against the source bytes before publishing it.
    $read = [IO.Compression.ZipFile]::OpenRead($temporary)
    try {
        if ($read.Entries.Count -ne $Files.Count) { throw "Entry count mismatch: $Name" }
        foreach ($file in $Files) {
            $entry = $read.GetEntry($file.Entry)
            if (-not $entry) { throw "Missing entry: $($file.Entry)" }
            $stream = $entry.Open()
            $hash = [Security.Cryptography.SHA256]::Create()
            try { $actual = [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '') }
            finally { $stream.Dispose(); $hash.Dispose() }
            if ($actual -ne (Get-FileHash -LiteralPath $file.Source -Algorithm SHA256).Hash) { throw "Content mismatch: $($file.Entry)" }
        }
    } finally { $read.Dispose() }
    Move-Item -LiteralPath $temporary -Destination $target -Force
    Write-Output "$Name : $($Files.Count) verified files"
}

foreach ($component in @('atlas-ui-extension', 'atlas-server-plugin')) {
    $directory = Join-Path $atlasRelease $component
    if (-not (Test-Path -LiteralPath $directory)) { throw 'Run npm run pack first' }
    $prefix = $directory.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    $files = @(Get-ChildItem -LiteralPath $directory -File -Recurse | Sort-Object FullName | ForEach-Object {
        @{ Source = $_.FullName; Entry = "$component/" + $_.FullName.Substring($prefix.Length).Replace('\', '/') }
    })
    Write-AtlasZip $component $files
}

Push-Location $atlasRoot
try { $sourcePaths = @(& git -c core.quotepath=false ls-files --cached); if ($LASTEXITCODE) { throw 'git ls-files failed' } }
finally { Pop-Location }
$sourceFiles = @($sourcePaths | Sort-Object -Unique | Where-Object {
    $_ -notmatch '^(release|\.tmp|node_modules|\.git)/' -and (Test-Path -LiteralPath (Join-Path $atlasRoot $_) -PathType Leaf)
} | ForEach-Object { @{ Source = Join-Path $atlasRoot $_; Entry = $_.Replace('\', '/') } })
Write-AtlasZip 'atlas-source' $sourceFiles
$sums = foreach ($name in @('atlas-ui-extension', 'atlas-server-plugin', 'atlas-source')) {
    $filename = "$name-$atlasVersion.zip"
    "$((Get-FileHash -LiteralPath (Join-Path $atlasRelease $filename) -Algorithm SHA256).Hash.ToLowerInvariant())  $filename"
}
$sumPath = Join-Path $atlasRelease "atlas-$atlasVersion-SHA256SUMS.txt"
if ($BackupDirectory -and (Test-Path -LiteralPath $sumPath)) { Copy-Item -LiteralPath $sumPath -Destination (Join-Path $BackupDirectory ([IO.Path]::GetFileName($sumPath))) }
[IO.File]::WriteAllText($sumPath, ($sums -join "`n") + "`n", [Text.UTF8Encoding]::new($false))
