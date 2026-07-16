#!/usr/bin/env bash
set -euo pipefail

source_dir=${1:-/home/shohei/プロジェクト/chat-app}
old_env=${2:-$source_dir/.env}
old_db=${3:-$source_dir/data/chat.db}
old_uploads=${4:-$source_dir/data/uploads}
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
backup_dir="/var/backups/chat-app/$timestamp"

if [[ ${EUID} -ne 0 ]]; then
  echo "migrate-gen8.sh must run as root (use sudo)." >&2
  exit 1
fi
if tailscale funnel status 2>/dev/null | grep -q 'Funnel on'; then
  echo "Funnel is still public. Run: sudo tailscale funnel --https=443 off" >&2
  exit 1
fi
[[ -f "$old_env" && -f "$old_db" ]] || { echo "old env or database not found" >&2; exit 1; }

getent group chat-app >/dev/null || groupadd --system chat-app
if ! id -u chat-app >/dev/null 2>&1; then
  useradd --system --gid chat-app --home-dir /var/lib/chat-app --shell /usr/sbin/nologin chat-app
fi
usermod -a -G chat-app shohei
install -d -o root -g root -m 0700 "$backup_dir"

web_was_active=0
timer_was_active=0
systemctl is-active --quiet chat-app && web_was_active=1
systemctl is-active --quiet chat-app-moderation.timer && timer_was_active=1
for unit in chat-app.service chat-app-moderation.service chat-app-moderation.timer; do
  if [[ -f "/etc/systemd/system/$unit" ]]; then
    cp -p "/etc/systemd/system/$unit" "$backup_dir/$unit"
  fi
done

migration_complete=0
rollback_migration() {
  local status=$?
  if [[ "$migration_complete" == "1" ]]; then
    return
  fi
  trap - EXIT
  for unit in chat-app.service chat-app-moderation.service chat-app-moderation.timer; do
    if [[ -f "$backup_dir/$unit" ]]; then
      install -o root -g root -m 0644 "$backup_dir/$unit" "/etc/systemd/system/$unit"
    fi
  done
  systemctl daemon-reload || true
  [[ "$web_was_active" == "1" ]] && systemctl start chat-app || true
  [[ "$timer_was_active" == "1" ]] && systemctl start chat-app-moderation.timer || true
  echo "migration failed; previous units and active services were restored. Funnel remains off." >&2
  exit "$status"
}
trap rollback_migration EXIT

"$source_dir/deploy/release.sh" "$source_dir" --no-restart

systemctl stop chat-app-moderation.timer 2>/dev/null || true
systemctl stop chat-app 2>/dev/null || true
MIGRATION_TIMESTAMP="$timestamp" "$source_dir/deploy/migrate-state.sh" \
  "$old_env" "$old_db" "$old_uploads" /

chown -R chat-app:chat-app /var/lib/chat-app
chmod 2770 /var/lib/chat-app /var/lib/chat-app/uploads
chown root:chat-app /etc/chat-app /etc/chat-app/chat-app.env
chmod 0750 /etc/chat-app
chmod 0640 /etc/chat-app/chat-app.env

install -o root -g root -m 0644 /opt/chat-app/current/deploy/chat-app.service /etc/systemd/system/chat-app.service
install -o root -g root -m 0644 /opt/chat-app/current/deploy/chat-app-moderation.service /etc/systemd/system/chat-app-moderation.service
install -o root -g root -m 0644 /opt/chat-app/current/deploy/chat-app-moderation.timer /etc/systemd/system/chat-app-moderation.timer
systemctl daemon-reload
systemctl enable --now chat-app
systemctl enable --now chat-app-moderation.timer

healthy=0
for _ in {1..20}; do
  status=$(curl --silent --output /dev/null --write-out '%{http_code}' http://127.0.0.1:3002/ || true)
  if [[ "$status" == "401" ]]; then
    healthy=1
    break
  fi
  sleep 1
done
if [[ "$healthy" != "1" ]]; then
  echo "new service failed health check; Funnel remains off" >&2
  exit 1
fi

systemctl --no-pager --full status chat-app
echo "migration complete; Funnel remains off until browser validation"
echo "migration backup: $backup_dir"
migration_complete=1
