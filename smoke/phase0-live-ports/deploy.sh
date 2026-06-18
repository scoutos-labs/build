#!/usr/bin/env bash
# Phase 0 deploy script (docs/scoutos-live-prd.md).
# Usage: SCOUTOS_API_KEY=sk_live_... ./deploy.sh <subdomain> [publishCode]
# Re-run with the publishCode printed on first deploy to verify republish.
set -euo pipefail

KEY="${SCOUTOS_API_KEY:?Set SCOUTOS_API_KEY (sk_live_..., scopes build+read)}"
SUBDOMAIN="${1:?Usage: deploy.sh <subdomain> [publishCode]}"
CODE="${2:-}"

DIR="$(cd "$(dirname "$0")" && pwd)"
TARBALL="$(mktemp -d)/phase0.tar.gz"
COPYFILE_DISABLE=1 tar --exclude node_modules --exclude .zepto -czf "$TARBALL" -C "$DIR" .

URL="https://scoutos.live/api/build?subdomain=${SUBDOMAIN}"
if [ -n "$CODE" ]; then URL="${URL}&code=${CODE}"; fi

echo "POST ${URL}"
RESPONSE=$(curl -fsS -X POST "$URL" \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/gzip" \
  --data-binary @"$TARBALL")
echo "$RESPONSE"

BUILD_ID=$(node -e 'console.log(JSON.parse(process.argv[1]).buildId)' "$RESPONSE")

echo "Polling build ${BUILD_ID} ..."
while true; do
  STATUS=$(curl -fsS "https://scoutos.live/api/build/${BUILD_ID}/status" -H "Authorization: Bearer $KEY")
  STATE=$(node -e 'console.log(JSON.parse(process.argv[1]).status)' "$STATUS")
  echo "  status=${STATE}"
  case "$STATE" in
    deployed)
      echo "$STATUS"
      echo
      echo "Now run: curl -X POST https://${SUBDOMAIN}.scoutos.live/verify"
      exit 0
      ;;
    failed|build_succeeded_deploy_failed)
      echo "$STATUS"
      exit 1
      ;;
  esac
  sleep 5
done
