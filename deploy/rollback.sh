#!/usr/bin/env bash
set -euo pipefail

commit=${1:-}
app_root=${CHAT_APP_ROOT:-/opt/chat-app}
service_name=${CHAT_APP_SERVICE:-chat-app}
health_url=${CHAT_APP_HEALTH_URL:-http://127.0.0.1:3002/}

if [[ ${EUID} -ne 0 ]]; then
  echo "rollback.sh must run as root (use sudo)." >&2
  exit 1
fi
if [[ ! "$commit" =~ ^[0-9a-f]{40}$ || ! -d "$app_root/releases/$commit" ]]; then
  echo "usage: sudo deploy/rollback.sh <existing-40-character-commit>" >&2
  exit 1
fi

[[ -L "$app_root/current" ]] || { echo "current release symlink is missing" >&2; exit 1; }
previous=$(readlink -f "$app_root/current")
next_link="$app_root/.current-next"
trap 'rm -f "$next_link"' EXIT
ln -s "releases/$commit" "$next_link"
mv -Tf "$next_link" "$app_root/current"

if ! systemctl restart "$service_name"; then
  ln -s "$previous" "$next_link"
  mv -Tf "$next_link" "$app_root/current"
  systemctl restart "$service_name" || true
  echo "rollback target failed; restored previous release" >&2
  exit 1
fi
for _ in {1..20}; do
  status=$(curl --silent --output /dev/null --write-out '%{http_code}' "$health_url" || true)
  if [[ "$status" == "200" || "$status" == "401" ]]; then
    echo "rolled back to release: $commit"
    exit 0
  fi
  sleep 1
done

ln -s "$previous" "$next_link"
mv -Tf "$next_link" "$app_root/current"
systemctl restart "$service_name" || true
echo "rollback target failed health check; restored previous release" >&2
exit 1
