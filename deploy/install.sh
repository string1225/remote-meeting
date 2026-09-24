#!/usr/bin/env bash
# Run as root from a release directory extracted from a committed Git archive.
set -euo pipefail
release_dir="$(cd -- "$(dirname -- "$0")/.." && pwd)"
site_config="${SITE_CONFIG:-/etc/nginx/conf.d/sunny-string.conf}"
origin="${PUBLIC_ORIGIN:-https://home.sunny-string.cn}"
[[ "$release_dir" == /opt/remote-meeting/releases/* ]] || { echo 'Extract release under /opt/remote-meeting/releases/ first.'; exit 1; }
[[ -f "$site_config" ]] || { echo 'Existing HTTPS site configuration not found.'; exit 1; }
[[ "$origin" =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?$ ]] || { echo 'PUBLIC_ORIGIN must be an HTTPS origin.'; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)'
nginx -t
if [[ ! -f /etc/systemd/system/remote-meeting.service ]] && ss -lnt | grep -q ':3033 '; then
    echo 'Port 3033 is already occupied; refusing to overwrite another service.'; exit 1
fi
id remote-meeting >/dev/null 2>&1 || useradd --system --home-dir /nonexistent --shell /sbin/nologin remote-meeting
cd "$release_dir"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
if [[ ! -f /etc/remote-meeting.env ]]; then
    umask 077
    admin_key="$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')"
    cat > /etc/remote-meeting.env <<EOF
NODE_ENV=production
HOST=127.0.0.1
PORT=3033
ADMIN_KEY=$admin_key
ALLOWED_ORIGINS=$origin
TRUST_PROXY=true
STUN_URLS=stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302
ROOM_TTL_HOURS=8
EOF
    unset admin_key
fi
chmod 600 /etc/remote-meeting.env
mkdir -p /etc/nginx/snippets /opt/remote-meeting/backups
stamp="$(date +%Y%m%d%H%M%S)"
cp -a "$site_config" "/opt/remote-meeting/backups/nginx-$stamp.conf"
install -m 644 deploy/meeting-location.conf /etc/nginx/snippets/remote-meeting-location.conf
python3 - "$site_config" <<'PY'
import pathlib, re, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text()
directive = '    include /etc/nginx/snippets/remote-meeting-location.conf;'
if directive.strip() not in text:
    # Insert only into the SSL server, directly before its certificate declaration.
    matches = list(re.finditer(r'^    ssl_certificate\s', text, re.M))
    if len(matches) != 1:
        raise SystemExit('Expected exactly one SSL server; review Nginx config manually.')
    start = matches[0].start()
    text = text[:start] + directive + '\n\n' + text[start:]
    path.write_text(text)
PY
if ! nginx -t; then
    cp -a "/opt/remote-meeting/backups/nginx-$stamp.conf" "$site_config"
    echo 'Nginx validation failed; existing configuration restored.'; exit 1
fi
previous="$(readlink -f /opt/remote-meeting/current || true)"
ln -sfn "$release_dir" /opt/remote-meeting/current
install -m 644 deploy/remote-meeting.service /etc/systemd/system/remote-meeting.service
systemctl daemon-reload
systemctl enable remote-meeting >/dev/null
systemctl restart remote-meeting
healthy=false
for attempt in $(seq 1 15); do
    if curl --fail --silent http://127.0.0.1:3033/api/health; then healthy=true; break; fi
    sleep 1
done
if [[ "$healthy" != true ]]; then
    if [[ -n "$previous" && "$previous" != "$release_dir" ]]; then ln -sfn "$previous" /opt/remote-meeting/current; systemctl restart remote-meeting; fi
    cp -a "/opt/remote-meeting/backups/nginx-$stamp.conf" "$site_config"
    echo 'Service health check failed; restored prior release/configuration.'; exit 1
fi
systemctl reload nginx
printf '\nDeployed: %s/meeting/\n' "$origin"
printf 'Admin key is stored only in /etc/remote-meeting.env (root-only).\n'
