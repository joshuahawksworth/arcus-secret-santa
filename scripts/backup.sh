#!/usr/bin/env bash
# Saves a full snapshot of the live pool (names, codes, sign-in tokens,
# answers, hints and, after the draw, the assignments) to a timestamped JSON
# file that scripts/restore.sh can put back.
#
#   ADMIN_TOKEN=... ./scripts/backup.sh            -> ./backups/pool-<date>.json
#   ADMIN_TOKEN=... ./scripts/backup.sh ~/Desktop   -> ~/Desktop/pool-<date>.json
#
# Needs the project's ADMIN_TOKEN. Keep the files private: anyone holding one
# can sign in as anybody in it.
set -euo pipefail

SITE="${SITE:-https://www.arcus-secret-santa.com}"
DEST="${1:-$(dirname "$0")/../backups}"

if [ -z "${ADMIN_TOKEN:-}" ]; then
  echo "Set ADMIN_TOKEN first, e.g.  ADMIN_TOKEN=xxxx $0" >&2
  exit 1
fi

mkdir -p "$DEST"
FILE="$DEST/pool-$(date -u +%Y%m%d-%H%M%S).json"

curl -sSf "$SITE/api/admin/export" -H "x-admin-token: $ADMIN_TOKEN" \
  | python3 -m json.tool > "$FILE"

python3 - "$FILE" <<'PY'
import json, sys
f = sys.argv[1]
d = json.load(open(f))
pool = d['pool']
print(f"saved {f}")
print(f"  {len(pool['participants'])} in the hat | drawn: {bool(pool.get('assignments'))} | reveal: {d['revealDate'][:10]}")
for p in pool['participants']:
    print(f"  {p['name']:<22} {p['code']}")
PY
