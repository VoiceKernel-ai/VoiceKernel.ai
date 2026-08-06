#!/usr/bin/env bash
#
# Sync source to the production host.
#
# --delete is what keeps the remote tree honest (a file deleted locally must
# disappear there too), but deploy/server/.env lives only on the server and
# holds the encryption key for tenant secrets at rest. Deleting it does not
# take production down - the running containers keep their environment - but
# it makes them unrecreatable, which is worse: the failure surfaces at the
# next deploy, not at the moment of the mistake.
#
# So .env is excluded explicitly rather than relied upon to be out of scope.
set -euo pipefail

# Deliberately has no default. A hard-coded host in a public repository tells
# every reader exactly where the production box is, and invites an accidental
# deploy to someone else's server.
HOST="${1:-${VOICEKERNEL_HOST:?pass the target as an argument, or set VOICEKERNEL_HOST}}"
DEST="${2:-/opt/voicekernel/}"
cd "$(dirname "$0")/../.."

rsync -az --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude dist \
  --exclude '*.log' \
  --exclude 'deploy/server/.env' \
  ./src ./scripts ./web ./packages ./db ./test ./vendor ./deploy \
  ./package.json ./package-lock.json ./tsconfig.json ./Dockerfile \
  "$HOST:$DEST"

ssh "$HOST" 'test -s /opt/voicekernel/deploy/server/.env' \
  || { echo "FATAL: .env missing on the host; do not rebuild until it is restored" >&2; exit 1; }

echo "synced; .env intact"
