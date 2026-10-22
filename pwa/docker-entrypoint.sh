#!/bin/sh
# One-shot: replace the contents of the shared volume with the built bundle.
set -eu
DEST=/srv/pwa
mkdir -p "$DEST"
# Remove visible and hidden entries, without touching the mount point itself.
find "$DEST" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
cp -a /dist/. "$DEST"/
n=$(find "$DEST" -type f | wc -l | tr -d ' ')
echo "pwa: dist copied ($n files)"
