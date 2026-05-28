$ErrorActionPreference = "Stop"

param(
  [Parameter(Mandatory = $true)]
  [string] $PackagePath
)

function Resolve-SignTool {
  $cmd = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  $kits = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
  if (Test-Path $kits) {
    $candidates = Get-ChildItem $kits -Directory -ErrorAction SilentlyContinue |
      ForEach-Object { Join-Path $_.FullName "x64\signtool.exe" } |
      Where-Object { Test-Path $_ }
    $best = $candidates | Sort-Object -Descending | Select-Object -First 1
    if ($best) { return $best }
  }

  throw "signtool.exe not found"
}

$thumbprint = ($env:KAVEH_WINDOWS_CERT_THUMBPRINT ?? "").Trim()
$pfxPath = ($env:KAVEH_WINDOWS_PFX ?? "").Trim()
$pfxBase64 = ($env:KAVEH_WINDOWS_PFX_BASE64 ?? "").Trim()
$pfxPassword = ($env:KAVEH_WINDOWS_PFX_PASSWORD ?? "").Trim()
$timestampUrl = ($env:KAVEH_WINDOWS_TIMESTAMP_URL ?? "").Trim()
if ([string]::IsNullOrWhiteSpace($timestampUrl)) {
  $timestampUrl = "http://timestamp.digicert.com"
}

if (
  [string]::IsNullOrWhiteSpace($thumbprint) -and
  [string]::IsNullOrWhiteSpace($pfxPath) -and
  [string]::IsNullOrWhiteSpace($pfxBase64)
) {
  exit 0
}

$signtool = Resolve-SignTool

if (-not (Test-Path $PackagePath)) {
  throw "PackagePath does not exist: $PackagePath"
}

$args = @("sign", "/fd", "sha256", "/tr", $timestampUrl, "/td", "sha256")
if (-not [string]::IsNullOrWhiteSpace($thumbprint)) {
  $args += @("/sha1", $thumbprint)
} else {
  if ((-not [string]::IsNullOrWhiteSpace($pfxBase64)) -and (-not (Test-Path $pfxPath))) {
    $tmpDir = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
    $tmpPfx = Join-Path $tmpDir "kaveh_codesign.pfx"
    [System.IO.File]::WriteAllBytes($tmpPfx, [System.Convert]::FromBase64String($pfxBase64))
    $pfxPath = $tmpPfx
  }
  if (-not (Test-Path $pfxPath)) {
    throw "KAVEH_WINDOWS_PFX does not exist: $pfxPath"
  }
  $args += @("/f", $pfxPath)
  if (-not [string]::IsNullOrWhiteSpace($pfxPassword)) {
    $args += @("/p", $pfxPassword)
  }
}

$args += @($PackagePath)

& $signtool @args | Out-Host
exit $LASTEXITCODE
