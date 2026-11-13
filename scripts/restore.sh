#!/usr/bin/env bash
# Puts the live pool back to a snapshot taken by scripts/backup.sh. Replaces
# everything currently there, so it takes a fresh backup first.
#
#   ADMIN_TOKEN=... ./scripts/restore.sh backups/pool-20261113-124500.json
set -euo pipefail

SITE="${SITE:-https://www.arcus-secret-santa.com}"
FILE="${1:-}"

if [ -z "${ADMIN_TOKEN:-}" ] || [ -z "$FILE" ]; then
  echo "usage: ADMIN_TOKEN=xxxx $0 <snapshot.json>" >&2
  exit 1
fi
if ! python3 -c "import json,sys; d=json.load(open(sys.argv[1])); assert 'pool' in d and 'participants' in d['pool']" "$FILE" 2>/dev/null; then
  echo "$FILE is not a full snapshot from scripts/backup.sh (needs a 'pool' with tokens)." >&2
  exit 1
fi

echo "Backing up the current pool before replacing it..."
"$(dirname "$0")/backup.sh"

echo "Restoring $FILE ..."
curl -sSf -X POST "$SITE/api/admin/restore" -H "x-admin-token: $ADMIN_TOKEN" \
  -H 'content-type: application/json' --data-binary "@$FILE"
echo
