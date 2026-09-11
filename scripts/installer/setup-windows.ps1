$ErrorActionPreference = 'Stop'

$ProjectDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$ConfigFile = Join-Path $ProjectDir 'config.json'
$MinNodeMajor = 18
$ExampleSlug = 'آموزش-گیت-جادی-mk12029'

function Log($msg) { Write-Host "[install] $msg" }
function Warn($msg) { Write-Host "[install][warn] $msg" -ForegroundColor Yellow }
function Fail($msg) { throw "[install][error] $msg" }

function Get-NodeMajor {
  try {
    $v = & node -p "process.versions.node.split('.')[0]" 2>$null
    if (-not $v) { return 0 }
    return [int]$v
  } catch {
    return 0
  }
}

function Test-CanPrompt {
  if ($env:MKD_SKIP_PROMPT -eq '1') { return $false }
  try {
    return [Environment]::UserInteractive -and -not [Console]::IsInputRedirected
  } catch {
    return $false
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
    & winget install --id OpenJS.NodeJS.LTS --exact --accept-source-agreements --accept-package-agreements
  } elseif ($choco) {
    & choco install nodejs-lts -y
  } else {
    Fail "Neither winget nor choco was found. Install Node.js manually from https://nodejs.org then re-open the terminal and run install again."
  }

  $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')

  $major = Get-NodeMajor
  if ($major -lt $MinNodeMajor) {
    Fail "Node.js installation did not complete or this terminal needs a restart. Close the terminal, open a new one, and run the installer again."
  }

  Log "Node.js installed: $(node -v)"
}

function Ensure-ConfigFile {
  if (Test-Path -LiteralPath $ConfigFile) {
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
  # UTF-8 without BOM (compatible with Node JSON.parse)
  $utf8NoBom = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($ConfigFile, $json, $utf8NoBom)
}

function Write-Credentials([string]$Email, [string]$Password) {
  # Use Node + env vars so argv parsing differences between powershell.exe / pwsh never break this.
  $emailArg = if ($null -eq $Email) { '' } else { $Email }
  $passwordArg = if ($null -eq $Password) { '' } else { $Password }
  $env:MKD_CFG_PATH = $ConfigFile
  $env:MKD_CFG_EMAIL = $emailArg
  $env:MKD_CFG_PASSWORD = $passwordArg
  try {
    & node -e @'
const fs = require("fs");
const cfgPath = process.env.MKD_CFG_PATH;
const email = process.env.MKD_CFG_EMAIL || "";
const password = process.env.MKD_CFG_PASSWORD || "";
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8")); } catch {}
if (!cfg.course || typeof cfg.course !== "object") cfg.course = { baseUrl: "https://maktabkhooneh.org/course/" };
if (!cfg.auth || typeof cfg.auth !== "object") cfg.auth = {};
if (!cfg.runtime || typeof cfg.runtime !== "object") cfg.runtime = { sampleBytes: 0, retryAttempts: 4, requestTimeoutMs: 30000, readTimeoutMs: 120000 };
if (!cfg.defaults || typeof cfg.defaults !== "object") cfg.defaults = { chapter: "", lesson: "", dryRun: false, forceLogin: false, verbose: false };
if (email) cfg.auth.email = email;
if (password) cfg.auth.password = password;
for (const [k, v] of Object.entries({ cookie: "", cookieFile: "", sessionCookie: "", sessionUpdated: "" })) {
  if (!(k in cfg.auth)) cfg.auth[k] = v;
}
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
'@
  } finally {
    Remove-Item Env:MKD_CFG_PATH -ErrorAction SilentlyContinue
    Remove-Item Env:MKD_CFG_EMAIL -ErrorAction SilentlyContinue
    Remove-Item Env:MKD_CFG_PASSWORD -ErrorAction SilentlyContinue
  }
}

function Prompt-Credentials {
  $email = $env:MKD_EMAIL
  $password = $env:MKD_PASSWORD

  if (-not [string]::IsNullOrWhiteSpace($email) -and -not [string]::IsNullOrWhiteSpace($password)) {
    Write-Credentials $email $password
    Log 'Credentials loaded from MKD_EMAIL / MKD_PASSWORD.'
    return
  }

  if (-not (Test-CanPrompt)) {
    Warn 'Non-interactive install detected. Skipping credential prompt.'
    Warn 'Set auth.email / auth.password in config.json later, or re-run with MKD_EMAIL / MKD_PASSWORD.'
    return
  }

  $email = Read-Host 'Maktabkhooneh email/phone (optional)'
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

  Write-Credentials $email $password
  Log 'config.json updated.'
}

function Show-NextSteps {
  Write-Host ''
  Write-Host 'Installation complete.'
  Write-Host ''
  Write-Host "Project folder:`n  $ProjectDir"
  Write-Host ''
  Write-Host '1) Open config.json and set auth.email / auth.password (if you skipped the prompt).'
  Write-Host '2) Preview a course (full slug ending with -mk<id>):'
  Write-Host "  cd `"$ProjectDir`""
  Write-Host "  node download.mjs `"$ExampleSlug`" --dry-run --chapter 1 --lesson 1"
  Write-Host '3) Download (start small first):'
  Write-Host "  node download.mjs `"$ExampleSlug`" --chapter 1 --lesson 1"
  Write-Host ''
}

Log "Project directory: $ProjectDir"
Ensure-Node
Ensure-ConfigFile
Prompt-Credentials
Show-NextSteps
