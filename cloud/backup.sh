#!/bin/bash
set -euo pipefail
umask 077
backup_dir=/var/backups/game-asset-settle
mkdir -p "$backup_dir"
chmod 700 "$backup_dir"
exec 9>"$backup_dir/.backup.lock"
flock -n 9 || exit 0
stamp=$(date -u +%Y%m%dT%H%M%SZ)
output="$backup_dir/buff_goods_cloud-$stamp.dump"
test ! -e "$output"
trap 'rm -f "$output.partial"' EXIT
docker exec -u postgres game-asset-settle-db pg_dump -U buff_cloud_admin -d buff_goods_cloud --format=custom > "$output.partial"
test -s "$output.partial"
mv "$output.partial" "$output"
sha256sum "$output" > "$output.sha256"
echo "Backup created: $output"
