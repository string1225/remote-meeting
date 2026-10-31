#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "$0")/.." && pwd)"
target=/etc/nginx/conf.d/00-public-redirects.conf
backup="/opt/remote-meeting/backups/public-redirects-$(date +%Y%m%d%H%M%S)"
nginx -t
mkdir -p "$backup"
if [[ -f "$target" ]]; then cp -a "$target" "$backup/previous.conf"; fi
rollback() {
    result=$?; trap - ERR; set +e
    if [[ -f "$backup/previous.conf" ]]; then cp -a "$backup/previous.conf" "$target"; else rm -f "$target"; fi
    nginx -t && systemctl reload nginx
    exit "$result"
}
trap rollback ERR
install -m 644 "$root/deploy/public-redirects.conf" "$target"
nginx -t
systemctl reload nginx
trap - ERR
printf 'Public HTTPS redirects now omit the internal Nginx port.\n'
