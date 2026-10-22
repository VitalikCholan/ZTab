#!/usr/bin/env bash
# Fetch main, pin the images to this commit (sha-<short>), pull them, restart, smoke-test.
#   bash deploy/update.sh        # run as the ztab user on the server
# Images exist only after the Images workflow for this commit succeeded; if they are not
# there yet, nothing is touched and the running stack keeps running on the previous tag.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

# Look first, move later: fetch, pin the tag of what origin has, and only merge the checkout
# (compose file, Caddyfile) once the matching images are pulled. A failed pull changes nothing.
git fetch --quiet
# Exactly 7 chars: --short=7 is only a minimum and grows when a prefix is ambiguous.
TAG="sha-$(git rev-parse '@{u}' | cut -c1-7)"

echo "update: pulling images for $TAG"
# Environment beats .env in compose, so .env is only rewritten once the pull has worked.
if ! IMAGE_TAG="$TAG" docker compose pull </dev/null; then
  echo "update: images for $TAG not published yet (check the Images workflow)" >&2
  exit 1
fi
# The Caddyfile is a single-file bind mount: the merge replaces its inode, and `up -d` does not
# recreate caddy (its image did not change), so a Caddyfile change needs an explicit restart.
CADDYFILE_BEFORE="$(git rev-parse --verify --quiet HEAD:deploy/Caddyfile || true)"
git merge --ff-only --quiet '@{u}'
CADDYFILE_AFTER="$(git rev-parse --verify --quiet HEAD:deploy/Caddyfile || true)"

set_tag() { # replace the IMAGE_TAG line (or append one), keeping mode 600
  local tmp
  tmp="$(umask 077 && mktemp "$HERE/.env.XXXXXX")"
  NEWTAG="$1" awk '
    BEGIN { done = 0 }
    /^IMAGE_TAG=/ { if (!done) { print "IMAGE_TAG=" ENVIRON["NEWTAG"]; done = 1 } ; next }
    { print }
    END { if (!done) print "IMAGE_TAG=" ENVIRON["NEWTAG"] }
  ' "$HERE/.env" >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$HERE/.env"
}
set_tag "$TAG"

docker compose up -d --remove-orphans </dev/null
if [ "$CADDYFILE_BEFORE" != "$CADDYFILE_AFTER" ]; then
  echo "update: Caddyfile changed, restarting caddy"
  docker compose restart caddy </dev/null
fi
bash "$HERE/smoke.sh"
