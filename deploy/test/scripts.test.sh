#!/usr/bin/env bash
# Tests for deploy/{init-env,update,smoke}.sh and shellcheck on every deploy script.
# server-setup.sh needs root on Ubuntu and is only linted, never run.
#   bash deploy/test/scripts.test.sh
# Portable: macOS bash 3.2 and Ubuntu bash 5. No secrets are printed.
# shellcheck disable=SC2015,SC2012,SC2016 # A && pass || fail is the assertion idiom; ls -l for portable mode
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="$(dirname "$HERE")"
ROOT="$(mktemp -d "${TMPDIR:-/tmp}/ztab-scripts-test.XXXXXX")"
trap 'rm -rf "$ROOT"' EXIT

PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "ok   - $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL - $1${2:+: $2}"; }
check() { # check <name> <command...>
  local name="$1"; shift
  if "$@"; then pass "$name"; else fail "$name"; fi
}

mode_of() { ls -l "$1" | cut -c1-10; }
envval() { grep -m1 "^$2=" "$1" | cut -d= -f2-; }

# ---------------------------------------------------------------- init-env
test_init_env() {
  local d="$ROOT/init" out1 out2 tok pw
  mkdir -p "$d"
  out1="$(DOMAIN=example.org ACME_EMAIL=a@b.c bash "$DEPLOY/init-env.sh" "$d" 2>&1 </dev/null)"
  check "init-env: creates .env" test -f "$d/.env"
  [ "$(mode_of "$d/.env")" = "-rw-------" ] && pass "init-env: .env is mode 600" || fail "init-env: .env is mode 600" "$(mode_of "$d/.env")"
  tok="$(envval "$d/.env" WATCHER_TOKEN)"
  pw="$(envval "$d/.env" POSTGRES_PASSWORD)"
  printf '%s' "$tok" | grep -Eq '^[0-9a-f]{64}$' && pass "init-env: WATCHER_TOKEN is 64 hex" || fail "init-env: WATCHER_TOKEN is 64 hex"
  printf '%s' "$pw" | grep -Eq '^[0-9a-f]{64}$' && pass "init-env: POSTGRES_PASSWORD is 64 hex" || fail "init-env: POSTGRES_PASSWORD is 64 hex"
  [ "$tok" != "$pw" ] && pass "init-env: secrets differ" || fail "init-env: secrets differ"
  [ "$(envval "$d/.env" DOMAIN)" = "example.org" ] && [ "$(envval "$d/.env" ACME_EMAIL)" = "a@b.c" ] \
    && pass "init-env: DOMAIN and ACME_EMAIL from env" || fail "init-env: DOMAIN and ACME_EMAIL from env"
  [ "$(envval "$d/.env" IMAGE_TAG)" = "main" ] && pass "init-env: IMAGE_TAG kept from example" || fail "init-env: IMAGE_TAG kept from example"
  grep -q '^# ZTAB_LIGHTWALLETD_URL=' "$d/.env" && pass "init-env: keeps the commented ZTAB_LIGHTWALLETD_URL line" || fail "init-env: keeps the commented ZTAB_LIGHTWALLETD_URL line"
  [ "$out1" = "deploy/.env written" ] && pass "init-env: prints only 'deploy/.env written'" || fail "init-env: prints only 'deploy/.env written'" "$out1"
  cp "$d/.env" "$ROOT/env.before"
  out2="$(DOMAIN=other.org ACME_EMAIL=x@y.z bash "$DEPLOY/init-env.sh" "$d" 2>&1 </dev/null)"
  cmp -s "$d/.env" "$ROOT/env.before" && pass "init-env: second run leaves .env byte-identical" || fail "init-env: second run leaves .env byte-identical"
  [ "$out2" = "deploy/.env exists, keeping it" ] && pass "init-env: second run says keeping it" || fail "init-env: second run says keeping it" "$out2"
  case "$out1$out2" in
    *"$tok"*|*"$pw"*) fail "init-env: output contains no secret" ;;
    *) pass "init-env: output contains no secret" ;;
  esac
  # no DOMAIN, no tty, no stdin: must fail, not hang or write a broken file
  local e="$ROOT/init-nodomain"
  mkdir -p "$e"
  if env -u DOMAIN -u ACME_EMAIL bash "$DEPLOY/init-env.sh" "$e" </dev/null >/dev/null 2>&1; then
    fail "init-env: missing DOMAIN without input fails"
  elif [ ! -e "$e/.env" ]; then
    pass "init-env: missing DOMAIN without input fails and writes nothing"
  else
    fail "init-env: missing DOMAIN without input leaves no .env"
  fi
  # interactive prompt from stdin for local use
  local f="$ROOT/init-prompt"
  mkdir -p "$f"
  printf 'prompt.example.org\nme@example.org\n' | env -u DOMAIN -u ACME_EMAIL bash "$DEPLOY/init-env.sh" "$f" >/dev/null 2>&1
  [ "$(envval "$f/.env" DOMAIN)" = "prompt.example.org" ] && pass "init-env: prompts when env is unset" || fail "init-env: prompts when env is unset"
  # hostile values must be rejected, not injected into .env
  local g="$ROOT/init-bad"
  mkdir -p "$g"
  if DOMAIN='x.org
EVIL=1' ACME_EMAIL=a@b.c bash "$DEPLOY/init-env.sh" "$g" >/dev/null 2>&1 </dev/null; then
    fail "init-env: rejects a DOMAIN with a newline"
  else
    pass "init-env: rejects a DOMAIN with a newline"
  fi
}

# ---------------------------------------------------------------- update
FAKEBIN="$ROOT/fakebin"
mkdir -p "$FAKEBIN"
cat >"$FAKEBIN/docker" <<'EOS'
#!/usr/bin/env bash
echo "$*" >>"$FAKE_DOCKER_LOG"
if [ "${1:-}" = compose ] && [ "${2:-}" = pull ] && [ "${FAKE_DOCKER_FAIL_PULL:-0}" = 1 ]; then
  echo "manifest unknown" >&2
  exit 1
fi
exit 0
EOS
chmod +x "$FAKEBIN/docker"

make_repo() { # make_repo <name>: bare origin + clone with deploy/ scripts, a stub smoke.sh and .env
  local o="$ROOT/$1.git" c="$ROOT/$1"
  git init -q --bare "$o"
  git clone -q "$o" "$c" 2>/dev/null
  mkdir -p "$c/deploy"
  cp "$DEPLOY/update.sh" "$c/deploy/update.sh"
  printf '#!/usr/bin/env bash\necho smoke-ran >>"$FAKE_DOCKER_LOG"\n' >"$c/deploy/smoke.sh"
  printf '{$DOMAIN} {\n}\n' >"$c/deploy/Caddyfile"
  printf 'DOMAIN=example.org\nIMAGE_TAG=main\nWATCHER_TOKEN=%s\n' "$(printf 'ab%.0s' $(seq 32))" >"$c/deploy/.env"
  chmod 600 "$c/deploy/.env"
  (
    cd "$c" || exit 1
    git config user.email t@example.org
    git config user.name t
    printf '.env\n' >.gitignore
    git add .gitignore deploy/update.sh deploy/smoke.sh deploy/Caddyfile
    git commit -q -m init
    git push -q origin HEAD 2>/dev/null
    git branch -q --set-upstream-to="origin/$(git rev-parse --abbrev-ref HEAD)" 2>/dev/null
  )
}

test_update() {
  make_repo upd
  local c="$ROOT/upd" log="$ROOT/upd.log" short out
  : >"$log"
  short="$(git -C "$c" rev-parse --short=7 HEAD)"
  printf '%s' "$short" | grep -Eq '^[0-9a-f]{7}$' || fail "test setup: short sha is 7 hex"
  out="$(cd "$c/deploy" && PATH="$FAKEBIN:$PATH" FAKE_DOCKER_LOG="$log" bash ./update.sh 2>&1)"
  local rc=$?
  [ "$rc" = 0 ] && pass "update: exits 0" || fail "update: exits 0" "$rc: $out"
  printf '%s' "$(envval "$c/deploy/.env" IMAGE_TAG)" | grep -Eq '^sha-[0-9a-f]{7}$' && pass "update: tag is exactly 7 hex chars" || fail "update: tag is exactly 7 hex chars"
  [ "$(envval "$c/deploy/.env" IMAGE_TAG)" = "sha-$short" ] && pass "update: .env gets IMAGE_TAG=sha-<short>" || fail "update: .env gets IMAGE_TAG=sha-<short>" "$(envval "$c/deploy/.env" IMAGE_TAG)"
  [ "$(grep -c '^IMAGE_TAG=' "$c/deploy/.env")" = 1 ] && pass "update: IMAGE_TAG line replaced, not duplicated" || fail "update: IMAGE_TAG line replaced, not duplicated"
  [ "$(envval "$c/deploy/.env" DOMAIN)" = "example.org" ] && pass "update: other .env lines untouched" || fail "update: other .env lines untouched"
  [ "$(mode_of "$c/deploy/.env")" = "-rw-------" ] && pass "update: .env stays mode 600" || fail "update: .env stays mode 600"
  local want
  want="$(printf 'compose pull\ncompose up -d --remove-orphans\nsmoke-ran')"
  [ "$(cat "$log")" = "$want" ] && pass "update: docker compose pull, then up -d --remove-orphans, then smoke" || fail "update: docker call order" "$(tr '\n' '|' <"$log")"
  case "$out" in *ab*ab*ab*ab*ab*ab*ab*ab*ab*ab*) fail "update: output has no secret" ;; *) pass "update: output has no secret" ;; esac

  # pull failure: message, non-zero, no up, .env still the previous tag
  make_repo updfail
  c="$ROOT/updfail"; log="$ROOT/updfail.log"; : >"$log"
  git clone -q "$ROOT/updfail.git" "$ROOT/updfail-other" 2>/dev/null
  (
    cd "$ROOT/updfail-other" || exit 1
    git config user.email t@example.org; git config user.name t
    echo newer >deploy/marker; git add deploy/marker; git commit -q -m newer; git push -q origin HEAD 2>/dev/null
  )
  local head_before
  head_before="$(git -C "$c" rev-parse HEAD)"
  short="$(git -C "$ROOT/updfail-other" rev-parse --short=7 HEAD)"
  out="$(cd "$c/deploy" && PATH="$FAKEBIN:$PATH" FAKE_DOCKER_LOG="$log" FAKE_DOCKER_FAIL_PULL=1 bash ./update.sh 2>&1)"
  rc=$?
  [ "$rc" != 0 ] && pass "update: failed pull exits non-zero" || fail "update: failed pull exits non-zero"
  case "$out" in *"images for sha-$short not published yet (check the Images workflow)"*) pass "update: failed pull prints the not-published message" ;; *) fail "update: failed pull prints the not-published message" "$out" ;; esac
  [ "$(git -C "$c" rev-parse HEAD)" = "$head_before" ] && [ ! -e "$c/deploy/marker" ] && pass "update: failed pull does not move the checkout" || fail "update: failed pull does not move the checkout"
  grep -q 'up' "$log" && fail "update: failed pull does not run up" || pass "update: failed pull does not run up"
  [ "$(envval "$c/deploy/.env" IMAGE_TAG)" = "main" ] && pass "update: failed pull keeps the previous IMAGE_TAG" || fail "update: failed pull keeps the previous IMAGE_TAG" "$(envval "$c/deploy/.env" IMAGE_TAG)"
  grep -q smoke-ran "$log" && fail "update: failed pull does not run smoke" || pass "update: failed pull does not run smoke"

  # upstream commit that changes the Caddyfile: caddy is restarted after up -d, before smoke
  push_change updcaddy deploy/Caddyfile
  log="$ROOT/updcaddy.log"; : >"$log"
  out="$(cd "$ROOT/updcaddy/deploy" && PATH="$FAKEBIN:$PATH" FAKE_DOCKER_LOG="$log" bash ./update.sh 2>&1)"; rc=$?
  want="$(printf 'compose pull\ncompose up -d --remove-orphans\ncompose restart caddy\nsmoke-ran')"
  [ "$rc" = 0 ] && [ "$(cat "$log")" = "$want" ] && pass "update: Caddyfile change upstream -> compose restart caddy after up" || fail "update: Caddyfile change upstream -> compose restart caddy after up" "$rc: $(tr '\n' '|' <"$log")"

  # upstream commit that leaves the Caddyfile alone: no restart
  push_change updnocaddy deploy/marker
  log="$ROOT/updnocaddy.log"; : >"$log"
  out="$(cd "$ROOT/updnocaddy/deploy" && PATH="$FAKEBIN:$PATH" FAKE_DOCKER_LOG="$log" bash ./update.sh 2>&1)"; rc=$?
  [ "$rc" = 0 ] && [ -e "$ROOT/updnocaddy/deploy/marker" ] && ! grep -q 'restart' "$log" && pass "update: no Caddyfile change -> no caddy restart" || fail "update: no Caddyfile change -> no caddy restart" "$rc: $(tr '\n' '|' <"$log")"
}

push_change() { # push_change <name> <file>: make_repo <name>, then push a commit touching <file> from a second clone
  make_repo "$1"
  git clone -q "$ROOT/$1.git" "$ROOT/$1-other" 2>/dev/null
  (
    cd "$ROOT/$1-other" || exit 1
    git config user.email t@example.org; git config user.name t
    echo "# changed" >>"$2"; git add "$2"; git commit -q -m change; git push -q origin HEAD 2>/dev/null
  )
}

# ---------------------------------------------------------------- smoke
FAKECURL="$ROOT/fakecurl"
mkdir -p "$FAKECURL"
cat >"$FAKECURL/curl" <<'EOS'
#!/usr/bin/env bash
# Canned responses by URL; FAKE_BAD names one check to break (status|csp|redirect|health).
args="$*"
url=""
for a in "$@"; do url="$a"; done
case "$url" in
  https://*/api/healthz) [ "${FAKE_BAD:-}" = health ] && exit 22; echo '{"status":"ok"}' ;;
  https://*/api/status) if [ "${FAKE_BAD:-}" = status ]; then echo '{"network":"main"}'; else echo '{"network":"test","watcher":"ok"}'; fi ;;
  https://*/t/x)
    printf 'HTTP/2 200\r\n'
    [ "${FAKE_BAD:-}" = csp ] || printf 'content-security-policy: default-src self\r\n'
    printf '\r\n' ;;
  http://*)
    case "$args" in *-I*) ;; esac
    if [ "${FAKE_BAD:-}" = redirect ]; then printf 'HTTP/1.1 200 OK\r\n\r\n'; else printf 'HTTP/1.1 308 Permanent Redirect\r\nlocation: https://example.org/\r\n\r\n'; fi ;;
  *) exit 6 ;;
esac
EOS
chmod +x "$FAKECURL/curl"

test_smoke() {
  local d="$ROOT/smoke" out rc
  mkdir -p "$d"
  cp "$DEPLOY/smoke.sh" "$d/smoke.sh"
  printf 'DOMAIN=example.org\nPOSTGRES_PASSWORD=supersecretvalue\nWATCHER_TOKEN=supersecrettoken\n' >"$d/.env"
  out="$(cd "$d" && PATH="$FAKECURL:$PATH" SMOKE_ATTEMPTS=1 bash ./smoke.sh 2>&1)"; rc=$?
  [ "$rc" = 0 ] && [[ "$out" == *"smoke OK"* ]] && pass "smoke: all checks pass -> smoke OK" || fail "smoke: all checks pass -> smoke OK" "$rc: $out"
  case "$out" in *supersecret*) fail "smoke: prints no .env value" ;; *) pass "smoke: prints no .env value" ;; esac
  local bad
  for bad in health status csp redirect; do
    out="$(cd "$d" && PATH="$FAKECURL:$PATH" FAKE_BAD=$bad SMOKE_ATTEMPTS=1 bash ./smoke.sh 2>&1)"; rc=$?
    if [ "$rc" != 0 ] && [[ "$out" == *"smoke FAILED"* ]] && [[ "$out" != *"smoke OK"* ]]; then pass "smoke: failing '$bad' check exits non-zero and names it"; else fail "smoke: failing '$bad' check" "$rc: $out"; fi
  done
  # DOMAIN from env wins and works without .env
  rm "$d/.env"
  out="$(cd "$d" && PATH="$FAKECURL:$PATH" DOMAIN=example.org SMOKE_ATTEMPTS=1 bash ./smoke.sh 2>&1)"; rc=$?
  [ "$rc" = 0 ] && pass "smoke: DOMAIN from env, no .env needed" || fail "smoke: DOMAIN from env, no .env needed" "$out"
  out="$(cd "$d" && env -u DOMAIN PATH="$FAKECURL:$PATH" SMOKE_ATTEMPTS=1 bash ./smoke.sh 2>&1)"; rc=$?
  [ "$rc" != 0 ] && pass "smoke: no DOMAIN anywhere fails" || fail "smoke: no DOMAIN anywhere fails"
}

# ---------------------------------------------------------------- shellcheck
test_shellcheck() {
  if ! command -v shellcheck >/dev/null 2>&1; then
    fail "shellcheck installed" "install shellcheck (brew install shellcheck / apt-get install shellcheck)"
    return
  fi
  local out
  if out="$(cd "$DEPLOY/.." && shellcheck -x deploy/*.sh deploy/test/*.sh 2>&1)"; then
    pass "shellcheck passes on deploy/*.sh and deploy/test/*.sh"
  else
    fail "shellcheck passes on deploy/*.sh and deploy/test/*.sh"; echo "$out"
  fi
  local s
  for s in init-env server-setup update smoke; do
    [ -f "$DEPLOY/$s.sh" ] && pass "$s.sh exists" || fail "$s.sh exists"
  done
}

test_init_env
test_update
test_smoke
test_shellcheck

echo "---"
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
