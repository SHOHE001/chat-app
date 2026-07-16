#!/usr/bin/env bash
set -euo pipefail

source_dir=${1:-$(pwd)}
no_restart=${2:-}
app_root=${CHAT_APP_ROOT:-/opt/chat-app}
service_name=${CHAT_APP_SERVICE:-chat-app}
health_url=${CHAT_APP_HEALTH_URL:-http://127.0.0.1:3002/}

if [[ ${EUID} -ne 0 ]]; then
  echo "release.sh must run as root (use sudo)." >&2
  exit 1
fi
if [[ "$no_restart" != "" && "$no_restart" != "--no-restart" ]]; then
  echo "usage: sudo deploy/release.sh [source-dir] [--no-restart]" >&2
  exit 1
fi
for command in git tar npm; do
  command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 1; }
done

git_cmd=(git -c "safe.directory=$source_dir" -C "$source_dir")
"${git_cmd[@]}" diff --quiet
"${git_cmd[@]}" diff --cached --quiet
commit=$("${git_cmd[@]}" rev-parse --verify HEAD)
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "invalid git commit" >&2; exit 1; }

releases_dir="$app_root/releases"
release_dir="$releases_dir/$commit"
temporary_dir="$releases_dir/.$commit.tmp"
archive=$(mktemp)
next_link="$app_root/.current-next"
trap 'rm -f "$archive" "$next_link"; rm -rf "$temporary_dir"' EXIT

install -d -o root -g root -m 0755 "$app_root" "$releases_dir"
if [[ ! -d "$release_dir" ]]; then
  "${git_cmd[@]}" archive --format=tar --output="$archive" "$commit"
  install -d -o root -g root -m 0755 "$temporary_dir"
  tar -xf "$archive" -C "$temporary_dir"
  npm ci --omit=dev --ignore-scripts --prefix "$temporary_dir"
  chown -R root:root "$temporary_dir"
  chmod -R go-w "$temporary_dir"
  mv "$temporary_dir" "$release_dir"
fi

previous=
if [[ -L "$app_root/current" ]]; then
  previous=$(readlink -f "$app_root/current")
fi
ln -s "releases/$commit" "$next_link"
mv -Tf "$next_link" "$app_root/current"

if [[ "$no_restart" != "--no-restart" ]] && systemctl is-active --quiet "$service_name"; then
  if ! systemctl restart "$service_name"; then
    if [[ -n "$previous" ]]; then
      ln -s "$previous" "$next_link"
      mv -Tf "$next_link" "$app_root/current"
    fi
    systemctl restart "$service_name" || true
    echo "restart failed; restored previous release" >&2
    exit 1
  fi
  healthy=0
  for _ in {1..20}; do
    status=$(curl --silent --output /dev/null --write-out '%{http_code}' "$health_url" || true)
    if [[ "$status" == "200" || "$status" == "401" ]]; then
      healthy=1
      break
    fi
    sleep 1
  done
  if [[ "$healthy" != "1" ]]; then
    if [[ -n "$previous" ]]; then
      ln -s "$previous" "$next_link"
      mv -Tf "$next_link" "$app_root/current"
      systemctl restart "$service_name" || true
    fi
    echo "health check failed; restored previous release" >&2
    exit 1
  fi
fi

echo "deployed release: $commit"
