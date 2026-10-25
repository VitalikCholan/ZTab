#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 24.04 VPS for ZTab. Run as root, from your laptop:
#   ssh root@<ip> "DOMAIN=example.org ACME_EMAIL=you@example.org bash -s" < deploy/server-setup.sh
# stdin is this script, so DOMAIN and ACME_EMAIL must come from the environment (or, when a
# terminal is attached, are asked on /dev/tty). Optional: REPO_URL (default: the public repo).
# Safe to re-run: every step checks before it acts, and an existing .env is never regenerated.
set -euo pipefail

# Everything lives in main() so bash parses the whole file before running any of it: children
# that read stdin (apt, dpkg, docker) cannot eat the rest of a script piped over ssh, and a
# dropped connection cannot run a truncated script.
main() {
REPO_URL="${REPO_URL:-https://github.com/VitalikCholan/ZTab}"
APP_DIR=/opt/ztab

if [ "$(id -u)" -ne 0 ]; then
  echo "server-setup: run as root (ssh root@<ip> ...)" >&2
  exit 1
fi
# shellcheck disable=SC1091
. /etc/os-release
if [ "${ID:-}" != ubuntu ]; then
  echo "server-setup: this script targets Ubuntu 24.04 (found ${PRETTY_NAME:-unknown})" >&2
  exit 1
fi

ask() { # ask <VAR> <prompt>: keep the env value, else read from the terminal when there is one
  local var="$1" prompt="$2" val="${!1:-}"
  if [ -z "$val" ] && { : </dev/tty; } 2>/dev/null; then
    read -r -p "$prompt: " val </dev/tty || true
  fi
  if [ -z "$val" ]; then
    echo "server-setup: $var is not set and no terminal is attached." >&2
    echo "Run: ssh root@<ip> \"DOMAIN=example.org ACME_EMAIL=you@example.org bash -s\" < deploy/server-setup.sh" >&2
    exit 1
  fi
  printf -v "$var" '%s' "$val"
}
ask DOMAIN "Domain (A record already pointing at this server)"
ask ACME_EMAIL "Email for Let's Encrypt notices"

export DEBIAN_FRONTEND=noninteractive

echo "== packages"
apt-get update -y </dev/null
apt-get install -y ca-certificates curl gnupg git openssl ufw fail2ban unattended-upgrades </dev/null

echo "== Docker Engine (official apt repo)"
install -m 0755 -d /etc/apt/keyrings
if [ ! -s /etc/apt/keyrings/docker.asc ]; then
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
fi
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
  >/etc/apt/sources.list.d/docker.list
apt-get update -y </dev/null
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin </dev/null
systemctl enable --now docker

echo "== firewall, fail2ban, automatic security updates"
ufw allow 22,80,443/tcp
ufw --force enable </dev/null
systemctl enable --now fail2ban || echo "warning: fail2ban did not start" >&2
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' \
  >/etc/apt/apt.conf.d/20auto-upgrades

echo "== user ztab"
id ztab >/dev/null 2>&1 || useradd --create-home --shell /bin/bash ztab
usermod -aG docker ztab

echo "== code in $APP_DIR"
mkdir -p "$APP_DIR"
chown ztab:ztab "$APP_DIR"
if [ ! -d "$APP_DIR/.git" ]; then
  runuser -u ztab -- git clone "$REPO_URL" "$APP_DIR" </dev/null
fi

echo "== deploy/.env"
(cd "$APP_DIR" && runuser -u ztab -- env "DOMAIN=$DOMAIN" "ACME_EMAIL=$ACME_EMAIL" \
  bash "$APP_DIR/deploy/init-env.sh" "$APP_DIR/deploy" </dev/null)

echo "== systemd: ztab.service (stack comes back after a reboot)"
cat >/etc/systemd/system/ztab.service <<'UNIT'
[Unit]
Description=ZTab stack (docker compose)
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
User=ztab
WorkingDirectory=/opt/ztab/deploy
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable ztab.service

echo "== first deploy (pull images, start, smoke test)"
(cd "$APP_DIR/deploy" && runuser -u ztab -- bash "$APP_DIR/deploy/update.sh" </dev/null)
systemctl start ztab.service

echo "server-setup: done. Open https://$DOMAIN"
}

main "$@"
