$ErrorActionPreference = 'Stop'

$RepoUrl = if ($env:MKD_REPO_URL) { $env:MKD_REPO_URL } else { 'https://github.com/ErfanDavoodiNasr/maktabkhooneh-downloader.git' }
$InstallDir = if ($env:MKD_INSTALL_DIR) { $env:MKD_INSTALL_DIR } else { Join-Path $HOME 'maktabkhooneh-downloader' }
$Branch = if ($env:MKD_BRANCH) { $env:MKD_BRANCH } else { 'main' }

function Log($msg) { Write-Host "[bootstrap] $msg" }
function Fail($msg) { throw "[bootstrap][error] $msg" }

function Install-FromZip {
  param([string]$Dest)
  $zipUrl = if ($env:MKD_ZIP_URL) {
    $env:MKD_ZIP_URL
  } else {
    "https://github.com/ErfanDavoodiNasr/maktabkhooneh-downloader/archive/refs/heads/$Branch.zip"
  }
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("mkd-" + [guid]::NewGuid().ToString() + '.zip')
  $extract = Join-Path ([System.IO.Path]::GetTempPath()) ("mkd-" + [guid]::NewGuid().ToString())
  Log "Git not found. Downloading ZIP instead:`n  $zipUrl"
  try {
    Invoke-WebRequest -Uri $zipUrl -OutFile $tmp
    New-Item -ItemType Directory -Path $extract -Force | Out-Null
    Expand-Archive -Path $tmp -DestinationPath $extract -Force
    $inner = Get-ChildItem -Path $extract | Select-Object -First 1
    if (-not $inner) { Fail 'ZIP download did not contain project files.' }
    if (Test-Path -LiteralPath $Dest) { Remove-Item -LiteralPath $Dest -Recurse -Force }
    Move-Item -LiteralPath $inner.FullName -Destination $Dest
  } finally {
    if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

$hasGit = [bool](Get-Command git -ErrorAction SilentlyContinue)

if (Test-Path (Join-Path $InstallDir '.git')) {
  if (-not $hasGit) { Fail "Existing git install found at $InstallDir but git is missing. Install git or delete that folder." }
  Log "Existing installation found at: $InstallDir"
  git -C $InstallDir fetch --all --prune
  git -C $InstallDir pull --ff-only
} elseif (Test-Path -LiteralPath $InstallDir) {
  Log "Existing folder found at: $InstallDir (non-git). Reusing it."
} else {
  if (Test-Path -LiteralPath $RepoUrl -PathType Container) {
    Log "Copying local repository to: $InstallDir"
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Copy-Item -Path (Join-Path $RepoUrl '*') -Destination $InstallDir -Recurse -Force
  } elseif ($hasGit -and ($RepoUrl -like 'http*' -or $RepoUrl -like 'git@*' -or $RepoUrl -like 'file:*' -or $RepoUrl -like 'ssh:*')) {
    Log "Cloning repository to: $InstallDir"
    git clone --branch $Branch --depth 1 $RepoUrl $InstallDir
  } else {
    Install-FromZip -Dest $InstallDir
  }
}

$SetupScript = Join-Path $InstallDir 'scripts/installer/setup-windows.ps1'
if (-not (Test-Path -LiteralPath $SetupScript)) {
  Fail "Installer not found: $SetupScript"
}

Log 'Running project installer...'
# IMPORTANT: run in the current PowerShell host (5.1 or 7+). Do NOT nest to powershell.exe.
& $SetupScript

Log "Done. Project path: $InstallDir"
