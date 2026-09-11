#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${MKD_REPO_URL:-https://github.com/ErfanDavoodiNasr/maktabkhooneh-downloader.git}"
INSTALL_DIR="${MKD_INSTALL_DIR:-$HOME/maktabkhooneh-downloader}"
BRANCH="${MKD_BRANCH:-main}"

log() { printf '[bootstrap] %s\n' "$*"; }
err() { printf '[bootstrap][error] %s\n' "$*" >&2; }

have_cmd() { command -v "$1" >/dev/null 2>&1; }

install_from_zip() {
  local dest="$1"
  local zip_url="${MKD_ZIP_URL:-https://github.com/ErfanDavoodiNasr/maktabkhooneh-downloader/archive/refs/heads/${BRANCH}.zip}"
  local tmp extract
  tmp="$(mktemp "${TMPDIR:-/tmp}/mkd-XXXXXX.zip")"
  extract="$(mktemp -d "${TMPDIR:-/tmp}/mkd-XXXXXX")"
  log "Git not found (or clone disabled). Downloading ZIP instead:"
  log "  $zip_url"
  if have_cmd curl; then
    curl -fsSL "$zip_url" -o "$tmp"
  elif have_cmd wget; then
    wget -qO "$tmp" "$zip_url"
  else
    err "Need git, or curl/wget to download the project ZIP."
    exit 1
  fi
  mkdir -p "$extract"
  if have_cmd unzip; then
    unzip -q "$tmp" -d "$extract"
  else
    err "unzip is required to install from ZIP. Install unzip or install git."
    rm -f "$tmp"
    exit 1
  fi
  local inner
  inner="$(find "$extract" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  if [ -z "$inner" ]; then
    err "ZIP download did not contain project files."
    exit 1
  fi
  rm -rf "$dest"
  mkdir -p "$(dirname "$dest")"
  mv "$inner" "$dest"
  rm -f "$tmp"
  rm -rf "$extract"
}

if [ -d "$INSTALL_DIR/.git" ]; then
  if ! have_cmd git; then
    err "Existing git install found at $INSTALL_DIR but git is missing. Install git or delete that folder."
    exit 1
  fi
  log "Existing installation found at: $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --all --prune
  git -C "$INSTALL_DIR" pull --ff-only
elif [ -d "$INSTALL_DIR" ]; then
  log "Existing folder found at: $INSTALL_DIR (non-git). Reusing it."
elif [ -d "$REPO_URL" ]; then
  log "Copying local repository to: $INSTALL_DIR"
  mkdir -p "$INSTALL_DIR"
  cp -R "$REPO_URL"/. "$INSTALL_DIR"/
elif have_cmd git; then
  log "Cloning repository to: $INSTALL_DIR"
  git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR"
else
  install_from_zip "$INSTALL_DIR"
fi

if [ ! -f "$INSTALL_DIR/scripts/installer/setup-unix.sh" ]; then
  err "Installer not found: $INSTALL_DIR/scripts/installer/setup-unix.sh"
  exit 1
fi

log "Running project installer..."
bash "$INSTALL_DIR/scripts/installer/setup-unix.sh"

log "Done. Project path: $INSTALL_DIR"
