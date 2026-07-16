#!/usr/bin/env bash
set -euo pipefail

old_env=${1:-}
old_db=${2:-}
old_uploads=${3:-}
destination_root=${4:-/}
timestamp=${MIGRATION_TIMESTAMP:-$(date -u +%Y%m%dT%H%M%SZ)}

if [[ -z "$old_env" || -z "$old_db" || ! -f "$old_env" || ! -f "$old_db" ]]; then
  echo "usage: migrate-state.sh <old-env> <old-db> <old-uploads-dir> [destination-root]" >&2
  exit 1
fi
[[ "$timestamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { echo "invalid MIGRATION_TIMESTAMP" >&2; exit 1; }

config_dir="$destination_root/etc/chat-app"
state_dir="$destination_root/var/lib/chat-app"
backup_dir="$destination_root/var/backups/chat-app/$timestamp"
install -d -m 0750 "$config_dir"
install -d -m 2770 "$state_dir" "$state_dir/uploads"
install -d -m 0700 "$backup_dir"

cp -p "$old_db" "$backup_dir/chat.db"
cp -p "$old_db" "$state_dir/chat.db"
if [[ -d "$old_uploads" ]]; then
  install -d -m 0700 "$backup_dir/uploads"
  cp -a "$old_uploads/." "$backup_dir/uploads/"
  cp -a "$old_uploads/." "$state_dir/uploads/"
fi

environment_file="$config_dir/chat-app.env"
cp -p "$old_env" "$environment_file"
chmod 0640 "$environment_file"

read_env_value() {
  local key=$1 line
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$key="* ]]; then
      printf '%s' "${line#*=}"
      return
    fi
  done < "$environment_file"
}

set_env_value() {
  local key=$1 value=$2 line found=0 temporary
  temporary=$(mktemp "$config_dir/.chat-app.env.XXXXXX")
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == "$key="* ]]; then
      printf '%s=%s\n' "$key" "$value" >> "$temporary"
      found=1
    else
      printf '%s\n' "$line" >> "$temporary"
    fi
  done < "$environment_file"
  if [[ "$found" == "0" ]]; then
    printf '%s=%s\n' "$key" "$value" >> "$temporary"
  fi
  chmod 0640 "$temporary"
  mv "$temporary" "$environment_file"
}

existing_user=$(read_env_value BASIC_AUTH_USER)
existing_password=$(read_env_value BASIC_AUTH_PASSWORD)
if [[ (-n "$existing_user" && -z "$existing_password") || (-z "$existing_user" && -n "$existing_password") ]]; then
  echo "existing Basic auth configuration is incomplete" >&2
  exit 1
fi

generated_password=
if [[ -z "$existing_password" ]]; then
  command -v openssl >/dev/null || { echo "missing command: openssl" >&2; exit 1; }
  generated_password=$(openssl rand -hex 16)
  existing_password=$generated_password
fi

set_env_value PORT 3002
set_env_value HOST 127.0.0.1
set_env_value DB_PATH /var/lib/chat-app/chat.db
set_env_value BASIC_AUTH_USER chat
set_env_value BASIC_AUTH_PASSWORD "$existing_password"

echo "state prepared: $state_dir"
echo "backup created: $backup_dir"
if [[ -n "$generated_password" ]]; then
  echo "Basic auth credential (shown once): chat:$generated_password"
else
  echo "Basic auth password preserved; username is chat"
fi
