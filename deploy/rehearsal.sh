#!/usr/bin/env bash
# Local rehearsal of the production stack: build the three images, bring the stack up on
# https://localhost (Caddy local CA, ports bound to 127.0.0.1), run the Playwright smoke,
# tear everything down (volumes included) unless --keep. Exit code = smoke result.
# Works on a dev machine and on a GitHub Actions ubuntu runner (needs Docker, Node 24, pnpm).
#   bash deploy/rehearsal.sh [--keep]
set -euo pipefail

KEEP=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "rehearsal: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$DEPLOY_DIR")"
PROJECT=ztab-rehearsal
WAIT_TIMEOUT="${REHEARSAL_WAIT_TIMEOUT:-300}"
CA_CERT="$DEPLOY_DIR/smoke/.ca.crt"

# Throwaway env for interpolation: random secrets, never printed, never deploy/.env.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ztab-rehearsal.XXXXXX")"
ENV_FILE="$WORK/rehearsal.env"
umask 077
{
  echo "DOMAIN=localhost"
  echo "ACME_EMAIL=rehearsal@example.com"
  echo "POSTGRES_PASSWORD=$(openssl rand -hex 32)"
  echo "WATCHER_TOKEN=$(openssl rand -hex 32)"
  echo "IMAGE_TAG=rehearsal"
} >"$ENV_FILE"
umask 022

compose() {
  docker compose -p "$PROJECT" --env-file "$ENV_FILE" \
    -f "$DEPLOY_DIR/docker-compose.yml" -f "$DEPLOY_DIR/docker-compose.rehearsal.yml" "$@"
}

cleanup() {
  local code=$?
  if [ "$KEEP" = 1 ]; then
    echo "rehearsal: --keep: stack '$PROJECT' left running on https://localhost"
    echo "rehearsal: tear down with: docker compose -p $PROJECT down -v"
  else
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    rm -f "$CA_CERT"
  fi
  rm -rf "$WORK"
  exit "$code"
}
trap cleanup EXIT

diagnose() {
  echo "rehearsal: --- docker compose ps ---" >&2
  compose ps -a >&2 || true
  echo "rehearsal: --- logs (last 30 lines per service, secrets filtered) ---" >&2
  compose logs --no-color --tail 30 2>&1 \
    | grep -viE 'password|token|secret|DATABASE_URL' >&2 || true
}

start=$(date +%s)
echo "rehearsal: building images"
docker build -q -t ztab-watcher:rehearsal "$REPO_DIR/watcher" >/dev/null
docker build -q -t ztab-api:rehearsal -f "$REPO_DIR/api/Dockerfile" "$REPO_DIR" >/dev/null
docker build -q -t ztab-pwa:rehearsal -f "$REPO_DIR/pwa/Dockerfile" \
  --build-arg VITE_API_URL=/api --build-arg VITE_NETWORK=test "$REPO_DIR" >/dev/null
echo "rehearsal: images built in $(( $(date +%s) - start ))s"

# Start from nothing: a stale stack or volume from an aborted run would hide first-boot bugs.
compose down -v --remove-orphans >/dev/null 2>&1 || true

echo "rehearsal: starting stack (timeout ${WAIT_TIMEOUT}s)"
if ! compose up -d --wait --wait-timeout "$WAIT_TIMEOUT"; then
  echo "rehearsal: stack did not become healthy" >&2
  diagnose
  exit 1
fi
echo "rehearsal: stack healthy after $(( $(date +%s) - start ))s"

# Caddy creates its local CA on first start; export the root (+ intermediate) for the smoke.
compose cp caddy:/data/caddy/pki/authorities/local/root.crt "$WORK/root.crt" >/dev/null
compose cp caddy:/data/caddy/pki/authorities/local/intermediate.crt "$WORK/intermediate.crt" >/dev/null
cat "$WORK/root.crt" "$WORK/intermediate.crt" >"$CA_CERT"

echo "rehearsal: running smoke"
set +e
(
  cd "$REPO_DIR"
  NODE_EXTRA_CA_CERTS="$CA_CERT" SMOKE_CA_CERTS="$CA_CERT" \
    SMOKE_BASE_URL=https://localhost SMOKE_COMPOSE_PROJECT="$PROJECT" \
    pnpm --filter @ztab/pwa exec playwright test --config ../deploy/smoke/playwright.config.ts
)
smoke=$?
set -e
if [ "$smoke" -ne 0 ]; then
  echo "rehearsal: smoke FAILED" >&2
  diagnose
else
  echo "rehearsal: smoke passed"
fi
echo "rehearsal: total $(( $(date +%s) - start ))s"
exit "$smoke"
