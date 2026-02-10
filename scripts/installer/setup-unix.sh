#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_FILE="$PROJECT_DIR/config.json"
MIN_NODE_MAJOR=18

log() { printf '[install] %s\n' "$*"; }
warn() { printf '[install][warn] %s\n' "$*"; }
err() { printf '[install][error] %s\n' "$*" >&2; }

have_cmd() { command -v "$1" >/dev/null 2>&1; }

node_major() {
  node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0
}

ensure_node() {
  if have_cmd node; then
    local major
    major="$(node_major)"
    if [ "$major" -ge "$MIN_NODE_MAJOR" ]; then
      log "Node.js v$(node -v) is already installed."
      return 0
    fi
    warn "Node.js is installed but version is too old (<$MIN_NODE_MAJOR)."
  else
    warn "Node.js is not installed."
  fi

  log "Trying to install Node.js LTS automatically..."

  case "$(uname -s)" in
    Darwin)
      if have_cmd brew; then
        brew update || true
        brew install node
      else
        err "Homebrew is not installed. Install Homebrew first: https://brew.sh"
        return 1
      fi
      ;;
    Linux)
      if have_cmd apt-get; then
        sudo apt-get update
        sudo apt-get install -y nodejs npm
      elif have_cmd dnf; then
        sudo dnf install -y nodejs npm
      elif have_cmd yum; then
        sudo yum install -y nodejs npm
      elif have_cmd pacman; then
        sudo pacman -Sy --noconfirm nodejs npm
      elif have_cmd zypper; then
        sudo zypper --non-interactive install nodejs npm
      else
        err "Unsupported Linux package manager. Install Node.js >= $MIN_NODE_MAJOR manually: https://nodejs.org"
        return 1
      fi
      ;;
    *)
      err "Unsupported OS for this script. Use scripts/install.ps1 on Windows."
      return 1
      ;;
  esac

  if ! have_cmd node; then
    err "Node.js installation failed."
    return 1
  fi
  if [ "$(node_major)" -lt "$MIN_NODE_MAJOR" ]; then
    err "Installed Node.js is still older than $MIN_NODE_MAJOR."
    return 1
  fi
  log "Node.js v$(node -v) installed successfully."
}

ensure_config_file() {
  if [ -f "$CONFIG_FILE" ]; then
    log "config.json already exists."
    return
  fi

  log "Creating default config.json..."
  cat > "$CONFIG_FILE" << 'JSON'
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
JSON
}

prompt_credentials() {
  local email password
  printf 'Maktabkhooneh email (optional): '
  IFS= read -r email || true
  printf 'Maktabkhooneh password (optional): '
  stty -echo
  IFS= read -r password || true
  stty echo
  printf '\n'

  if [ -z "$email" ] || [ -z "$password" ]; then
    warn "Email/password left empty. You can set them later in config.json."
  fi

  node <<'NODE' "$CONFIG_FILE" "$email" "$password"
const fs = require('fs');
const [cfgPath, email, password] = process.argv.slice(2);
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
if (!cfg.course || typeof cfg.course !== 'object') cfg.course = { baseUrl: 'https://maktabkhooneh.org/course/' };
if (!cfg.auth || typeof cfg.auth !== 'object') cfg.auth = {};
if (!cfg.runtime || typeof cfg.runtime !== 'object') cfg.runtime = { sampleBytes: 0, retryAttempts: 4, requestTimeoutMs: 30000, readTimeoutMs: 120000 };
if (!cfg.defaults || typeof cfg.defaults !== 'object') cfg.defaults = { chapter: '', lesson: '', dryRun: false, forceLogin: false, verbose: false };
if (email) cfg.auth.email = email;
if (password) cfg.auth.password = password;
for (const [k, v] of Object.entries({ cookie: '', cookieFile: '', sessionCookie: '', sessionUpdated: '' })) {
  if (!(k in cfg.auth)) cfg.auth[k] = v;
}
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
NODE

  log "config.json updated."
}

main() {
  log "Project directory: $PROJECT_DIR"
  ensure_node
  ensure_config_file
  prompt_credentials

  cat <<'TXT'

Installation complete.

Next commands:
  node download.mjs /python --dry-run
  node download.mjs /python

TXT
}

main "$@"
