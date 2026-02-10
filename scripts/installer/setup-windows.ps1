$ErrorActionPreference = 'Stop'

$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ConfigFile = Join-Path $ProjectDir 'config.json'
$MinNodeMajor = 18

function Log($msg) { Write-Host "[install] $msg" }
function Warn($msg) { Write-Host "[install][warn] $msg" -ForegroundColor Yellow }
function Fail($msg) { throw "[install][error] $msg" }

function Get-NodeMajor {
  try {
    $v = node -p "process.versions.node.split('.')[0]" 2>$null
    return [int]$v
  } catch {
    return 0
  }
}

function Ensure-Node {
  $major = Get-NodeMajor
  if ($major -ge $MinNodeMajor) {
    Log "Node.js is already installed: $(node -v)"
    return
  }

  Warn "Node.js >= $MinNodeMajor is required. Trying to install Node.js LTS..."

  $winget = Get-Command winget -ErrorAction SilentlyContinue
  $choco = Get-Command choco -ErrorAction SilentlyContinue

  if ($winget) {
    winget install --id OpenJS.NodeJS.LTS --exact --accept-source-agreements --accept-package-agreements
  } elseif ($choco) {
    choco install nodejs-lts -y
  } else {
    Fail "Neither winget nor choco was found. Install Node.js manually: https://nodejs.org"
  }

  $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')

  $major = Get-NodeMajor
  if ($major -lt $MinNodeMajor) {
    Fail "Node.js installation did not complete or terminal needs restart. Re-open terminal and run this script again."
  }

  Log "Node.js installed: $(node -v)"
}

function Ensure-ConfigFile {
  if (Test-Path $ConfigFile) {
    Log 'config.json already exists.'
    return
  }

  Log 'Creating default config.json...'
  $json = @'
{
  "course": {
    "baseUrl": "https://maktabkhooneh.org/course/"
  },
  "auth": {
    "email": "",
    "password": "",
    "cookie": "",
    "cookieFile": "",
    "sessionCookie": "",
    "sessionUpdated": ""
  },
  "runtime": {
    "sampleBytes": 0,
    "retryAttempts": 4,
    "requestTimeoutMs": 30000,
    "readTimeoutMs": 120000
  },
  "defaults": {
    "chapter": "",
    "lesson": "",
    "dryRun": false,
    "forceLogin": false,
    "verbose": false
  }
}
'@
  Set-Content -Path $ConfigFile -Value $json -Encoding UTF8
}

function Prompt-Credentials {
  $email = Read-Host 'Maktabkhooneh email (optional)'
  $secure = Read-Host 'Maktabkhooneh password (optional)' -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }

  if ([string]::IsNullOrWhiteSpace($email) -or [string]::IsNullOrWhiteSpace($password)) {
    Warn 'Email/password left empty. You can set them later in config.json.'
  }

  $cfg = @{}
  if (Test-Path $ConfigFile) {
    try { $cfg = Get-Content $ConfigFile -Raw | ConvertFrom-Json -AsHashtable } catch { $cfg = @{} }
  }

  if (-not $cfg.ContainsKey('course') -or -not ($cfg.course -is [hashtable])) { $cfg.course = @{ baseUrl = 'https://maktabkhooneh.org/course/' } }
  if (-not $cfg.ContainsKey('auth') -or -not ($cfg.auth -is [hashtable])) { $cfg.auth = @{} }
  if (-not $cfg.ContainsKey('runtime') -or -not ($cfg.runtime -is [hashtable])) {
    $cfg.runtime = @{ sampleBytes = 0; retryAttempts = 4; requestTimeoutMs = 30000; readTimeoutMs = 120000 }
  }
  if (-not $cfg.ContainsKey('defaults') -or -not ($cfg.defaults -is [hashtable])) {
    $cfg.defaults = @{ chapter = ''; lesson = ''; dryRun = $false; forceLogin = $false; verbose = $false }
  }

  if (-not [string]::IsNullOrWhiteSpace($email)) { $cfg.auth.email = $email }
  if (-not [string]::IsNullOrWhiteSpace($password)) { $cfg.auth.password = $password }
  foreach ($k in @('cookie','cookieFile','sessionCookie','sessionUpdated')) {
    if (-not $cfg.auth.ContainsKey($k)) { $cfg.auth[$k] = '' }
  }

  $cfg | ConvertTo-Json -Depth 8 | Set-Content -Path $ConfigFile -Encoding UTF8
  Log 'config.json updated.'
}

Log "Project directory: $ProjectDir"
Ensure-Node
Ensure-ConfigFile
Prompt-Credentials

Write-Host "`nInstallation complete.`n"
Write-Host 'Next commands:'
Write-Host '  node download.mjs /python --dry-run'
Write-Host '  node download.mjs /python'
