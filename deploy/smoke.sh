#!/usr/bin/env bash
# Production check, run after `up -d` (update.sh does it). Read-only: safe against the live stack.
# NOT the same as deploy/rehearsal.sh, whose smoke stops and restarts the API.
#   bash deploy/smoke.sh        # DOMAIN from the environment, else from deploy/.env
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ATTEMPTS="${SMOKE_ATTEMPTS:-12}" # the first certificate can take a minute
PAUSE="${SMOKE_PAUSE:-5}"

if [ -z "${DOMAIN:-}" ] && [ -f "$HERE/.env" ]; then
  # Only the DOMAIN line is read; the rest of the file is never loaded or printed.
  DOMAIN="$(grep -m1 '^DOMAIN=' "$HERE/.env" | cut -d= -f2- | tr -d '"'"'"'\r ')"
fi
if [ -z "${DOMAIN:-}" ]; then
  echo "smoke FAILED: DOMAIN is not set (env or deploy/.env)" >&2
  exit 1
fi

CURL=(curl -sS --max-time 15)

check_health() { "${CURL[@]}" -f "https://$DOMAIN/api/healthz" >/dev/null; }
check_status() { "${CURL[@]}" -f "https://$DOMAIN/api/status" | grep -q '"network":"test"'; }
check_csp() {
  local h
  h="$("${CURL[@]}" -I "https://$DOMAIN/t/x")" || return 1
  printf '%s\n' "$h" | grep -qi 'content-security-policy'
}
check_redirect() {
  local h
  h="$("${CURL[@]}" -I "http://$DOMAIN")" || return 1
  printf '%s\n' "$h" | grep -qi '^location: https'
}

run_check() { # run_check <label> <function>: retried, so a still-issuing certificate is not a failure
  local label="$1" fn="$2" i=1
  while [ "$i" -le "$ATTEMPTS" ]; do
    if "$fn" 2>/dev/null; then return 0; fi
    [ "$i" -lt "$ATTEMPTS" ] && sleep "$PAUSE"
    i=$((i + 1))
  done
  echo "smoke FAILED: $label" >&2
  return 1
}

run_check "https://$DOMAIN/api/healthz does not answer 2xx" check_health || exit 1
run_check "https://$DOMAIN/api/status does not report network test" check_status || exit 1
run_check "https://$DOMAIN/t/x has no Content-Security-Policy header" check_csp || exit 1
run_check "http://$DOMAIN does not redirect to https" check_redirect || exit 1
echo "smoke OK"
