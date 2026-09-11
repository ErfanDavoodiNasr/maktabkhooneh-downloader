#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIG_FILE="$PROJECT_DIR/config.json"
MIN_NODE_MAJOR=20
EXAMPLE_SLUG='آموزش-گیت-جادی-mk12029'

log() { printf '[install] %s\n' "$*"; }
warn() { printf '[install][warn] %s\n' "$*"; }
err() { printf '[install][error] %s\n' "$*" >&2; }

have_cmd() { command -v "$1" >/dev/null 2>&1; }

node_major() {
  node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0
}

is_interactive() {
  if [ "${MKD_SKIP_PROMPT:-}" = "1" ]; then
    return 1
  fi
  [ -t 0 ] && [ -t 1 ]
}

ensure_node() {
  if have_cmd node; then
    local major
    major="$(node_major)"
    if [ "$major" -ge "$MIN_NODE_MAJOR" ]; then
      log "Node.js $(node -v) is already installed."
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
      if have_cmd apk; then
        if have_cmd sudo && [ "$(id -u)" -ne 0 ]; then
          sudo apk add --no-cache nodejs npm
        else
          apk add --no-cache nodejs npm
        fi
      elif have_cmd apt-get; then
        if have_cmd sudo && [ "$(id -u)" -ne 0 ]; then
          sudo apt-get update
          sudo apt-get install -y nodejs npm
        else
          apt-get update
          apt-get install -y nodejs npm
        fi
      elif have_cmd dnf; then
        if have_cmd sudo && [ "$(id -u)" -ne 0 ]; then
          sudo dnf install -y nodejs npm
        else
          dnf install -y nodejs npm
        fi
      elif have_cmd yum; then
        if have_cmd sudo && [ "$(id -u)" -ne 0 ]; then
          sudo yum install -y nodejs npm
        else
          yum install -y nodejs npm
        fi
      elif have_cmd pacman; then
        if have_cmd sudo && [ "$(id -u)" -ne 0 ]; then
          sudo pacman -Sy --noconfirm nodejs npm
        else
          pacman -Sy --noconfirm nodejs npm
        fi
      elif have_cmd zypper; then
        if have_cmd sudo && [ "$(id -u)" -ne 0 ]; then
          sudo zypper --non-interactive install nodejs npm
        else
          zypper --non-interactive install nodejs npm
        fi
      else
        err "Unsupported Linux package manager. Install Node.js >= $MIN_NODE_MAJOR manually: https://nodejs.org"
        return 1
      fi
      ;;
    *)
      err "Unsupported OS for this script. Use install.ps1 on Windows."
      return 1
      ;;
  esac

  # Refresh command hash in case package manager just installed node
  hash -r 2>/dev/null || true

  if ! have_cmd node; then
    err "Node.js installation failed."
    return 1
  fi
  if [ "$(node_major)" -lt "$MIN_NODE_MAJOR" ]; then
    err "Installed Node.js ($(node -v)) is older than v$MIN_NODE_MAJOR."
    err "Please install a newer Node.js from https://nodejs.org and re-run this installer."
    return 1
  fi
  log "Node.js $(node -v) installed successfully."
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

write_credentials() {
  local email="$1"
  local password="$2"
  # Use `node -` so argv[1] is "-", and real args start at argv[2].
  node - "$CONFIG_FILE" "$email" "$password" <<'NODE'
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
}

prompt_credentials() {
  local email="${MKD_EMAIL:-}"
  local password="${MKD_PASSWORD:-}"

  if [ -n "$email" ] && [ -n "$password" ]; then
    write_credentials "$email" "$password"
    log "Credentials loaded from MKD_EMAIL / MKD_PASSWORD."
    return
  fi

  if ! is_interactive; then
    warn "Non-interactive install detected. Skipping credential prompt."
    warn "Set auth.email / auth.password in config.json later, or re-run with MKD_EMAIL / MKD_PASSWORD."
    return
  fi

  printf 'Maktabkhooneh email/phone (optional): '
  IFS= read -r email || true
  printf 'Maktabkhooneh password (optional): '
  stty -echo
  IFS= read -r password || true
  stty echo
  printf '\n'

  if [ -z "${email:-}" ] || [ -z "${password:-}" ]; then
    warn "Email/password left empty. You can set them later in config.json."
  fi

  write_credentials "${email:-}" "${password:-}"
  log "config.json updated."
}

print_next_steps() {
  cat <<TXT

Installation complete.

Project folder:
  $PROJECT_DIR

1) Open config.json and set auth.email / auth.password (if you skipped the prompt).
2) Preview a course (full slug ending with -mk<id>):
  cd "$PROJECT_DIR"
  node download.mjs "$EXAMPLE_SLUG" --dry-run --chapter 1 --lesson 1
3) Download (start small first):
  node download.mjs "$EXAMPLE_SLUG" --chapter 1 --lesson 1

TXT
}

main() {
  log "Project directory: $PROJECT_DIR"
  ensure_node
  ensure_config_file
  prompt_credentials
  print_next_steps
}

main "$@"
