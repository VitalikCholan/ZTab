#!/usr/bin/env bash
# Create <dir>/.env (default: this directory) from .env.example with fresh secrets.
#   bash deploy/init-env.sh [dir]
# DOMAIN and ACME_EMAIL come from the environment, else are asked (from stdin, or /dev/tty).
# POSTGRES_PASSWORD and WATCHER_TOKEN are `openssl rand -hex 32`, never printed.
# An existing .env is never touched: regenerating WATCHER_TOKEN would strand the running stack.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIR="${1:-$HERE}"
TARGET="$DIR/.env"

if [ -e "$TARGET" ]; then
  echo "deploy/.env exists, keeping it"
  exit 0
fi

ask() { # ask <VAR> <prompt>: keep the env value, else read a line (stdin first, then /dev/tty)
  local var="$1" prompt="$2" val="${!1:-}"
  if [ -z "$val" ]; then
    if [ -t 0 ]; then
      read -r -p "$prompt: " val || true
    elif { : </dev/tty; } 2>/dev/null; then
      read -r -p "$prompt: " val </dev/tty || true
    else
      read -r val || true
    fi
  fi
  printf -v "$var" '%s' "$val"
}

ask DOMAIN "Domain (A record already pointing here, e.g. ztab.example.org)"
ask ACME_EMAIL "Email for Let's Encrypt notices"

# Strict shapes: the values land in a dotenv file and in a Caddyfile.
RE_DOMAIN='^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$'
RE_EMAIL='^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$'
if ! [[ "$DOMAIN" =~ $RE_DOMAIN ]]; then
  echo "init-env: DOMAIN is missing or not a bare hostname (set DOMAIN=...)" >&2
  exit 1
fi
if ! [[ "$ACME_EMAIL" =~ $RE_EMAIL ]]; then
  echo "init-env: ACME_EMAIL is missing or not an email (set ACME_EMAIL=...)" >&2
  exit 1
fi

EXAMPLE="$HERE/.env.example"
[ -f "$EXAMPLE" ] || { echo "init-env: $EXAMPLE not found" >&2; exit 1; }

POSTGRES_PASSWORD="$(openssl rand -hex 32)"
WATCHER_TOKEN="$(openssl rand -hex 32)"
export DOMAIN ACME_EMAIL POSTGRES_PASSWORD WATCHER_TOKEN # to awk via ENVIRON, not argv

mkdir -p "$DIR"
# Created mode 600 from the first byte (umask only inside this subshell), then moved into place.
(
  umask 077
  TMP="$(mktemp "$DIR/.env.XXXXXX")"
  trap 'rm -f "$TMP"' EXIT
  awk '
    /^(DOMAIN|ACME_EMAIL|POSTGRES_PASSWORD|WATCHER_TOKEN)=/ {
      k = substr($0, 1, index($0, "=") - 1)
      print k "=" ENVIRON[k]
      next
    }
    { print }
  ' "$EXAMPLE" >"$TMP"
  chmod 600 "$TMP"
  mv "$TMP" "$TARGET"
  trap - EXIT
)
echo "deploy/.env written"
