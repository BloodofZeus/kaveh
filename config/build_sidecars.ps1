$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $repoRoot "ui\src-tauri\binaries"

New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function Get-HostTriple {
  try {
    $t = (rustc --print host-tuple 2>$null).Trim()
    if ($t) { return $t }
  } catch {}

  $vv = (rustc -Vv) -join "`n"
  foreach ($line in $vv.Split("`n")) {
    if ($line.Trim().StartsWith("host:")) {
      $parts = $line.Trim().Split(" ", [System.StringSplitOptions]::RemoveEmptyEntries)
      if ($parts.Length -ge 2) { return $parts[1].Trim() }
    }
  }
  throw "Unable to determine Rust host triple"
}

$triple = Get-HostTriple

$engineOut = Join-Path $outDir ("kaveh-engine-" + $triple + ".exe")
Push-Location (Join-Path $repoRoot "engine")
go build -trimpath -ldflags "-s -w" -o $engineOut .
Pop-Location

$coreBase = Join-Path $outDir "kaveh-core.exe"
$coreOut = Join-Path $outDir ("kaveh-core-" + $triple + ".exe")

Push-Location $repoRoot
try {
  python -m PyInstaller --version | Out-Null
} catch {
  python -m pip install --upgrade pyinstaller
}

$workDir = Join-Path $repoRoot ".pyinstaller"
New-Item -ItemType Directory -Force -Path $workDir | Out-Null

python -m PyInstaller --clean --noconfirm --onefile --name kaveh-core `
  --distpath $outDir `
  --workpath (Join-Path $workDir "build") `
  --specpath (Join-Path $workDir "spec") `
  (Join-Path $repoRoot "core\api\entrypoint.py")

if (Test-Path $coreOut) { Remove-Item -Force $coreOut }
Rename-Item -Path $coreBase -NewName (Split-Path -Leaf $coreOut)
Pop-Location
