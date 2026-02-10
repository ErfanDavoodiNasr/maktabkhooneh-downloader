$ErrorActionPreference = 'Stop'

$RepoUrl = if ($env:MKD_REPO_URL) { $env:MKD_REPO_URL } else { 'https://github.com/ErfanDavoodiNasr/maktabkhooneh-downloader.git' }
$InstallDir = if ($env:MKD_INSTALL_DIR) { $env:MKD_INSTALL_DIR } else { Join-Path $HOME 'maktabkhooneh-downloader' }

function Log($msg) { Write-Host "[bootstrap] $msg" }
function Fail($msg) { throw "[bootstrap][error] $msg" }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Fail 'git is required but not found. Install git, then run this command again.'
}

if (Test-Path (Join-Path $InstallDir '.git')) {
  Log "Existing installation found at: $InstallDir"
  git -C $InstallDir fetch --all --prune
  git -C $InstallDir pull --ff-only
} else {
  Log "Cloning repository to: $InstallDir"
  git clone $RepoUrl $InstallDir
}

$SetupScript = Join-Path $InstallDir 'scripts/installer/setup-windows.ps1'
if (-not (Test-Path $SetupScript)) {
  Fail "Installer not found: $SetupScript"
}

Log 'Running project installer...'
& powershell -ExecutionPolicy Bypass -File $SetupScript

Log "Done. Project path: $InstallDir"
