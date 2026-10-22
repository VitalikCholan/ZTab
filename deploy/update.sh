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
TAG="sha-$(git rev-parse --short=7 '@{u}')"

echo "update: pulling images for $TAG"
# Environment beats .env in compose, so .env is only rewritten once the pull has worked.
if ! IMAGE_TAG="$TAG" docker compose pull </dev/null; then
  echo "update: images for $TAG not published yet (check the Images workflow)" >&2
  exit 1
fi
git merge --ff-only --quiet '@{u}'

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
bash "$HERE/smoke.sh"
