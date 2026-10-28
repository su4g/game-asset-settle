#!/bin/bash
set -euo pipefail
umask 077
backup_file=${1:?Pass a backup file from /var/backups/game-asset-settle}
case "$backup_file" in /var/backups/game-asset-settle/buff_goods_cloud-*.dump) ;; *) echo 'Unexpected backup path' >&2; exit 1;; esac
test -f "$backup_file"
sha256sum -c "$backup_file.sha256" >/dev/null
restore_db="buff_goods_test_cloud_restore_$(date -u +%Y%m%d%H%M%S)_$$"
cleanup() { docker exec -u postgres game-asset-settle-db dropdb -U buff_cloud_admin --if-exists "$restore_db" >/dev/null; }
trap cleanup EXIT
docker exec -u postgres game-asset-settle-db createdb -U buff_cloud_admin -O buff_cloud_app "$restore_db"
docker exec -i -u postgres game-asset-settle-db pg_restore -U buff_cloud_admin -d "$restore_db" --exit-on-error < "$backup_file"
result=$(docker exec -u postgres game-asset-settle-db psql -U buff_cloud_admin -d "$restore_db" -Atc "SELECT count(*) FROM buff_cloud.profiles WHERE id IN ('account-1','account-2');")
test "$result" = 2
echo "Isolated restore verified; temporary database removed on exit."
