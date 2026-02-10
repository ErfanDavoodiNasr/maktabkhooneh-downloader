#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${MKD_REPO_URL:-https://github.com/ErfanDavoodiNasr/maktabkhooneh-downloader.git}"
INSTALL_DIR="${MKD_INSTALL_DIR:-$HOME/maktabkhooneh-downloader}"

log() { printf '[bootstrap] %s\n' "$*"; }
err() { printf '[bootstrap][error] %s\n' "$*" >&2; }

if ! command -v git >/dev/null 2>&1; then
  err "git is required but not found. Install git, then run this command again."
  exit 1
fi

if [ -d "$INSTALL_DIR/.git" ]; then
  log "Existing installation found at: $INSTALL_DIR"
  git -C "$INSTALL_DIR" fetch --all --prune
  git -C "$INSTALL_DIR" pull --ff-only
else
  log "Cloning repository to: $INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

if [ ! -f "$INSTALL_DIR/scripts/installer/setup-unix.sh" ]; then
  err "Installer not found: $INSTALL_DIR/scripts/installer/setup-unix.sh"
  exit 1
fi

log "Running project installer..."
bash "$INSTALL_DIR/scripts/installer/setup-unix.sh"

log "Done. Project path: $INSTALL_DIR"
