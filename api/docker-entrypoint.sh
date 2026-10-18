#!/bin/sh
set -e
# Fail fast naming the variable; never echo values.
: "${DATABASE_URL:?DATABASE_URL is required}"
: "${WATCHER_TOKEN:?WATCHER_TOKEN is required}"
node_modules/.bin/prisma migrate deploy
# exec so SIGTERM reaches node (graceful shutdown closes HTTP and Prisma).
exec node dist/src/main.js
